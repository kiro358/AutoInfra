/**
 * score-offline.ts — re-score the golden set from CACHED predictions. Zero LLM calls.
 *
 * Every eval run persists each project's extraction to
 * `<project>/generated_spreadsheets/predicted_facts.json`. This script re-runs the
 * facts metric on those cached predictions against the resolved truth workbooks, so
 * metric/matching changes can be validated — and the accuracy dashboard refreshed —
 * without spending a Vertex run. See EVAL_METHODOLOGY.md (offline-first loop).
 *
 * It writes `golden-results-offline.json` (NOT `golden-results.json` — that file is
 * evaluate-golden.ts's own resume cache and must not be clobbered by a derived
 * artifact). The shape is evaluate-golden's Summary plus a per-entity breakdown and
 * a status flag, which is what the dashboard's richer views need.
 *
 * Usage:  npm run score:offline
 *         PREDICTIONS_DIR=/tmp/fresh npm run score:offline   # score an exported run
 */
import fs from 'fs';
import path from 'path';
import { compareFacts } from '../lib/compare-facts';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { GoldenRow, summarizePerformance } from '../lib/perf-summary';
import { TakeoffFacts } from '../lib/types';

const ROOT = path.resolve(__dirname, '../../..');
const TRUTH_DIR = path.join(ROOT, 'existing_projects_training_data');
const PRED_DIR = process.env.PREDICTIONS_DIR || TRUTH_DIR;
const OUT_FILE = path.join(ROOT, 'golden-results-offline.json');

async function main() {
  const manifest = loadTruthManifest(path.join(ROOT, 'truth-manifest.json'));
  const rows: GoldenRow[] = [];

  for (const p of GOLDEN_PROJECTS) {
    const predFile = path.join(PRED_DIR, p.folder, 'generated_spreadsheets', 'predicted_facts.json');
    if (!fs.existsSync(predFile)) {
      console.log(`  ${p.label.padEnd(36)} no prediction cached — skipped`);
      continue;
    }

    let pred: TakeoffFacts;
    try {
      pred = JSON.parse(fs.readFileSync(predFile, 'utf8'));
    } catch (e) {
      console.log(`  ${p.label.padEnd(36)} unreadable prediction: ${(e as Error).message}`);
      continue;
    }

    let truth: TakeoffFacts | undefined;
    try {
      truth = (await resolveTruthFacts(path.join(TRUTH_DIR, p.folder), p.folder, manifest))?.facts;
    } catch (e) {
      console.log(`  ${p.label.padEnd(36)} truth unreadable: ${(e as Error).message}`);
      continue;
    }
    if (!truth) {
      console.log(`  ${p.label.padEnd(36)} no truth workbook resolved — skipped`);
      continue;
    }

    const c = compareFacts(pred, truth);
    const ent = (k: string) => c.entities.find((e) => e.kind === k);
    const predTotal =
      pred.structures.length + pred.sewers.length + pred.catchbasins.length + pred.watermain.length;

    let fieldM = 0, fieldT = 0;
    for (const f of c.fields) { fieldM += f.matched; fieldT += f.total; }

    rows.push({
      folder: p.folder,
      label: p.label,
      repeats: 1,
      detF1: c.detectionF1,
      structM: ent('structures')?.matched ?? 0,
      structT: ent('structures')?.truthCount ?? 0,
      runM: ent('sewerRuns')?.matched ?? 0,
      runT: ent('sewerRuns')?.truthCount ?? 0,
      fieldM,
      fieldT,
      entities: c.entities.map((e) => ({
        kind: e.kind,
        matched: e.matched,
        truthCount: e.truthCount,
        predCount: e.predCount,
      })),
      // An extraction that produced nothing at all is a failed run, not a 0%-accurate
      // model — the dashboard reports those separately so they can't be read as accuracy.
      status: predTotal === 0 ? 'empty' : 'ok',
      totalTokens: pred.cost?.totalTokens ?? null,
    });

    const pctF1 = (c.detectionF1 * 100).toFixed(1).padStart(5);
    console.log(`  ${p.label.padEnd(36)} detF1 ${pctF1}%  ${predTotal === 0 ? '(EMPTY EXTRACTION)' : ''}`);
  }

  const summary = summarizePerformance(rows);
  const payload = {
    _meta: {
      source: 'offline-rescore',
      generatedAt: new Date().toISOString(),
      predictionsDir: PRED_DIR === TRUTH_DIR ? 'training-data (in place)' : PRED_DIR,
      note: 'Recomputed from cached predicted_facts.json — no LLM calls. See score-offline.ts.',
    },
    rows: Object.fromEntries(rows.map((r) => [r.folder, r])),
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  console.log(`\n=== GOLDEN SET, offline rescore (${rows.length} projects with cached predictions) ===`);
  console.log(`  mean detF1 (scored runs only)  ${pct(summary.meanDetF1)}   over ${summary.projectsScored} projects`);
  console.log(`  mean detF1 (failures as zero)  ${pct(summary.meanDetF1WithFailures)}   over ${summary.projectsTotal} projects`);
  console.log(`  mean field accuracy            ${pct(summary.meanFieldAcc)}`);
  if (summary.projectsFailed) console.log(`  failed extractions             ${summary.projectsFailed} (no entities returned)`);
  console.log('\n  ENTITY          recall  precision      F1   truth   pred');
  for (const e of summary.entities) {
    console.log(
      '  ' + e.kind.padEnd(15) +
      pct(e.recall).padStart(6) + pct(e.precision).padStart(11) + pct(e.f1).padStart(8) +
      String(e.truth).padStart(8) + String(e.pred).padStart(7)
    );
  }
  if (summary.scaleSplit) {
    const s = summary.scaleSplit;
    console.log(`\n  by drawing size: <${s.threshold} entities ${pct(s.smallMean)}   vs   >=${s.threshold} entities ${pct(s.largeMean)}`);
  }
  console.log(`\nWrote ${OUT_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
