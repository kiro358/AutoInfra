/**
 * score-manual-facts.ts — ceiling-calibration harness (see EVAL_METHODOLOGY.md
 * "Measuring the ceiling").
 *
 * The ground-truth workbooks encode an estimator's stylistic conventions (CB-lead
 * grouping, label styles, scope choices), so the facts-level detF1 metric has an
 * unknown per-project ceiling below 100%. To find that ceiling, a human transcribes
 * a project's drawing PDFs by hand into the same TakeoffFacts JSON the LLM produces
 * (never looking at the truth workbook), and this script scores that transcription
 * against the same resolved truth used by evaluate-golden.ts — reusing compareFacts
 * exactly, so the number is directly comparable to the model's detF1.
 *
 * No LLM calls. Pure local file I/O + the existing comparison logic.
 *
 * Usage:
 *   npm run score:manual -- --init "<project folder name>"   # write manual_facts.json skeleton
 *   npm run score:manual -- "<project folder name>"           # score the filled-in skeleton
 */
import fs from 'fs';
import path from 'path';
import { compareFacts, formatFactsComparison, matchSewerRuns, normalizeLabel } from '../lib/compare-facts';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { TakeoffFacts, StructureFact, SewerFact } from '../lib/types';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');
const TRUTH_MANIFEST = loadTruthManifest(path.resolve(__dirname, '../../..', 'truth-manifest.json'));
const MANUAL_FILENAME = 'manual_facts.json';

// ---------------------------------------------------------------------------
// Pure diff logic (unit-tested in score-manual-facts.test.ts).
// ---------------------------------------------------------------------------

// Truth values sourced from xlsx cell arithmetic can carry float noise (e.g.
// 2.7099999999999795); round for display only — comparisons elsewhere use the
// raw numbers untouched.
const round2 = (n: number): number => Math.round(n * 100) / 100;

function formatStructure(s: StructureFact): string {
  const dims: string[] = [];
  if (s.pipeOutDiameter != null) dims.push(`${round2(s.pipeOutDiameter)}mm out`);
  if (s.depth != null) dims.push(`${round2(s.depth)}m deep`);
  return dims.length ? `${s.description} (${dims.join(', ')})` : s.description;
}

function formatRun(s: SewerFact): string {
  const dims: string[] = [];
  if (s.length != null) dims.push(`${round2(s.length)}m`);
  if (s.pipeDiameter != null) dims.push(`${round2(s.pipeDiameter)}mm`);
  return dims.length ? `${s.runLabel} (${dims.join('/')})` : s.runLabel;
}

/**
 * Every truth structure/run not matched in pred ("MISSED") and every pred
 * structure/run not matched in truth ("EXTRA"), using the SAME matching logic
 * compareFacts uses (matchSewerRuns for runs, normalized-label matching for
 * structures) so the diff always agrees with the reported detection F1.
 */
export function diffEntities(pred: TakeoffFacts, truth: TakeoffFacts): { missed: string[]; extra: string[] } {
  const missed: string[] = [];
  const extra: string[] = [];

  // Structures: normalized-label multiset matching (mirrors matchByKey in compare-facts.ts).
  const predByLabel = new Map<string, StructureFact[]>();
  for (const p of pred.structures) {
    const k = normalizeLabel(p.description);
    if (!k) continue;
    const bucket = predByLabel.get(k);
    if (bucket) bucket.push(p);
    else predByLabel.set(k, [p]);
  }
  const usedPred = new Set<StructureFact>();
  for (const t of truth.structures) {
    const k = normalizeLabel(t.description);
    const bucket = predByLabel.get(k);
    if (bucket && bucket.length > 0) {
      usedPred.add(bucket.shift()!);
    } else {
      missed.push(`structure ${formatStructure(t)}`);
    }
  }
  for (const p of pred.structures) {
    if (!usedPred.has(p)) extra.push(`structure ${formatStructure(p)}`);
  }

  // Sewer runs: reuse compareFacts' own matcher (endpoint signature + attribute
  // fallbacks) so the diff is consistent with the scored detF1.
  const predRuns = pred.sewers.filter((s) => !s.isLineItem);
  const truthRuns = truth.sewers.filter((s) => !s.isLineItem);
  const { pairs } = matchSewerRuns(predRuns, truthRuns);
  const matchedPred = new Set(pairs.map((x) => x.p));
  const matchedTruth = new Set(pairs.map((x) => x.t));
  for (const t of truthRuns) {
    if (!matchedTruth.has(t)) missed.push(`run ${formatRun(t)}`);
  }
  for (const p of predRuns) {
    if (!matchedPred.has(p)) extra.push(`run ${formatRun(p)}`);
  }

  return { missed, extra };
}

// ---------------------------------------------------------------------------
// CLI shell.
// ---------------------------------------------------------------------------

function emptyFacts(projectName: string): TakeoffFacts {
  return {
    projectName,
    jobNumber: '',
    date: '',
    structures: [],
    catchbasins: [],
    sewers: [],
    watermain: [],
    watermainSpecials: [],
    watermainValves: [],
    confidence: 1,
    warnings: [],
  };
}

async function runInit(folder: string): Promise<void> {
  const projectDir = path.join(TRAINING_DIR, folder);
  if (!fs.existsSync(projectDir)) {
    console.error(`❌ Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  const manualPath = path.join(projectDir, MANUAL_FILENAME);
  if (fs.existsSync(manualPath)) {
    console.error(`❌ Refusing to overwrite existing ${manualPath}`);
    process.exit(1);
  }

  const resolvedTruth = await resolveTruthFacts(projectDir, folder, TRUTH_MANIFEST);
  if (!resolvedTruth) {
    console.error(`❌ No usable ground-truth workbook for ${folder} (excluded or none found) — cannot report expected counts.`);
    process.exit(1);
  }

  const t = resolvedTruth.facts;
  const structCount = t.structures.length;
  const runCount = t.sewers.filter((s) => !s.isLineItem).length;
  const cbCount = t.catchbasins.length;
  const wmCount = t.watermain.length;

  const instructions = [
    `Transcribe from the drawing PDFs only for "${folder}". Truth has ${structCount} structures / ${runCount} runs / ${cbCount} CB groups / ${wmCount} watermain — do NOT copy from the truth workbook.`,
    'structures[]: one entry per manhole/structure labeled on the drawing. description = the label as drawn (e.g. "MH 1"). topElevation/lowInvert/highInvert/pipeOutDiameter/depth are optional physical values — leave null if not shown.',
    'sewers[]: one entry per pipe run (storm or sanitary) between structures. runLabel = "FROM-TO" as labeled (or the dimension callout if no endpoint labels are shown). length (m), pipeDiameter (mm), typeClass, slope, depth as read off the drawing/legend. isLineItem should stay false — it is for non-pipe fee rows, which do not appear on drawings.',
    'catchbasins[]: one entry PER TYPE actually present on the drawing — type is one of SINGLE_CB / DOUBLE_CB / DITCH_INLET_CB / DOUBLE_DITCH_INLET_CB — with quantity = the total count of that type.',
    'watermain[]: one entry per watermain run. sizeAndType = the size/material label (e.g. "150mm PVC"), length (m), pipeDiameter (mm).',
    'Leave watermainSpecials/watermainValves empty — not required for ceiling calibration.',
  ].join('\n');

  const skeleton = { ...emptyFacts(folder), _instructions: instructions };
  fs.writeFileSync(manualPath, JSON.stringify(skeleton, null, 2) + '\n');
  console.log(`✅ Wrote skeleton: ${manualPath}`);
  console.log(`   Truth: ${structCount} structures / ${runCount} runs / ${cbCount} CB groups / ${wmCount} watermain`);
  console.log('   Fill it in by hand from the drawing PDFs, then run:');
  console.log(`   npm run score:manual -- "${folder}"`);
}

async function runScore(folder: string): Promise<void> {
  const projectDir = path.join(TRAINING_DIR, folder);
  if (!fs.existsSync(projectDir)) {
    console.error(`❌ Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  const manualPath = path.join(projectDir, MANUAL_FILENAME);
  if (!fs.existsSync(manualPath)) {
    console.error(`❌ No ${MANUAL_FILENAME} found in ${projectDir}. Run "npm run score:manual -- --init \\"${folder}\\"" first.`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(manualPath, 'utf8'));
  delete raw._instructions;
  const pred = raw as TakeoffFacts;

  const resolvedTruth = await resolveTruthFacts(projectDir, folder, TRUTH_MANIFEST);
  if (!resolvedTruth) {
    console.error(`❌ No usable ground-truth workbook for ${folder} (excluded or none found).`);
    process.exit(1);
  }

  const comparison = compareFacts(pred, resolvedTruth.facts);
  console.log(formatFactsComparison(comparison));

  const { missed, extra } = diffEntities(pred, resolvedTruth.facts);
  console.log('🔍 DIFF (structures + runs) — classify each as reading error vs. estimator convention');
  console.log('-'.repeat(60));
  if (missed.length === 0 && extra.length === 0) {
    console.log('  (no unmatched structures or runs)');
  } else {
    for (const m of missed) console.log(`  MISSED: ${m}`);
    for (const e of extra) console.log(`  EXTRA:  ${e}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--init') {
    const folder = args[1];
    if (!folder) {
      console.error('Usage: npm run score:manual -- --init "<project folder name>"');
      process.exit(1);
    }
    await runInit(folder);
    return;
  }

  const folder = args[0];
  if (!folder) {
    console.error('Usage: npm run score:manual -- "<project folder name>"');
    process.exit(1);
  }
  await runScore(folder);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
