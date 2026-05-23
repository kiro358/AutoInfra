/**
 * evaluate-golden.ts
 *
 * Runs local evaluation against a representative "Golden Set" of 5 projects,
 * computing accuracy instantly and printing a beautiful scoreboard.
 *
 * Spans simple, medium, and complex projects to provide robust and fast feedback.
 *
 * Usage:
 *   GCP_PROJECT_ID=autoinfra-ai GCP_LOCATION=us-central1 npx tsx src/scripts/evaluate-golden.ts
 */

import fs from 'fs';
import path from 'path';
import { extractFromPDF } from '../lib/extraction';
import { populateTemplate } from '../lib/spreadsheet';
import { DEFAULT_PARAMS } from '../lib/constants';
import { compareSpreadsheets, CompareResult } from './compare-sheets';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');

// The 5 Golden projects representative of the full dataset
const GOLDEN_PROJECTS = [
  { folder: '2026-067 201 GEORGIAN DR,BARRIE', label: '1. Georgian Dr, Barrie (Simple storm)' },
  { folder: '2026-068 HOLIDAY INN,TRENTON', label: '2. Holiday Inn, Trenton (Medium storm+san)' },
  { folder: '2026-021 MATTHEWS HANGER WATERLOO', label: '3. Matthews Hangar (Complex system)' },
  { folder: '2026-010 NEW ORILLIA E.S', label: '4. New Orillia E.S. (High density CBs)' },
  { folder: '2026-004 SHN CENTENNIAL EMERGENCY DEPARTMENT REDEVELOPMENT', label: '5. SHN Centennial (Site specials)' }
];

async function evaluateProject(folderName: string): Promise<CompareResult | null> {
  const projectDir = path.join(TRAINING_DIR, folderName);
  if (!fs.existsSync(projectDir)) {
    console.error(`❌ Project directory not found: ${folderName}`);
    return null;
  }

  const files = fs.readdirSync(projectDir);
  const pdfFiles = files.filter(f => 
    f.toLowerCase().endsWith('.pdf') && 
    !f.toLowerCase().includes('quote') && 
    !f.toLowerCase().includes('quotation') && 
    !f.toLowerCase().includes('schedule') && 
    !f.toLowerCase().includes('bid') && 
    !f.toLowerCase().includes('geotechnical') && 
    !f.toLowerCase().includes('report') &&
    !f.toLowerCase().includes('granular') &&
    !f.toLowerCase().includes('structural') &&
    !f.toLowerCase().includes('architectural')
  );
  const xlsxFiles = files.filter(f => f.toLowerCase().endsWith('.xlsx') && !f.toLowerCase().includes('eval_run_'));

  if (pdfFiles.length === 0 || xlsxFiles.length === 0) {
    console.warn(`⚠️ Skipping ${folderName}: missing PDF or XLSX`);
    return null;
  }

  // Find the largest drawing PDF to process the main plan set
  let selectedPdf = pdfFiles[0];
  let maxSize = 0;
  for (const pdf of pdfFiles) {
    const filePath = path.join(projectDir, pdf);
    const stat = fs.statSync(filePath);
    if (stat.size > maxSize) {
      maxSize = stat.size;
      selectedPdf = pdf;
    }
  }

  const pdfPath = path.join(projectDir, selectedPdf);
  const truthPath = path.join(projectDir, xlsxFiles[0]);

  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    console.log(`   [evaluate-golden] Processing PDF: ${selectedPdf} (${(pdfBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
    
    // Extract using the restored single-pass pipeline
    const result = await extractFromPDF(pdfBuffer, folderName);

    // Populate standard spreadsheet template
    const genBuffer = await populateTemplate(result, DEFAULT_PARAMS as any);

    const genDir = path.join(projectDir, 'generated_spreadsheets');
    if (!fs.existsSync(genDir)) fs.mkdirSync(genDir);

    const genFilename = `eval_run_golden_${Date.now()}.xlsx`;
    const genPath = path.join(genDir, genFilename);
    fs.writeFileSync(genPath, genBuffer);

    // Compare generated sheet vs ground truth
    const compareResult = await compareSpreadsheets(truthPath, genPath, folderName);
    return compareResult;
  } catch (e: any) {
    console.error(`❌ Error evaluating project ${folderName}:`, e.message);
    return null;
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          AutoInfra FAST GOLDEN EVALUATION LOOP               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`Starting fast local evaluation loop on ${GOLDEN_PROJECTS.length} Golden Projects...`);
  console.log('Evaluating sequentially to ensure stable network proxy connections...\n');

  const startTime = Date.now();
  const results: (CompareResult | null)[] = [];
  
  for (let i = 0; i < GOLDEN_PROJECTS.length; i++) {
    const p = GOLDEN_PROJECTS[i];
    console.log(`\n------------------------------------------------------------`);
    console.log(`[${i + 1}/${GOLDEN_PROJECTS.length}] Evaluating: ${p.label}...`);
    const res = await evaluateProject(p.folder);
    results.push(res);
    
    if (res) {
      console.log(`✅ Success! Accuracy: ${res.overallAccuracy.toFixed(1)}%`);
    }
  }
  
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(90));
  console.log('                     GOLDEN SCOREBOARD RESULT');
  console.log('='.repeat(90));
  console.log(
    'Project'.padEnd(50) +
    '│ MH Str │ MH CB  │ Sewers │ WM     │ Overall'
  );
  console.log('─'.repeat(90));

  let totalOverall = 0;
  let validCount = 0;

  for (let i = 0; i < GOLDEN_PROJECTS.length; i++) {
    const project = GOLDEN_PROJECTS[i];
    const res = results[i];

    if (!res) {
      console.log(project.label.padEnd(50) + '│ ERROR  │ ERROR  │ ERROR  │ ERROR  │ ERROR');
      continue;
    }

    const mhsAcc = res.reports[0].totalCells > 0 ? ((res.reports[0].matchingCells / res.reports[0].totalCells) * 100).toFixed(1) + '%' : 'N/A';
    const cbsAcc = res.reports[1].totalCells > 0 ? ((res.reports[1].matchingCells / res.reports[1].totalCells) * 100).toFixed(1) + '%' : 'N/A';
    const swAcc = res.reports[2].totalCells > 0 ? ((res.reports[2].matchingCells / res.reports[2].totalCells) * 100).toFixed(1) + '%' : 'N/A';
    const wmAcc = res.reports[3].totalCells > 0 ? ((res.reports[3].matchingCells / res.reports[3].totalCells) * 100).toFixed(1) + '%' : 'N/A';
    const overallAcc = res.overallAccuracy.toFixed(1) + '%';

    console.log(
      project.label.padEnd(50) +
      `│ ${mhsAcc.padEnd(6)} │ ${cbsAcc.padEnd(6)} │ ${swAcc.padEnd(6)} │ ${wmAcc.padEnd(6)} │ ${overallAcc}`
    );

    totalOverall += res.overallAccuracy;
    validCount++;
  }

  console.log('─'.repeat(90));
  const meanAccuracy = validCount > 0 ? (totalOverall / validCount).toFixed(1) : '0.0';
  console.log(`🏆 MEAN SCOREBOARD ACCURACY: ${meanAccuracy}%`);
  console.log(`⏱️ Completed in ${elapsedSec}s (approx. ${((Number(elapsedSec) / GOLDEN_PROJECTS.length)).toFixed(1)}s per project)`);
  console.log('='.repeat(90) + '\n');
}

if (require.main === module) {
  main().catch(console.error);
}
