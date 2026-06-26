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
import { priceTakeoff } from '../lib/costing-rules';
import { populateTemplate } from '../lib/spreadsheet';
import { DEFAULT_PARAMS } from '../lib/constants';
import { compareSpreadsheets, CompareResult, formatCompareResult } from './compare-sheets';
import { compareFacts, formatFactsComparison } from '../lib/compare-facts';
import { readTruthFacts } from '../lib/truth-facts';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');

// The 5 Golden projects representative of the full dataset
const GOLDEN_PROJECTS = [
  { folder: '2026-067 201 GEORGIAN DR,BARRIE', label: '1. Georgian Dr, Barrie (Simple storm)' },
  { folder: '2026-068 HOLIDAY INN,TRENTON', label: '2. Holiday Inn, Trenton (Medium storm+san)' },
  { folder: '2026-021 MATTHEWS HANGER WATERLOO', label: '3. Matthews Hangar (Complex system)' },
  { folder: '2026-010 NEW ORILLIA E.S', label: '4. New Orillia E.S. (High density CBs)' },
  { folder: '2026-004 SHN CENTENNIAL EMERGENCY DEPARTMENT REDEVELOPMENT', label: '5. SHN Centennial (Site specials)' }
];

const PDF_BLOCKLIST = [
  'quote', 'quotation', 'schedule', 'bid', 'geotechnical', 'geotech',
  'report', 'proposal', 'estimate', 'pricing', 'breakdown', 'budget',
  'letter', 'backup', 'specifications', 'specs', 'rpt', 'contracting',
  'invoice', 'addendum', 'tender_form', 'tender form', 'tipp',
  'structural', 'architectural', 'hydrogeological', 'landscape',
  'cover sheet', 'appendix'
];

async function evaluateProject(folderName: string): Promise<CompareResult | null> {
  const projectDir = path.join(TRAINING_DIR, folderName);
  if (!fs.existsSync(projectDir)) {
    console.error(`❌ Project directory not found: ${folderName}`);
    return null;
  }

  const files = fs.readdirSync(projectDir);
  const pdfFiles = files.filter(f => {
    const name = f.toLowerCase();
    return name.endsWith('.pdf') && !PDF_BLOCKLIST.some(b => name.includes(b));
  });
  const xlsxFiles = files.filter(f => 
    f.toLowerCase().endsWith('.xlsx') && 
    !f.toLowerCase().includes('eval_run_') &&
    !f.toLowerCase().includes('backup') &&
    !f.toLowerCase().includes('quote') &&
    !f.toLowerCase().includes('sand') &&
    !f.toLowerCase().includes('budget')
  );

  if (pdfFiles.length === 0 || xlsxFiles.length === 0) {
    console.warn(`⚠️ Skipping ${folderName}: missing PDF or XLSX`);
    return null;
  }

  // Sort PDFs by relevance
  const scorePDF = (filename: string): number => {
    const name = filename.toLowerCase();
    let score = 0;
    if (name.includes('civil') || name.includes('servicing') || name.includes('drainage') || name.includes('plan') || name.includes('pnp') || name.includes('storm') || name.includes('sewer') || name.includes('water')) {
      score += 1000;
    }
    if (name.includes('detail') || name.includes('det-') || name.includes('notes')) {
      score -= 200;
    }
    return score;
  };

  const sortedPdfs = pdfFiles.sort((a, b) => {
    const scoreA = scorePDF(a);
    const scoreB = scorePDF(b);
    if (scoreA !== scoreB) return scoreB - scoreA;
    const sizeA = fs.statSync(path.join(projectDir, a)).size;
    const sizeB = fs.statSync(path.join(projectDir, b)).size;
    return sizeB - sizeA;
  });

  const truthPath = path.join(projectDir, xlsxFiles[0]);

  try {
    // Read ALL drawing PDF buffers
    const pdfBuffers: Buffer[] = [];
    let totalSizeMB = 0;
    for (const pdf of sortedPdfs) {
      const buf = fs.readFileSync(path.join(projectDir, pdf));
      totalSizeMB += buf.length / 1024 / 1024;
      pdfBuffers.push(buf);
    }

    console.log(`   [evaluate-golden] Processing ${pdfBuffers.length} PDFs (${totalSizeMB.toFixed(1)} MB total):`);
    sortedPdfs.forEach((f, i) => console.log(`     ${i + 1}. ${f}`));
    
    // Extract physical facts, then apply deterministic costing
    const facts = await extractFromPDF(pdfBuffers, folderName);
    const result = priceTakeoff(facts);

    // Populate standard spreadsheet template
    const genBuffer = await populateTemplate(result, DEFAULT_PARAMS as any);

    const genDir = path.join(projectDir, 'generated_spreadsheets');
    if (!fs.existsSync(genDir)) fs.mkdirSync(genDir);

    const genFilename = `eval_run_golden_${Date.now()}.xlsx`;
    const genPath = path.join(genDir, genFilename);
    fs.writeFileSync(genPath, genBuffer);

    // Redesigned extraction metric: score facts vs ground truth (model-only signal)
    try {
      const truthFacts = await readTruthFacts(truthPath, folderName);
      console.log(formatFactsComparison(compareFacts(facts, truthFacts)));
    } catch (e: any) {
      console.warn(`   [evaluate-golden] facts metric skipped: ${e.message}`);
    }

    // Legacy cell-level comparison of the priced sheet (costing + extraction mixed)
    const compareResult = await compareSpreadsheets(truthPath, genPath, folderName);

    // Save and print detailed discrepancies
    const diffReport = formatCompareResult(compareResult);
    const diffPath = path.join(genDir, genFilename.replace('.xlsx', '_diff.txt'));
    fs.writeFileSync(diffPath, diffReport);

    console.log(`\n🔍 Cell-Level Discrepancy Log (Saved to: ${path.basename(diffPath)}):`);
    for (const report of compareResult.reports) {
      if (report.totalCells > 0) {
        const acc = ((report.matchingCells / report.totalCells) * 100).toFixed(1);
        console.log(`   📊 ${report.sectionLabel}: ${acc}% (${report.matchingCells}/${report.totalCells})`);
        if (report.diffs.length > 0) {
          console.log(`      ❌ ${report.diffs.length} mismatches:`);
          for (const d of report.diffs.slice(0, 15)) {
            const errStr = d.pctError !== undefined ? ` (${d.pctError.toFixed(1)}% err)` : '';
            console.log(`         Row ${d.row} [${d.colName}]: truth="${d.truthValue}" vs gen="${d.genValue}"${errStr}`);
          }
          if (report.diffs.length > 15) {
            console.log(`         ... and ${report.diffs.length - 15} more`);
          }
        }
      }
    }
    console.log('');

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

    // Rate limit throttling - pause 10s between projects to respect API quotas
    if (i < GOLDEN_PROJECTS.length - 1) {
      console.log(`   ⏳ Waiting 10s to respect API rate limits...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
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
