/**
 * Facts-level extraction metric (the redesigned evaluation).
 *
 * The old eval compared the *priced* spreadsheet cell-by-cell, which conflated
 * what the model controls (reading facts off the drawing) with what the costing
 * rules control (dollars). This module scores ONLY the extraction stage:
 *
 *   1. Entity detection — did we find the right structures / pipe runs / mains?
 *      Reported as precision / recall / F1 against ground-truth facts.
 *   2. Field accuracy — on entities matched to ground truth, are the physical
 *      values right? (exact for diameter/class, tolerance for length/slope/depth)
 *
 * Pure and dependency-free, so it is unit-tested with synthetic fixtures and
 * needs none of the (gitignored) project data to validate.
 */
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact } from './types';

export interface EntityScore {
  kind: string;
  truthCount: number;
  predCount: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface FieldScore {
  field: string;
  matched: number;
  total: number;
  accuracy: number;
}

export interface FactsComparison {
  entities: EntityScore[];
  fields: FieldScore[];
  /** Mean F1 across entity kinds. */
  detectionF1: number;
  /** Field accuracy across all compared fields on matched entities. */
  fieldAccuracy: number;
}

// ---- normalization & value matching ----

/**
 * Normalize a structure label for comparison: drop estimator note suffixes
 * (e.g. "MH 1/O.P.", "MH 8/EXT.DROP", "CBMH 1/RIP RAP" -> the bare ID), parens,
 * spaces, and punctuation.
 */
// Storm/sanitary structures are labelled "STMH 1" / "SAN MH 3" / "ST CBMH 2" on the
// drawings, but the estimator's takeoff drops the system qualifier (it lives in a separate
// column) and writes bare "MH 1" / "CBMH 2". Strip a leading storm/san qualifier when it
// sits directly on a structure code + number, so the two match. The `\d` lookahead keeps
// run/schedule IDs like "ST 1" / "SA 2" (storm/sanitary run labels) intact.
const SYS_PREFIX = /^(?:STORM|SANITARY|STM|SAN|ST|SA)(?=(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|HS|OS)\d)/;
export function stripSystemPrefix(token: string): string {
  return token.replace(SYS_PREFIX, '');
}

// Estimator note prefixes that qualify a structure without changing its identity:
// "DIV.MH 2" is MH 2 on a diversion, "CTRL MH 5" is MH 5 used as a control. The
// digit lookahead keeps them anchored to a real structure id.
const QUALIFIER_PREFIX = /^(?:DIV|CTRL|CONTROL|STORMCEPTOR|JELLYFISH|OGS|OILGRITSEPARATOR)(?=(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|HS|OS|JF|EF)\d)/;

// A structure id is (letters)(number)(optional letter suffix). Comparing the number
// NUMERICALLY is what makes "MH01" and "MH 1" the same structure while keeping
// "MH10" distinct — stripping zeros textually would merge them.
const LABEL_PARTS = /^([A-Z]+)0*(\d+)([A-Z]*)$/;

const NOTE_SUFFIX_RE = /[-\s/]+(?:DH|EXT\.?\s*DROP|DROP|OIL\s*GRIT|OGS|RIP\s*RAP|O\.?P\.?|REPL\.?|EX\.?|PROP\.?)$/i;

export function normalizeLabel(label: string): string {
  const pre = (label || '')
    .toUpperCase()
    .replace(/\(.*?\)/g, '')
    .split('/')[0] // drop note suffix after the first slash
    .replace(NOTE_SUFFIX_RE, '') // drop note suffixes after hyphen or space
    .trim();

  const flat = stripSystemPrefix(
    pre
      .replace(/[^A-Z0-9]/g, '')
      .replace(QUALIFIER_PREFIX, '')
  );
  const m = LABEL_PARTS.exec(flat);
  return m ? `${m[1]}${Number(m[2])}${m[3]}` : flat;
}

/**
 * Order-insensitive endpoint signature for a pipe run label ("A-B" == "B-A").
 * Drops note suffixes ("/INS.", "/P.INS.", " / INS.", "c/w …") that would corrupt
 * the endpoint tokens, and maps connection sentinels (CONN/PLUG/OUTLET) to a
 * single stable token so "MH 8-CONN." keeps its second endpoint instead of
 * collapsing to a single node (which caused false matches).
 */
export function runSignature(label: string): string {
  let s = (label || '').toUpperCase();
  s = s.replace(/\bC\/W.*$/, '');   // "c/w ROD.GRATE ..." note
  s = s.replace(/\/.*$/, '');        // anything after the first slash (/INS., /P.INS., /O.P., ...)
  s = s.replace(/\bTO\b/g, '-');
  s = s.replace(/\s+/g, '');
  const tokens = s
    .split('-')
    .map((t) => stripSystemPrefix(t.replace(/[^A-Z0-9]/g, '')))
    .filter(Boolean)
    .map((t) => (/^(CONN|PLUG|OUTLET)/.test(t) ? 'CONN' : t));
  return Array.from(new Set(tokens)).sort().join('|');
}

function numClose(a: number | null, b: number | null, relTol = 0.05): boolean {
  if (a == null || b == null) return false;
  if (a === b) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return true;
  return Math.abs(a - b) / denom <= relTol;
}

function exactNum(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  return a === b;
}

// ---- generic greedy matcher ----

function matchByKey<T>(pred: T[], truth: T[], key: (t: T) => string) {
  const predByKey = new Map<string, T[]>();
  for (const p of pred) {
    const k = key(p);
    if (!k) continue;
    const bucket = predByKey.get(k);
    if (bucket) bucket.push(p);
    else predByKey.set(k, [p]);
  }
  const pairs: { p: T; t: T }[] = [];
  let matched = 0;
  for (const t of truth) {
    const k = key(t);
    const bucket = predByKey.get(k);
    if (bucket && bucket.length > 0) {
      const p = bucket.shift()!;
      pairs.push({ p, t });
      matched++;
    }
  }
  return { matched, pairs };
}

// A sewer run is a physical pipe. Many drawings label runs only by a dimension
// callout ("45.0m-250mm PVC STM @0.5%"), not by FROM-TO structures, so endpoint-label
// matching misses them even when the pipe itself is captured correctly. As a fallback
// we match an unmatched pred/truth run pair by physical attributes: same diameter,
// close length, and (when both present) close slope.
function sewerAttrMatch(p: SewerFact, t: SewerFact): boolean {
  if (p.pipeDiameter == null || t.pipeDiameter == null || p.pipeDiameter !== t.pipeDiameter) return false;
  if (p.length == null || t.length == null) return false;
  if (Math.abs(p.length - t.length) > Math.max(1.0, 0.05 * t.length)) return false;
  if (p.slope != null && t.slope != null && Math.abs(p.slope - t.slope) > 0.15) return false;
  return true;
}

// ---- structure matching ----

const MANHOLE_FAMILY_RE = /^(?:MH|CBMH|DCBMH|DICBMH|STMH|SANMH|STMCBMH|SANCBMH)(\d+[A-Z]?)$/;
export function manholeFamilyKey(norm: string): string | null {
  const m = MANHOLE_FAMILY_RE.exec(norm);
  return m ? m[1] : null;
}

// ---- domain aliases (phase 3) ----
//
// The drafter names a structure the way it is drawn; the estimator names it the way it is
// purchased. "DIVERSION MH 15" and "DIV.MH 15" are one manhole; "CULTEC C100HD CHAMBERS"
// and "C100 CHAMBER" are one product. Phase 3 pairs those, but ONLY on corroborating
// evidence — the same id/model designation, or an unambiguous singleton (exactly one
// candidate free on each side). Family membership alone is never enough: two Jellyfish
// units in truth and one generic "JELLYFISH UNIT" prediction stay unmatched, because
// which one it is cannot be known.

/** Qualifiers that describe a structure's role without changing which structure it is. */
const ALIAS_PHRASES: [RegExp, string][] = [
  [/\bMAINTENANCE\s*HOLES?\b/g, 'MH'],
  [/\bMANHOLES?\b/g, 'MH'],
  [/\bDOG\s*HOUSE\b/g, 'DH'],
  [/\bDOGHOUSE\b/g, 'DH'],
  [/\bDIVERSION\b/g, 'DIV'],
  [/\bCONTROL\b/g, 'CTRL'],
  [/\bSAFETY\s*PLATFORM\b/g, 'SP'],
  [/\bOPEN\s*PLATFORM\b/g, 'OP'],
];
/** Qualifier tokens (post-expansion) that mark a label as a *qualified* structure. */
const QUALIFIED_RE = /\b(?:CTRL|DIV|DH|SP|OP)\b/;
/**
 * System words. Dropped ONLY from a qualified label ("STM CONTROL MANHOLE" -> "CTRL MH"):
 * the estimator keeps the system in a separate column. Dropping them unconditionally would
 * reduce plain ids like "SAN 1A" to a bare number, which is not an identity.
 */
const SYSTEM_WORDS = /\b(?:STORM|STM|SANITARY|SAN)\b/g;

/**
 * Normalized label with estimator/drafter abbreviations expanded to one spelling, so
 * "DIVERSION MH 15" and "DIV.MH 15" produce the same key.
 */
export function canonicalStructureLabel(label: string): string {
  let s = (label || '').toUpperCase().replace(/\./g, ' ');
  for (const [re, to] of ALIAS_PHRASES) s = s.replace(re, to);
  if (QUALIFIED_RE.test(s)) s = s.replace(SYSTEM_WORDS, ' ');
  return normalizeLabel(s.replace(/\s+/g, ' ').trim());
}

/** A structure typology: a product/equipment family plus its designation, when printed. */
export interface StructureTypology {
  family: string;
  designation: string | null;
}

// A label that already reads as an ordinary sewer structure id is that structure, even when
// it carries a treatment note ("MH 3/OGS/EF 06" is MH 3, not an OGS unit).
const PLAIN_STRUCTURE_ID = /^(?:DDICB|DCBMH|DICBMH|CBMH|DICB|DCB|STMH|SANMH|MH|CB|HS|EF)\d/;

// Oil-grit-separator / pre-treatment product families. The code and the product name are
// the same unit: JF = Jellyfish, STC = Stormceptor, HF = Hydrofilter. Each regex consumes
// only the LETTERS so an attached designation ("JF4-1-1") survives into `designation`.
const OGS_FAMILIES: [RegExp, string][] = [
  [/\b(?:JELLY\s*FISH|JF)(?=\d|\b)/, 'JF'],
  [/\b(?:STORMCEPTOR|STC)(?=\d|\b)/, 'STC'],
  [/\b(?:HYDRO\s*FILTER|HF)(?=\d|\b)/, 'HF'],
  [/\bCDS(?=\d|\b)/, 'CDS'],
  [/\b(?:OIL[\s-]*GRIT[\s-]*SEPARATOR|OGS)(?=\d|\b)/, 'OGS'],
];

const CHAMBER_WORD = /\b(?:CHAMBERS?|VAULTS?)\b/;
const VAULT_WORD = /\bVAULTS?\b/;
// Estimator chamber codes, as a whole normalized id: VC 300 (valve chamber), DC 150 /
// DCVC-200 (double-check valve chamber), WMC 100 (water meter chamber).
const CHAMBER_CODE = /^(DCVC|WMC|VC|DC)(\d*)$/;
const CHAMBER_SPELLED: [RegExp, string][] = [
  [/\bDOUBLE\s*CHECK\b/, 'DC'],
  [/\bWATER\s*METER\b/, 'WMC'],
  [/\bVALVE\b/, 'VC'],
];
// A manufacturer model core: CULTEC C100HD, ADS StormTech MC-3500. The trailing grade
// letters ("HD") are a variant of the same line, so the core is letters + digits.
const MODEL_CORE = /\b([A-Z]{1,3})[-\s]?(\d{2,5})(?:[A-Z]{1,3})?\b/;

function digitsOf(s: string): string | null {
  const m = s.match(/\d+/g);
  return m && m.length > 0 ? m.join('-') : null;
}

/**
 * Classify a structure label into a product/equipment typology, or null when it is an
 * ordinary sewer structure (which phases 1 and 2 already handle).
 */
export function structureTypology(label: string): StructureTypology | null {
  const raw = (label || '').toUpperCase();
  if (!raw.trim()) return null;
  const norm = normalizeLabel(label);

  // Doghouse manholes are marked with a note ("MH 1A-DH") or spelled out
  // ("DOGHOUSE MAINTENANCE HOLE"). Allowed on plain ids: the note IS the qualifier.
  if (/\bDOG\s*HOUSE\b|\bDOGHOUSE\b|\bDH\b/.test(raw)) {
    return { family: 'DOGHOUSE', designation: PLAIN_STRUCTURE_ID.test(norm) ? norm : digitsOf(raw) };
  }

  if (PLAIN_STRUCTURE_ID.test(norm)) return null;

  for (const [re, fam] of OGS_FAMILIES) {
    if (re.test(raw)) return { family: `OGS:${fam}`, designation: digitsOf(raw.replace(re, ' ')) };
  }

  const code = CHAMBER_CODE.exec(norm);
  if (code) return { family: `CH:${code[1] === 'DCVC' ? 'DC' : code[1]}`, designation: code[2] || null };
  if (CHAMBER_WORD.test(raw)) {
    for (const [re, fam] of CHAMBER_SPELLED) {
      if (re.test(raw)) return { family: `CH:${fam}`, designation: digitsOf(raw) };
    }
    const model = MODEL_CORE.exec(raw);
    if (model) return { family: `CH:${model[1]}${model[2]}`, designation: null };
    return { family: VAULT_WORD.test(raw) ? 'CH:VAULT' : 'CH:CHAMBER', designation: digitsOf(raw) };
  }
  return null;
}

/** One free structure within a typology family, carrying its model designation (if printed). */
interface FamilyRow {
  s: StructureFact;
  d: string | null;
}

/**
 * Pair free structures whose typologies denote the same physical unit.
 *
 * Within a family, two rules — both requiring the pairing to be UNAMBIGUOUS:
 *   (i)  the same designation, present exactly once on each side; then
 *   (ii) an unambiguous singleton: one candidate left on each side, and not two
 *        CONFLICTING designations (truth "JF 4-1-1" never pairs with pred "JF 6-3-1").
 */
function matchTypologies(
  pred: StructureFact[],
  truth: StructureFact[],
  usedPred: Set<StructureFact>,
  usedTruth: Set<StructureFact>,
  pairs: { p: StructureFact; t: StructureFact }[]
): void {
  const group = (list: StructureFact[], used: Set<StructureFact>): Map<string, FamilyRow[]> => {
    const byFamily = new Map<string, FamilyRow[]>();
    for (const s of list) {
      if (used.has(s)) continue;
      const ty = structureTypology(s.description);
      if (!ty) continue;
      const bucket = byFamily.get(ty.family);
      if (bucket) bucket.push({ s, d: ty.designation });
      else byFamily.set(ty.family, [{ s, d: ty.designation }]);
    }
    return byFamily;
  };
  const truthByFamily = group(truth, usedTruth);
  const predByFamily = group(pred, usedPred);

  for (const [family, ts] of truthByFamily) {
    let ps: FamilyRow[] | undefined = predByFamily.get(family);
    if (!ps) continue;
    let remainingT: FamilyRow[] = ts;

    // (i) same designation, unambiguous on both sides.
    const once = (list: FamilyRow[], d: string): boolean => list.filter((x) => x.d === d).length === 1;
    for (const t of ts) {
      if (t.d == null || !once(remainingT, t.d) || !once(ps, t.d)) continue;
      const p: FamilyRow = ps.find((x) => x.d === t.d)!;
      usedPred.add(p.s); usedTruth.add(t.s); pairs.push({ p: p.s, t: t.s });
      remainingT = remainingT.filter((x) => x !== t);
      ps = ps.filter((x) => x !== p);
    }

    // (ii) unambiguous singleton, with no conflicting designation.
    if (remainingT.length === 1 && ps.length === 1) {
      const t = remainingT[0], p = ps[0];
      if (t.d == null || p.d == null || t.d === p.d) {
        usedPred.add(p.s); usedTruth.add(t.s); pairs.push({ p: p.s, t: t.s });
      }
    }
  }
}

/**
 * Structure matching:
 * Phase 1: strict normalized label equality (exact match).
 * Phase 2: manhole family prefix relaxation (e.g. "MH 5" <-> "CBMH 5", "CBMH 10" <-> "MH 10").
 * Only applies when both structure labels belong to the manhole family and share the exact same
 * numeric identifier, matching the common drafter vs estimator convention mismatch.
 * Phase 3a: qualifier-abbreviation equality ("DIVERSION MH 15" <-> "DIV.MH 15"), one pair per
 * key and only when that key is unambiguous (exactly one free row on each side).
 * Phase 3b: product/equipment typology (OGS units, chambers/vaults, doghouse MHs).
 *
 * Every phase is frozen once it has run: a later, weaker phase only ever consults rows that
 * are still free, so it can never break a stronger pair to gain a count. Matching stays
 * strictly one-to-one throughout.
 */
export function matchStructures(pred: StructureFact[], truth: StructureFact[]) {
  const first = matchByKey<StructureFact>(pred, truth, (s) => normalizeLabel(s.description));
  const usedPred = new Set(first.pairs.map((x) => x.p));
  const usedTruth = new Set(first.pairs.map((x) => x.t));
  const pairs = [...first.pairs];

  for (const t of truth) {
    if (usedTruth.has(t)) continue;
    const tn = normalizeLabel(t.description);
    const tk = manholeFamilyKey(tn);
    if (!tk) continue;
    const p = pred.find((q) => !usedPred.has(q) && manholeFamilyKey(normalizeLabel(q.description)) === tk);
    if (p) {
      usedPred.add(p);
      usedTruth.add(t);
      pairs.push({ p, t });
    }
  }

  // Phase 3a: qualifier abbreviations. Unique-key only, so "CTRL MH" is not pinned to one
  // of three predicted control manholes at random.
  {
    const keyed = (list: StructureFact[], used: Set<StructureFact>) => {
      const byKey = new Map<string, StructureFact[]>();
      for (const s of list) {
        if (used.has(s)) continue;
        const k = canonicalStructureLabel(s.description);
        if (!k) continue;
        const bucket = byKey.get(k);
        if (bucket) bucket.push(s);
        else byKey.set(k, [s]);
      }
      return byKey;
    };
    const truthByKey = keyed(truth, usedTruth);
    const predByKey = keyed(pred, usedPred);
    for (const [k, ts] of truthByKey) {
      const ps = predByKey.get(k);
      if (!ps || ts.length !== 1 || ps.length !== 1) continue;
      usedPred.add(ps[0]);
      usedTruth.add(ts[0]);
      pairs.push({ p: ps[0], t: ts[0] });
    }
  }

  // Phase 3b: product/equipment typology.
  matchTypologies(pred, truth, usedPred, usedTruth, pairs);

  return { matched: pairs.length, pairs };
}

// Endpoint structure tokens of a run label, for partial matching (drop /notes and the
// CONN/PLUG/WYE sentinels, which are ends the drawing abstracts rather than named structures).
function runEndpoints(label: string): string[] {
  return String(label).split(/[-–]/)
    .map((p) => normalizeLabel(p.split('/')[0]))
    .filter((x) => x && x !== 'CONN' && x !== 'PLUG' && x !== 'WYE');
}

// The same physical run where truth names an endpoint the drawing abstracted (truth
// "MH 2-CONN." vs pred "MH 2-MH 1") shares one endpoint + the diameter. Require a close-ish
// length too so two different pipes out of the same structure can't false-match.
function sewerSharedEndpointMatch(p: SewerFact, t: SewerFact): boolean {
  if (p.pipeDiameter == null || t.pipeDiameter == null || p.pipeDiameter !== t.pipeDiameter) return false;
  if (p.length == null || t.length == null || Math.abs(p.length - t.length) > Math.max(3, 0.25 * t.length)) return false;
  const te = runEndpoints(t.runLabel);
  return te.length > 0 && runEndpoints(p.runLabel).some((x) => te.includes(x));
}

export function matchSewerRuns(pred: SewerFact[], truth: SewerFact[]) {
  // Phase 1: endpoint-label signature (strict, preferred).
  const first = matchByKey<SewerFact>(pred, truth, (s) => runSignature(s.runLabel));
  const usedPred = new Set(first.pairs.map((x) => x.p));
  const usedTruth = new Set(first.pairs.map((x) => x.t));
  const pairs = [...first.pairs];
  // Phase 2: attribute fallback on the leftovers.
  augmentPhase(pred, truth, usedPred, usedTruth, pairs, sewerAttrMatch);
  // Phase 3: shared endpoint + same diameter + close-ish length.
  augmentPhase(pred, truth, usedPred, usedTruth, pairs, sewerSharedEndpointMatch);
  return { matched: pairs.length, pairs };
}

/**
 * Pair up whatever a phase's predicate allows, taking the MAXIMUM number of pairs it
 * admits rather than the first ones a single pass happens to find.
 *
 * This loosens no evidence: a pair is still made only where the phase predicate says
 * the two rows describe the same physical pipe. It fixes contention only. Scanning once
 * and keeping the first eligible prediction lets one truth run consume a prediction that
 * was the ONLY candidate for a later truth run, so a pairing the predicate fully permits
 * is lost to iteration order. Augmenting paths (Kuhn's) re-seat earlier pairs *within
 * this phase* when that frees a prediction, which cannot manufacture a pair the
 * predicate would reject.
 *
 * Earlier phases are frozen: their pairs rest on stronger evidence, so a weaker phase is
 * never allowed to break one to gain a count. Candidates are tried closest-length first,
 * so when several predictions are admissible the best-measured one is the pair whose
 * fields get scored (the same intent as matchWatermain's phase ordering).
 */
function augmentPhase(
  pred: SewerFact[],
  truth: SewerFact[],
  usedPred: Set<SewerFact>,
  usedTruth: Set<SewerFact>,
  pairs: { p: SewerFact; t: SewerFact }[],
  eligible: (p: SewerFact, t: SewerFact) => boolean
): void {
  const freeTruth = truth.filter((t) => !usedTruth.has(t));
  const freePred = pred.filter((p) => !usedPred.has(p));
  if (freeTruth.length === 0 || freePred.length === 0) return;

  const gap = (p: SewerFact, t: SewerFact) =>
    p.length == null || t.length == null ? Number.POSITIVE_INFINITY : Math.abs(p.length - t.length);
  const candidates = freeTruth.map((t) =>
    freePred
      .map((_, i) => i)
      .filter((i) => eligible(freePred[i], t))
      .sort((a, b) => gap(freePred[a], t) - gap(freePred[b], t))
  );

  const owner: number[] = new Array(freePred.length).fill(-1);
  const assign = (ti: number, seen: boolean[]): boolean => {
    for (const pi of candidates[ti]) {
      if (seen[pi]) continue;
      seen[pi] = true;
      if (owner[pi] === -1 || assign(owner[pi], seen)) {
        owner[pi] = ti;
        return true;
      }
    }
    return false;
  };
  for (let ti = 0; ti < freeTruth.length; ti++) assign(ti, new Array(freePred.length).fill(false));

  for (let pi = 0; pi < owner.length; pi++) {
    if (owner[pi] === -1) continue;
    const p = freePred[pi];
    const t = freeTruth[owner[pi]];
    usedPred.add(p);
    usedTruth.add(t);
    pairs.push({ p, t });
  }
}

/**
 * Watermain matching, three phases from strongest to weakest evidence — the same
 * shape as matchSewerRuns.
 *
 * A watermain row's IDENTITY is its pipe size: the estimator's workbook carries one
 * row per diameter with the total length of that size, not one row per segment.
 * Length is therefore a FIELD of the row, not part of its identity.
 *
 * Phase 3 (diameter alone) exists because requiring length agreement to *detect* a
 * pipe conflated two different failures: a 200mm main that was found but mismeasured
 * scored as "not found", AND — because field accuracy only scores matched pairs — its
 * wrong length then vanished from watermain.length entirely. The defect was real but
 * invisible in both numbers. Detection now counts the pipe; the bad length shows up in
 * watermain.length where it belongs.
 *
 * Phases run strongest-first so that when several pred rows share a diameter, the one
 * with the right length is the pair that gets scored for fields.
 */
function matchWatermain(pred: WatermainFact[], truth: WatermainFact[]) {
  const first = matchByKey<WatermainFact>(pred, truth, (w) => normalizeLabel(w.sizeAndType));
  const usedPred = new Set(first.pairs.map((x) => x.p));
  const usedTruth = new Set(first.pairs.map((x) => x.t));
  const pairs = [...first.pairs];

  const sameDiameter = (q: WatermainFact, t: WatermainFact) =>
    q.pipeDiameter != null && t.pipeDiameter != null && q.pipeDiameter === t.pipeDiameter;

  // Phase 2: same diameter AND a close length — the confident pairing.
  for (const t of truth) {
    if (usedTruth.has(t)) continue;
    const p = pred.find((q) => !usedPred.has(q) && sameDiameter(q, t)
      && Math.abs(q.length - t.length) <= Math.max(2, 0.1 * t.length));
    if (p) { usedPred.add(p); usedTruth.add(t); pairs.push({ p, t }); }
  }

  // Phase 3: same diameter, any length. Detection only — the length still gets
  // scored (and fails) as a field.
  for (const t of truth) {
    if (usedTruth.has(t)) continue;
    const p = pred.find((q) => !usedPred.has(q) && sameDiameter(q, t));
    if (p) { usedPred.add(p); usedTruth.add(t); pairs.push({ p, t }); }
  }
  return { matched: pairs.length, pairs };
}

function prf(matched: number, predCount: number, truthCount: number): EntityScore {
  const precision = predCount > 0 ? matched / predCount : truthCount === 0 ? 1 : 0;
  const recall = truthCount > 0 ? matched / truthCount : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { kind: '', truthCount, predCount, matched, precision, recall, f1 };
}

// ---- field scorers ----

function scoreFields<T>(
  pairs: { p: T; t: T }[],
  specs: { field: string; ok: (p: T, t: T) => boolean; present: (t: T) => boolean }[]
): FieldScore[] {
  return specs.map(({ field, ok, present }) => {
    let matched = 0;
    let total = 0;
    for (const { p, t } of pairs) {
      if (!present(t)) continue;
      total++;
      if (ok(p, t)) matched++;
    }
    return { field, matched, total, accuracy: total > 0 ? matched / total : 1 };
  });
}

export function compareFacts(pred: TakeoffFacts, truth: TakeoffFacts): FactsComparison {
  const entities: EntityScore[] = [];
  const fields: FieldScore[] = [];

  // Structures — match by normalized label with manhole family fallback
  {
    const m = matchStructures(pred.structures, truth.structures);
    entities.push({ ...prf(m.matched, pred.structures.length, truth.structures.length), kind: 'structures' });
    fields.push(
      ...scoreFields(m.pairs, [
        { field: 'structure.topElevation', present: (t) => t.topElevation != null, ok: (p, t) => numClose(p.topElevation, t.topElevation) },
        { field: 'structure.lowInvert', present: (t) => t.lowInvert != null, ok: (p, t) => numClose(p.lowInvert, t.lowInvert) },
        { field: 'structure.pipeOutDiameter', present: (t) => t.pipeOutDiameter != null, ok: (p, t) => exactNum(p.pipeOutDiameter, t.pipeOutDiameter) },
      ])
    );
  }

  // Sewer pipe runs — match by endpoint signature (line-item fee rows excluded)
  {
    const predRuns = pred.sewers.filter((s) => !s.isLineItem);
    const truthRuns = truth.sewers.filter((s) => !s.isLineItem);
    const m = matchSewerRuns(predRuns, truthRuns);
    entities.push({ ...prf(m.matched, predRuns.length, truthRuns.length), kind: 'sewerRuns' });
    fields.push(
      ...scoreFields(m.pairs, [
        { field: 'sewer.length', present: (t) => t.length != null, ok: (p, t) => numClose(p.length, t.length) },
        { field: 'sewer.pipeDiameter', present: (t) => t.pipeDiameter != null, ok: (p, t) => exactNum(p.pipeDiameter, t.pipeDiameter) },
        { field: 'sewer.typeClass', present: (t) => t.typeClass != null, ok: (p, t) => numClose(p.typeClass, t.typeClass, 0.02) },
        { field: 'sewer.slope', present: (t) => t.slope != null, ok: (p, t) => numClose(p.slope, t.slope) },
        { field: 'sewer.depth', present: (t) => t.depth != null, ok: (p, t) => numClose(p.depth, t.depth, 0.1) },
      ])
    );
  }

  // Catchbasins — counted by type; compare per-type quantities (recall/precision on units)
  {
    const cbTypes = ['SINGLE_CB', 'DOUBLE_CB', 'DITCH_INLET_CB', 'DOUBLE_DITCH_INLET_CB'] as const;
    const qty = (list: typeof pred.catchbasins, ty: string) =>
      list.filter((c) => c.type === ty).reduce((s, c) => s + (c.quantity || 0), 0);
    let cbM = 0, cbT = 0, cbP = 0;
    for (const ty of cbTypes) {
      const tq = qty(truth.catchbasins, ty), pq = qty(pred.catchbasins, ty);
      cbM += Math.min(tq, pq); cbT += tq; cbP += pq;
    }
    if (cbT > 0 || cbP > 0) entities.push({ ...prf(cbM, cbP, cbT), kind: 'catchbasins' });
  }

  // Watermain runs — truth's size/type label is usually blank, so match on diameter + close
  // length (attribute), falling back from any label match. Same physical-pipe logic as sewers.
  {
    const m = matchWatermain(pred.watermain, truth.watermain);
    entities.push({ ...prf(m.matched, pred.watermain.length, truth.watermain.length), kind: 'watermainRuns' });
    fields.push(
      ...scoreFields(m.pairs, [
        { field: 'watermain.length', present: (t) => t.length != null, ok: (p, t) => numClose(p.length, t.length) },
        { field: 'watermain.pipeDiameter', present: (t) => t.pipeDiameter != null, ok: (p, t) => exactNum(p.pipeDiameter, t.pipeDiameter) },
      ])
    );
  }

  // Only average over entity kinds that actually have something to measure (truth
  // present or something predicted). A kind with 0 truth AND 0 predictions is
  // vacuous — counting its F1=1 inflates the score (e.g. no-watermain jobs).
  const active = entities.filter((e) => e.truthCount > 0 || e.predCount > 0);
  const detectionF1 = active.length > 0 ? active.reduce((s, e) => s + e.f1, 0) / active.length : 1;
  const totalFields = fields.reduce((s, f) => s + f.total, 0);
  const matchedFields = fields.reduce((s, f) => s + f.matched, 0);
  const fieldAccuracy = totalFields > 0 ? matchedFields / totalFields : 1;

  return { entities, fields, detectionF1, fieldAccuracy };
}

export function formatFactsComparison(c: FactsComparison): string {
  let out = '\n📐 EXTRACTION FACTS METRIC\n' + '='.repeat(60) + '\n';
  for (const e of c.entities) {
    out += `  ${e.kind.padEnd(16)} P=${(e.precision * 100).toFixed(0)}% R=${(e.recall * 100).toFixed(0)}% F1=${(e.f1 * 100).toFixed(0)}%  (${e.matched}/${e.truthCount} truth, ${e.predCount} pred)\n`;
  }
  out += '  ' + '-'.repeat(56) + '\n';
  for (const f of c.fields) {
    if (f.total === 0) continue;
    out += `  ${f.field.padEnd(28)} ${(f.accuracy * 100).toFixed(0)}%  (${f.matched}/${f.total})\n`;
  }
  out += '  ' + '-'.repeat(56) + '\n';
  out += `  Detection F1: ${(c.detectionF1 * 100).toFixed(1)}%   Field accuracy: ${(c.fieldAccuracy * 100).toFixed(1)}%\n`;
  return out;
}
