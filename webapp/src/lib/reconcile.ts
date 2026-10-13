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

// Construction features the estimator builds differently: a drop connection, a
// doghouse built over an existing pipe, an internal weir/orifice control, or a
// discharge outlet. They reach us as a note ON the label ("MH 5/EXT DROP") or in
// structureType — and normalizeLabel deliberately STRIPS those notes when grouping,
// so the plain reading of the same manhole from a neighbouring tile lands in the
// same group as the annotated one. That makes this merge the only place the feature
// can survive: without it, whichever tile happens to sort first silently decides
// whether the drop/doghouse/control note is kept or deleted.
const SPECIAL_FEATURE =
  /\b(?:(?:EXT|INT)\.?\s*DROP|DROP|DOGHOUSE|D\/?H|DIV(?:ERSION)?|CTRL|CONTROL|WEIR|ORIFICE|HEADWALL|OUTFALL|OUTLET|FLARED\s*END)\b/i;

// '' is as empty as null here. A tile that read a structure's label but not its type
// emits "" for structureType, which is NOT null and so used to block every later
// tile's real value from ever filling the field.
const isBlank = (v: unknown): boolean => v == null || (typeof v === 'string' && v.trim() === '');

/** How much a structureType string tells the estimator. A feature note outranks any length. */
const descriptiveness = (v: string): number => (SPECIAL_FEATURE.test(v) ? 1e6 : 0) + v.trim().length;

function mergeStructureGroup(group: StructureFact[]): StructureFact {
  const out = { ...group[0] };

  // Promote a description only to rescue a special-feature note the first reading
  // lacks — never merely because another reading is longer, which would churn labels
  // ("MH 1" -> "STMH 1") against the house convention for no information gained.
  //
  // Candidates are screened by the junk filters because those run AFTER this merge:
  // promoting a spec note into the description would make the whole merged row — a
  // REAL structure — get dropped as a note.
  if (!SPECIAL_FEATURE.test(out.description || '')) {
    const annotated = group.find(
      (s) =>
        SPECIAL_FEATURE.test(s.description || '') &&
        !isSpecNoteDescription(s.description) &&
        !isNonStructureFeature(s.description)
    );
    if (annotated) out.description = annotated.description;
  }

  for (const s of group.slice(1)) {
    // Fill every field the earlier readings left blank. Order is significance order:
    // the first row wins any field both read, which is what keeps mergeTakeoffs'
    // "primary wins" contract true for the exact text-layer path.
    for (const k of ['topElevation', 'lowInvert', 'highInvert', 'pipeOutDiameter', 'structureType', 'depth', 'diameter'] as const) {
      if (isBlank(out[k]) && !isBlank(s[k])) (out as any)[k] = s[k];
    }
    // structureType is the one field where later beats earlier, because the readings
    // are not competing values but different amounts of the same one: "DROP MH 1200Ø"
    // and "MH" are both correct, and the fuller string is strictly more useful.
    if (!isBlank(s.structureType) && descriptiveness(s.structureType!) > descriptiveness(out.structureType ?? '')) {
      out.structureType = s.structureType;
    }
  }
  return out;
}

/**
 * A structure row that carries NO reading at all: every measured field null and no
 * type text. It contributes a label and nothing else.
 */
const GEOMETRY_FIELDS = ['topElevation', 'lowInvert', 'highInvert', 'pipeOutDiameter', 'depth', 'diameter'] as const;
export function isFieldEmptyStructure(s: StructureFact): boolean {
  return GEOMETRY_FIELDS.every((k) => (s as any)[k] == null) && isBlank(s.structureType);
}

/**
 * Collapse field-empty phase-suffix re-reads into the structure they duplicate.
 *
 * A numbered structure is sometimes read twice: once as a real callout block (label
 * + elevations) and once as a bare suffixed echo — a legend/phase-list mention the
 * transcriber emitted as "MH61E" beside the real "MH61" (the Milton transcript
 * literally contains the garbled fragment "MH61EE61" next to MH61's full block).
 * Grouping by normalized label can't merge them: the suffix IS part of the label.
 * Left alone, the estimate prices the structure twice.
 *
 * The collapse is deliberately narrow, because a suffix letter can equally denote
 * a REAL second structure (the golden corpus's truth sets hold bare + A forms as
 * separate structures on 61 bases, usually both fully read). It fires only when a
 * (system, kind, number) base has EXACTLY ONE field-bearing form: every other
 * form of that base is field-empty, so merging it in loses no reading — the empty
 * row's label is the only thing it ever contributed. Two bearing forms (Ontario
 * Tech's MH106 / MH106A / MH106B, three distinct inverts) or zero (two bare
 * mentions, nothing read) both stay untouched: ambiguity resolves to NO merge.
 * Kind spellings are NOT unified here — CBMH15 vs MH15A are different bases;
 * same-number different-kind rows are usually distinct structures.
 */
export function collapseEmptySuffixReads(structures: StructureFact[]): {
  structures: StructureFact[];
  collapsed: string[];
} {
  const byBase = new Map<string, StructureFact[]>();
  for (const s of structures) {
    const norm = normalizeLabel(s.description);
    const m = LABEL_PARTS.exec(norm);
    if (!m) continue;
    const sys = /^\s*SAN(?:ITARY)?\b/i.test(s.description) ? 'SAN|' : '';
    const base = `${sys}${m[1]}:${Number(m[2])}`;
    (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(s);
  }

  const collapsed: string[] = [];
  const removed = new Set<StructureFact>();
  const replaced = new Map<StructureFact, StructureFact>();
  for (const rows of byBase.values()) {
    // One entry per distinct label form (same-label rows were already one group
    // in reconcileTakeoff; if a caller hands us raw duplicates, skip the base —
    // which of them is "the" form is not this function's call).
    const forms = new Map<string, StructureFact>();
    for (const s of rows) forms.set(normalizeLabel(s.description), s);
    if (forms.size < 2 || forms.size !== rows.length) continue;
    const bearing = [...forms.values()].filter((s) => !isFieldEmptyStructure(s));
    if (bearing.length !== 1) continue;
    const keep = bearing[0];
    const empties = [...forms.values()].filter((s) => s !== keep);
    replaced.set(keep, mergeStructureGroup([keep, ...empties]));
    for (const e of empties) {
      removed.add(e);
      collapsed.push(`${e.description} → ${keep.description}`);
    }
  }
  if (collapsed.length === 0) return { structures, collapsed };
  return {
    structures: structures
      .filter((s) => !removed.has(s))
      .map((s) => replaced.get(s) ?? s),
    collapsed,
  };
}

// HW (headwall), OCS (outlet control structure) and FES (flared end section) are the
// terminal structures of a storm system. A run that discharges to one ("MH 8-HW 1") is
// a normal two-endpoint run, but without these tokens it read as having only ONE
// endpoint and so was excluded from endpoint-aware stitching and dedupe.
const ENDPOINT_TOKEN = /^(?:EX)?(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|OCS|HS|HW|OS|FES|JF|EF|ST|SA)\d|^CONN$/;
const STRUCTURE_TOKEN = /^(?:EX)?(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|OCS|HS|HW|OS|FES|JF|EF|ST|SA)\d/;
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

const BARE_RUN_ID_RE = /^[A-Z]{1,4}\d+[A-Z]?$/;

/** The schedule id a bare run label reduces to ("ST 1" -> "ST1"), or null
 *  when the label is anything richer (endpoint pair, dimension callout). */
function bareRunId(label: string): string | null {
  const norm = normalizeLabel(label);
  return BARE_RUN_ID_RE.test(norm) ? norm : null;
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

  // 2b. Both runs carry a bare schedule id as their whole label ("ST1",
  // "SA2"). The id IS the run's identity: a pipe schedule lists
  // attribute-identical rows on purpose (two legs of the same size, length
  // and grade are different pipes), so distinct ids never merge — and the
  // same id re-read from an overlapping tile does, under the same diameter
  // agreement the endpoint case requires.
  const idA = bareRunId(a.runLabel);
  const idB = bareRunId(b.runLabel);
  if (idA && idB) {
    if (idA !== idB) return false;
    if (a.pipeDiameter != null && b.pipeDiameter != null && a.pipeDiameter !== b.pipeDiameter) return false;
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
// Filters below answer the question — "is this row a reading of a physical
// thing, or is it something the model scraped off the sheet that isn't one?" — and
// are deliberately NARROW. Three broader structure filters (long-contiguous-run,
// missing-data, sewer-endpoint corroboration) were measured and REJECTED because each
// killed real structures; see CLAUDE.md. Do not widen these into those.

const BARE_HEADING =
  /^(?:(?:PROP|PROPOSED|EX|EXISTING)\.?\s*)?(?:\((?:STM|SAN|WTR|WATER|STORM|SANITARY)\)\s*)?(?:SANITARY|STORM|WATER|SEWER|SEWER\s+CONNECTION|WATER\s+METER|WATER\s+VAULT|GAS|HYDRO|ELECTRICAL)(?:\s*\((?:STM|SAN|WTR|WATER|STORM|SANITARY)\))?$/i;

const ELEVATION_EQUATION = /\b(?:INV|T\/?G)\s*=\s*\d/i;

const NON_STRUCTURE_KEYWORDS =
  /\b(?:BIKE\s+RACKS?|RETAINING\s+WALLS?|DEPRESSED\s+CURBS?|MUD\s+MATS?|SNOW\s+STORAGE|SEWER\s+CROSSINGS?|CROSSING\s+C|TRANSFORMERS?|LIGHT\s+POLES?|HYDRO\s+POLES?|SILT\s+FENCES?|TREE\s+PROTECTIONS?|HANDRAILS?|GUARDRAILS?|BOLLARDS?)\b/i;

/**
 * True when a structure description is a civil site feature, bare discipline heading,
 * or elevation equation rather than a structure identifier.
 */
export function isNonStructureFeature(description: string): boolean {
  const d = (description || '').trim();
  if (!d) return false;
  if (ELEVATION_EQUATION.test(d)) return true;
  if (NON_STRUCTURE_KEYWORDS.test(d)) return true;
  const stripped = d.replace(/^[^\w]+|[^\w]+$/g, '').trim();
  if (BARE_HEADING.test(stripped)) return true;
  return false;
}

export function dropNonStructureFeatures(structures: StructureFact[]): {
  structures: StructureFact[];
  dropped: string[];
} {
  const dropped: string[] = [];
  const kept = structures.filter((s) => {
    if (!isNonStructureFeature(s.description)) return true;
    dropped.push(s.description);
    return false;
  });
  return { structures: kept, dropped };
}

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
const HAS_STRUCTURE_ID =
  /\b(?:EX\.?\s*)?(?:DDICB|DICBMH|DCBMH|CBMH|DICB|DCB|CB|MH|OCS|HS|HW|OS|FES|JF|EF|TD|AD|STMH)\s*\.?\s*\d/i;
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
 * a group's quantity is far outside that bound it is not a takeoff count, and it must
 * not flow into the priced estimate. Two failure modes produce such quantities:
 *
 *  - A misread number (a station, an elevation, a dimension) read as a quantity: one
 *    golden project reports 249 single CBs on a site whose whole extracted network
 *    is 16 rows.
 *  - A site-wide numbering enumeration read as units: Panattoni's grading plan
 *    numbers every catchbasin on the site (CB0–CB805, a complete sequence; 915 of
 *    the blocks were transcribed from a single tile), and label-counting assembly
 *    summed the labels into an 806-unit SINGLE_CB group against an extracted
 *    network of 246 rows (3.3x) — while the estimator's servicing takeoff for the
 *    project counts 32 units in scoped groups. The earlier 4x ceiling never fired
 *    here because the same over-extraction that inflated the count also inflated
 *    the network it was measured against.
 *
 * The ceiling is 2x the extracted network (floor 10, so tiny drawings are not
 * squeezed). Calibration is corpus-bound: the highest genuine per-group ratio in
 * the golden truths is Eric Smith Way's 27 singles on a 25-row network (~1.1x), so
 * 2x leaves real headroom above anything genuine — including CB-dense lots whose
 * network extraction under-reads — while the enumeration failure sits at 3.3x.
 *
 * The offending group is DROPPED, not clamped: having declared the number out of
 * scope we do not get to substitute a different one. A warning records the loss so
 * the estimator sees a gap rather than a fabricated quantity.
 */
export function dropImplausibleCatchbasinGroups(
  groups: TakeoffFacts['catchbasins'],
  networkSize: number
): { catchbasins: TakeoffFacts['catchbasins']; dropped: { type: string; quantity: number }[] } {
  const ceiling = 2 * Math.max(networkSize, 10);
  const dropped: { type: string; quantity: number }[] = [];
  const kept = groups.filter((g) => {
    if ((g.quantity || 0) <= ceiling) return true;
    dropped.push({ type: g.type, quantity: g.quantity });
    return false;
  });
  return { catchbasins: kept, dropped };
}

// A plain surface catchbasin ("CB 3", "DCB 101", "DICB 301", "DDICB 5") is NOT a
// structure in the estimator's schema. It is counted in the grouped `catchbasins`
// quantity block, by type — truth has ZERO surface catchbasins in `structures`
// across the whole golden corpus. Extraction nonetheless emits them as structure
// rows, where every one is an unmatched false positive and pure precision loss.
//
// The boundary that MUST hold: a catchbasin MANHOLE (CBMH / DCBMH / DICBMH) is a
// real structure and belongs in `structures` — truth carries 120 of them. So the
// filter is deliberately double-guarded: `(?!MH)` stops the id regex mid-token, and
// MANHOLE_TOKEN rejects the whole description if a manhole id appears ANYWHERE in it
// (a real "CBMH 5 C/W CB LEAD" must not be dropped because of its trailing CB lead).
const MANHOLE_TOKEN = /MH(?![A-Z])/;
// `(?:^|[^A-Z])` is a left boundary that cannot be satisfied inside DCBMH/DICBMH, so
// the CB of a manhole id can never start a match. The number is optional: a bare "CB"
// or "P. CB PER T-705.010" is still a surface catchbasin, not a structure.
const SURFACE_CB_ID = /(?:^|[^A-Z])(?:DDICB|DICB|DCB|CB)(?!MH)\s*\.?\s*#?\s*(?:\d+[A-Z]?)?(?![A-Z0-9])/;

/**
 * True when a structure description names a plain surface catchbasin, which the
 * estimator routes to the grouped `catchbasins` count block rather than `structures`.
 *
 * False for catchbasin manholes (CBMH/DCBMH/DICBMH) and every other structure type.
 */
export function isSurfaceCatchbasin(description: string): boolean {
  const d = (description || '').toUpperCase();
  if (!d.trim()) return false;
  if (MANHOLE_TOKEN.test(d)) return false;
  return SURFACE_CB_ID.test(d);
}

/**
 * Route surface catchbasins out of `structures`. They are NOT discarded information:
 * the reader saw them on the drawing, and the caller is told so in a warning, because
 * removing them from `structures` without a corresponding entry in the `catchbasins`
 * block can leave the catchbasin count understated. We do not invent a quantity to
 * compensate — a number nobody read is not a number we get to supply.
 */
export function dropSurfaceCatchbasinStructures(structures: StructureFact[]): {
  structures: StructureFact[];
  dropped: string[];
} {
  const dropped: string[] = [];
  const kept = structures.filter((s) => {
    if (!isSurfaceCatchbasin(s.description)) return true;
    dropped.push(s.description);
    return false;
  });
  return { structures: kept, dropped };
}

export function reconcileTakeoff(facts: TakeoffFacts): TakeoffFacts {
  // 1. structures: merge by normalized label
  const byLabel = new Map<string, StructureFact[]>();
  for (const s of facts.structures) {
    // normalizeLabel strips the system prefix (the estimator's sheet does too), but storm
    // and sanitary networks number independently: "SAN MH 1" and "MH 1" are two
    // structures, so the merge key keeps the system.
    const base = normalizeLabel(s.description);
    if (!base) continue;
    const k = /^\s*SAN(?:ITARY)?\b/i.test(s.description) ? `SAN|${base}` : base;
    (byLabel.get(k) ?? byLabel.set(k, []).get(k)!).push(s);
  }
  const groupedStructures = Array.from(byLabel.values()).map(mergeStructureGroup);
  // 1b. collapse field-empty phase-suffix re-reads ("MH61E" echoing "MH61") into
  // the one field-bearing form of their base — see collapseEmptySuffixReads for
  // why this can only fire when there is exactly one.
  const suffixCollapse = collapseEmptySuffixReads(groupedStructures);
  const structures = suffixCollapse.structures;

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
  // measured against is the CLEANED one — spec notes and non-structure features must
  // not inflate the budget that decides whether a catchbasin count is plausible.
  const nonStruct = dropNonStructureFeatures(structures);
  const note = dropSpecNoteStructures(nonStruct.structures);
  const cb = dropImplausibleCatchbasinGroups(
    mergeCatchbasinGroups(facts.catchbasins) as TakeoffFacts['catchbasins'],
    note.structures.length + keptSewers.filter((s) => !s.isLineItem).length
  );
  // Surface catchbasins are re-ROUTED, not junk, so this runs AFTER the ceiling above.
  // They are real parts of the drainage network and must still count toward the budget
  // that decides whether a catchbasin quantity is plausible — shrinking that budget by
  // the very rows the catchbasin block is meant to hold would push it toward dropping
  // the legitimate counts.
  const surfaceCb = dropSurfaceCatchbasinStructures(note.structures);

  const warnings = [...facts.warnings];
  if (suffixCollapse.collapsed.length > 0) {
    warnings.push(
      `Collapsed ${suffixCollapse.collapsed.length} field-empty phase-suffix re-read(s) into the structure ` +
        `they duplicate (the suffixed rows carried no measurements of their own): ` +
        `${suffixCollapse.collapsed.slice(0, 8).join(' | ')}${suffixCollapse.collapsed.length > 8 ? ' | …' : ''}`
    );
  }
  if (nonStruct.dropped.length > 0) {
    warnings.push(
      `Dropped ${nonStruct.dropped.length} structure(s) whose description is a civil site feature or heading, not a structure: ` +
        `${nonStruct.dropped.slice(0, 8).join(' | ')}${nonStruct.dropped.length > 8 ? ' | …' : ''}`
    );
  }
  if (note.dropped.length > 0) {
    warnings.push(
      `Dropped ${note.dropped.length} structure(s) whose description is a spec note, not a structure id: ` +
        `${note.dropped.slice(0, 8).join(' | ')}${note.dropped.length > 8 ? ' | …' : ''}`
    );
  }
  if (surfaceCb.dropped.length > 0) {
    warnings.push(
      `Moved ${surfaceCb.dropped.length} surface catchbasin(s) out of the structure list — the estimator ` +
        `counts these in the grouped catchbasin block, not as structures: ` +
        `${surfaceCb.dropped.slice(0, 8).join(' | ')}${surfaceCb.dropped.length > 8 ? ' | …' : ''}. ` +
        `They were read off the drawing but NOT added to any catchbasin quantity, so the catchbasin ` +
        `count may be understated by up to ${surfaceCb.dropped.length}. Verify it against the drawing.`
    );
  }
  for (const d of cb.dropped) {
    warnings.push(
      `Dropped catchbasin group ${d.type} qty ${d.quantity} — implausible against a drainage network of ` +
        `${note.structures.length + keptSewers.length} rows; the quantity is a misread or an ` +
        `out-of-scope enumeration, not a takeoff count. Count these catchbasins manually.`
    );
  }

  return {
    ...facts,
    structures: surfaceCb.structures,
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
