/**
 * analyze-failures-cloud.ts
 *
 * Identifies projects that failed the cloud batch evaluation,
 * downloads their truth/generated sheets from GCS, extracts diffs, 
 * uses the LLM to suggest improvements, and applies them.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { Storage } from '@google-cloud/storage';
import { GoogleGenAI } from '@google/genai';
import { compareSpreadsheets } from './compare-sheets';
import ExcelJS from 'exceljs';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'autoinfra-ai-eval-data';
const PROJECT_ID = process.env.GCP_PROJECT_ID || '';
const LOCATION = process.env.GCP_LOCATION || 'us-central1';

function getGenAI() {
  return new GoogleGenAI({
    vertexai: true,
    project: PROJECT_ID,
    location: LOCATION
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
    return { projectName, overall };
  });

  return results.filter(r => r.overall < 95);
}

async function suggestImprovements(diffsSummary: string, projectName: string) {
  const ai = getGenAI();
  
  const systemPrompt = `You are an expert AI optimization engineer. We have a data extraction pipeline that pulls civil engineering infrastructure data from PDF drawings and populates an Excel spreadsheet.
  
We just ran an evaluation pass and found mismatches between what our pipeline generated and what human estimators manually entered (Ground Truth).

Your task is to analyze the following mismatches for a single project and suggest exactly ONE of the following fixes:
1. "PROMPT_TUNING": If the pipeline misunderstood the schema or format, suggest what sentence to add to the SYSTEM_PROMPT.
2. "ADD_HEURISTIC": If it's a domain-specific default that isn't on the drawings, suggest a new post-processing heuristic rule.
3. "ADD_FEW_SHOT": If the drawing is just too complex, recommend adding this project to the few-shot examples.

Explain your reasoning clearly.
Return ONLY a JSON object matching this schema:
{
  "action": "PROMPT_TUNING" | "ADD_HEURISTIC" | "ADD_FEW_SHOT",
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

function applyDynamicRule(action: string, rule: string) {
  let p = path.resolve(__dirname, '../lib/dynamic-rules.json');
  if (!fs.existsSync(p)) {
    p = path.resolve(process.cwd(), 'src/lib/dynamic-rules.json');
  }
  const rules = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (action === 'PROMPT_TUNING') {
    rules.promptAdditions.push(rule);
  } else if (action === 'ADD_HEURISTIC') {
    rules.heuristics.push(rule);
  }
  fs.writeFileSync(p, JSON.stringify(rules, null, 2));
}

function applyFewShot(gtData: any) {
  let p = path.resolve(__dirname, '../../few_shot_examples.json');
  if (!fs.existsSync(p)) {
    p = path.resolve(process.cwd(), 'few_shot_examples.json');
  }
  let fewshots = [];
  if (fs.existsSync(p)) {
    fewshots = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  fewshots.push(gtData);
  fs.writeFileSync(p, JSON.stringify(fewshots, null, 2));
}

async function analyzeFailuresCloud(csvPath: string, limit: number = Infinity, targetProject: string | null = null) {
  let failedProjects = parseScoreboard(csvPath);
  
  if (targetProject) {
    failedProjects = failedProjects.filter(p => p.projectName.toLowerCase().includes(targetProject.toLowerCase()));
  }
  
  // Sort from worst to best
  failedProjects.sort((a, b) => a.overall - b.overall);
  failedProjects = failedProjects.slice(0, limit);
  console.log(`Found ${failedProjects.length} projects with <95% accuracy after filtering.\n`);

  for (const { projectName, overall } of failedProjects) {
    console.log(`====================================================`);
    console.log(`🔍 Analyzing: ${projectName} (${overall.toFixed(1)}% Accuracy)`);
    
    // Find project files in GCS
    const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: projectName + '/' });
    const fileNames = files.map(f => f.name);
    
    const truthFile = fileNames.find(f => f.endsWith('.xlsx') && !f.includes('eval_') && !f.includes('generated_spreadsheets'));
    const genFiles = fileNames.filter(f => f.includes('generated_spreadsheets/eval_')).sort();
    
    if (!truthFile || genFiles.length === 0) {
      console.log(`Missing truth file or generated file in GCS. Skipping.`);
      continue;
    }
    
    const genFile = genFiles[genFiles.length - 1]; // latest
    
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-'));
    const truthPath = path.join(tmpDir, 'truth.xlsx');
    const genPath = path.join(tmpDir, 'gen.xlsx');
    
    await storage.bucket(BUCKET_NAME).file(truthFile).download({ destination: truthPath });
    await storage.bucket(BUCKET_NAME).file(genFile).download({ destination: genPath });

    const result = await compareSpreadsheets(truthPath, genPath, projectName);
    
    let diffsSummary = '';
    for (const report of result.reports) {
      if (report.diffs.length > 0) {
        diffsSummary += `\nSection: ${report.sectionLabel}\n`;
        for (const diff of report.diffs.slice(0, 10)) {
          diffsSummary += `- Row ${diff.row} [${diff.colName}]: Ground Truth="${diff.truthValue}" vs Generated="${diff.genValue}"\n`;
        }
        if (report.diffs.length > 10) {
          diffsSummary += `  ...and ${report.diffs.length - 10} more similar mismatches.\n`;
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
        
        if (suggestion.action === 'ADD_FEW_SHOT') {
          const gt = await extractGtForFewShot(projectName, truthPath);
          applyFewShot(gt);
          console.log(`✅ Applied: Added ${projectName} to few_shot_examples.json`);
        } else if (suggestion.action === 'PROMPT_TUNING' && suggestion.promptAddition) {
          applyDynamicRule('PROMPT_TUNING', suggestion.promptAddition);
          console.log(`✅ Applied: Added rule to dynamic-rules.json`);
        } else if (suggestion.action === 'ADD_HEURISTIC' && suggestion.heuristicRule) {
          applyDynamicRule('ADD_HEURISTIC', suggestion.heuristicRule);
          console.log(`✅ Applied: Added heuristic to dynamic-rules.json`);
        }
      } catch (e: any) {
        console.error(`Failed to get/apply suggestion: ${e.message}`);
      }
    }
    
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx src/scripts/analyze-failures-cloud.ts <path-to-evaluation_scoreboard.csv> [--limit N] [--project "name"]');
    process.exit(1);
  }
  
  const csvPath = args[0];
  let limit = Infinity;
  let targetProject: string | null = null;
  
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--project' && args[i + 1]) {
      targetProject = args[i + 1];
      i++;
    }
  }
  
  await analyzeFailuresCloud(csvPath, limit, targetProject);
}

if (require.main === module) {
  main().catch(console.error);
}
