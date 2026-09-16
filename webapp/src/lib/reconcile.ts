/**
 * Global consistency layer for TakeoffFacts. Every extraction path (text-layer,
 * vision transcript, legacy LLM) ends here: one entity per physical thing.
 * Pure — the offline re-assembly loop (assemble-from-transcripts.ts) depends on
 * being able to re-run this for free against cached inputs.
 */
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact } from './types';
import { normalizeLabel, runSignature, stripSystemPrefix } from './compare-facts';
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

const ENDPOINT_TOKEN = /^(?:EX)?(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|HS|OS|JF|EF|ST|SA)\d|^CONN$/;
const STRUCTURE_TOKEN = /^(?:EX)?(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|HS|OS|JF|EF|ST|SA)\d/;
const LABEL_PARTS = /^([A-Z]+)0*(\d+)([A-Z]*)$/;

function normalizeEndpointToken(t: string): string {
  const stripped = stripSystemPrefix(t.replace(/[^A-Z0-9]/g, ''));
  if (/^(CONN|PLUG|OUTLET)/.test(stripped)) return 'CONN';
  const m = LABEL_PARTS.exec(stripped);
  return m ? `${m[1]}${Number(m[2])}${m[3]}` : stripped;
}

export function getEndpointSignature(label: string): string | null {
  let s = (label || '').toUpperCase();
  s = s.replace(/\bC\/W.*$/, '');
  s = s.replace(/\/.*$/, '');
  s = s.replace(/\bTO\b/g, '-');
  s = s.replace(/\s+/g, '');
  const tokens = s
    .split('-')
    .map(normalizeEndpointToken)
    .filter(Boolean);
  const endpoints = tokens.filter((t) => ENDPOINT_TOKEN.test(t));
  if (endpoints.length >= 2 && endpoints.some((t) => STRUCTURE_TOKEN.test(t))) {
    return Array.from(new Set(endpoints)).sort().join('|');
  }
  return null;
}

export const isEndpointPair = (s: SewerFact): boolean => {
  return getEndpointSignature(s.runLabel) !== null;
};

export function hasInsulation(label: string): boolean {
  return /\/P?\.?INS/i.test(label || '');
}

export function getSystem(label: string): 'STORM' | 'SAN' | 'UNKNOWN' {
  const upper = (label || '').toUpperCase();
  if (/\b(SAN|SANITARY)\b/.test(upper)) return 'SAN';
  if (/\b(STM|STORM)\b/.test(upper)) return 'STORM';
  return 'UNKNOWN';
}

export function compatibleSystem(labelA: string, labelB: string): boolean {
  const sysA = getSystem(labelA);
  const sysB = getSystem(labelB);
  if (sysA !== 'UNKNOWN' && sysB !== 'UNKNOWN' && sysA !== sysB) {
    return false;
  }
  return true;
}

export function closeLength(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  const diff = Math.abs(a - b);
  const maxLen = Math.max(a, b);
  return diff <= Math.max(0.5, 0.02 * maxLen);
}

export function compatibleSlope(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return true;
  const diff = Math.abs(a - b);
  const maxSlope = Math.max(Math.abs(a), Math.abs(b));
  return diff <= Math.max(0.2, 0.15 * maxSlope);
}

export function compatibleTypeClass(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return true;
  return a === b;
}

export function mergeRunLabels(labelA: string, labelB: string): string {
  const a = (labelA || '').trim();
  const b = (labelB || '').trim();
  if (!a) return b;
  if (!b) return a;

  const endA = getEndpointSignature(a);
  const endB = getEndpointSignature(b);

  let base: string;
  if (endA && !endB) {
    base = a;
  } else if (!endA && endB) {
    base = b;
  } else {
    const cleanA = a.replace(/\/.*$/, '').trim();
    const cleanB = b.replace(/\/.*$/, '').trim();
    base = cleanA.length >= cleanB.length ? a : b;
  }

  const isIns = hasInsulation(a) || hasInsulation(b);
  if (isIns && !hasInsulation(base)) {
    base = base.includes('/') ? base.replace(/\/.*$/, '/INS.') : `${base}/INS.`;
  }
  return base;
}

export function mergeSewerFact(a: SewerFact, b: SewerFact): SewerFact {
  let length: number | null = null;
  if (a.length != null && b.length != null) {
    length = Math.max(a.length, b.length);
  } else {
    length = a.length ?? b.length;
  }

  let pipeDiameter: number | null = null;
  if (a.pipeDiameter != null && b.pipeDiameter != null) {
    pipeDiameter = Math.max(a.pipeDiameter, b.pipeDiameter);
  } else {
    pipeDiameter = a.pipeDiameter ?? b.pipeDiameter;
  }

  let depth: number | null = null;
  if (a.depth != null && b.depth != null) {
    depth = Math.max(a.depth, b.depth);
  } else {
    depth = a.depth ?? b.depth;
  }

  return {
    runLabel: mergeRunLabels(a.runLabel, b.runLabel),
    isLineItem: a.isLineItem && b.isLineItem,
    lineItemType: a.lineItemType ?? b.lineItemType,
    length,
    pipeDiameter,
    typeClass: a.typeClass ?? b.typeClass,
    slope: a.slope ?? b.slope,
    depth,
  };
}

export function canMergeSewerRuns(a: SewerFact, b: SewerFact): boolean {
  if (a === b) return false;
  if (a.isLineItem || b.isLineItem) return false;

  // 1. System check: SAN vs STM never merge
  if (!compatibleSystem(a.runLabel, b.runLabel)) return false;

  const sigA = getEndpointSignature(a.runLabel);
  const sigB = getEndpointSignature(b.runLabel);

  // 2. Both runs have endpoint signatures
  if (sigA && sigB) {
    // If endpoint signatures do not match, these are distinct runs (e.g. MH 1-MH 2 vs MH 3-MH 4)
    if (sigA !== sigB) {
      return false;
    }
    // Matching endpoints! Pipe diameters must match if both are present
    if (a.pipeDiameter != null && b.pipeDiameter != null && a.pipeDiameter !== b.pipeDiameter) {
      return false;
    }
    return true;
  }

  // 3. At least one run lacks an endpoint signature (dimension callout or schedule id)
  // Attribute-level duplicate deduplication:
  if (a.pipeDiameter == null || b.pipeDiameter == null || a.pipeDiameter !== b.pipeDiameter) {
    return false;
  }

  if (!closeLength(a.length, b.length)) {
    return false;
  }

  if (!compatibleSlope(a.slope, b.slope)) {
    return false;
  }
  if (!compatibleTypeClass(a.typeClass, b.typeClass)) {
    return false;
  }

  return true;
}

/**
 * Stitch sewer runs that represent the same physical pipe extracted from overlapping tiles.
 *
 * Two merging strategies:
 * 1. Endpoint match: same two structure IDs (order-insensitive, e.g. MH 1 & MH 2) + matching diameter
 *    → merge, taking max length, merging non-null fields, and preserving /INS. suffix
 * 2. Attribute match: same diameter + length within 2% (or 0.5m) + similar slope/typeClass
 *    → collapse to one run (unless they have distinct, non-matching endpoint structure IDs)
 */
export function stitchSewerRuns(sewers: SewerFact[]): SewerFact[] {
  if (!sewers || sewers.length === 0) return [];

  const result: SewerFact[] = [];

  for (const raw of sewers) {
    if (!raw) continue;
    const s = { ...raw };

    if (s.isLineItem) {
      const existingIdx = result.findIndex(
        (r) => r.isLineItem && r.runLabel === s.runLabel && r.lineItemType === s.lineItemType
      );
      if (existingIdx >= 0) {
        result[existingIdx] = mergeSewerFact(result[existingIdx], s);
      } else {
        result.push(s);
      }
      continue;
    }

    let merged = false;
    for (let i = 0; i < result.length; i++) {
      if (canMergeSewerRuns(result[i], s)) {
        result[i] = mergeSewerFact(result[i], s);
        merged = true;
        break;
      }
    }

    if (!merged) {
      result.push(s);
    }
  }

  // Iterative consolidation pass until fixed point
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        if (canMergeSewerRuns(result[i], result[j])) {
          result[i] = mergeSewerFact(result[i], result[j]);
          result.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return result;
}

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

  // 2. sewers: multi-tile sewer run stitching & endpoint-aware consolidation
  const keptSewers = stitchSewerRuns(facts.sewers);

  // 3. watermain: exact dedupe, then AGGREGATE BY DIAMETER.
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
