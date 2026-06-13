/**
 * analyze-failures-cloud.ts
 *
 * Identifies projects that failed the cloud batch evaluation,
 * downloads their truth/generated sheets from GCS, extracts diffs, 
 * uses the LLM to suggest improvements, and applies them.
 *
 * Modes:
 *   --dry-run: Write candidate files instead of overwriting production
 *   Default: Apply changes to production files (legacy behavior, discouraged)
 *
 * Caps:
 *   - Max 5 prompt additions (FIFO eviction when full)
 *   - Max 3 dynamic few-shot examples
 */

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

import fs from 'fs';
import os from 'os';
import { Storage } from '@google-cloud/storage';
import ExcelJS from 'exceljs';
import { getWorksheetFlex } from './compare-sheets';
import { GoogleGenAI } from '@google/genai';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'autoinfra-ai-eval-data';
const PROJECT_ID = process.env.GCP_PROJECT_ID || '';
const LOCATION = process.env.GCP_LOCATION || 'us-central1';

const MAX_PROMPT_ADDITIONS = 10;
const MAX_DYNAMIC_FEW_SHOTS = 15;

function getGenAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  const useVertex = process.env.USE_VERTEX_AI === 'true' || !apiKey;

  if (useVertex) {
    console.log(`      [analyze-failures-cloud.ts] Initializing Gemini client using Vertex AI (Project: ${PROJECT_ID})`);
    return new GoogleGenAI({
      vertexai: true,
      project: PROJECT_ID,
      location: LOCATION,
      httpOptions: {
        timeout: 300000 // 5 minutes in milliseconds
      }
    });
  } else {
    console.log('      [analyze-failures-cloud.ts] Initializing Gemini client using Google AI Studio (Free Tier)');
    return new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        timeout: 300000 // 5 minutes in milliseconds
      }
    });
  }
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
          { text: `\\n\\nProject: \${projectName}\\n\\nHere are the mismatches:\\n\${diffsSummary}` }
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



function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseScoreboard(csvPath: string) {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  const dataLines = lines.slice(1);
  
  const seen = new Map<string, { projectName: string; overall: number; semanticOverall: number; totalCells: number }>();
  for (const line of dataLines) {
    const parts = parseCSVLine(line);
    if (parts.length < 8) continue;
    const projectName = parts[0].replace(/"/g, '').trim();
    const overall = parseFloat(parts[5]);
    let semanticOverall = overall;
    let totalCells = 0;
    
    if (parts.length >= 9) {
      semanticOverall = parseFloat(parts[6]);
      totalCells = parts[7] ? parseInt(parts[7], 10) : 0;
    } else {
      totalCells = parts[6] ? parseInt(parts[6], 10) : 0;
    }
    if (!projectName || isNaN(overall) || isNaN(semanticOverall)) continue;
    
    // Always overwrite with the last seen entry (latest date)
    seen.set(projectName.toLowerCase(), { projectName, overall, semanticOverall, totalCells });
  }

  const results = Array.from(seen.values());
  return results.filter(r => r.semanticOverall < 95 && !isNaN(r.totalCells) && r.totalCells > 0);
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

  const mhSheet = getWorksheetFlex(wb, 'MANHOLES (1)');
  const swSheet = getWorksheetFlex(wb, 'SEWERS (1)');
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

  const wmSheet = getWorksheetFlex(wb, 'WATERMAIN (1)');
  if (wmSheet) {
    // Read watermain runs (rows 13-19)
    for (let r = 13; r <= 19; r++) {
      const sizeAndType = getCellValue(wmSheet, `B${r}`);
      if (!sizeAndType) continue;
      result.watermain.push({
        sizeAndType: String(sizeAndType),
        length: getCellValue(wmSheet, `C${r}`) != null ? Number(getCellValue(wmSheet, `C${r}`)) : null,
        pipeDiameter: getCellValue(wmSheet, `D${r}`) != null ? Number(getCellValue(wmSheet, `D${r}`)) : null,
        ocSc: String(getCellValue(wmSheet, `F${r}`) || 'OC'),
        addMaterials: Number(getCellValue(wmSheet, `G${r}`)) || 0,
        addLE: Number(getCellValue(wmSheet, `H${r}`)) || 0,
        avgCover: getCellValue(wmSheet, `J${r}`) != null ? Number(getCellValue(wmSheet, `J${r}`)) : null,
      });
    }

    // Read watermain specials (rows 24-40)
    for (let r = 24; r <= 40; r++) {
      const specialName = getCellValue(wmSheet, `B${r}`);
      if (!specialName) continue;
      result.watermainSpecials.push({
        specialName: String(specialName),
        quantity: getCellValue(wmSheet, `C${r}`) != null ? Number(getCellValue(wmSheet, `C${r}`)) : null,
        costEach: getCellValue(wmSheet, `D${r}`) != null ? Number(getCellValue(wmSheet, `D${r}`)) : null,
        thrustBlock: getCellValue(wmSheet, `E${r}`) != null ? Number(getCellValue(wmSheet, `E${r}`)) : null,
        anodeCost: getCellValue(wmSheet, `F${r}`) != null ? Number(getCellValue(wmSheet, `F${r}`)) : null,
        laborEach: getCellValue(wmSheet, `G${r}`) != null ? Number(getCellValue(wmSheet, `G${r}`)) : null,
      });
    }

    // Read watermain valves (rows 24-40)
    for (let r = 24; r <= 40; r++) {
      const valveSize = getCellValue(wmSheet, `O${r}`);
      if (!valveSize) continue;
      result.watermainValves.push({
        valveSize: String(valveSize),
        quantity: getCellValue(wmSheet, `P${r}`) != null ? Number(getCellValue(wmSheet, `P${r}`)) : null,
        valveCost: getCellValue(wmSheet, `Q${r}`) != null ? Number(getCellValue(wmSheet, `Q${r}`)) : null,
        boxCost: getCellValue(wmSheet, `R${r}`) != null ? Number(getCellValue(wmSheet, `R${r}`)) : null,
        anodeCost: getCellValue(wmSheet, `S${r}`) != null ? Number(getCellValue(wmSheet, `S${r}`)) : null,
        laborPerValve: getCellValue(wmSheet, `T${r}`) != null ? Number(getCellValue(wmSheet, `T${r}`)) : null,
      });
    }
  }

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

function applyDynamicRule(
  rules: DynamicRulesV2,
  action: string,
  rule: string,
  component?: 'manholes' | 'sewers' | 'watermain' | 'general'
): { applied: boolean; reason: string } {
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
      component,
    });
    return { applied: true, reason: 'Added prompt rule' };
    
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
  
  // Evict oldest (FIFO) if at cap
  if (fewshots.length >= MAX_DYNAMIC_FEW_SHOTS) {
    const evicted = fewshots.shift();
    console.log(`[analyze-failures-cloud.ts] Cap reached (${MAX_DYNAMIC_FEW_SHOTS}). Evicted oldest few-shot: ${evicted?.projectName}`);
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

export async function analyzeFailuresCloud(
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
  failedProjects.sort((a, b) => a.semanticOverall - b.semanticOverall);
  failedProjects = failedProjects.slice(0, limit);
  console.log(`Found ${failedProjects.length} projects with <95% semantic accuracy after filtering.\n`);

  const report: AnalysisReport = {
    analyzedProjects: failedProjects.length,
    changesApplied: 0,
    changesRejected: 0,
    details: [],
  };

  // Load rules once
  const rules = loadDynamicRules(rulesPath);

  for (const { projectName, semanticOverall } of failedProjects) {
    console.log(`====================================================`);
    console.log(`🔍 Analyzing: ${projectName} (${semanticOverall.toFixed(1)}% Semantic Accuracy)`);
    
    // Find project files in GCS
    const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: projectName + '/' });
    const fileNames = files.map(f => f.name);
    
    const xlsxFiles = fileNames.filter(f => {
      // Ensure the file is directly under the project folder (ignore subfolders like tender submissions/quotes)
      const relativePath = f.slice(projectName.length + 1);
      if (relativePath.includes('/')) return false;

      const name = path.basename(f).toLowerCase();
      return name.endsWith('.xlsx') &&
        !name.includes('quote') &&
        !name.includes('budget') &&
        !name.includes('backup') &&
        !name.includes('sand') &&
        !name.includes('appendix') &&
        !name.includes('estimate') &&
        !name.includes('additional') &&
        !name.includes('eval_') &&
        !name.includes('generated_spreadsheets');
    });
    
    const truthFile = xlsxFiles.length > 0 ? xlsxFiles[0] : undefined;
    
    if (!truthFile) {
      console.log(`Missing truth file in GCS. Skipping.`);
      continue;
    }
    
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-'));
    const truthPath = path.join(tmpDir, 'truth.xlsx');
    
    await storage.bucket(BUCKET_NAME).file(truthFile).download({ destination: truthPath });

    // Download latest discrepancy text report if available
    const diffFiles = fileNames.filter(f => f.includes('/generated_spreadsheets/') && f.endsWith('_diff.txt'));
    let diffsSummary = '';
    if (diffFiles.length > 0) {
      diffFiles.sort();
      const latestDiffFile = diffFiles[diffFiles.length - 1];
      const diffDest = path.join(tmpDir, 'diff.txt');
      try {
        await storage.bucket(BUCKET_NAME).file(latestDiffFile).download({ destination: diffDest });
        diffsSummary = fs.readFileSync(diffDest, 'utf8');
      } catch (err: any) {
        console.warn(`   ⚠️ Failed to download discrepancy report: ${err.message}`);
      }
    }

    let suggestion = { action: 'ADD_FEW_SHOT', reasoning: 'No discrepancy report found. Defaulting to few-shot.' };
    if (diffsSummary) {
      console.log(`🤖 LLM analyzing mismatches and suggesting fixes...`);
      try {
        suggestion = await suggestImprovements(diffsSummary, projectName);
        console.log(`   Action suggested: ${suggestion.action}`);
        console.log(`   Reasoning: ${suggestion.reasoning}`);
      } catch (err: any) {
        console.warn(`   ⚠️ LLM suggestion failed: ${err.message}. Defaulting to ADD_FEW_SHOT.`);
      }
    }

    try {
      if (suggestion.action === 'PROMPT_TUNING' && (suggestion as any).promptAddition) {
        const applyResult = applyDynamicRule(rules, 'PROMPT_TUNING', (suggestion as any).promptAddition, (suggestion as any).component);
        if (applyResult.applied) {
          report.changesApplied++;
          console.log(`✅ ${applyResult.reason}`);
        } else {
          report.changesRejected++;
          console.log(`⏭️ Skipped: ${applyResult.reason}`);
        }
        report.details.push({
          project: projectName,
          action: 'PROMPT_TUNING',
          applied: applyResult.applied,
          reason: applyResult.reason,
        });
      } else if (suggestion.action === 'ADD_HEURISTIC' && (suggestion as any).heuristicRule) {
        const applyResult = applyDynamicRule(rules, 'ADD_HEURISTIC', (suggestion as any).heuristicRule);
        if (applyResult.applied) {
          report.changesApplied++;
          console.log(`✅ ${applyResult.reason}`);
        } else {
          report.changesRejected++;
          console.log(`⏭️ Skipped: ${applyResult.reason}`);
        }
        report.details.push({
          project: projectName,
          action: 'ADD_HEURISTIC',
          applied: applyResult.applied,
          reason: applyResult.reason,
        });
      } else {
        // ADD_FEW_SHOT
        console.log(`🤖 Automatically extracting Ground Truth as a few-shot candidate...`);
        const gt = await extractGtForFewShot(projectName, truthPath);
        const applyResult = applyFewShot(fewShotsPath, gt);
        if (applyResult.applied) {
          report.changesApplied++;
          console.log(`✅ ${applyResult.reason}`);
        } else {
          report.changesRejected++;
          console.log(`⏭️ Skipped: ${applyResult.reason}`);
        }
        report.details.push({
          project: projectName,
          action: 'ADD_FEW_SHOT',
          applied: applyResult.applied,
          reason: applyResult.reason,
        });
      }
    } catch (e: any) {
      console.error(`Failed to apply suggested optimization: ${e.message}`);
      report.details.push({
        project: projectName,
        action: 'ERROR',
        applied: false,
        reason: e.message,
      });
    }
    
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    console.error('Usage: npx tsx src/scripts/analyze-failures-cloud.ts <path-to-evaluation_scoreboard.csv> [--limit N] [--project "name"] [--dry-run]');
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
  
  await analyzeFailuresCloud(csvPath, { limit, targetProject, dryRun });
}

if (require.main === module) {
  main().catch(console.error);
}
