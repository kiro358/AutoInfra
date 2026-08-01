/**
 * analyze-eval.ts — turn a set of predictions into a holistic ERROR DECOMPOSITION,
 * so we can hunt systematic bugs/blunders OFFLINE (free) instead of guessing between
 * expensive eval runs. This is the "measure the ruler, find the mass of the error"
 * tool: run it after any eval that left generated_spreadsheets/predicted_facts.json
 * (locally, or exported from the VM — see build:dataset / the eval VM startup).
 *
 * It reports, aggregated across the golden set:
 *   - per-entity precision / recall / F1 + pred/truth ratio  → over- vs under-extraction
 *   - field accuracy by field                                → which values are wrong
 *   - per-project entity recall                              → which projects fail
 *   - unmatched-truth samples                                → normalization/recall patterns
 *   - flags: stuck-at-0, extreme over/under-extraction, watermain false positives
 *
 * Usage:  npm run analyze:eval            (reads existing_projects_training_data/…/predicted_facts.json)
 *         PREDICTIONS_DIR=/path npm run analyze:eval   (reads exported predictions)
 */
import fs from 'fs';
import path from 'path';
import { compareFacts, normalizeLabel } from '../lib/compare-facts';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { TakeoffFacts } from '../lib/types';

// Truth xlsx always come from the canonical training dir; predictions can come from a
// separate dir (e.g. a fresh export overlaid to a scratch dir) via PREDICTIONS_DIR. This
// keeps analysis non-destructive — no need to overwrite local predicted_facts.
const TRUTH_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');
const TRUTH_MANIFEST = loadTruthManifest(path.resolve(__dirname, '../../..', 'truth-manifest.json'));
const PRED_DIR = process.env.PREDICTIONS_DIR || TRUTH_DIR;

// Import the golden set rather than scraping evaluate-golden.ts for `folder: '...'`
// literals — that regex silently returned [] (→ "0 projects analyzed") once the list
// moved into golden-set.ts. golden-set.ts is the canonical definition; use it.
function goldenFolders(): string[] {
  return GOLDEN_PROJECTS.map((p) => p.folder);
}

async function main() {
  const folders = goldenFolders();
  const kinds = ['structures', 'sewerRuns', 'catchbasins', 'watermainRuns'] as const;
  const agg: Record<string, { m: number; t: number; p: number }> = {};
  for (const k of kinds) agg[k] = { m: 0, t: 0, p: 0 };
  const fieldAgg: Record<string, { m: number; t: number }> = {};
  const perProject: { label: string; runsR: number; structR: number }[] = [];
  const unmatchedStruct: string[] = [];
  let wmFP = 0, analyzed = 0, missing = 0;

  for (const f of folders) {
    const pf = path.join(PRED_DIR, f, 'generated_spreadsheets', 'predicted_facts.json');
    if (!fs.existsSync(pf)) { missing++; continue; }
    const pred = JSON.parse(fs.readFileSync(pf, 'utf8')) as TakeoffFacts;
    const dir = path.join(TRUTH_DIR, f);
    let truth: TakeoffFacts;
    try {
      const resolved = await resolveTruthFacts(dir, f, TRUTH_MANIFEST);
      if (!resolved) { missing++; continue; }
      truth = resolved.facts;
    } catch { missing++; continue; }

    const c = compareFacts(pred, truth);
    analyzed++;
    for (const e of c.entities) if (agg[e.kind]) { agg[e.kind].m += e.matched; agg[e.kind].t += e.truthCount; agg[e.kind].p += e.predCount; }
    for (const fl of c.fields) { (fieldAgg[fl.field] ??= { m: 0, t: 0 }); fieldAgg[fl.field].m += fl.matched; fieldAgg[fl.field].t += fl.total; }
    const sw = c.entities.find((e) => e.kind === 'sewerRuns'), st = c.entities.find((e) => e.kind === 'structures');
    perProject.push({ label: f.replace(/^2026-\d+ /, '').slice(0, 26), runsR: sw?.recall ?? 0, structR: st?.recall ?? 0 });
    if (truth.watermain.length === 0 && pred.watermain.length > 0) wmFP += pred.watermain.length;
    const pn = new Map<string, number>();
    for (const p of pred.structures) { const k = normalizeLabel(p.description); pn.set(k, (pn.get(k) || 0) + 1); }
    for (const t of truth.structures) { const k = normalizeLabel(t.description); if ((pn.get(k) || 0) > 0) pn.set(k, pn.get(k)! - 1); else unmatchedStruct.push(t.description); }
  }

  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  console.log(`\n=== ERROR DECOMPOSITION (${analyzed} projects analyzed${missing ? `, ${missing} missing predictions` : ''}) ===\n`);
  console.log('ENTITY          recall  precision  F1    truth  pred   ratio   read');
  for (const k of kinds) {
    const a = agg[k]; if (a.t === 0 && a.p === 0) continue;
    const r = pct(a.m, a.t), p = pct(a.m, a.p), f1 = r + p ? Math.round((2 * r * p) / (r + p)) : 0;
    const flag = a.p > a.t * 1.5 ? ' ⚠over-extract' : a.p < a.t * 0.6 ? ' ⚠under-extract (coverage?)' : '';
    console.log('  ' + k.padEnd(14) + `${r}%`.padStart(6) + `${p}%`.padStart(9) + `${f1}%`.padStart(6) + `${a.t}`.padStart(7) + `${a.p}`.padStart(6) + `${(a.p / (a.t || 1)).toFixed(2)}`.padStart(8) + flag);
  }
  console.log('\nFIELD ACCURACY (on matched entities):');
  for (const [k, v] of Object.entries(fieldAgg)) console.log('  ' + k.padEnd(26) + pct(v.m, v.t) + '%  (' + v.m + '/' + v.t + ')');
  console.log('\nSTUCK / EXTREME projects:');
  for (const p of perProject) {
    const flags = [];
    if (p.runsR === 0) flags.push('runs=0');
    if (p.structR === 0) flags.push('struct=0');
    if (flags.length) console.log('  ' + p.label.padEnd(28) + flags.join(', '));
  }
  console.log('\nWATERMAIN false positives (truth=0, pred>0):', wmFP);
  console.log('\nUNMATCHED truth structures (recall gaps / label variants), first 30:');
  console.log('  ' + unmatchedStruct.slice(0, 30).join(' | '));
  console.log('');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
