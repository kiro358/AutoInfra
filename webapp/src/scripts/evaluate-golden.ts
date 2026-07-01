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
import { compareFacts, formatFactsComparison, FactsComparison } from '../lib/compare-facts';
import { readTruthFacts } from '../lib/truth-facts';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');

// Golden set: 12 projects with verified standard-template ground truth, spanning
// simple storm -> complex -> multi-PDF. A larger set reduces run-to-run variance so
// real changes are visible above noise. Override count with GOLDEN_REPEATS to average.
const GOLDEN_PROJECTS = [
  { folder: '2026-067 201 GEORGIAN DR,BARRIE', label: 'Georgian Dr, Barrie (simple storm)' },
  { folder: '2026-068 HOLIDAY INN,TRENTON', label: 'Holiday Inn, Trenton (storm+san)' },
  { folder: '2026-021 MATTHEWS HANGER WATERLOO', label: 'Matthews Hangar (complex)' },
  { folder: '2026-010 NEW ORILLIA E.S', label: 'New Orillia E.S. (dense CBs)' },
  { folder: '2026-004 SHN CENTENNIAL EMERGENCY DEPARTMENT REDEVELOPMENT', label: 'SHN Centennial (site specials)' },
  { folder: '2026-001 ECOLE SECONDAIRE CATHOLIQUE-BRAMPTON', label: 'Ecole Secondaire, Brampton' },
  { folder: '2026-002 BRADFORD WEST GWILLIMBURY CIVIC CENTRE', label: 'Bradford Civic Centre' },
  { folder: '2026-006 OAKVILLE FIRE HALL 9', label: 'Oakville Fire Hall 9' },
  { folder: '2026-015 UXBRIDGE POOL SPRUNG', label: 'Uxbridge Pool Sprung' },
  { folder: '2026-033 MILTON # 13 ELEMENTARY SCHOOL', label: 'Milton #13 Elementary' },
  { folder: '2026-050 PANATTONI-6500 MISSISSAUGA ROAD', label: 'Panattoni 6500 Mississauga (multi-PDF)' },
  { folder: '2026-060 PROPOSED COMMERCIAL DEVELOPMENT', label: 'Proposed Commercial Development' },
];

// Clear non-drawing documents — always excluded, even if also tagged "civil".
const PDF_HARD_EXCLUDE = [
  'quote', 'quotation', 'geotechnical', 'geotech', 'proposal', 'estimate',
  'pricing', 'breakdown', 'budget', 'letter', 'backup', 'invoice', 'addendum',
  'bid form', 'tender_form', 'tender form', 'tipp', 'report', 'rpt', 'contracting',
  'specifications', 'specs', 'structural', 'architectural', 'hydrogeological',
  'landscape', 'electrical', 'mechanical', 'cover sheet',
];

// Civil/servicing drawing hints — these win even if the filename also contains a
// blocklist-ish word like "appendix" (e.g. "Appendix 1.00 AMCAI Civil Plan Set").
const PDF_CIVIL_HINTS = [
  'civil', 'servicing', 'drainage', 'plan', 'pnp', 'plan and profile',
  'plan & profile', 'storm', 'sewer', 'watermain', 'grading', 'site',
];

/** Allowlist-first PDF selection: prefer civil drawing sets, fall back to anything not hard-excluded. */
function selectDrawingPdfs(pdfNames: string[]): string[] {
  const notExcluded = pdfNames.filter(f => {
    const n = f.toLowerCase();
    return !PDF_HARD_EXCLUDE.some(b => n.includes(b));
  });
  const civil = notExcluded.filter(f => {
    const n = f.toLowerCase();
    return PDF_CIVIL_HINTS.some(c => n.includes(c));
  });
  return civil.length > 0 ? civil : notExcluded;
}

interface ProjectResult { cell: CompareResult | null; facts: FactsComparison | null; }

async function evaluateProject(folderName: string): Promise<ProjectResult> {
  const projectDir = path.join(TRAINING_DIR, folderName);
  if (!fs.existsSync(projectDir)) {
    console.error(`❌ Project directory not found: ${folderName}`);
    return { cell: null, facts: null };
  }

  const files = fs.readdirSync(projectDir);
  const pdfFiles = selectDrawingPdfs(files.filter(f => f.toLowerCase().endsWith('.pdf')));
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
    return { cell: null, facts: null };
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
    let factsCmp: FactsComparison | null = null;
    try {
      const truthFacts = await readTruthFacts(truthPath, folderName);
      factsCmp = compareFacts(facts, truthFacts);
      console.log(formatFactsComparison(factsCmp));
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

    return { cell: compareResult, facts: factsCmp };
  } catch (e: any) {
    console.error(`❌ Error evaluating project ${folderName}:`, e.message);
    return { cell: null, facts: null };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (x: number) => (x * 100).toFixed(0) + '%';

// Compact per-project result, persisted so a run killed mid-way (e.g. machine
// sleep) can resume with GOLDEN_RESUME=true instead of re-extracting everything.
interface Summary {
  folder: string;
  label: string;
  detF1: number | null; // mean across repeats
  structM: number; structT: number;
  runM: number; runT: number;
  fieldM: number; fieldT: number;
  cellAcc: number | null;
}

const RESULTS_FILE = path.resolve(__dirname, '../../..', 'golden-results.json');
const loadResults = (): Record<string, Summary> => {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch { return {}; }
};
const saveResults = (all: Record<string, Summary>) => {
  try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(all, null, 2)); } catch {}
};

function buildSummary(folder: string, label: string, detF1s: number[], facts: FactsComparison | null, cell: CompareResult | null): Summary {
  const st = facts?.entities.find((e) => e.kind === 'structures') ?? null;
  const sw = facts?.entities.find((e) => e.kind === 'sewerRuns') ?? null;
  let fieldM = 0, fieldT = 0;
  if (facts) for (const f of facts.fields) { fieldM += f.matched; fieldT += f.total; }
  return {
    folder, label,
    detF1: detF1s.length ? detF1s.reduce((a, b) => a + b, 0) / detF1s.length : null,
    structM: st?.matched ?? 0, structT: st?.truthCount ?? 0,
    runM: sw?.matched ?? 0, runT: sw?.truthCount ?? 0,
    fieldM, fieldT,
    cellAcc: cell ? cell.overallAccuracy : null,
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                 AutoInfra GOLDEN EVALUATION                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const REPEATS = Math.max(1, Number(process.env.GOLDEN_REPEATS || '1'));
  const RESUME = process.env.GOLDEN_RESUME === 'true';
  console.log(`Evaluating ${GOLDEN_PROJECTS.length} projects × ${REPEATS} run(s)${RESUME ? ' (resume: skipping cached)' : ' (fresh)'}.`);
  console.log(`Progress cache: ${RESULTS_FILE}\n`);

  const startTime = Date.now();
  const all = RESUME ? loadResults() : {};
  if (!RESUME) saveResults(all); // fresh baseline clears prior cache

  for (let i = 0; i < GOLDEN_PROJECTS.length; i++) {
    const p = GOLDEN_PROJECTS[i];
    if (RESUME && all[p.folder]) {
      const c = all[p.folder];
      console.log(`[${i + 1}/${GOLDEN_PROJECTS.length}] ${p.label} — cached (detF1 ${c.detF1 != null ? pct(c.detF1) : 'ERR'}), skipping.`);
      continue;
    }
    const detF1s: number[] = [];
    let lastFacts: FactsComparison | null = null;
    let lastCell: CompareResult | null = null;
    for (let r = 0; r < REPEATS; r++) {
      console.log(`\n------------------------------------------------------------`);
      console.log(`[${i + 1}/${GOLDEN_PROJECTS.length}]${REPEATS > 1 ? ` run ${r + 1}/${REPEATS}` : ''} ${p.label}...`);
      const res = await evaluateProject(p.folder);
      if (res.facts) { detF1s.push(res.facts.detectionF1); lastFacts = res.facts; }
      if (res.cell) lastCell = res.cell;
      console.log(`   → cell ${res.cell ? res.cell.overallAccuracy.toFixed(1) + '%' : 'ERR'} | detF1 ${res.facts ? pct(res.facts.detectionF1) : 'ERR'}`);
      await sleep(6000);
    }
    all[p.folder] = buildSummary(p.folder, p.label, detF1s, lastFacts, lastCell);
    saveResults(all); // persist after each project so a kill is resumable
  }

  const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);

  // ---------- FACTS SCOREBOARD (primary, model-only signal) ----------
  console.log('\n' + '='.repeat(92));
  console.log('  EXTRACTION FACTS SCOREBOARD  (entity detection F1 + field accuracy)');
  console.log('='.repeat(92));
  console.log('Project'.padEnd(42) + '│ detF1 │ struct m/T │ runs m/T │ fieldAcc');
  console.log('─'.repeat(92));

  let sumDet = 0, nDet = 0, structM = 0, structT = 0, runM = 0, runT = 0, fieldM = 0, fieldT = 0, cellSum = 0, cellN = 0;
  for (const p of GOLDEN_PROJECTS) {
    const s = all[p.folder];
    if (!s) { console.log(p.label.slice(0, 40).padEnd(42) + '│ (not run)'); continue; }
    const detCell = s.detF1 != null ? pct(s.detF1) : 'ERR';
    console.log(
      p.label.slice(0, 40).padEnd(42) +
      `│ ${detCell.padEnd(5)} │ ${`${s.structM}/${s.structT}`.padEnd(10)} │ ${`${s.runM}/${s.runT}`.padEnd(8)} │ ${s.fieldT ? Math.round(s.fieldM / s.fieldT * 100) + '%' : '–'}`
    );
    if (s.detF1 != null) { sumDet += s.detF1; nDet++; }
    structM += s.structM; structT += s.structT; runM += s.runM; runT += s.runT; fieldM += s.fieldM; fieldT += s.fieldT;
    if (s.cellAcc != null) { cellSum += s.cellAcc; cellN++; }
  }
  console.log('─'.repeat(92));
  console.log(`  Mean detection F1: ${nDet ? (sumDet / nDet * 100).toFixed(1) : '0'}%   `
    + `structures ${structM}/${structT} (${structT ? Math.round(structM / structT * 100) : 0}%)   `
    + `runs ${runM}/${runT} (${runT ? Math.round(runM / runT * 100) : 0}%)   `
    + `field acc ${fieldT ? Math.round(fieldM / fieldT * 100) : 0}%`);
  console.log(`  Legacy cell-accuracy (mixed): ${cellN ? (cellSum / cellN).toFixed(1) : '0'}%`);
  console.log(`  ${nDet}/${GOLDEN_PROJECTS.length} projects scored${elapsedMin !== '0.0' ? ` in ${elapsedMin} min` : ' (cached)'}`);
  console.log('='.repeat(92) + '\n');
}

if (require.main === module) {
  main().catch(console.error);
}
