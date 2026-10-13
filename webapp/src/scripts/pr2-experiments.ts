/**
 * pr2-experiments.ts — TEMPORARY analysis driver for PR 2 (Phase 0 ruler fixes).
 *
 * Part 0: field-population census (truth vs pred, on matched pairs) for the
 *   candidate newly-scored fields, so "score it" decisions rest on data.
 * Part H2: is truth sewer typeClass a learnable convention? Cross-tab against
 *   pipe diameter and material tokens in the run label; report lookup accuracy.
 * Part H3: is truth sewer run depth derivable? For runs matched between cached
 *   pred and truth whose endpoint structures also matched, compare truth depth
 *   against rim−invert derived from the TRUTH endpoint structures (the
 *   upper-bound test: is the quantity geometrically determined at all?).
 *
 * No metric reimplementation for scoring decisions: matching comes from
 * compare-facts' own matchers. Run: npx tsx src/scripts/pr2-experiments.ts
 */
import fs from 'fs';
import path from 'path';
import { compareFacts, matchStructures, matchSewerRuns, normalizeLabel } from '../lib/compare-facts';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { TakeoffFacts, StructureFact, SewerFact } from '../lib/types';

const ROOT = path.resolve(__dirname, '../../..');
const DATA = path.join(ROOT, 'existing_projects_training_data');
const manifest = loadTruthManifest(path.join(ROOT, 'truth-manifest.json'));

const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) + '%' : 'n/a');

// ---------------- Part 0: census ----------------
async function census(projects: { pred: TakeoffFacts; truth: TakeoffFacts }[]) {
  const structFields: (keyof StructureFact)[] = ['topElevation', 'lowInvert', 'highInvert', 'pipeOutDiameter', 'structureType', 'depth'];
  const counts: Record<string, { truthNN: number; predNN: number; pairs: number }> = {};
  const typeValues = new Map<string, number>();
  let cbTruthGroups = 0, cbTruthWall = 0, cbTruthDepth = 0;
  const cbPredByType = new Map<string, { groups: number; wall: number; depth: number }>();

  for (const { pred, truth } of projects) {
    const ms = matchStructures(pred.structures, truth.structures);
    for (const f of structFields) {
      const c = (counts[f as string] ??= { truthNN: 0, predNN: 0, pairs: ms.pairs.length });
      for (const t of truth.structures) if (t[f] != null && t[f] !== '') c.truthNN++;
      for (const p of pred.structures) if (p[f] != null && p[f] !== '') c.predNN++;
    }
    for (const t of truth.structures) if (t.structureType) typeValues.set(t.structureType, (typeValues.get(t.structureType) ?? 0) + 1);
    for (const g of truth.catchbasins) {
      cbTruthGroups++;
      if (g.wallThickness != null) cbTruthWall++;
      if (g.depth != null) cbTruthDepth++;
    }
    for (const g of pred.catchbasins) {
      const e = cbPredByType.get(g.type) ?? { groups: 0, wall: 0, depth: 0 };
      e.groups++;
      if (g.wallThickness != null) e.wall++;
      if (g.depth != null) e.depth++;
      cbPredByType.set(g.type, e);
    }
  }
  console.log('\n=== PART 0: field population census (26 projects) ===');
  console.log('field              truth non-null   pred non-null   (matched structure pairs totalled per row above)');
  for (const f of structFields) {
    const c = counts[f as string];
    console.log(`  ${('structure.' + f).padEnd(26)} ${String(c.truthNN).padStart(6)} ${String(c.predNN).padStart(12)}`);
  }
  console.log('  truth structureType values:', [...typeValues.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15));
  console.log(`  catchbasin truth groups: ${cbTruthGroups}, wallThickness non-null ${cbTruthWall}, depth non-null ${cbTruthDepth}`);
  for (const [ty, e] of cbPredByType) console.log(`  catchbasin pred ${ty}: groups ${e.groups}, wall non-null ${e.wall}, depth non-null ${e.depth}`);
}

// ---------------- H2: typeClass ----------------
function materialToken(label: string): string {
  const s = (label || '').toUpperCase();
  if (/PVC/.test(s)) return 'PVC';
  if (/HDPE|PE\b/.test(s)) return 'HDPE';
  if (/CONC|RCP|CONCRETE/.test(s)) return 'CONC';
  if (/CPP/.test(s)) return 'CPP';
  if (/STEEL|ST\b/.test(s)) return 'STEEL?';
  if (/\bDI\b|DUCTILE/.test(s)) return 'DI';
  return '(none)';
}

async function h2(truths: TakeoffFacts[]) {
  const runs: { tc: number; dia: number | null; mat: string }[] = [];
  for (const truth of truths) {
    for (const r of truth.sewers) {
      if (r.isLineItem || r.typeClass == null) continue;
      runs.push({ tc: r.typeClass, dia: r.pipeDiameter, mat: materialToken(r.runLabel) });
    }
  }
  console.log(`\n=== H2: typeClass cross-tab (${runs.length} truth runs with typeClass) ===`);
  const dist = new Map<number, number>();
  for (const r of runs) dist.set(r.tc, (dist.get(r.tc) ?? 0) + 1);
  console.log('  value distribution:', [...dist.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}: ${n} (${pct(n, runs.length)})`).join('  '));

  const lookup = (key: (r: typeof runs[number]) => string) => {
    const byKey = new Map<string, Map<number, number>>();
    for (const r of runs) {
      const k = key(r);
      const m = byKey.get(k) ?? new Map<number, number>();
      m.set(r.tc, (m.get(r.tc) ?? 0) + 1);
      byKey.set(k, m);
    }
    let correct = 0;
    for (const m of byKey.values()) correct += Math.max(...m.values());
    return { correct, keys: byKey.size };
  };
  const global = lookup(() => 'all');
  const byDia = lookup((r) => String(r.dia));
  const byMat = lookup((r) => r.mat);
  const byBoth = lookup((r) => `${r.dia}|${r.mat}`);
  console.log(`  global majority lookup:  ${global.correct}/${runs.length} = ${pct(global.correct, runs.length)}`);
  console.log(`  by diameter (${byDia.keys} keys):       ${byDia.correct}/${runs.length} = ${pct(byDia.correct, runs.length)}`);
  console.log(`  by label material (${byMat.keys} keys):  ${byMat.correct}/${runs.length} = ${pct(byMat.correct, runs.length)}`);
  console.log(`  by diameter+material (${byBoth.keys} keys): ${byBoth.correct}/${runs.length} = ${pct(byBoth.correct, runs.length)}`);

  // diameter x typeClass table for the big diameters
  const diaTab = new Map<string, Map<number, number>>();
  for (const r of runs) {
    const k = String(r.dia);
    const m = diaTab.get(k) ?? new Map<number, number>();
    m.set(r.tc, (m.get(r.tc) ?? 0) + 1);
    diaTab.set(k, m);
  }
  console.log('  diameter -> typeClass counts (top diameters):');
  for (const [dia, m] of [...diaTab.entries()].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0)).slice(0, 10)) {
    console.log(`    ${dia}mm:`, [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`).join('  '));
  }
  const mats = new Map<string, number>();
  for (const r of runs) mats.set(r.mat, (mats.get(r.mat) ?? 0) + 1);
  console.log('  material tokens found in truth run labels:', [...mats.entries()].sort((a, b) => b[1] - a[1]));
}

// ---------------- H3: run depth derivation ----------------
function endpointsOf(label: string): string[] {
  return String(label).split(/[-–]/)
    .map((p) => normalizeLabel(p.split('/')[0]))
    .filter((x) => x && x !== 'CONN' && x !== 'PLUG' && x !== 'WYE');
}

async function h3(projects: { pred: TakeoffFacts; truth: TakeoffFacts; label: string }[]) {
  interface Row { truthDepth: number; dLow: number | null; dHigh: number | null; proj: string; run: string }
  const rows: Row[] = [];
  let matchedRuns = 0, withTruthDepth = 0, endpointsResolved = 0;

  for (const { pred, truth, label } of projects) {
    const predRuns = pred.sewers.filter((s) => !s.isLineItem);
    const truthRuns = truth.sewers.filter((s) => !s.isLineItem);
    const mr = matchSewerRuns(predRuns, truthRuns);
    const ms = matchStructures(pred.structures, truth.structures);
    const matchedTruthStructs = new Set(ms.pairs.map((x) => x.t));
    const truthByNorm = new Map<string, StructureFact>();
    for (const s of truth.structures) {
      const n = normalizeLabel(s.description);
      if (n && !truthByNorm.has(n)) truthByNorm.set(n, s);
    }
    for (const { t } of mr.pairs) {
      matchedRuns++;
      if (t.depth == null) continue;
      withTruthDepth++;
      const eps = endpointsOf(t.runLabel)
        .map((n) => truthByNorm.get(n))
        .filter((s): s is StructureFact => !!s && matchedTruthStructs.has(s));
      if (eps.length === 0) continue;
      endpointsResolved++;
      const derive = (inv: (s: StructureFact) => number | null) => {
        const vals = eps.map((s) => {
          const i = inv(s);
          return s.topElevation != null && i != null ? s.topElevation - i : null;
        }).filter((v): v is number => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      rows.push({
        truthDepth: t.depth,
        dLow: derive((s) => s.lowInvert),
        dHigh: derive((s) => s.highInvert),
        proj: label, run: t.runLabel,
      });
    }
  }
  console.log(`\n=== H3: run depth derivation ===`);
  console.log(`  matched runs: ${matchedRuns}; with truth depth: ${withTruthDepth}; endpoints resolved to matched structures: ${endpointsResolved}`);
  const report = (name: string, get: (r: Row) => number | null) => {
    const usable = rows.filter((r) => get(r) != null);
    const within = usable.filter((r) => Math.abs(get(r)! - r.truthDepth) / r.truthDepth <= 0.10);
    const errs = usable.map((r) => Math.abs(get(r)! - r.truthDepth)).sort((a, b) => a - b);
    const med = errs.length ? errs[Math.floor(errs.length / 2)] : null;
    console.log(`  ${name}: n=${usable.length}  within 10%: ${within.length} (${pct(within.length, usable.length)})  median |err| ${med?.toFixed(2)}m`);
    for (const r of usable.slice(0, 5)) console.log(`    sample: ${r.proj} "${r.run}" truth=${r.truthDepth} derived=${get(r)?.toFixed(2)}`);
  };
  report('derived = mean(top − lowInvert) over endpoints', (r) => r.dLow);
  report('derived = mean(top − highInvert) over endpoints', (r) => r.dHigh);
}

async function main() {
  const projects: { pred: TakeoffFacts; truth: TakeoffFacts; label: string }[] = [];
  for (const g of GOLDEN_PROJECTS) {
    const dir = path.join(DATA, g.folder);
    const predFile = path.join(dir, 'generated_spreadsheets', 'predicted_facts.json');
    if (!fs.existsSync(predFile)) { console.error('NO PRED', g.folder); continue; }
    const pred = JSON.parse(fs.readFileSync(predFile, 'utf8')) as TakeoffFacts;
    const truthRes = await resolveTruthFacts(dir, g.folder, manifest);
    if (!truthRes) { console.error('NO TRUTH', g.folder); continue; }
    projects.push({ pred, truth: truthRes.facts, label: g.label });
  }
  console.log(`loaded ${projects.length} projects`);
  await census(projects);
  await h2(projects.map((p) => p.truth));
  await h3(projects);
}

main().catch((e) => { console.error(e); process.exit(1); });
