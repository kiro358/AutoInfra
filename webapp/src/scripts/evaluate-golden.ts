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
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { chooseDrawingPdfs } from '../lib/dataset';
import { GOLDEN_PROJECTS, FOCUS_SET } from '../lib/golden-set';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');
const TRUTH_MANIFEST = loadTruthManifest(path.resolve(__dirname, '../../..', 'truth-manifest.json'));

interface ProjectResult { cell: CompareResult | null; facts: FactsComparison | null; cost?: { totalTokens: number; tiles: number; llmCalls: number; dpi: number } | null; }

async function evaluateProject(folderName: string): Promise<ProjectResult> {
  const projectDir = path.join(TRAINING_DIR, folderName);
  if (!fs.existsSync(projectDir)) {
    console.error(`❌ Project directory not found: ${folderName}`);
    return { cell: null, facts: null };
  }

  const pdfFiles = chooseDrawingPdfs(projectDir); // recursive: finds nested civil drawing sets

  // Robust ground-truth selection: manifest-driven (merge genuine site splits /
  // pin canonical file / exclude), else richest non-empty candidate. Replaces
  // the old readdir[0] pick, which landed on empty/partial decoys for several
  // projects. See truth-facts.ts::resolveTruthFacts.
  const resolvedTruth = await resolveTruthFacts(projectDir, folderName, TRUTH_MANIFEST);

  if (pdfFiles.length === 0 || !resolvedTruth) {
    console.warn(`⚠️ Skipping ${folderName}: missing PDF or no usable ground-truth workbook`);
    return { cell: null, facts: null };
  }
  const truthPath = path.join(projectDir, resolvedTruth.primary);
  if (resolvedTruth.sources.length > 1) {
    console.log(`   [evaluate-golden] Truth merged from ${resolvedTruth.sources.length} workbooks: ${resolvedTruth.sources.join(', ')}`);
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

    // Persist raw predicted facts so metric changes can be re-scored offline (no LLM).
    try { fs.writeFileSync(path.join(genDir, 'predicted_facts.json'), JSON.stringify(facts, null, 2)); } catch {}

    const genFilename = `eval_run_golden_${Date.now()}.xlsx`;
    const genPath = path.join(genDir, genFilename);
    fs.writeFileSync(genPath, genBuffer);

    // Redesigned extraction metric: score facts vs ground truth (model-only signal)
    let factsCmp: FactsComparison | null = null;
    try {
      factsCmp = compareFacts(facts, resolvedTruth.facts);
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

    return { cell: compareResult, facts: factsCmp, cost: facts.cost ?? null };
  } catch (e: any) {
    console.error(`❌ Error evaluating project ${folderName}:`, e.message);
    return { cell: null, facts: null };
  }
}

const pct = (x: number) => (x * 100).toFixed(0) + '%';

// Compact per-project result, persisted so a run killed mid-way (e.g. machine
// sleep) can resume with GOLDEN_RESUME=true instead of re-extracting everything.
interface Summary {
  folder: string;
  label: string;
  repeats: number;
  detF1: number | null;                 // mean across repeats
  detF1Lo: number | null; detF1Hi: number | null; // min/max across repeats (variance band)
  structM: number; structT: number;     // structM = mean matched across repeats
  runM: number; runT: number;           // runM = mean matched across repeats
  runMLo: number; runMHi: number;       // min/max matched runs (the noisiest metric)
  fieldM: number; fieldT: number;
  cellAcc: number | null;               // mean
}

// One repeat's metrics, so buildSummary can report mean + variance across repeats
// (single-run noise is large enough to swamp real changes — see REDESIGN §eval).
interface RepMetrics {
  detF1: number; structM: number; structT: number; runM: number; runT: number;
  structP: number; runP: number; // predicted counts (to detect empty/transport-failed repeats)
  fieldM: number; fieldT: number; cellAcc: number | null;
}
function factsToMetrics(facts: FactsComparison, cell: CompareResult | null): RepMetrics {
  const st = facts.entities.find((e) => e.kind === 'structures');
  const sw = facts.entities.find((e) => e.kind === 'sewerRuns');
  let fieldM = 0, fieldT = 0;
  for (const f of facts.fields) { fieldM += f.matched; fieldT += f.total; }
  return {
    detF1: facts.detectionF1,
    structM: st?.matched ?? 0, structT: st?.truthCount ?? 0,
    runM: sw?.matched ?? 0, runT: sw?.truthCount ?? 0,
    structP: st?.predCount ?? 0, runP: sw?.predCount ?? 0,
    fieldM, fieldT, cellAcc: cell ? cell.overallAccuracy : null,
  };
}

const RESULTS_FILE = path.resolve(__dirname, '../../..', 'golden-results.json');
const loadResults = (): Record<string, Summary> => {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch { return {}; }
};
const saveResults = (all: Record<string, Summary>) => {
  try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(all, null, 2)); } catch {}
};

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function buildSummary(folder: string, label: string, reps: RepMetrics[]): Summary {
  const det = reps.map((r) => r.detF1);
  const runs = reps.map((r) => r.runM);
  const cells = reps.map((r) => r.cellAcc).filter((x): x is number => x != null);
  return {
    folder, label, repeats: reps.length,
    detF1: mean(det),
    detF1Lo: Math.min(...det), detF1Hi: Math.max(...det),
    structM: mean(reps.map((r) => r.structM)), structT: reps[0].structT,
    runM: mean(runs), runT: reps[0].runT,
    runMLo: Math.min(...runs), runMHi: Math.max(...runs),
    fieldM: mean(reps.map((r) => r.fieldM)), fieldT: reps[0].fieldT,
    cellAcc: cells.length ? mean(cells) : null,
  };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                 AutoInfra GOLDEN EVALUATION                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const REPEATS = Math.max(1, Number(process.env.GOLDEN_REPEATS || '1'));
  const RESUME = process.env.GOLDEN_RESUME === 'true';
  const CONCURRENCY = Number(process.env.GOLDEN_CONCURRENCY) || 3;

  // Two-tier workflow: iterate on a small FOCUS set fast, then run the full set as a
  // regression gate. GOLDEN_FILTER=<substrings> runs an arbitrary subset; GOLDEN_FOCUS=true
  // uses the curated focus set (current run-extraction / high-variance problem projects).
  const rawFilter = process.env.GOLDEN_FILTER || (process.env.GOLDEN_FOCUS === 'true' ? FOCUS_SET.join(',') : '');
  const filters = rawFilter.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const projects = filters.length
    ? GOLDEN_PROJECTS.filter((p) => filters.some((f) => p.folder.toLowerCase().includes(f) || p.label.toLowerCase().includes(f)))
    : GOLDEN_PROJECTS;
  const N = projects.length;

  console.log(`Evaluating ${N}${filters.length ? `/${GOLDEN_PROJECTS.length} (filter: ${filters.join(', ')})` : ''} project(s) × ${REPEATS} run(s)${RESUME ? ' (resume)' : ''}, concurrency ${CONCURRENCY}.`);
  console.log(`Progress cache: ${RESULTS_FILE}\n`);

  const startTime = Date.now();
  const all = loadResults();                                  // preserve prior results (esp. non-filtered projects)
  if (!RESUME) projects.forEach((p) => delete all[p.folder]); // fresh: re-run only the selected ones

  const todo: { p: typeof GOLDEN_PROJECTS[number]; i: number }[] = [];
  projects.forEach((p, i) => {
    if (all[p.folder]) {
      console.log(`[${i + 1}/${N}] ${p.label} — cached (detF1 ${all[p.folder].detF1 != null ? pct(all[p.folder].detF1!) : 'ERR'}), skipping.`);
    } else {
      todo.push({ p, i });
    }
  });
  console.log(`Running ${todo.length} project(s).\n`);

  const costAgg = { tokens: 0, tiles: 0, calls: 0, extractions: 0, dpi: 0 };
  const runOne = async ({ p, i }: { p: typeof GOLDEN_PROJECTS[number]; i: number }) => {
    const reps: RepMetrics[] = [];
    for (let r = 0; r < REPEATS; r++) {
      console.log(`[${i + 1}/${N}]${REPEATS > 1 ? ` run ${r + 1}/${REPEATS}` : ''} ${p.label} — extracting...`);
      const res = await evaluateProject(p.folder);
      if (res.cost) { costAgg.tokens += res.cost.totalTokens; costAgg.tiles += res.cost.tiles; costAgg.calls += res.cost.llmCalls; costAgg.extractions++; costAgg.dpi = res.cost.dpi; }
      if (res.facts) reps.push(factsToMetrics(res.facts, res.cell));
      console.log(`   → ${p.label}${REPEATS > 1 ? ` r${r + 1}` : ''}: cell ${res.cell ? res.cell.overallAccuracy.toFixed(1) + '%' : 'ERR'} | detF1 ${res.facts ? pct(res.facts.detectionF1) : 'ERR'}`);
    }
    // A repeat that came back EMPTY while ground truth has data is a transport failure
    // (UND_ERR_SOCKET etc.), not a real 0 — drop those repeats and average the rest. Only
    // skip caching if EVERY repeat was empty (so a single transient blip doesn't discard a
    // project, and a later resume can retry a fully-failed one).
    const truthHasData = reps.length > 0 && (reps[0].structT > 0 || reps[0].runT > 0);
    const good = reps.filter((r) => r.structP + r.runP > 0);
    if (reps.length === 0 || (good.length === 0 && truthHasData)) {
      console.log(`   ⚠ ${p.label} returned nothing on all repeats (likely transport failure) — NOT caching; a resume will retry it.`);
      return;
    }
    all[p.folder] = buildSummary(p.folder, p.label, good.length ? good : reps);
    saveResults(all); // persist after each project so a kill is resumable
  };

  // Concurrency pool over the outstanding projects.
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, todo.length)) }, async () => {
    while (next < todo.length) { const idx = next++; await runOne(todo[idx]); }
  }));

  const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);

  // ---------- FACTS SCOREBOARD (primary, model-only signal) ----------
  const anyRepeats = projects.some((p) => (all[p.folder]?.repeats ?? 1) > 1);
  console.log('\n' + '='.repeat(96));
  console.log('  EXTRACTION FACTS SCOREBOARD' + (anyRepeats ? '  (mean across repeats; [lo–hi] = variance band)' : ''));
  console.log('='.repeat(96));
  console.log('Project'.padEnd(40) + `│ detF1${anyRepeats ? ' [band]   ' : '  '}│ struct m/T │ runs m/T${anyRepeats ? ' [band]' : ''}  │ field`);
  console.log('─'.repeat(96));

  let sumDet = 0, nDet = 0, structM = 0, structT = 0, runM = 0, runT = 0, fieldM = 0, fieldT = 0, cellSum = 0, cellN = 0;
  for (const p of projects) {
    const s = all[p.folder];
    if (!s) { console.log(p.label.slice(0, 38).padEnd(40) + '│ (not run)'); continue; }
    const det = (s.detF1 != null ? pct(s.detF1) : 'ERR') + (anyRepeats && s.detF1Lo != null ? ` [${pct(s.detF1Lo)}–${pct(s.detF1Hi!)}]` : '');
    const runsCell = `${s.repeats > 1 ? s.runM.toFixed(1) : Math.round(s.runM)}/${s.runT}` + (anyRepeats ? ` [${s.runMLo}–${s.runMHi}]` : '');
    console.log(
      p.label.slice(0, 38).padEnd(40) +
      `│ ${det.padEnd(anyRepeats ? 14 : 5)} │ ${`${Math.round(s.structM)}/${s.structT}`.padEnd(10)} │ ${runsCell.padEnd(anyRepeats ? 14 : 8)} │ ${s.fieldT ? Math.round(s.fieldM / s.fieldT * 100) + '%' : '–'}`
    );
    if (s.detF1 != null) { sumDet += s.detF1; nDet++; }
    structM += s.structM; structT += s.structT; runM += s.runM; runT += s.runT; fieldM += s.fieldM; fieldT += s.fieldT;
    if (s.cellAcc != null) { cellSum += s.cellAcc; cellN++; }
  }
  console.log('─'.repeat(96));
  console.log(`  Mean detection F1: ${nDet ? (sumDet / nDet * 100).toFixed(1) : '0'}%   `
    + `structures ${Math.round(structM)}/${structT} (${structT ? Math.round(structM / structT * 100) : 0}%)   `
    + `runs ${runM.toFixed(1)}/${runT} (${runT ? Math.round(runM / runT * 100) : 0}%)   `
    + `field acc ${fieldT ? Math.round(fieldM / fieldT * 100) : 0}%`);
  console.log(`  Legacy cell-accuracy (mixed): ${cellN ? (cellSum / cellN).toFixed(1) : '0'}%`);
  console.log(`  ${nDet}/${N} projects scored${elapsedMin !== '0.0' ? ` in ${elapsedMin} min` : ' (cached)'}${anyRepeats ? ` × ${REPEATS} repeats` : ''}`);
  if (costAgg.extractions > 0) {
    const per = (n: number) => (n / costAgg.extractions);
    console.log(`  COST @${costAgg.dpi}dpi: ${(costAgg.tokens / 1e6).toFixed(2)}M tokens, ${costAgg.tiles} tiles, ${costAgg.calls} LLM calls over ${costAgg.extractions} extraction(s)`
      + ` — avg ${Math.round(per(costAgg.tokens) / 1000)}k tok / ${per(costAgg.tiles).toFixed(1)} tiles per extraction`);
  }
  console.log('='.repeat(96) + '\n');
}

if (require.main === module) {
  main().catch(console.error);
}
