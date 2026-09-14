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

// ---- junk filters (precision) ----
//
// Both filters below answer the same question — "is this row a reading of a physical
// thing, or is it something the model scraped off the sheet that isn't one?" — and both
// are deliberately NARROW. Three broader structure filters (long-contiguous-run,
// missing-data, sewer-endpoint corroboration) were measured and REJECTED because each
// killed real structures; see CLAUDE.md. Do not widen these into those.

// A structure's description is an IDENTIFIER ("MH 12", "CBMH 4", "JELLYFISH UNIT",
// "STORMTRAP DOUBLETRAP DETENTION SYSTEM OOS"). It is never an instruction to the
// contractor. Drawings carry both, and vision reads them off the same sheet, so notes
// like "ADJUST MH BENCHING TO SUIT" arrive shaped exactly like a structure row.
//
// An instruction is recognised by GRAMMAR, not by vocabulary: it either opens with an
// imperative verb, or contains a directive/spec phrase. That distinction is what keeps
// noun-phrase equipment names — which look superficially similar and ARE real
// structures — out of the filter.
const IMPERATIVE_OPENER =
  /^(?:CORE|INSTALL|ADJUST|CONNECT|PROVIDE|REMOVE|RELOCATE|RESTORE|CAP|MAINTAIN|PROTECT|VERIFY|NOTIFY|CONFIRM|COORDINATE|SAWCUT|EXCAVATE|BACKFILL|ENSURE|CONTRACTOR)\b/i;
const DIRECTIVE_PHRASE =
  /\b(?:TO BE|TO SUIT|AS REQUIRED|IF REQUIRED|SHALL|MUST BE|PRIOR TO|BY OTHERS|REFER TO|SEE DETAIL)\b/i;
// A real structure id somewhere in the text (code + number). Only relaxes the
// prose-LENGTH test — an imperative or directive is a note regardless, because
// "CORE 150mmØ PVC SAN INTO EX. SAN. MH.38A" names a manhole but is still an instruction.
const HAS_STRUCTURE_ID = /\b(?:EX\.?\s*)?(?:DDICB|DICBMH|DCBMH|CBMH|DICB|DCB|CB|MH|HS|OS|JF|EF|TD|AD|STMH)\s*\.?\s*\d/i;
/** Word count at which a description stops reading as a name and starts reading as prose. */
const PROSE_WORDS = 7;

/**
 * True when a structure description is a spec note / instruction rather than a
 * structure identifier. Exported for direct use by extraction paths that do not
 * route through reconcileTakeoff.
 */
export function isSpecNoteDescription(description: string): boolean {
  const d = (description || '').trim();
  if (!d) return false; // an empty label is a different defect; not this filter's business
  if (IMPERATIVE_OPENER.test(d)) return true;
  if (DIRECTIVE_PHRASE.test(d)) return true;
  return d.split(/\s+/).length >= PROSE_WORDS && !HAS_STRUCTURE_ID.test(d);
}

export function dropSpecNoteStructures(structures: StructureFact[]): {
  structures: StructureFact[];
  dropped: string[];
} {
  const dropped: string[] = [];
  const kept = structures.filter((s) => {
    if (!isSpecNoteDescription(s.description)) return true;
    dropped.push(s.description);
    return false;
  });
  return { structures: kept, dropped };
}

/**
 * A catchbasin is a physical structure that must be drained by a pipe, so the number
 * of them is bounded by the size of the drainage network the same drawing shows. When
 * a group's quantity is far outside that bound it is a misread number (a station, an
 * elevation, a dimension), not a count — one golden project reports 249 single CBs on
 * a site whose whole extracted network is 16 rows, and 249 catchbasins would flow
 * straight into the priced estimate.
 *
 * The ceiling is 4x the extracted network (floor 10, so tiny drawings are not squeezed).
 * Across the golden truth set the highest real catchbasins/network ratio is ~1.2, so 4x
 * sits more than three times beyond anything genuine and can only fire on a misread.
 *
 * The offending group is DROPPED, not clamped: having declared the number unreadable we
 * do not get to substitute a different one. A warning records the loss so the estimator
 * sees a gap rather than a fabricated quantity.
 */
export function dropImplausibleCatchbasinGroups(
  groups: TakeoffFacts['catchbasins'],
  networkSize: number
): { catchbasins: TakeoffFacts['catchbasins']; dropped: { type: string; quantity: number }[] } {
  const ceiling = 4 * Math.max(networkSize, 10);
  const dropped: { type: string; quantity: number }[] = [];
  const kept = groups.filter((g) => {
    if ((g.quantity || 0) <= ceiling) return true;
    dropped.push({ type: g.type, quantity: g.quantity });
    return false;
  });
  return { catchbasins: kept, dropped };
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

  const keptSewers = sewers.filter((s) => !kill.has(s));

  // 5. junk filters. Structures first, so the network size the catchbasin ceiling is
  // measured against is the CLEANED one — spec notes must not inflate the budget that
  // decides whether a catchbasin count is plausible.
  const note = dropSpecNoteStructures(structures);
  const cb = dropImplausibleCatchbasinGroups(
    mergeCatchbasinGroups(facts.catchbasins) as TakeoffFacts['catchbasins'],
    note.structures.length + keptSewers.filter((s) => !s.isLineItem).length
  );

  const warnings = [...facts.warnings];
  if (note.dropped.length > 0) {
    warnings.push(
      `Dropped ${note.dropped.length} structure(s) whose description is a spec note, not a structure id: ` +
        `${note.dropped.slice(0, 8).join(' | ')}${note.dropped.length > 8 ? ' | …' : ''}`
    );
  }
  for (const d of cb.dropped) {
    warnings.push(
      `Dropped catchbasin group ${d.type} qty ${d.quantity} — implausible against a drainage network of ` +
        `${note.structures.length + keptSewers.length} rows; the quantity was almost certainly misread. ` +
        `Count these catchbasins manually.`
    );
  }

  return {
    ...facts,
    structures: note.structures,
    sewers: keptSewers,
    // 3. catchbasins: merge duplicate label groups by type (see mergeCatchbasinGroups)
    catchbasins: cb.catchbasins,
    watermain,
    warnings,
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
