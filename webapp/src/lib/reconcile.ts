/**
 * Global consistency layer for TakeoffFacts. Every extraction path (text-layer,
 * vision transcript, legacy LLM) ends here: one entity per physical thing.
 * Pure — the offline re-assembly loop (assemble-from-transcripts.ts) depends on
 * being able to re-run this for free against cached inputs.
 */
import { TakeoffFacts, StructureFact, SewerFact } from './types';
import { normalizeLabel, runSignature } from './compare-facts';
import { mergeCatchbasinGroups } from './extraction';

const nonNullCount = (o: object) => Object.values(o).filter((v) => v !== null && v !== '').length;

function mergeStructureGroup(group: StructureFact[]): StructureFact {
  const out = { ...group[0] };
  for (const s of group.slice(1)) {
    for (const k of ['topElevation', 'lowInvert', 'highInvert', 'pipeOutDiameter', 'structureType', 'depth'] as const) {
      if (out[k] == null && s[k] != null) (out as any)[k] = s[k];
    }
  }
  return out;
}

function samePipe(a: SewerFact, b: SewerFact): boolean {
  if (a.pipeDiameter == null || b.pipeDiameter == null || a.pipeDiameter !== b.pipeDiameter) return false;
  if (a.length == null || b.length == null) return false;
  return Math.abs(a.length - b.length) <= Math.max(1, 0.02 * Math.max(a.length, b.length));
}

const isEndpointPair = (s: SewerFact) => runSignature(s.runLabel).includes('|');

export function reconcileTakeoff(facts: TakeoffFacts): TakeoffFacts {
  // 1. structures: merge by normalized label
  const byLabel = new Map<string, StructureFact[]>();
  for (const s of facts.structures) {
    const k = normalizeLabel(s.description);
    if (!k) continue;
    (byLabel.get(k) ?? byLabel.set(k, []).get(k)!).push(s);
  }
  const structures = Array.from(byLabel.values()).map(mergeStructureGroup);

  // 2. sewers: exact-signature dedupe (keep most complete), then dual-label kill
  const bySig = new Map<string, SewerFact>();
  const sewers: SewerFact[] = [];
  for (const s of facts.sewers) {
    const sig = runSignature(s.runLabel);
    const prev = sig ? bySig.get(sig) : undefined;
    if (prev) {
      if (nonNullCount(s) > nonNullCount(prev)) { sewers[sewers.indexOf(prev)] = s; bySig.set(sig, s); }
      continue;
    }
    if (sig) bySig.set(sig, s);
    sewers.push(s);
  }
  const kill = new Set<SewerFact>();
  for (const a of sewers) {
    if (kill.has(a) || !isEndpointPair(a)) continue;
    for (const b of sewers) {
      if (a === b || kill.has(b) || isEndpointPair(b)) continue;
      if (samePipe(a, b)) kill.add(b); // b is the schedule-id duplicate of endpoint-labeled a
    }
  }

  // 4. watermain exact dedupe
  const wmSeen = new Set<string>();
  const watermain = facts.watermain.filter((w) => {
    const k = `${w.pipeDiameter}|${w.length}`;
    if (wmSeen.has(k)) return false;
    wmSeen.add(k);
    return true;
  });

  return {
    ...facts,
    structures,
    sewers: sewers.filter((s) => !kill.has(s)),
    // 3. catchbasins: merge duplicate label groups by type (see mergeCatchbasinGroups)
    catchbasins: mergeCatchbasinGroups(facts.catchbasins) as TakeoffFacts['catchbasins'],
    watermain,
  };
}

export function mergeTakeoffs(primary: TakeoffFacts, secondary: TakeoffFacts): TakeoffFacts {
  const primaryLabels = new Set(primary.structures.map((s) => normalizeLabel(s.description)));
  return reconcileTakeoff({
    ...primary,
    structures: [...primary.structures, ...secondary.structures.filter((s) => !primaryLabels.has(normalizeLabel(s.description)))],
    sewers: [...primary.sewers, ...secondary.sewers],
    catchbasins: [...primary.catchbasins, ...secondary.catchbasins],
    watermain: [...primary.watermain, ...secondary.watermain],
    watermainSpecials: [...primary.watermainSpecials, ...secondary.watermainSpecials],
    watermainValves: [...primary.watermainValves, ...secondary.watermainValves],
    warnings: [...primary.warnings, ...secondary.warnings],
  });
}
