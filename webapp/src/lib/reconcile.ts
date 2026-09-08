/**
 * Global consistency layer for TakeoffFacts. Every extraction path (text-layer,
 * vision transcript, legacy LLM) ends here: one entity per physical thing.
 * Pure — the offline re-assembly loop (assemble-from-transcripts.ts) depends on
 * being able to re-run this for free against cached inputs.
 */
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact } from './types';
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

// A run is "endpoint-labelled" when its label names two ENDPOINTS, not when it
// merely contains a hyphen — "83.7m-375mm SAN" is a dimension callout whose
// hyphen would otherwise make runSignature look like an endpoint pair, so the
// schedule row and its plan callout both survived as separate pipes.
//
// An endpoint is a structure ("MH 8", "EX CBMH 3") or a connection sentinel:
// runSignature collapses CONN/PLUG/OUTLET to one `CONN` token precisely so
// "MH 8-CONN." keeps its second endpoint, so `CONN` must count as one here or
// that real run is both blunted and newly killable. ST/SA stay in the list:
// they are run/schedule ids rather than structures, but excluding them would
// only narrow the predicate, and narrowing costs recall.
const ENDPOINT_TOKEN = /^(?:EX)?(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|HS|OS|JF|EF|ST|SA)\d|^CONN$/;
const STRUCTURE_TOKEN = /^(?:EX)?(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|HS|OS|JF|EF|ST|SA)\d/;

const isEndpointPair = (s: SewerFact) => {
  const tokens = runSignature(s.runLabel).split('|');
  const endpoints = tokens.filter((t) => ENDPOINT_TOKEN.test(t));
  // Two endpoints, at least one of them a real structure — so a label made only
  // of connection sentinels can never masquerade as a pipe run.
  return endpoints.length >= 2 && endpoints.some((t) => STRUCTURE_TOKEN.test(t));
};

/**
 * Collapse watermain rows to one per pipe diameter, summing their lengths — the
 * shape the estimating workbook (and therefore the truth set) uses.
 *
 * Rows with no diameter can't be aggregated onto a size, so they pass through
 * untouched rather than being silently merged into an arbitrary bucket or dropped.
 * ocSc/avgCover are taken from the first row that states one; they describe the
 * installation, not the segment, so summing them would be meaningless.
 */
export function aggregateWatermainByDiameter(rows: WatermainFact[]): WatermainFact[] {
  const byDia = new Map<number, WatermainFact>();
  const passthrough: WatermainFact[] = [];

  for (const w of rows) {
    if (w.pipeDiameter == null) { passthrough.push(w); continue; }
    const prev = byDia.get(w.pipeDiameter);
    if (!prev) {
      byDia.set(w.pipeDiameter, { ...w, sizeAndType: `${w.pipeDiameter}mm`, length: w.length ?? 0 });
      continue;
    }
    prev.length += w.length ?? 0;
    if (prev.ocSc == null && w.ocSc != null) prev.ocSc = w.ocSc;
    if (prev.avgCover == null && w.avgCover != null) prev.avgCover = w.avgCover;
  }

  // Largest size first — how a watermain schedule is normally written.
  const aggregated = [...byDia.values()].sort((a, b) => b.pipeDiameter - a.pipeDiameter);
  return [...aggregated, ...passthrough];
}

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

  // 4. watermain: exact dedupe, then AGGREGATE BY DIAMETER.
  //
  // The estimator's workbook carries one watermain row per pipe SIZE holding the
  // total metres of that size — you buy 195m of 200mmØ, not nine separate segments.
  // Every extraction path emits one row per callout, so they have to be summed here
  // or a correct read still scores as a pile of unmatched rows.
  //
  // Order matters: the exact (diameter, length) dedupe runs FIRST, because the same
  // physical callout read from two overlapping tiles must be dropped, not added
  // twice. Two genuinely distinct segments that share a diameter AND an identical
  // length collapse to one — the same trade-off this dedupe already made, and tile
  // overlap is by far the likelier cause of an exact duplicate.
  const wmSeen = new Set<string>();
  const watermain = aggregateWatermainByDiameter(
    facts.watermain.filter((w) => {
      const k = `${w.pipeDiameter}|${w.length}`;
      if (wmSeen.has(k)) return false;
      wmSeen.add(k);
      return true;
    })
  );

  return {
    ...facts,
    structures,
    sewers: sewers.filter((s) => !kill.has(s)),
    // 3. catchbasins: merge duplicate label groups by type (see mergeCatchbasinGroups)
    catchbasins: mergeCatchbasinGroups(facts.catchbasins) as TakeoffFacts['catchbasins'],
    watermain,
  };
}

/**
 * Combine two extraction paths' facts, `primary` winning conflicts.
 *
 * Secondary structures are appended WHOLE rather than dropped when their label
 * already appears in primary: reconcileTakeoff groups by normalized label and
 * mergeStructureGroup fills only the fields the first (primary) row left null.
 * Filtering them out instead discarded values that nothing else supplied — the
 * text layer reads the label + invert while the vector/topology path reads the
 * rim, and the rim was being thrown away. Primary still wins any field both read.
 */
export function mergeTakeoffs(primary: TakeoffFacts, secondary: TakeoffFacts): TakeoffFacts {
  return reconcileTakeoff({
    ...primary,
    structures: [...primary.structures, ...secondary.structures],
    sewers: [...primary.sewers, ...secondary.sewers],
    catchbasins: [...primary.catchbasins, ...secondary.catchbasins],
    watermain: [...primary.watermain, ...secondary.watermain],
    watermainSpecials: [...primary.watermainSpecials, ...secondary.watermainSpecials],
    watermainValves: [...primary.watermainValves, ...secondary.watermainValves],
    warnings: [...primary.warnings, ...secondary.warnings],
  });
}
