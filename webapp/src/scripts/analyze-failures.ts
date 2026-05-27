/**
 * analyze-failures.ts
 *
 * This script identifies projects that failed the batch evaluation,
 * extracts the exact mismatches (diffs) locally, and uses the LLM to suggest
 * improvements. It then automatically applies those improvements to close the loop!
 *
 * Upgraded with V2 metadata schema, deduplication, FIFO evictions, and strict caps.
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { compareSpreadsheets } from './compare-sheets';
import ExcelJS from 'exceljs';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');
const PROJECT_ID = process.env.GCP_PROJECT_ID || '';
const LOCATION = process.env.GCP_LOCATION || 'us-central1';

const MAX_PROMPT_ADDITIONS = 5;
const MAX_DYNAMIC_FEW_SHOTS = 3;

function getGenAI() {
  return new GoogleGenAI({
    vertexai: true,
    project: PROJECT_ID,
    location: LOCATION,
    httpOptions: {
      timeout: 300000 // 5 minutes in milliseconds
    }
  });
}

function parseScoreboard(csvPath: string) {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  const dataLines = lines.slice(1);
  
  const results = dataLines.map(line => {
    const parts = line.split(',');
    const projectName = parts[0].replace(/"/g, '');
    const overall = parseFloat(parts[5]);
    const totalCells = parts[6] ? parseInt(parts[6], 10) : 0;
    return { projectName, overall, totalCells };
  });

  return results.filter(r => r.overall < 95 && !isNaN(r.totalCells) && r.totalCells > 0);
}

async function suggestImprovements(diffsSummary: string, projectName: string) {
  const ai = getGenAI();
  
  const systemPrompt = `You are an expert AI optimization engineer. We have a data extraction pipeline that pulls civil engineering infrastructure data from PDF drawings and populates an Excel spreadsheet.
  
We just ran an evaluation pass and found mismatches between what our pipeline generated and what human estimators manually entered (Ground Truth).

Your task is to analyze the following mismatches for a single project and suggest exactly ONE of the following fixes:
1. "PROMPT_TUNING": If the pipeline misunderstood the schema or format, suggest what sentence to add to the system prompt of the targeted component.
2. "ADD_HEURISTIC": If it's a domain-specific default that isn't on the drawings, suggest a new post-processing heuristic rule.
3. "ADD_FEW_SHOT": If the drawing is just too complex, recommend adding this project to the few-shot examples.

Explain your reasoning clearly.
Return ONLY a JSON object matching this schema:
{
  "action": "PROMPT_TUNING" | "ADD_HEURISTIC" | "ADD_FEW_SHOT",
  "component": "manholes" | "sewers" | "watermain" | "general", // Target component if action is PROMPT_TUNING
  "reasoning": "Explanation here",
  "promptAddition": "Sentence to add to prompt (if PROMPT_TUNING)",
  "heuristicRule": "Description of rule (if ADD_HEURISTIC)"
}`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-pro',
    contents: [
      {
        role: 'user',
        parts: [
          { text: systemPrompt },
          { text: `\n\nProject: ${projectName}\n\nHere are the mismatches:\n${diffsSummary}` }
        ]
      }
    ],
    config: {
      temperature: 0.2,
      responseMimeType: 'application/json'
    }
  });

  return JSON.parse(response.text || '{}');
}

function getCellValue(sheet: any, ref: string) {
  const cell = sheet.getCell(ref);
  if (cell.value === null || cell.value === undefined) return null;
  if (typeof cell.value === 'object') {
    if ('result' in cell.value) return cell.value.result;
    if ('text' in cell.value) return cell.value.text;
    return null;
  }
  return cell.value;
}

async function extractGtForFewShot(projectName: string, truthPath: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(truthPath);

  const mhSheet = wb.getWorksheet('MANHOLES (1)');
  const swSheet = wb.getWorksheet('SEWERS (1)');
  if (!mhSheet || !swSheet) throw new Error('Missing tabs');

  const result: any = { 
    projectName: String(getCellValue(mhSheet, 'B2') || projectName), 
    jobNumber: String(getCellValue(mhSheet, 'B3') || ''), 
    date: String(getCellValue(mhSheet, 'B5') || '') 
  };

  result.manholes = [];
  for (let r = 11; r <= 50; r++) {
    const desc = getCellValue(mhSheet, `B${r}`);
    if (!desc) continue;
    result.manholes.push({
      description: String(desc),
      depth: getCellValue(mhSheet, `J${r}`),
      addMaterials: Number(getCellValue(mhSheet, `H${r}`)) || 0,
      addLE: Number(getCellValue(mhSheet, `I${r}`)) || 0,
    });
  }

  result.catchbasins = { groups: [], laborRates: {} };
  const cbTypes: Record<number, string> = {53:'SINGLE_CB', 54:'DOUBLE_CB', 55:'DITCH_INLET_CB', 56:'DOUBLE_DITCH_INLET_CB'};
  for (const [rowStr, type] of Object.entries(cbTypes)) {
    const row = Number(rowStr);
    const qty = getCellValue(mhSheet, `C${row}`);
    if (qty) {
      result.catchbasins.groups.push({
        type,
        quantity: Number(qty),
        wallThickness: Number(getCellValue(mhSheet, `D${row}`)) || 4,
        depth: Number(getCellValue(mhSheet, `E${row}`)) || 2.2,
        grateEach: Number(getCellValue(mhSheet, `F${row}`)) || 0,
        addMaterials: Number(getCellValue(mhSheet, `G${row}`)) || 0,
      });
    }
  }
  result.catchbasins.laborRates = {
    scbLabor: Number(getCellValue(mhSheet, 'C59')) || 200,
    dcbLabor: Number(getCellValue(mhSheet, 'C60')) || 250,
    dicbFC: Number(getCellValue(mhSheet, 'F59')) || 465,
    ddicbFC: Number(getCellValue(mhSheet, 'F60')) || 715,
  };

  result.sewers = [];
  for (let r = 14; r <= 55; r++) {
    const label = getCellValue(swSheet, `B${r}`);
    if (!label) continue;
    const length = getCellValue(swSheet, `C${r}`);
    const pipeDia = getCellValue(swSheet, `D${r}`);
    const isLineItem = !length && !pipeDia;

    // Skip standard fee line items — they're added deterministically
    const labelUpper = String(label).toUpperCase();
    if (isLineItem && (labelUpper.includes('VIDEO') || labelUpper.includes('LAYOUT') || labelUpper.includes('AS BUILT'))) {
      continue;
    }

    result.sewers.push({
      runLabel: String(label),
      isLineItem,
      length: length != null ? Number(length) : null,
      pipeDiameter: pipeDia != null ? Number(pipeDia) : null,
      typeClass: getCellValue(swSheet, `E${r}`) != null ? Number(getCellValue(swSheet, `E${r}`)) : null,
      slope: getCellValue(swSheet, `F${r}`) != null ? Number(getCellValue(swSheet, `F${r}`)) : null,
      depth: getCellValue(swSheet, `G${r}`) != null ? Number(getCellValue(swSheet, `G${r}`)) : null,
      addMaterials: Number(getCellValue(swSheet, `H${r}`)) || 0,
      addLE: Number(getCellValue(swSheet, `I${r}`)) || 0,
    });
  }
  
  result.watermain = [];
  result.watermainSpecials = [];
  result.watermainValves = [];
  return result;
}

// ======================== RULE MANAGEMENT ========================

interface DynamicRulesV2 {
  version: number;
  baselineAccuracy: number;
  lastUpdated: string;
  promptAdditions: { rule: string; addedBy: string; addedAt: string; accuracyDelta: number | null; component?: 'manholes' | 'sewers' | 'watermain' | 'general' }[];
  heuristics: { rule: string; addedBy: string; addedAt: string; accuracyDelta: number | null }[];
}

function loadDynamicRules(filePath: string): DynamicRulesV2 {
  if (!fs.existsSync(filePath)) {
    return {
      version: 2,
      baselineAccuracy: 0,
      lastUpdated: new Date().toISOString().split('T')[0],
      promptAdditions: [],
      heuristics: [],
    };
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  // Migrate v1 → v2 if needed
  if (!raw.version || raw.version < 2) {
    const migrated: DynamicRulesV2 = {
      version: 2,
      baselineAccuracy: raw.baselineAccuracy || 0,
      lastUpdated: new Date().toISOString().split('T')[0],
      promptAdditions: (raw.promptAdditions || []).map((r: string | { rule: string }) => ({
        rule: typeof r === 'string' ? r : r.rule,
        addedBy: 'migrated',
        addedAt: new Date().toISOString().split('T')[0],
        accuracyDelta: null,
      })),
      heuristics: (raw.heuristics || []).map((h: string | { rule: string }) => ({
        rule: typeof h === 'string' ? h : h.rule,
        addedBy: 'migrated',
        addedAt: new Date().toISOString().split('T')[0],
        accuracyDelta: null,
      })),
    };
    return migrated;
  }

  return raw as DynamicRulesV2;
}

/**
 * Check if a new rule is semantically similar to an existing one.
 * Simple word-overlap heuristic to prevent near-duplicate rules.
 */
function isDuplicateRule(existingRules: string[], newRule: string): boolean {
  const newWords = new Set(newRule.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  
  for (const existing of existingRules) {
    const existingWords = new Set(existing.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    let overlap = 0;
    for (const w of newWords) {
      if (existingWords.has(w)) overlap++;
    }
    const similarity = overlap / Math.max(newWords.size, existingWords.size);
    if (similarity > 0.6) return true; // >60% word overlap = likely duplicate
  }
  return false;
}

function applyDynamicRule(rules: DynamicRulesV2, action: string, rule: string, component?: string): { applied: boolean; reason: string } {
  const today = new Date().toISOString().split('T')[0];
  
  if (action === 'PROMPT_TUNING') {
    const existingRules = rules.promptAdditions.map(r => r.rule);
    if (isDuplicateRule(existingRules, rule)) {
      return { applied: false, reason: 'Duplicate rule detected (>60% word overlap with existing)' };
    }
    
    // FIFO eviction if at cap
    if (rules.promptAdditions.length >= MAX_PROMPT_ADDITIONS) {
      const evicted = rules.promptAdditions.shift()!;
      console.log(`   ⚠️ Evicted oldest prompt rule: "${evicted.rule.slice(0, 60)}..."`);
    }
    
    rules.promptAdditions.push({
      rule,
      addedBy: 'flywheel',
      addedAt: today,
      accuracyDelta: null,
      component: (component as any) || 'general'
    });
    return { applied: true, reason: `Added prompt rule for [${component || 'general'}]` };
    
  } else if (action === 'ADD_HEURISTIC') {
    const existingRules = rules.heuristics.map(h => h.rule);
    if (isDuplicateRule(existingRules, rule)) {
      return { applied: false, reason: 'Duplicate heuristic detected' };
    }
    
    rules.heuristics.push({
      rule,
      addedBy: 'flywheel',
      addedAt: today,
      accuracyDelta: null,
    });
    return { applied: true, reason: 'Added heuristic' };
  }
  
  return { applied: false, reason: `Unknown action: ${action}` };
}

function applyFewShot(fewShotsPath: string, gtData: any): { applied: boolean; reason: string } {
  let fewshots: any[] = [];
  if (fs.existsSync(fewShotsPath)) {
    fewshots = JSON.parse(fs.readFileSync(fewShotsPath, 'utf8'));
  }
  
  // Cap check
  if (fewshots.length >= MAX_DYNAMIC_FEW_SHOTS) {
    return { applied: false, reason: `Dynamic few-shots at cap (${MAX_DYNAMIC_FEW_SHOTS}). Not adding more.` };
  }
  
  // Duplicate check by project name
  const exists = fewshots.some((f: any) =>
    f.projectName && gtData.projectName &&
    f.projectName.toLowerCase() === gtData.projectName.toLowerCase()
  );
  if (exists) {
    return { applied: false, reason: `Project "${gtData.projectName}" already in few-shots` };
  }
  
  fewshots.push(gtData);
  fs.writeFileSync(fewShotsPath, JSON.stringify(fewshots, null, 2));
  return { applied: true, reason: `Added ${gtData.projectName} to few-shots` };
}

// ======================== MAIN ANALYSIS ========================

export interface AnalysisReport {
  analyzedProjects: number;
  changesApplied: number;
  changesRejected: number;
  details: { project: string; action: string; applied: boolean; reason: string }[];
}

export async function analyzeFailuresLocal(
  csvPath: string,
  options: {
    limit?: number;
    targetProject?: string | null;
    dryRun?: boolean;
    candidateRulesPath?: string;
    candidateFewShotsPath?: string;
  } = {}
): Promise<AnalysisReport> {
  const {
    limit = Infinity,
    targetProject = null,
    dryRun = false,
    candidateRulesPath,
    candidateFewShotsPath,
  } = options;

  // Determine file paths
  const productionRulesPath = path.resolve(__dirname, '../lib/dynamic-rules.json');
  const productionFewShotsPath = path.resolve(__dirname, '../../few_shot_examples.json');

  let rulesPath: string;
  let fewShotsPath: string;

  if (dryRun) {
    rulesPath = candidateRulesPath || productionRulesPath.replace('.json', '.candidate.json');
    fewShotsPath = candidateFewShotsPath || productionFewShotsPath.replace('.json', '.candidate.json');
    
    // Copy production → candidate as starting point
    if (fs.existsSync(productionRulesPath)) {
      fs.copyFileSync(productionRulesPath, rulesPath);
    }
    if (fs.existsSync(productionFewShotsPath)) {
      fs.copyFileSync(productionFewShotsPath, fewShotsPath);
    }
    
    console.log(`🔒 DRY RUN: Writing candidates to:`);
    console.log(`   Rules: ${rulesPath}`);
    console.log(`   Few-shots: ${fewShotsPath}`);
  } else {
    rulesPath = productionRulesPath;
    fewShotsPath = productionFewShotsPath;
  }

  let failedProjects = parseScoreboard(csvPath);
  
  if (targetProject) {
    failedProjects = failedProjects.filter(p => p.projectName.toLowerCase().includes(targetProject.toLowerCase()));
  }
  
  // Sort from worst to best
  failedProjects.sort((a, b) => a.overall - b.overall);
  failedProjects = failedProjects.slice(0, limit);
  console.log(`Found ${failedProjects.length} projects with <95% accuracy after filtering.\n`);

  const report: AnalysisReport = {
    analyzedProjects: failedProjects.length,
    changesApplied: 0,
    changesRejected: 0,
    details: [],
  };

  // Load rules once
  const rules = loadDynamicRules(rulesPath);

  for (const { projectName, overall } of failedProjects) {
    console.log(`====================================================`);
    console.log(`🔍 Analyzing: ${projectName} (${overall.toFixed(1)}% Accuracy)`);
    
    const projectDir = path.join(TRAINING_DIR, projectName);
    if (!fs.existsSync(projectDir)) {
      console.log(`Project folder not found in training data: ${projectName}. Skipping.`);
      continue;
    }

    const allFiles = fs.readdirSync(projectDir);
    const truthFiles = allFiles.filter(f => f.endsWith('.xlsx') && !f.includes('eval_') && !f.toLowerCase().includes('quote'));
    if (truthFiles.length === 0) {
      console.log(`Missing truth sheet in local folder. Skipping.`);
      continue;
    }
    
    const genDir = path.join(projectDir, 'generated_spreadsheets');
    if (!fs.existsSync(genDir)) {
      console.log(`Missing generated_spreadsheets folder locally. Skipping.`);
      continue;
    }
    
    const genFiles = fs.readdirSync(genDir).filter(f => f.endsWith('.xlsx')).sort();
    if (genFiles.length === 0) {
      console.log(`Missing generated sheets locally. Skipping.`);
      continue;
    }

    const truthPath = path.join(projectDir, truthFiles[0]);
    const genPath = path.join(genDir, genFiles[genFiles.length - 1]); // use latest

    const result = await compareSpreadsheets(truthPath, genPath, projectName);
    
    let diffsSummary = '';
    for (const rep of result.reports) {
      if (rep.diffs.length > 0) {
        diffsSummary += `\nSection: ${rep.sectionLabel}\n`;
        for (const diff of rep.diffs.slice(0, 10)) {
          diffsSummary += `- Row ${diff.row} [${diff.colName}]: Ground Truth="${diff.truthValue}" vs Generated="${diff.genValue}"\n`;
        }
        if (rep.diffs.length > 10) {
          diffsSummary += `  ...and ${rep.diffs.length - 10} more similar mismatches.\n`;
        }
      }
    }

    if (!diffsSummary) {
      console.log(`No diffs summary available.`);
    } else {
      console.log(`🤖 Asking AI for recommendations...`);
      try {
        const suggestion = await suggestImprovements(diffsSummary, projectName);
        console.log(`\n💡 AI Recommendation: [${suggestion.action}]`);
        console.log(`   Reasoning: ${suggestion.reasoning}`);
        
        let applyResult: { applied: boolean; reason: string };
        
        if (suggestion.action === 'ADD_FEW_SHOT') {
          const gt = await extractGtForFewShot(projectName, truthPath);
          applyResult = applyFewShot(fewShotsPath, gt);
        } else if (suggestion.action === 'PROMPT_TUNING' && suggestion.promptAddition) {
          applyResult = applyDynamicRule(rules, 'PROMPT_TUNING', suggestion.promptAddition, suggestion.component);
        } else if (suggestion.action === 'ADD_HEURISTIC' && suggestion.heuristicRule) {
          applyResult = applyDynamicRule(rules, 'ADD_HEURISTIC', suggestion.heuristicRule);
        } else {
          applyResult = { applied: false, reason: 'No actionable suggestion from AI' };
        }

        if (applyResult.applied) {
          report.changesApplied++;
          console.log(`✅ ${applyResult.reason}`);
        } else {
          report.changesRejected++;
          console.log(`⏭️ Skipped: ${applyResult.reason}`);
        }

        report.details.push({
          project: projectName,
          action: suggestion.action,
          applied: applyResult.applied,
          reason: applyResult.reason,
        });
      } catch (e: any) {
        console.error(`Failed to get/apply suggestion: ${e.message}`);
        report.details.push({
          project: projectName,
          action: 'ERROR',
          applied: false,
          reason: e.message,
        });
      }
    }
  }

  // Write updated rules
  rules.lastUpdated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));

  console.log(`\n📊 Analysis Report: ${report.changesApplied} applied, ${report.changesRejected} rejected out of ${report.analyzedProjects} projects`);
  
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx src/scripts/analyze-failures.ts <path-to-evaluation_scoreboard.csv> [--limit N] [--project "name"] [--dry-run]');
    process.exit(1);
  }
  
  const csvPath = args[0];
  let limit = Infinity;
  let targetProject: string | null = null;
  let dryRun = false;
  
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--project' && args[i + 1]) {
      targetProject = args[i + 1];
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    }
  }
  
  await analyzeFailuresLocal(csvPath, { limit, targetProject, dryRun });
}

if (require.main === module) {
  main().catch(console.error);
}
