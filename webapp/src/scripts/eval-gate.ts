/**
 * eval-gate.ts — automated regression gate for the deterministic eval layers.
 *
 * Formalizes the acceptance rule from EVAL_METHODOLOGY.md ("accept only if
 * the aggregate clears the band AND no project regresses beyond its band")
 * for the $0 text-layer path, so it can run unattended instead of relying on
 * a human eyeballing the evaluate:text table. See eval-results/README.md.
 *
 * What it does:
 *   1. Runs the same computation as evaluate-text.ts (extractPageText →
 *      assembleTextTakeoff → compareFacts vs manifest truth) for every golden
 *      project, capturing per-project detection F1 + field accuracy (not just
 *      the single printed textF1), plus the cached-LLM F1 when a
 *      generated_spreadsheets/predicted_facts.json exists (informational only —
 *      it never gates, because offline rescoring cannot see extraction changes;
 *      see EVAL_METHODOLOGY.md "What each $0 loop can and cannot prove").
 *   2. Writes the full run to <repo root>/eval-results/<timestamp>.json.
 *   3. Compares against <repo root>/eval-results/baseline.json:
 *        FAIL (exit 1) if aggregate detection F1 or field accuracy drops by
 *          more than GATE_AGG_BAND_PTS points (default 0.5), or any single
 *          project's detection F1 drops by more than GATE_PROJECT_BAND_PTS
 *          points (default 2), or a project that scored in the baseline no
 *          longer scores.
 *        PASS (exit 0) otherwise. Exit 2 = gate could not run (no baseline and
 *          no --update-baseline, missing manifest, etc.).
 *   4. `--update-baseline` writes the current run as the new baseline (the
 *      "New baseline" step at the end of the methodology loop). The run JSON
 *      is still written, so history is preserved.
 *
 * Bands are in percentage POINTS (0–100 scale), mirroring the methodology's
 * noise-band language. The text path is deterministic, so in practice the band
 * absorbs dataset/manifest changes rather than model variance; for the future
 * LLM layer the same gate shape applies with GOLDEN_REPEATS-averaged inputs.
 *
 * Usage:
 *   npm run eval:gate                      # compare vs baseline
 *   npm run eval:gate -- --update-baseline # record current run as baseline
 *   GATE_AGG_BAND_PTS=1 npm run eval:gate  # widen the aggregate band
 */
import fs from 'fs';
import path from 'path';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { extractPageText, isTextyPage, PageText } from '../lib/pdf-text';
import { assembleTextTakeoff } from '../lib/text-takeoff';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { compareFacts } from '../lib/compare-facts';

const ROOT = path.resolve(__dirname, '../../..');
const DATA = path.join(ROOT, 'existing_projects_training_data');
const RESULTS_DIR = path.join(ROOT, 'eval-results');
const BASELINE_PATH = path.join(RESULTS_DIR, 'baseline.json');

const AGG_BAND = Number(process.env.GATE_AGG_BAND_PTS ?? 0.5);
const PROJECT_BAND = Number(process.env.GATE_PROJECT_BAND_PTS ?? 2);
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

interface ProjectResult {
  folder: string;
  label: string;
  status: 'scored' | 'no-texty-pages' | 'no-truth' | 'missing' | 'error';
  textyPages?: number;
  totalPages?: number;
  detectionF1?: number; // 0..100
  fieldAccuracy?: number; // 0..100
  llmCachedF1?: number | null; // informational
  error?: string;
}

interface GateRun {
  generatedAt: string;
  layer: 'text';
  projects: ProjectResult[];
  aggregate: {
    scoredProjects: number;
    detectionF1: number | null; // mean over scored projects, points
    fieldAccuracy: number | null; // matched-count-weighted mean, points
  };
}

async function runEval(): Promise<GateRun> {
  let manifest: Array<{ folder: string; drawingPdfs?: { name: string }[] }> = [];
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dataset-manifest.json'), 'utf8'));
  } catch (e: any) {
    console.error(`eval-gate: cannot read dataset-manifest.json (${e.message}). Run: npm run dataset:manifest`);
    process.exit(2);
  }
  const truthManifest = loadTruthManifest(path.join(ROOT, 'truth-manifest.json'));

  const projects: ProjectResult[] = [];
  let f1Sum = 0, f1N = 0, faWeighted = 0, faWeight = 0;

  for (const g of GOLDEN_PROJECTS) {
    const base: ProjectResult = { folder: g.folder, label: g.label, status: 'missing' };
    const entry = manifest.find((m) => m.folder === g.folder);
    const projectDir = path.join(DATA, g.folder);
    if (!entry || !fs.existsSync(projectDir)) {
      projects.push(base);
      continue;
    }
    try {
      const truth = await resolveTruthFacts(projectDir, g.folder, truthManifest);
      if (!truth) {
        projects.push({ ...base, status: 'no-truth' });
        continue;
      }

      let texty = 0, total = 0;
      const textyPages: PageText[] = [];
      for (const pdf of entry.drawingPdfs ?? []) {
        const p = path.join(projectDir, pdf.name);
        if (!fs.existsSync(p)) continue;
        const pages = await extractPageText(fs.readFileSync(p));
        total += pages.length;
        for (const pt of pages) {
          if (isTextyPage(pt)) { texty++; textyPages.push(pt); }
        }
      }

      let llmCachedF1: number | null = null;
      const pf = path.join(projectDir, 'generated_spreadsheets', 'predicted_facts.json');
      if (fs.existsSync(pf)) {
        try {
          const cached = JSON.parse(fs.readFileSync(pf, 'utf8'));
          llmCachedF1 = +(compareFacts(cached, truth.facts).detectionF1 * 100).toFixed(2);
        } catch { /* stale cache is informational only */ }
      }

      if (textyPages.length === 0) {
        projects.push({ ...base, status: 'no-texty-pages', textyPages: 0, totalPages: total, llmCachedF1 });
        continue;
      }

      const facts = assembleTextTakeoff(textyPages, g.folder);
      const cmp = compareFacts(facts, truth.facts);
      const detF1 = +(cmp.detectionF1 * 100).toFixed(2);
      const fldAcc = +(cmp.fieldAccuracy * 100).toFixed(2);
      const fldTotal = cmp.fields.reduce((a, f) => a + f.total, 0);
      f1Sum += detF1; f1N++;
      if (fldTotal > 0) { faWeighted += fldAcc * fldTotal; faWeight += fldTotal; }
      projects.push({
        ...base, status: 'scored', textyPages: texty, totalPages: total,
        detectionF1: detF1, fieldAccuracy: fldAcc, llmCachedF1,
      });
    } catch (e: any) {
      projects.push({ ...base, status: 'error', error: String(e?.message ?? e) });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    layer: 'text',
    projects,
    aggregate: {
      scoredProjects: f1N,
      detectionF1: f1N ? +(f1Sum / f1N).toFixed(2) : null,
      fieldAccuracy: faWeight ? +(faWeighted / faWeight).toFixed(2) : null,
    },
  };
}

function fmt(v: number | null | undefined): string {
  return v == null ? '  —  ' : v.toFixed(1).padStart(5);
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const run = await runEval();

  const stamp = run.generatedAt.replace(/[:.]/g, '-');
  const runPath = path.join(RESULTS_DIR, `${stamp}.json`);
  fs.writeFileSync(runPath, JSON.stringify(run, null, 2));
  console.log(`eval-gate: run written to ${path.relative(ROOT, runPath)}`);
  console.log(`eval-gate: ${run.aggregate.scoredProjects}/${run.projects.length} projects scored; ` +
    `aggregate detectionF1 ${fmt(run.aggregate.detectionF1)}  fieldAccuracy ${fmt(run.aggregate.fieldAccuracy)}`);

  if (UPDATE_BASELINE) {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(run, null, 2));
    console.log('eval-gate: baseline UPDATED (--update-baseline). PASS');
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('eval-gate: no baseline at eval-results/baseline.json. Seed one with: npm run eval:gate -- --update-baseline');
    process.exit(2);
  }
  const baseline: GateRun = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const baseByFolder = new Map(baseline.projects.map((p) => [p.folder, p]));

  const failures: string[] = [];
  const lines: string[] = [];
  lines.push(`\n  ${'project'.padEnd(30)} ${'base F1'.padStart(8)} ${'now F1'.padStart(8)} ${'ΔF1'.padStart(7)}  verdict`);
  for (const p of run.projects) {
    const b = baseByFolder.get(p.folder);
    if (!b) { lines.push(`  ${p.label.padEnd(30)} (new in current run)`); continue; }
    if (b.status === 'scored' && p.status !== 'scored') {
      failures.push(`${p.label}: scored in baseline, now ${p.status}`);
      lines.push(`  ${p.label.padEnd(30)} ${fmt(b.detectionF1).padStart(8)} ${'—'.padStart(8)} ${''.padStart(7)}  FAIL (no longer scores)`);
      continue;
    }
    if (b.status !== 'scored' || p.status !== 'scored') continue;
    const d = +(p.detectionF1! - b.detectionF1!).toFixed(2);
    const bad = d < -PROJECT_BAND;
    if (bad) failures.push(`${p.label}: detectionF1 ${b.detectionF1} -> ${p.detectionF1} (${d} pts, band ${PROJECT_BAND})`);
    lines.push(`  ${p.label.padEnd(30)} ${fmt(b.detectionF1).padStart(8)} ${fmt(p.detectionF1).padStart(8)} ${(d >= 0 ? '+' : '') + d.toFixed(1)}`.padEnd(62) + (bad ? '  FAIL' : '  ok'));
  }
  const aggChecks: Array<[string, number | null, number | null]> = [
    ['aggregate detectionF1', baseline.aggregate.detectionF1, run.aggregate.detectionF1],
    ['aggregate fieldAccuracy', baseline.aggregate.fieldAccuracy, run.aggregate.fieldAccuracy],
  ];
  for (const [name, b, n] of aggChecks) {
    if (b != null && n != null) {
      const d = +(n - b).toFixed(2);
      lines.push(`  ${name}: ${b.toFixed(1)} -> ${n.toFixed(1)} (${d >= 0 ? '+' : ''}${d.toFixed(1)} pts, band ${AGG_BAND})`);
      if (d < -AGG_BAND) failures.push(`${name} dropped ${d} pts (band ${AGG_BAND})`);
    }
  }
  console.log(lines.join('\n'));

  if (failures.length) {
    console.error(`\neval-gate: FAIL — ${failures.length} regression(s) beyond band:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\neval-gate: PASS — no regression beyond band.');
}

main().catch((e) => { console.error(e); process.exit(2); });
