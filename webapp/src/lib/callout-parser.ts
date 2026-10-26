/**
 * Grammar for civil-drawing callout strings. Pure, no I/O.
 *
 * The callout language on Ontario servicing drawings is rigidly formulaic:
 *   runs:        "83.7m-375mmØ SAN @ 0.02%", "EX SAN 7.2m - 250mmØ DR 35 @ 0.05%"
 *                "450mm PVC @ 0.5% (25.0m)", "PVC 250mm STM @ 0.5% (40.0m)", "50m of 200mm PVC SAN"
 *   structures:  "EX CBMH1035 (1200Ø)", "STMH 1", "MH 101", "HW 1", "OCS 1",
 *                "VALVE CHAMBER 1", "DOUBLE CHECK VALVE VAULT", "MC-3500", "C100HD"
 *   elevations:  "T/G=224.95", "N INV=223.350", "SW INV = 310.60", "OUT INV 150.20", "RIM 250.00"
 *   watermain:   "EX. 300 mmØ PVC WATERMAIN", "EX WM - 250 mm", "150mm FIRE SERVICE",
 *                "HYDRANT LEAD (150mm)"
 * These parsers are the single place that grammar lives; both the text-layer
 * path (text-takeoff.ts) and the vision-transcript path (transcript-takeoff.ts)
 * feed through them.
 *
 * Two structural conventions worth knowing before editing:
 *  - Optional result fields (`insulated`, `service`) are left **undefined** rather than
 *    set to a falsy value. Callers and tests compare whole parse results with `toEqual`,
 *    which ignores undefined keys, so this keeps additive fields from churning every
 *    existing assertion.
 *  - Every alternation that shares a prefix is ordered longest-first (DCBMH before DCB,
 *    DCVC before DC, INVERT before INV). Regex alternation is first-match-wins at a given
 *    position, so reordering these silently truncates labels.
 */
import { snapToPipeDiameter, normalizeSlope } from './geometry';

export interface ParsedRun {
  length: number;
  diameterMm: number;
  system: 'STORM' | 'SAN' | 'UNKNOWN';
  material: string | null;
  typeClass: number | null;
  slopePct: number | null;
  existing: boolean;
  /** Only present (as `true`) when the callout marks the pipe insulated ("INS", "P.INS"). */
  insulated?: true;
}
export interface ParsedStructure {
  label: string;
  kind: 'MH' | 'CBMH' | 'DCBMH' | 'CB' | 'DCB' | 'DICB' | 'DDICB' | 'HS' | 'OS' | 'JF' | 'EF'
    | 'CHAMBER' | 'HW' | 'OCS' | 'FES' | 'VAULT' | 'TANK' | 'MHTEE';
  diameterMm: number | null;
  existing: boolean;
  /** Sewer system the label names ("SAN MH 1" vs "STMH 1"), when it says. Storm and
   *  sanitary networks reuse the same numbers, so without this "MH 1" collides. */
  system?: 'SAN' | 'STM' | null;
}
export interface ParsedElevation { type: 'TG' | 'INV'; direction: string | null; value: number; }
export interface ParsedWatermain {
  diameterMm: number;
  lengthM: number | null;
  material: string | null;
  existing: boolean;
  /** Only present when the callout names a branch rather than a plain main. */
  service?: 'DOMESTIC' | 'FIRE' | 'HYDRANT_LEAD';
  /** Only present (as `true`) when the callout marks the pipe insulated. */
  insulated?: true;
}

// "EX", "EX.", "EXIST", "EXISTING" all mark an existing (not-to-be-built) feature.
// The period may butt straight against the length ("EX.110.0 - 450Ø CONC STM"), so a digit
// is accepted after it as well as whitespace — but ONLY after a period, so that "EX9" stays
// unmatched. The trailing test is a lookahead: every caller uses .test(), nothing reads the
// consumed group, and not consuming keeps "EX." adjacent to the number the parsers want.
const EX_RE = /(^|\s)EX(?:IST(?:ING)?)?(?:\.(?=\d)|\.?(?=\s|$))/i;
// length + diameter core: "83.7m-375mmØ", "7.2m - 250mmØ", "45.0m - 250mm", "19.2m-250#",
// "10.5m-300Ø", "30.0m - 375 DIA", "50m of 200mm" (the "of" form is why `of` is an alternative
// to the dash — the length and diameter stay tightly adjacent either way).
const LEN_DIA_RE = /(\d+(?:\.\d+)?)\s*m\b\s*(?:-|–|of)?\s*(\d{2,4})\s*(?:mm|#|Ø|DIA|DIAM)?(?:\b|[^a-zA-Z0-9])/i;
const SLOPE_RE = /@\s*(\d+(?:\.\d+)?)\s*(%|‰)?/;
// DR/SDR accept a hyphen as well as a space ("DR-18" is the common watermain spelling).
const MATERIAL_RE = /\b(PVC|HDPE|CONC|CSP|RCP|DI|(?:S?DR)[\s-]*(\d{1,3}))\b/i;
// Concrete pipe strength class: "CL III", "CL IV", "CLASS 3". Arabic form is capped at two
// digits so a chainage/centreline note ("CL 100+00") cannot be read as a pipe class.
const CLASS_RE = /\bCL(?:ASS)?\.?\s*(IV|III|II|I|V|\d{1,2})\b/i;
const ROMAN_CLASS: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
// "INS", "INS.", "P.INS", "POLY INS", "INSULATED", "INSULATION" — the leading \b after a
// period or space means the POLY/P. prefixes need no branch of their own. "INSPECTION" is
// NOT matched (no word boundary after its "INS").
const INSULATED_RE = /\bINS(?:UL(?:ATED|ATION))?\b/i;
// Watermain, including the branch forms that never say "water" at all (fire service,
// hydrant lead). Deliberately NOT a bare \bWATER\b — that would swallow "WATER QUALITY UNIT".
// PR25: two dialect gaps closed. "WTM" is the standard abbreviation a whole office
// (Project Crimson) uses for every watermain callout ("250mmØ DOM. WTM", "150mmØ WTM");
// without it those callouts parsed as nothing at all. And a bare "DOMESTIC" names the
// domestic water service in this dialect ("PROP. 68.00m - 150mmØ PVC DOMESTIC",
// "100mmØ DOMESTIC") — sewers here are "SANITARY", never "domestic" — so the bare word
// is a watermain token too; without it such callouts parsed as SEWER runs, because
// parseRunCallout's only protection is this regex (it refuses WM_RE lines outright).
// A bare "FIRE" was tried and REVERTED in the same PR: it minted watermain rows out
// of spec prose ("A 50MM OUTLET ON 100MM AND LARGER LINES … ON FIRE LINES, FLUSHING
// OUTLET …"), costing Loretto Abbey 8.3 detF1 points. The trailing form
// ("…150mmØ PVC FIRE", Stevenson) therefore still reads as a run — documented
// residue; FIRE needs a companion word (SERVICE/LINE/WATER) to count.
const WM_RE = /\b(?:WATERMAIN|WATER\s+MAIN|WM|W\/M|WTM)\b|\b(?:DOMESTIC|FIRE)\s+(?:WATER|SERVICE|LINE)\b|\bDOMESTIC\b|\bWATER\s+SERVICE\b|\bHYD(?:RANT)?\s+LEAD\b/i;
const SUBDRAIN_RE = /\bSUB[\s-]?DRAIN\b/i;
// Shared pattern: diameter in millimetres (used by both watermain and subdrain parsers)
const DIA_MM_RE = /(\d{2,4})\s*mm/i;

// Leading length with the "m" unit dropped: "44.1 - 200# PVC CL. 65.0 STM @ 0.30%".
// Nothing marks the first number as a length here, so this form is deliberately the
// narrowest of the three: the two figures must be separated by a dash, the diameter must
// carry an explicit unit, and the line must corroborate a pipe. Drop any one of those and
// a job number ("2026 - 050 STM") or an aggregate spec ("75-200mm CLEAR") reads as a run.
const LEN_DIA_NO_UNIT_RE = /(\d+(?:\.\d+)?)\s*(?:-|–)\s*(\d{2,4})\s*(?:mm|#|Ø|DIAM|DIA)/i;

// --- diameter-first run forms -------------------------------------------------------------
// "450mm PVC @ 0.5% (25.0m)", "300mm CONC CL III (12.5m)", "PVC 250mm STM @ 0.5% (40.0m)".
// Unlike LEN_DIA_RE the diameter has no adjacent length to anchor it, so the unit is
// REQUIRED here — otherwise any 2-4 digit number on the line would read as a pipe size.
const DIA_UNIT_RE = /(\d{2,4})\s*(?:mm|#|Ø|DIAM|DIA)/i;
// Trailing parenthesised length: "(25.0m)", "(15m)".
const PAREN_LEN_RE = /\(\s*(\d+(?:\.\d+)?)\s*m\s*\)/i;
// A bare length token. The (?!m) guard is what stops "450mm" being read as "450m" + "m".
const BARE_LEN_RE = /(?:^|[\s(\-–])(\d+(?:\.\d+)?)\s*m\b(?!m)/i;

// System tag. Shared by the run parser's corroboration test and the wrapped-callout
// predicates below, so "is this line talking about a sewer" is decided in one place.
const SYSTEM_RE = /\b(SAN|SANITARY|STM|STORM)\b/i;
// The length half of a wrapped callout on a line of its own: "(25.0m)", "- 45.0m", "45.0m".
// Anchored to the WHOLE line — a bare figure is far too common on a drawing to vacuum into
// the preceding callout unless it is literally all the line says.
const LENGTH_ONLY_RE = /^[\s(\-–]*\d+(?:\.\d+)?\s*m\s*\)?[.,]?$/i;
// Standalone DR/SDR probe. MATERIAL_RE returns only its FIRST match, so on the very common
// "250mm PVC DR35" the material is PVC and the DR rating never reaches group 2 — this finds
// the rating wherever it sits on the line.
const DR_RE = /\b(?:S?DR)[\s-]*(\d{1,3})\b/i;

/** DR/SDR number if present, else the concrete strength class (roman or arabic). */
function parseTypeClass(line: string, mat: RegExpExecArray | null): number | null {
  if (mat && mat[2]) return parseInt(mat[2], 10);
  const dr = DR_RE.exec(line);
  if (dr) return parseInt(dr[1], 10);
  const cl = CLASS_RE.exec(line);
  if (!cl) return null;
  const token = cl[1].toUpperCase();
  if (token in ROMAN_CLASS) return ROMAN_CLASS[token];
  const n = parseInt(token, 10);
  return Number.isFinite(n) ? n : null;
}

function buildRun(line: string, length: number, rawDiameter: number): ParsedRun {
  const slope = SLOPE_RE.exec(line);
  const mat = MATERIAL_RE.exec(line);
  const system = /\b(SAN|SANITARY)\b/i.test(line) ? 'SAN'
    : /\b(STM|STORM)\b/i.test(line) ? 'STORM' : 'UNKNOWN';
  let slopePct: number | null = null;
  if (slope) {
    const v = parseFloat(slope[1]);
    slopePct = slope[2] === '‰' ? v / 10 : normalizeSlope(v);
  }
  return {
    length,
    diameterMm: snapToPipeDiameter(rawDiameter),
    system,
    material: mat ? mat[1].replace(/\s+/g, ' ').trim().toUpperCase() : null,
    typeClass: parseTypeClass(line, mat),
    slopePct,
    existing: EX_RE.test(line),
    insulated: INSULATED_RE.test(line) ? true : undefined,
  };
}

/** Does the line say "pipe" by any means other than its figures? */
function corroboratesPipe(line: string): boolean {
  return SLOPE_RE.test(line) || MATERIAL_RE.test(line) || CLASS_RE.test(line) || SYSTEM_RE.test(line);
}

export function parseRunCallout(line: string): ParsedRun | null {
  if (WM_RE.test(line)) return null; // watermain callouts share the mm form
  if (SUBDRAIN_RE.test(line)) return null; // subdrains share the mm form but are handled separately

  // Form 1 (canonical): length first, diameter tightly coupled to it.
  const core = LEN_DIA_RE.exec(line);
  if (core) return buildRun(line, parseFloat(core[1]), parseInt(core[2], 10));

  // Form 2: diameter first, length stated separately ("450mm PVC @ 0.5% (25.0m)") or the
  // material written ahead of the size ("PVC 250mm STM @ 0.5% (40.0m)"). Because neither the
  // length nor the diameter anchors the other here, this form is only accepted when the line
  // states a length AND carries at least one corroborating pipe signal (slope, material,
  // strength class, or a system tag). Without that guard a structure callout such as
  // "CBMH 1 (1200Ø)" would be misread as a 1200mm pipe run.
  // Form 1b: as Form 1 but with the "m" unit missing from the length. Requires the
  // corroboration Form 1 gets for free from that unit (see LEN_DIA_NO_UNIT_RE).
  const loose = LEN_DIA_NO_UNIT_RE.exec(line);
  if (loose && corroboratesPipe(line)) {
    return buildRun(line, parseFloat(loose[1]), parseInt(loose[2], 10));
  }

  const dia = DIA_UNIT_RE.exec(line);
  if (!dia) return null;
  const parenLen = PAREN_LEN_RE.exec(line);
  const bareLen = parenLen ? null : BARE_LEN_RE.exec(line);
  const lengthText = parenLen ? parenLen[1] : bareLen ? bareLen[1] : null;
  if (lengthText === null) return null;
  if (!corroboratesPipe(line)) return null;
  return buildRun(line, parseFloat(lengthText), parseInt(dia[1], 10));
}

export interface ParsedScheduleRun {
  /** Run id as the schedule writes it, normalised: uppercased, glued, footnote
   *  asterisks stripped ("ST4A", "SA2"). This is the run's identity — the same
   *  form compare-facts' runSignature reduces the estimator's "ST 4A" to. */
  id: string;
  length: number;
  diameterMm: number;
  slopePct: number | null;
  /** The one unclassified text cell (material/class, e.g. "PVC DR35"), when present. */
  material: string | null;
}

// A schedule row's id cell: a short series code + number (+ optional letter
// suffix), with the drafter's footnote asterisks tolerated ("ST7 **"). An
// "EX" prefix marks an existing pipe; the row is refused, like everywhere else.
const SCHEDULE_ID_RE = /^\s*(EX\.?\s+)?([A-Za-z]{1,4})\s*#?\s*(\d+)([A-Za-z])?\s*(?:\*{1,2})?\s*$/;
// The length cell must be ONLY a length ("29.6 m") — a unit is required, so a
// bare number from some other table (a structure size, an area, a flow) can
// never pose as one. Same discipline for slope ("1.0%"); the diameter cell is
// the one cell allowed company ("250 mm dia.").
const SCHEDULE_LEN_RE = /^(\d+(?:\.\d+)?)\s*m\.?$/i;
const SCHEDULE_DIA_RE = /^\D{0,12}(\d{3,4})\s*mm\b/i;
const SCHEDULE_SLOPE_RE = /^(\d+(?:\.\d+)?)\s*%$/;
// Series codes that head STRUCTURE schedules, not run schedules. A row headed
// by one of these ("MH1 | 1200 | 701.010 | …") is a structure table — refused
// here whatever its other cells look like (see the schedule-row guard in
// transcript-takeoff for the scope reasoning).
const STRUCTURE_SERIES = new Set([
  'MH', 'STMH', 'SANMH', 'CBMH', 'DCBMH', 'DICBMH', 'CB', 'DCB', 'DICB',
  'DDICB', 'HS', 'HW', 'OS', 'OCS', 'FES', 'JF', 'EF', 'MHTEE',
]);

/**
 * Parse one pipe-delimited SCHEDULE row (already split into cells) as a single
 * sewer run: "ST1 | 29.6 m | 250 mm dia. | PVC DR35 | 1.0%".
 *
 * A schedule row is one pipe whose fields live in separate cells — split the
 * cells apart (transcript-takeoff step 4's fallback) and no cell parses alone,
 * so the run vanishes. This is the row-level reading. It is deliberately
 * strict, because pipe-delimited text is everywhere on a drawing (revision
 * tables, crossing tables, drainage-area tables, fixture schedules) and
 * almost none of it is a pipe schedule:
 *  - the first cell must be a bare run id from a non-structure series;
 *  - exactly one cell may be a bare unit'd length, exactly one a diameter,
 *    at most one a slope, and at most one further cell (the material) may
 *    remain unclassified;
 *  - a row carrying invert/rim cells is a structure row, full stop.
 * Anything ambiguous returns null and the caller falls back to per-cell
 * parsing — never a guess.
 */
export function parseScheduleRunRow(cells: string[]): ParsedScheduleRun | null {
  if (cells.length < 4 || cells.length > 6) return null;
  if (cells.some((c) => /\bINV\b|(?:^|\s)(?:TOP|RIM|T\/?G)\s*=/i.test(c))) return null;

  const idm = SCHEDULE_ID_RE.exec(cells[0]);
  if (!idm || idm[1]) return null; // no id, or an existing (EX) row
  const series = idm[2].toUpperCase();
  if (STRUCTURE_SERIES.has(series)) return null;
  if (HASH_STRUCTURE_HEADER_RE.test(cells[0])) return null;

  let length: number | null = null;
  let dia: number | null = null;
  let slope: number | null = null;
  const rest: string[] = [];
  for (const raw of cells.slice(1)) {
    const cell = raw.trim();
    const lm = SCHEDULE_LEN_RE.exec(cell);
    if (lm) { if (length !== null) return null; length = parseFloat(lm[1]); continue; }
    const dm = SCHEDULE_DIA_RE.exec(cell);
    if (dm) { if (dia !== null) return null; dia = parseInt(dm[1], 10); continue; }
    const sm = SCHEDULE_SLOPE_RE.exec(cell);
    if (sm) { if (slope !== null) return null; slope = parseFloat(sm[1]); continue; }
    rest.push(cell);
  }
  if (length === null || dia === null) return null;
  if (!(length > 0 && length <= 1000)) return null;
  if (slope !== null && !(slope > 0 && slope <= 20)) return null;
  if (rest.length > 1) return null;

  return {
    id: `${series}${parseInt(idm[3], 10)}${(idm[4] || '').toUpperCase()}`,
    length,
    diameterMm: snapToPipeDiameter(dia),
    slopePct: slope !== null ? normalizeSlope(slope) : null,
    material: rest.length ? rest[0] : null,
  };
}

/**
 * The diameter-first head of a wrapped callout: "300mm PVC STM", "250mmØ PVC SAN",
 * "525mm CONC STM" — a size and a pipe signal, with the slope and/or the length still to
 * come on the next visual line.
 *
 * Nothing anchors the diameter here (that is the whole point — the length is on the other
 * line), so the test is deliberately narrow: the line must corroborate "pipe" with a
 * material, strength class or system tag; must state neither a slope nor a length (with
 * either it is a whole callout, not a head); and must not parse as a structure, because
 * "CBMH 1 (1200Ø)" states a diameter too.
 */
function isDiameterFirstHead(line: string): boolean {
  if (SUBDRAIN_RE.test(line)) return false; // priced separately; never folded into a run
  if (!DIA_UNIT_RE.test(line)) return false;
  if (SLOPE_RE.test(line)) return false;
  if (PAREN_LEN_RE.test(line) || BARE_LEN_RE.test(line)) return false;
  if (parseStructureLabel(line) !== null) return false;
  return MATERIAL_RE.test(line) || CLASS_RE.test(line) || SYSTEM_RE.test(line);
}
/**
 * Head half of a callout the drafter wrapped across visual lines. Three shapes occur:
 *   a) length-first   — "45.0m - 250mmØ", the tail carrying the material/slope;
 *   b) diameter-first — "300mm PVC STM", the tail carrying the slope and/or the length;
 *   c) length-only    — "PROPOSED 7.47m", "8.2m -": the callout split at the
 *      length|diameter boundary, its diameter still to come (S4 COL-FRAG, PR58).
 * Form (c) is admitted only when the caller opts in (`opts.colFrag` — the
 * joiners pass the S4 kill-switch state, the parseDetachedElevation
 * convention), and a form-(c) head may be COMMITTED only through
 * parseColFragJoin's conjunction below; the predicate alone never joins.
 */
export function isDanglingRunHead(line: string, opts?: { colFrag?: boolean }): boolean {
  if (WM_RE.test(line)) return false;
  if (LEN_DIA_RE.test(line)) return !SLOPE_RE.test(line) && !MATERIAL_RE.test(line);
  if (isDiameterFirstHead(line)) return true;
  return opts?.colFrag === true && isLengthOnlyRunHead(line);
}

// --- length-only heads (S4 COL-FRAG, PR58) -----------------------------------
// A callout split at the length|diameter boundary leaves its length on a
// line of its own: "PROPOSED 7.47m" (Stevenson, transcript path) and
// "8.2m -" (Oakville, a rotated callout the text layer emits as fragments).
// The head line is FULLY consumed by an optional status prefix, the length,
// and an optional trailing dash — no diameter, no material, no slope,
// nothing else. Any extra word ("12.0m WIDE") disqualifies it: a bare
// figure is far too common on a drawing to trust on shape alone, which is
// why the join side (parseColFragJoin) carries the real conjunction and
// this predicate only names the shape.
const LENGTH_ONLY_HEAD_RE = /^\s*(?:EX(?:IST(?:ING)?)?\.?\s*|(?:NEW|PROP(?:OSED)?|PR)\.?\s+)?\d+(?:\.\d+)?\s*m\s*(?:-|–)?\s*$/i;

export function isLengthOnlyRunHead(line: string): boolean {
  if (WM_RE.test(line)) return false;
  if (!LENGTH_ONLY_HEAD_RE.test(line)) return false;
  if (parseStructureLabel(line) !== null) return false;
  return true;
}

/** Does the line carry a pipe diameter (and no length of its own)? The
 * first-continuation shape a length-only head may join to: "375mmØ",
 * "250mmØ PVC", "375mmØ PVC STM @ 0.50%". A whole neighbouring callout
 * (it carries a length, or parses as a run) is never a fragment. */
export function isDiameterBearingFragment(line: string): boolean {
  if (!DIA_UNIT_RE.test(line)) return false;
  if (LEN_DIA_RE.test(line) || BARE_LEN_RE.test(line) || PAREN_LEN_RE.test(line)) return false;
  if (parseRunCallout(line) !== null) return false;
  if (parseStructureLabel(line) !== null) return false;
  return true;
}

/**
 * Callout-vocabulary residue test: strip every token the callout grammar
 * can consume (slope, lengths, diameters, classes, materials, system
 * tags, status prefixes) and require that nothing but punctuation and
 * whitespace remains. This is what keeps a spec-prose accident — a bare
 * length line that happens to sit next to a pipe tail — from passing as
 * a reassembled callout (the PR44/PR56 loose-scan failure mode).
 */
function calloutTextFullyConsumed(text: string): boolean {
  const rest = text
    .replace(/@\s*\d+(?:\.\d+)?\s*(?:%|‰)?/g, ' ')
    .replace(/\(\s*\d+(?:\.\d+)?\s*m\s*\)/gi, ' ')
    .replace(/\d+(?:\.\d+)?\s*m\b(?!m)/gi, ' ')
    .replace(/\d{2,4}\s*(?:mm|#|Ø|DIAM|DIA)/gi, ' ')
    .replace(/\bS?DR[\s-]*\d{1,3}\b/gi, ' ')
    .replace(/\bCL(?:ASS)?\.?\s*(?:IV|III|II|I|V|\d{1,2})\b/gi, ' ')
    .replace(/\b(?:PVC|HDPE|CONC|CSP|RCP|DI|SAN|SANITARY|STM|STORM|EX|EXIST|EXISTING|NEW|PROP|PROPOSED|PR|INS|INSULATED|INSULATION|POLY|OF)\b/gi, ' ');
  return /^[\s\-–—().,/Ø]*$/.test(rest);
}

/**
 * The fail-closed join for a length-only head (S4 COL-FRAG, PR58). Every
 * condition must hold, or the lines are left exactly as they were:
 *  - `head` is a length-only head (shape above);
 *  - the FIRST continuation line is diameter-bearing, and the joined
 *    parse's diameter is that line's diameter (the size arrived with
 *    the continuation, not from somewhere else in the joined text);
 *  - the joined text parses as a complete run that is NOT existing and
 *    carries a slope (a slope-less join is some other annotation's
 *    figure standing next to a pipe tail);
 *  - the joined text is fully consumed by callout vocabulary.
 */
export function parseColFragJoin(head: string, firstContinuation: string, joined: string): ParsedRun | null {
  if (!isLengthOnlyRunHead(head)) return null;
  if (!isDiameterBearingFragment(firstContinuation)) return null;
  const dia = DIA_UNIT_RE.exec(firstContinuation);
  if (!dia) return null;
  const run = parseRunCallout(joined);
  if (!run) return null;
  if (run.existing) return null;
  if (run.slopePct === null) return null;
  if (run.diameterMm !== snapToPipeDiameter(parseInt(dia[1], 10))) return null;
  if (!calloutTextFullyConsumed(joined)) return null;
  return run;
}
/**
 * Tail half of a wrapped callout: the material/slope tail ("DR 35 @ 0.05%", "PVC STM"), the
 * slope/length tail that follows a diameter-first head ("@ 1.00% (25.0m)", "@ 0.50% - 45.0m",
 * "@ 0.30%"), or the bare qualifier drafters drop onto a third line ("INSULATED"). Callers
 * join greedily, so one tail may be followed by another.
 */
export function isRunContinuation(line: string): boolean {
  if (WM_RE.test(line)) return false;
  // A line that already parses as a complete run on its own is never a continuation of the
  // previous one — the diameter-first forms carry a slope/material and would otherwise be
  // vacuumed into the preceding dangling head.
  if (LEN_DIA_RE.test(line)) return false;
  if (parseRunCallout(line) !== null) return false;
  if (parseElevation(line) !== null) return false;
  // A slope or a material is strong enough evidence of a pipe tail to stand on its own,
  // and has been since this predicate existed — "...@ 0.5% TO MH 5" is a tail that happens
  // to name a structure, and refusing it strands the head.
  if (SLOPE_RE.test(line) || MATERIAL_RE.test(line)) return true;
  // The weaker signals below (a bare system tag, a lone length, "INSULATED") match far too
  // much to be trusted against a line that is really a structure of its own.
  if (parseStructureLabel(line) !== null) return false;
  return CLASS_RE.test(line) || SYSTEM_RE.test(line) || INSULATED_RE.test(line)
    || LENGTH_ONLY_RE.test(line.trim());
}

// Longest-first so CBMH wins over CB, DCBMH over DCB, etc. STMH/SANMH normalize to MH
// (the estimator's sheet drops the system qualifier — see compare-facts stripSystemPrefix).
//
// Group layout (all explicitly captured so label reconstruction doesn't need fragile
// index math against the original line):
//   1 = status prefix as written (undefined if absent): "EX " / "EX." marks an existing
//       structure; "NEW " / "PROP. " / "PR. " mark a proposed one (NOT existing — the
//       existing flag is derived from the prefix text, not its mere presence). EX may
//       butt straight against the kind ("EX.MH#4A"), so its trailing space is optional.
//   2 = structure kind code as written ("STMH", "CBMH", "MH", ...). Two compound
//       spellings join the alternation: "CB/MH" (catchbasin manhole -> CBMH) and
//       "DBL/CB" (double catchbasin -> DCB); both are remapped in parseStructureLabel.
//   3 = separator between kind and id as written (may be "", " ", "-", " - ", "#",
//       " #") -> whether the reconstructed label keeps a space (e.g. "STMH 1") or not
//       (e.g. "CBMH1035"). The "#" form is a whole dialect ("MH#3", "CB #1"), not a
//       typo — several offices number structures that way on every sheet.
//   4 = id number (may carry a trailing letter, e.g. "104A"; now also hyphenated like "6-3-1")
//   5 = parenthesized diameter in mm, if present ("(1200Ø)")
// Two additions: JF/EF joined the kind alternation (junction and end-of-flow structures)
// and the id now accepts hyphenated parts (e.g. "JF 6-3-1"). Leading delimiter now
// includes '(' to catch parenthesized structure ids in embedded contexts like
// "HATCH JF2000 (JF6-3-1)" — the genuine hyphenated id can be seen after the model code.
// (Note: the widened (?:^|[\s(]) delimiter applies to every kind, not just JF.)
// OCS (outlet control structure), HW (headwall) and FES (flared end section) are the
// abbreviated spellings; their written-out forms go through NAMED_STRUCTURES below.
// PR42: the system prefix also admits the hyphenated separator ("STM-MH 4") —
// the same label with the hyphen the kind–id separator already allows. Without
// it the whole callout block was invisible to the grammar.
const STRUCT_RE = /(?:^|[\s(])(EX\.?\s*|(?:NEW|PROP(?:OSED)?|PR)\.?\s+)?(?:(?:SAN(?:ITARY)?|STM|STORM)(?:\s*-\s*|\s+))?(DDICB|DCBMH|DICB|MHTEE|CB\/MH|DBL\/CB|CBMH|DCB|STMH|SANMH|OCS|FES|CB|MH|HS|HW|OS|JF|EF)(\s?-?\s?|\s?#\s?)(\d+(?:-\d+)*[A-Z]?)\s*(?:\((\d{3,4})\s*(?:MM)?\s*[ØO]?\))?/i;
// Global copy for matchAll iteration. matchAll clones the regex internally, so no shared
// lastIndex state leaks between calls (do NOT add 'g' to STRUCT_RE itself and call exec in a loop).
const STRUCT_RE_G = new RegExp(STRUCT_RE.source, 'gi');

// Chambers are written id-first ("C100 CHAMBER", "OGS100 CHAMBER"), so they need
// their own pattern rather than another alternation branch.
const CHAMBER_RE = /(?:^|\s)(EX\.?\s+)?([A-Z]{1,4}\d+[A-Z]?)\s+CHAMBER\b/i;

// Compound kind spellings remapped to the canonical kind + label code:
// "CB/MH" is a catchbasin manhole (written out as CBMH everywhere else) and
// "DBL/CB" is a double catchbasin (DCB). Keyed by the uppercased group-2 text.
const COMPOUND_KINDS: Record<string, { kind: ParsedStructure['kind']; code: string }> = {
  'CB/MH': { kind: 'CBMH', code: 'CBMH' },
  'DBL/CB': { kind: 'DCB', code: 'DCB' },
};

/**
 * A bare structure header in the "#" dialect and nothing else: "STMH #1",
 * "PROP. CB #2", "CB #4A". Anchored to the whole string, unlike STRUCT_RE —
 * this exists so callers that split schedule-table rows into cells
 * (transcript-takeoff step 4) can recognise when a cell is one of these.
 * Schedule rows are a separate input class from callout blocks: their
 * numbering series runs past the takeoff's scope (Ultimate Drive's structure
 * schedule lists STMH #1..#24 against 13 taken-off manholes), so whether to
 * harvest them is the schedule-table work's decision, not the block
 * grammar's. Keep the kind alternation in step with STRUCT_RE's.
 */
export const HASH_STRUCTURE_HEADER_RE = /^\s*(?:EX\.?\s*|(?:NEW|PROP(?:OSED)?|PR)\.?\s+)?(?:(?:SAN(?:ITARY)?|STM|STORM)\s+)?(?:DDICB|DCBMH|DICB|MHTEE|CB\/MH|DBL\/CB|CBMH|DCB|STMH|SANMH|OCS|FES|CB|MH|HS|HW|OS|JF|EF)\s*#\s*\d+(?:-\d+)*[A-Z]?\s*(?:\(\d{3,4}\s*(?:MM)?\s*[ØO]?\))?\s*$/i;

// Id-first headers: "SA3 (MH)", "ST1 (CBMH)", "ST3 (CB)" — the structure's id leads
// and its kind trails in parentheses, prefixed by a two-letter system code (SA =
// sanitary, ST = storm). The same structure is often drawn twice (plan + profile)
// with the profile copy carrying a trailing asterisk ("ST1* (CBMH)"), so a single
// optional "*" is tolerated after the id; the label is unchanged, and dedupe
// collapses the pair. Anchored to the line start: mid-text, "SA3" is just a
// schedule/run id. The parenthesised code must be a real structure kind —
// "ST8 (FD-4 OGS)" names an OGS unit model, not a structure, and stays unparsed.
//   1 = status prefix (same convention as STRUCT_RE group 1)
//   2 = system code ("SA" | "ST")
//   3 = id (same shape as STRUCT_RE group 4)
//   4 = kind code as written
const ID_FIRST_RE = /^\s*(EX\.?\s*|(?:NEW|PROP(?:OSED)?|PR)\.?\s+)?(SA|ST)(\d+(?:-\d+)*[A-Z]?)\*?\s*\((DDICB|DCBMH|DICB|CBMH|DCB|CB|MH|HS|HW|OS)\)/i;

// Structures the drawing spells out in words. These carry no kind code and often no id at
// all ("DOUBLE CHECK VALVE VAULT"), so — unlike STRUCT_RE, which is anchored by its id —
// the pattern is anchored to the WHOLE line. That is the guard against fabricating a
// structure out of a legend row or a note ("FLARED END SECTION DETAIL", "SEE INFILTRATION
// TANK NOTES"): only a line that is essentially just the name counts.
const NAMED_STRUCTURES: { body: string; kind: ParsedStructure['kind'] }[] = [
  { body: 'DOUBLE[\\s-]+CHECK(?:[\\s-]+VALVE)?[\\s-]+(?:VAULT|CHAMBER|ASSEMBLY)', kind: 'VAULT' },
  { body: 'OUTLET[\\s-]+CONTROL[\\s-]+STRUCTURE', kind: 'OCS' },
  { body: 'FLARED[\\s-]+END[\\s-]+SECTION', kind: 'FES' },
  { body: '(?:INFILTRATION|INFILTRATOR|DETENTION|RETENTION|STORAGE|CISTERN)[\\s-]+TANK', kind: 'TANK' },
  { body: '(?:SERVICE|METER|WATER|CURB[\\s-]+STOP)[\\s-]+VAULT', kind: 'VAULT' },
  { body: '(?:VALVE|METER|SAMPLING|MAINTENANCE)[\\s-]+CHAMBER', kind: 'CHAMBER' },
  { body: 'HEAD[\\s-]*WALL', kind: 'HW' },
];
// 1 = existing/proposed prefix, 2 = leading diameter, 3 = the name, 4 = id, 5 = trailing (1200Ø)
const NAMED_STRUCTURE_RES: { re: RegExp; kind: ParsedStructure['kind'] }[] = NAMED_STRUCTURES.map(
  ({ body, kind }) => ({
    re: new RegExp(
      '^\\s*(?:(EX|EXIST(?:ING)?|PR|PROP(?:OSED)?|NEW)\\.?\\s+)?'
      + '(?:(\\d{3,4})\\s*(?:mm)?\\s*[ØO]?\\s+)?'
      + `(${body})`
      + '(?:\\s*(?:NO\\.?|#)?\\s*(\\d+[A-Z]?))?'
      + '\\s*(?:\\((\\d{3,4})\\s*[ØO]?\\))?\\s*$',
      'i',
    ),
    kind,
  }),
);

// Proprietary SWM / separator unit model designations: "MC-3500", "SC-740", "STC 4000",
// "DCVC-200", "C100HD". The prefix list is a deliberate ALLOWLIST rather than a generic
// `[A-Z]{1,4}\d+` — a bare letters-plus-digits token is far too common on a drawing to
// treat as a structure on sight.
//
// The single-letter C series (Cultec) needs more care than the rest, and the golden corpus
// says why: "C401", "C002", "C501", "C301" are SHEET NUMBERS (the civil C-series), and
// "ASTM C33", "AWWA C900" are material specs. Accepting a bare C-code invented structures
// on Matthews Hangar, Oakville, Bradford and Ultimate Drive. So a C code counts only when
// something disambiguates it: the unambiguous "HD" suffix, a brand word on the line, or the
// word CHAMBER after it (which CHAMBER_RE already handles).
//
// JF is deliberately absent: Jellyfish model codes (JF1000, JF2000) are NOT structures;
// only the hyphenated Jellyfish ids ("JF 6-3-1") are, and STRUCT_RE already handles those.
//
// PR25: MC (StormTech arch chambers, "MC-3500") and SC (Stormceptor, "SC-800") are
// absent for the same reason, on golden-corpus evidence: those model designations were
// admitted as structures on four projects (Milton, Loretto Abbey, Wigmore) and the
// estimator's takeoff carries them ZERO times — the systems are priced outside the
// structures table. The codes that remain (DCVC, STC, DC) are the estimator's own
// chamber codes and ARE carried ("DCVC-200", "STC 4000", "DC 150"), as is the Cultec
// C-HD series below ("C100 CHAMBER").
const MODEL_CODE = '(?:DCVC|STC|DC)[\\s-]?\\d{2,4}(?:[\\s-]?HD)?';
const CULTEC_CODE = 'C[\\s-]?\\d{2,4}(?:[\\s-]?HD)?';
// Whole-line form: the code is the entire callout, bar an existing/proposed prefix and a
// trailing noun. Anchoring is what keeps prose ("DRAWING OF MC-3500 UNIT", "SEE DETAIL ON
// C501 AND") from minting a structure.
const MODEL_ANCHORED_RE = new RegExp(
  '^\\s*(?:(EX|EXIST(?:ING)?|PR|PROP(?:OSED)?|NEW)\\.?\\s+)?'
  + `(${MODEL_CODE}|C[\\s-]?\\d{2,4}[\\s-]?HD)`
  + '(?:\\s+(?:CHAMBERS?|UNITS?|SYSTEMS?|ROWS?))?\\s*$',
  'i',
);
// Brand-qualified form: "CULTEC C100HD CHAMBERS" names a real unit even mid-line, because
// the brand word is the disambiguator a bare code lacks.
const MODEL_BRAND_RE = /\b(?:CULTEC|STORMTECH|STORMTRAP|TRITON|CONTECH|ADS)\b/i;
const MODEL_QUALIFIED_RE = new RegExp(
  `(?:^|[\\s(])(EX\\.?\\s+)?(${MODEL_CODE}|${CULTEC_CODE})(?![A-Z0-9-])`,
  'i',
);

// A leading EX/EXISTING marks the whole callout existing even when the kind code that
// follows it is not the one STRUCT_RE matches ("EX STMH MH 3": STMH has no id, so the
// match is " MH 3" — and the EX would otherwise be lost).
const LEADING_EX_RE = /^\s*EX(?:IST(?:ING)?)?\.?\s/i;
const SAN_SYSTEM_RE = /\bSAN(?:ITARY|MH)?\b/i;
const STM_SYSTEM_RE = /\b(?:STM|STORM|STMH)\b/i;
// Cultec spells its chamber models as product names: "RECHARGER 902HD", "CONTACTOR 100HD".
const CULTEC_PRODUCT_RE = /\b(?:RECHARGER|CONTACTOR)\s*(\d{2,4})\s*-?\s*HD\b/i;

function structureSystem(prefix: string, kind: string): 'SAN' | 'STM' | null {
  if (kind === 'SANMH' || SAN_SYSTEM_RE.test(prefix)) return 'SAN';
  if (kind === 'STMH' || STM_SYSTEM_RE.test(prefix)) return 'STM';
  return null;
}

/** The structure's row label. Sanitary structures keep their "SAN" qualifier: storm and
 *  sanitary networks number independently, so a bare "MH 1" names two different
 *  structures and reconcile would merge them into one. */
export function structureDescription(parsed: ParsedStructure): string {
  return parsed.system === 'SAN' ? `SAN ${parsed.label}` : parsed.label;
}

/** Chamber systems (Cultec, StormTech, ...) are priced as a lump sum by the estimator —
 *  there is no precast-manhole formula for them — so surface one loudly rather than let
 *  it ride through as an unpriced row. Includes the bed area when the callout states it. */
export function chamberWarning(label: string, lines: string[]): string {
  const area = lines.join(' ').match(/BED\s+AREA\s*([\d,]+(?:\.\d+)?)\s*(?:SQ\.?\s*M|M2|M²)/i);
  return `Chamber system ${label}${area ? ` (bed area ${area[1]} m²)` : ''} needs manual pricing — it is listed as a structure row with no precast cost.`;
}

/**
 * PR25: component structures named inside a host structure's own callout.
 *
 * An oil-grit separator's callout carries its end-of-flow component in
 * parentheses — "CBMH33 (OGS3-EF04)", "MH25 (OGS2-EF08)" — and the estimator
 * inventories that component as its own structure row ("EF 04", "EF 08").
 * The host parses through parseStructureLabel as usual; this returns the
 * component structures the same line names, for the assemblers to emit
 * alongside it. Deliberately the one component shape the corpus shows:
 * slash-note forms ("MH 3/OGS/EF 06") are the estimator's single-row
 * convention for the same idea and are NOT split.
 */
const OGS_EF_COMPONENT_RE = /\(\s*OGS\s*\d+\s*-\s*EF\s*(\d+)\s*\)/i;
export function parseComponentStructures(line: string): ParsedStructure[] {
  const m = OGS_EF_COMPONENT_RE.exec(line);
  if (!m) return [];
  return [{ label: `EF ${m[1]}`, kind: 'EF', diameterMm: null, existing: false }];
}

export function parseStructureLabel(line: string): ParsedStructure | null {
  // PR25: a "MODEL:" callout names the unit by its designation — the designation
  // right after the prefix is the structure, and anything in parentheses after it
  // is a sub-component spec, not a rival label. Without this priority the scan
  // below reached inside the parentheses and returned the component's code
  // ("MODEL: STC 4000 (JF6-3-1)" came back as a Jellyfish "JF6-3-1", a structure
  // the takeoff does not carry, while the Stormceptor it names went unread).
  const modelPrefix = /^\s*MODEL\s*:\s*/i.exec(line);
  if (modelPrefix) {
    const designation = line.slice(modelPrefix[0].length).split('(')[0].trim();
    if (designation) {
      const parsed = parseStructureLabel(designation);
      if (parsed) return parsed;
    }
  }

  // PR25: the chamber inlet is a structure the estimator inventories under the
  // bare name "INLET" (Loretto Abbey). The drawing writes it out as a whole-line
  // label, "CHAMBER INLET" — whole-line anchoring is the guard, exactly as for
  // NAMED_STRUCTURES below: mid-sentence, "inlet" is just a word.
  const inlet = /^\s*(EX\.?\s+)?(?:CHAMBER\s+)?INLET\s*$/i.exec(line);
  if (inlet) {
    return { label: 'INLET', kind: 'CHAMBER', diameterMm: null, existing: Boolean(inlet[1]) || LEADING_EX_RE.test(line) };
  }

  const cultec = CULTEC_PRODUCT_RE.exec(line);
  if (cultec) {
    return { label: `${cultec[1]} HD`, kind: 'CHAMBER', diameterMm: null, existing: LEADING_EX_RE.test(line) };
  }

  const chamber = CHAMBER_RE.exec(line);
  if (chamber) {
    return { label: chamber[2].toUpperCase(), kind: 'CHAMBER', diameterMm: null, existing: Boolean(chamber[1]) };
  }

  // Iterate through all candidate structure matches and return the first one that passes validation.
  // This allows scanning past rejected candidates (e.g., JF model codes) to find genuine structures
  // in the same line (e.g., hyphenated JF ids in parentheses after the model code).
  for (const m of line.matchAll(STRUCT_RE_G)) {
    const rawKind = m[2].toUpperCase();
    const compound = COMPOUND_KINDS[rawKind];
    const kind = (compound ? compound.kind
      : rawKind === 'STMH' || rawKind === 'SANMH' ? 'MH' : rawKind) as ParsedStructure['kind'];

    // JF ids must be hyphenated to distinguish real structures (JF 6-3-1) from Jellyfish
    // product model numbers (JF1000, JF2000). EF ids are not hyphenated in the corpus.
    if (kind === 'JF' && !m[4].includes('-')) {
      continue; // Try the next candidate match, not this one
    }

    // PR25: "HS20" / "HS-20" is the AASHTO loading designation, not a headwall —
    // it lives in spec prose ("STRUCTURE SHALL MEET AASHTO HS-20, ASSUMING EARTH
    // COVER") and the scan above happily extracted it as a structure. Genuine
    // headwalls in the corpus are written spaced ("HS 4", "HS 6"), so only the
    // fused/hyphenated form of the number 20 is refused; a spaced "HS 20" still
    // parses, and every other HS id is untouched.
    if (kind === 'HS' && m[4] === '20' && !/\s/.test(m[3])) {
      continue; // Try the next candidate match, not this one
    }



    // Preserve the drawing's own kind-code text in the label (normalizeLabel handles
    // matching later); whether a space separates code from id follows what was on the
    // drawing, captured verbatim in group 3. Compound kinds label under their
    // canonical code ("CB/MH #1" -> "CBMH 1"), since that is what every other
    // dialect — and the estimator — calls the same structure.
    const hadSpace = /\s/.test(m[3]);
    const label = `${compound ? compound.code : m[2].toUpperCase()}${hadSpace ? ' ' : ''}${m[4].toUpperCase()}`;
    return {
      label,
      kind,
      diameterMm: m[5] ? parseInt(m[5], 10) : null,
      // Group 1 now carries proposed prefixes too ("NEW ", "PROP. "), so the
      // existing flag comes from the prefix TEXT, not its presence.
      existing: (m[1] ? /^EX/i.test(m[1]) : false) || LEADING_EX_RE.test(line),
      system: structureSystem(line.slice(0, (m.index ?? 0) + m[0].length), rawKind) ?? undefined,
    };
  }

  // Id-first dialect ("SA3 (MH)"): kind-first grammar above cannot see these —
  // the leading token is a run-style id, and the parenthesised kind alone has no
  // id after it. The label is rebuilt kind-first ("MH 3") with the system the
  // two-letter prefix names, so it lands in the same identity space as every
  // other dialect.
  const idFirst = ID_FIRST_RE.exec(line);
  if (idFirst) {
    const kind = idFirst[4].toUpperCase() as ParsedStructure['kind'];
    return {
      label: `${kind} ${idFirst[3].toUpperCase()}`,
      kind,
      diameterMm: null,
      existing: (idFirst[1] ? /^EX/i.test(idFirst[1]) : false) || LEADING_EX_RE.test(line),
      system: idFirst[2].toUpperCase() === 'SA' ? 'SAN' : 'STM',
    };
  }

  for (const { re, kind } of NAMED_STRUCTURE_RES) {
    const m = re.exec(line);
    if (!m) continue;
    const name = m[3].replace(/[\s-]+/g, ' ').trim().toUpperCase();
    const diameter = m[5] ?? m[2];
    return {
      label: m[4] ? `${name} ${m[4].toUpperCase()}` : name,
      kind,
      diameterMm: diameter ? parseInt(diameter, 10) : null,
      existing: /^EX/i.test(m[1] ?? ''),
    };
  }

  const anchoredModel = MODEL_ANCHORED_RE.exec(line);
  if (anchoredModel) {
    return {
      label: anchoredModel[2].replace(/\s+/g, ' ').trim().toUpperCase(),
      kind: 'CHAMBER',
      diameterMm: null,
      existing: /^EX/i.test(anchoredModel[1] ?? ''),
    };
  }
  if (MODEL_BRAND_RE.test(line)) {
    const brandModel = MODEL_QUALIFIED_RE.exec(line);
    if (brandModel) {
      return {
        label: brandModel[2].replace(/\s+/g, ' ').trim().toUpperCase(),
        kind: 'CHAMBER',
        diameterMm: null,
        existing: EX_RE.test(line),
      };
    }
  }

  // No candidate matched all validation rules
  return null;
}

// Directions may sit on either side of the keyword ("OUT INV 150.20" and "INV OUT = 150.20"
// are both in the corpus). Longest-first again so OUTLET is not truncated to OUT.
const ELEV_DIR = 'NORTH|SOUTH|EAST|WEST|UPSTREAM|DOWNSTREAM|BOTTOM|OUTLET|INLET|OUT|IN|BOT|TOP|US|DS|NE|NW|SE|SW|N|S|E|W';
// Top-of-grate synonyms (T/G, T.G., TG, TOP, TOP OF GRATE, RIM, GRATE, LID) and invert synonyms
// (INV, INV., INVERT). INVERT precedes INV so the whole word is consumed. LID is the
// lid/rim elevation some offices write on every structure ("LID. 276.58" beside
// "W INV. 274.63"); the whole-line anchor keeps the stormwater sense of "LID"
// (low-impact development, always mid-sentence in notes) from ever matching.
const ELEV_TYPE = 'T\\/G|T\\.\\s?G|TG|TOP(?:\\s+OF)?(?:\\s+GRATE|\\s+GRATING)?|RIM|GRATE|GRATING|LID|INVERT|INV';
const ELEV_RE = new RegExp(
  `^\\s*(?:(${ELEV_DIR})[\\s.]+)?(${ELEV_TYPE})\\.?(?:\\s+EL(?:EV(?:ATION)?)?\\.?)?\\s*(?:(${ELEV_DIR})\\b\\.?\\s*)?[:=]?\\s*(\\d{2,3}(?:\\.\\d{1,3})?)\\s*±?\\s*$`,
  'i',
);
const DIR_ALIASES: Record<string, string> = {
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  UPSTREAM: 'US', DOWNSTREAM: 'DS', BOT: 'BOTTOM', INLET: 'IN', OUTLET: 'OUT',
};

export function parseElevation(line: string): ParsedElevation | null {
  const m = ELEV_RE.exec(line);
  if (!m) return null;
  // Collapse the keyword's punctuation so "T/G", "T.G." and "T G" classify identically.
  const keyword = m[2].toUpperCase().replace(/[\s./]/g, '');
  const isTopOfGrate = keyword.startsWith('TG') || keyword.startsWith('TOP')
    || keyword === 'RIM' || keyword === 'LID' || keyword.startsWith('GRAT');
  const rawDirection = m[1] ?? m[3];
  const direction = rawDirection
    ? (DIR_ALIASES[rawDirection.toUpperCase()] ?? rawDirection.toUpperCase())
    : null;
  return { type: isTopOfGrate ? 'TG' : 'INV', direction, value: parseFloat(m[4]) };
}

// DICL before DI, and the DR/SDR branch so "200mm DR-18 WATERMAIN" keeps its pressure class.
const WM_MATERIAL_RE = /\b(PVC|HDPE|CONC|DICL|DI|CPP|CSP|(?:S?DR)[\s-]*\d{1,3})\b/i;

export function parseWatermainCallout(line: string): ParsedWatermain | null {
  if (!WM_RE.test(line)) return null;
  let diameterMm: number;
  let lengthM: number | null;
  const dia = DIA_MM_RE.exec(line);
  if (dia) {
    diameterMm = parseInt(dia[1], 10);
    const len = /(\d+(?:\.\d+)?)\s*m\b(?!m)/i.exec(line);
    lengthM = len ? parseFloat(len[1]) : null;
  } else {
    // Canonical run-callout form with the diameter written as Ø/DIA instead of
    // "mm" ("19.0m - 300Ø PVC WATERMAIN"): length and diameter arrive as one
    // coupled figure (LEN_DIA_RE — the same core parseRunCallout trusts).
    // Without this fallback the callout was dropped whole — no diameter, no
    // length — even though the drawing dimensions the main exactly like a
    // sewer run (Milton #13's 300mm main; the only such line in the golden
    // corpus, verified by census in PR 11). Lines that parse today are
    // untouched: this branch runs only where DIA_MM_RE found nothing.
    const core = LEN_DIA_RE.exec(line);
    if (!core) return null;
    lengthM = parseFloat(core[1]);
    diameterMm = parseInt(core[2], 10);
  }
  const mat = WM_MATERIAL_RE.exec(line);
  const service = /\bHYD(?:RANT)?\s+LEAD\b/i.test(line) ? 'HYDRANT_LEAD' as const
    : /\bFIRE\b/i.test(line) ? 'FIRE' as const
      : /\bDOMESTIC\b/i.test(line) ? 'DOMESTIC' as const : undefined;
  return {
    diameterMm,
    lengthM,
    material: mat ? mat[1].replace(/\s+/g, ' ').trim().toUpperCase() : null,
    existing: EX_RE.test(line),
    service,
    insulated: INSULATED_RE.test(line) ? true : undefined,
  };
}

/**
 * Subdrains are perforated pipe under the road base. They carry a diameter but
 * no system tag and no slope, so parseRunCallout ignores them — yet the
 * estimator prices them as a sewer line item (Oakville: "SUBDRAIN 67m").
 *
 * Most subdrain callouts on real drawings state only a diameter ("150mm
 * SUBDRAIN") — the canonical run-callout form ("67.0m - 150mmØ SUBDRAIN") is
 * rare. When that tightly-coupled length+diameter core is present, trust it;
 * otherwise fall back to the diameter alone with length 0 rather than
 * dropping the pipe. Deliberately do NOT search the line for an unrelated
 * number to use as a length — "1.8m BIOSWALE WITH 200mm SUBDRAIN" carries the
 * bioswale's width, not the pipe's length, and LEN_DIA_RE's tight adjacency
 * already keeps that number from being mistaken for one.
 *
 * When a line carries multiple millimetre figures (e.g., "300mm STM C/W 150mm SUBDRAIN"),
 * we pick the one nearest to the SUBDRAIN keyword to avoid capturing an unrelated pipe's diameter.
 */
export function parseSubdrainCallout(line: string): { length: number; diameterMm: number; existing: boolean } | null {
  if (!SUBDRAIN_RE.test(line)) return null;
  const core = LEN_DIA_RE.exec(line);
  if (core) {
    return { length: parseFloat(core[1]), diameterMm: snapToPipeDiameter(parseInt(core[2], 10)), existing: EX_RE.test(line) };
  }
  // No canonical length+diameter pair; look for a diameter figure nearest to the SUBDRAIN keyword
  const subdrainMatch = SUBDRAIN_RE.exec(line);
  if (!subdrainMatch) return null; // Already checked above, but safety first
  const subdrainIndex = subdrainMatch.index;

  // Find all diameter figures in the line with their indices
  const diaMatches = Array.from(line.matchAll(new RegExp(DIA_MM_RE.source, 'gi')));
  if (diaMatches.length === 0) return null; // no diameter on the line — nothing to describe

  // Pick the diameter figure with the smallest distance to the SUBDRAIN keyword
  let nearest = diaMatches[0];
  let minDistance = Math.abs(nearest.index - subdrainIndex);
  for (let i = 1; i < diaMatches.length; i++) {
    const distance = Math.abs(diaMatches[i].index - subdrainIndex);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = diaMatches[i];
    }
  }

  return { length: 0, diameterMm: snapToPipeDiameter(parseInt(nearest[1], 10)), existing: EX_RE.test(line) };
}
