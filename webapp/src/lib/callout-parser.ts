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
    | 'CHAMBER' | 'HW' | 'OCS' | 'FES' | 'VAULT' | 'TANK';
  diameterMm: number | null;
  existing: boolean;
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
const WM_RE = /\b(?:WATERMAIN|WATER\s+MAIN|WM|W\/M)\b|\b(?:DOMESTIC|FIRE)\s+(?:WATER|SERVICE|LINE)\b|\bWATER\s+SERVICE\b|\bHYD(?:RANT)?\s+LEAD\b/i;
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
 * Head half of a callout the drafter wrapped across visual lines. Two shapes occur:
 *   a) length-first   — "45.0m - 250mmØ", the tail carrying the material/slope;
 *   b) diameter-first — "300mm PVC STM", the tail carrying the slope and/or the length.
 */
export function isDanglingRunHead(line: string): boolean {
  if (WM_RE.test(line)) return false;
  if (LEN_DIA_RE.test(line)) return !SLOPE_RE.test(line) && !MATERIAL_RE.test(line);
  return isDiameterFirstHead(line);
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
//   1 = "EX " / "EX." prefix (undefined if absent) -> existing flag
//   2 = structure kind code as written ("STMH", "CBMH", "MH", ...)
//   3 = separator between kind and id as written (may be "", " ", "-", " - ") -> whether
//       the reconstructed label keeps a space (e.g. "STMH 1") or not (e.g. "CBMH1035")
//   4 = id number (may carry a trailing letter, e.g. "104A"; now also hyphenated like "6-3-1")
//   5 = parenthesized diameter in mm, if present ("(1200Ø)")
// Two additions: JF/EF joined the kind alternation (junction and end-of-flow structures)
// and the id now accepts hyphenated parts (e.g. "JF 6-3-1"). Leading delimiter now
// includes '(' to catch parenthesized structure ids in embedded contexts like
// "HATCH JF2000 (JF6-3-1)" — the genuine hyphenated id can be seen after the model code.
// (Note: the widened (?:^|[\s(]) delimiter applies to every kind, not just JF.)
// OCS (outlet control structure), HW (headwall) and FES (flared end section) are the
// abbreviated spellings; their written-out forms go through NAMED_STRUCTURES below.
const STRUCT_RE = /(?:^|[\s(])(EX\.?\s+)?(?:(?:SAN(?:ITARY)?|STM|STORM)\s+)?(DDICB|DCBMH|DICB|CBMH|DCB|STMH|SANMH|OCS|FES|CB|MH|HS|HW|OS|JF|EF)(\s?-?\s?)(\d+(?:-\d+)*[A-Z]?)\s*(?:\((\d{3,4})\s*[ØO]?\))?/i;
// Global copy for matchAll iteration. matchAll clones the regex internally, so no shared
// lastIndex state leaks between calls (do NOT add 'g' to STRUCT_RE itself and call exec in a loop).
const STRUCT_RE_G = new RegExp(STRUCT_RE.source, 'gi');

// Chambers are written id-first ("C100 CHAMBER", "OGS100 CHAMBER"), so they need
// their own pattern rather than another alternation branch.
const CHAMBER_RE = /(?:^|\s)(EX\.?\s+)?([A-Z]{1,4}\d+[A-Z]?)\s+CHAMBER\b/i;

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
const MODEL_CODE = '(?:DCVC|STC|SC|MC|DC)[\\s-]?\\d{2,4}(?:[\\s-]?HD)?';
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

export function parseStructureLabel(line: string): ParsedStructure | null {
  const chamber = CHAMBER_RE.exec(line);
  if (chamber) {
    return { label: chamber[2].toUpperCase(), kind: 'CHAMBER', diameterMm: null, existing: Boolean(chamber[1]) };
  }

  // Iterate through all candidate structure matches and return the first one that passes validation.
  // This allows scanning past rejected candidates (e.g., JF model codes) to find genuine structures
  // in the same line (e.g., hyphenated JF ids in parentheses after the model code).
  for (const m of line.matchAll(STRUCT_RE_G)) {
    const rawKind = m[2].toUpperCase();
    const kind = (rawKind === 'STMH' || rawKind === 'SANMH' ? 'MH' : rawKind) as ParsedStructure['kind'];

    // JF ids must be hyphenated to distinguish real structures (JF 6-3-1) from Jellyfish
    // product model numbers (JF1000, JF2000). EF ids are not hyphenated in the corpus.
    if (kind === 'JF' && !m[4].includes('-')) {
      continue; // Try the next candidate match, not this one
    }

    // Preserve the drawing's own kind-code text in the label (normalizeLabel handles
    // matching later); whether a space separates code from id follows what was on the
    // drawing, captured verbatim in group 3.
    const hadSpace = /\s/.test(m[3]);
    const label = `${m[2].toUpperCase()}${hadSpace ? ' ' : ''}${m[4].toUpperCase()}`;
    return {
      label,
      kind,
      diameterMm: m[5] ? parseInt(m[5], 10) : null,
      existing: Boolean(m[1]),
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
// Top-of-grate synonyms (T/G, T.G., TG, TOP, TOP OF GRATE, RIM, GRATE) and invert synonyms
// (INV, INV., INVERT). INVERT precedes INV so the whole word is consumed.
const ELEV_TYPE = 'T\\/G|T\\.\\s?G|TG|TOP(?:\\s+OF)?(?:\\s+GRATE|\\s+GRATING)?|RIM|GRATE|GRATING|INVERT|INV';
const ELEV_RE = new RegExp(
  `^\\s*(?:(${ELEV_DIR})[\\s.]+)?(${ELEV_TYPE})\\.?\\s*(?:(${ELEV_DIR})\\b\\.?\\s*)?[:=]?\\s*(\\d{2,3}(?:\\.\\d{1,3})?)\\s*±?\\s*$`,
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
    || keyword === 'RIM' || keyword.startsWith('GRAT');
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
  const dia = DIA_MM_RE.exec(line);
  if (!dia) return null;
  const len = /(\d+(?:\.\d+)?)\s*m\b(?!m)/i.exec(line);
  const mat = WM_MATERIAL_RE.exec(line);
  const service = /\bHYD(?:RANT)?\s+LEAD\b/i.test(line) ? 'HYDRANT_LEAD' as const
    : /\bFIRE\b/i.test(line) ? 'FIRE' as const
      : /\bDOMESTIC\b/i.test(line) ? 'DOMESTIC' as const : undefined;
  return {
    diameterMm: parseInt(dia[1], 10),
    lengthM: len ? parseFloat(len[1]) : null,
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
