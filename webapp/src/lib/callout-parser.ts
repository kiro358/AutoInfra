/**
 * Grammar for civil-drawing callout strings. Pure, no I/O.
 *
 * The callout language on Ontario servicing drawings is rigidly formulaic:
 *   runs:        "83.7m-375mmØ SAN @ 0.02%", "EX SAN 7.2m - 250mmØ DR 35 @ 0.05%"
 *   structures:  "EX CBMH1035 (1200Ø)", "STMH 1", "MH 101"
 *   elevations:  "T/G=224.95", "N INV=223.350", "SW INV = 310.60"
 *   watermain:   "EX. 300 mmØ PVC WATERMAIN", "EX WM - 250 mm"
 * These parsers are the single place that grammar lives; both the text-layer
 * path (text-takeoff.ts) and the vision-transcript path (transcript-takeoff.ts)
 * feed through them.
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
}
export interface ParsedStructure {
  label: string;
  kind: 'MH' | 'CBMH' | 'DCBMH' | 'CB' | 'DCB' | 'DICB' | 'DDICB' | 'HS' | 'OS' | 'JF' | 'EF' | 'CHAMBER';
  diameterMm: number | null;
  existing: boolean;
}
export interface ParsedElevation { type: 'TG' | 'INV'; direction: string | null; value: number; }
export interface ParsedWatermain { diameterMm: number; lengthM: number | null; material: string | null; existing: boolean; }

const EX_RE = /(^|\s)EX\.?(\s|$)/i;
// length + diameter core: "83.7m-375mmØ", "7.2m - 250mmØ", "45.0m - 250mm"
const LEN_DIA_RE = /(\d+(?:\.\d+)?)\s*m\b\s*(?:-|–|of)?\s*(\d{2,4})\s*mm/i;
const SLOPE_RE = /@\s*(\d+(?:\.\d+)?)\s*(%|‰)?/;
const MATERIAL_RE = /\b(PVC|HDPE|CONC|CSP|(?:S?DR)\s*(\d{1,3}))\b/i;
const WM_RE = /\b(WATERMAIN|WM)\b/i;
const SUBDRAIN_RE = /\bSUB[\s-]?DRAIN\b/i;
// Shared pattern: diameter in millimetres (used by both watermain and subdrain parsers)
const DIA_MM_RE = /(\d{2,4})\s*mm/i;

export function parseRunCallout(line: string): ParsedRun | null {
  if (WM_RE.test(line)) return null; // watermain callouts share the mm form
  if (SUBDRAIN_RE.test(line)) return null; // subdrains share the mm form but are handled separately
  const core = LEN_DIA_RE.exec(line);
  if (!core) return null;
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
    length: parseFloat(core[1]),
    diameterMm: snapToPipeDiameter(parseInt(core[2], 10)),
    system,
    material: mat ? mat[1].replace(/\s+/g, ' ').trim() : null,
    typeClass: mat && mat[2] ? parseInt(mat[2], 10) : null,
    slopePct,
    existing: EX_RE.test(line),
  };
}

export function isDanglingRunHead(line: string): boolean {
  return LEN_DIA_RE.test(line) && !SLOPE_RE.test(line) && !MATERIAL_RE.test(line) && !WM_RE.test(line);
}
export function isRunContinuation(line: string): boolean {
  return !LEN_DIA_RE.test(line) && (SLOPE_RE.test(line) || MATERIAL_RE.test(line)) && !WM_RE.test(line)
    && parseElevation(line) === null;
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
const STRUCT_RE = /(?:^|[\s(])(EX\.?\s+)?(?:(?:SAN(?:ITARY)?|STM|STORM)\s+)?(DDICB|DCBMH|DICB|CBMH|DCB|STMH|SANMH|CB|MH|HS|OS|JF|EF)(\s?-?\s?)(\d+(?:-\d+)*[A-Z]?)\s*(?:\((\d{3,4})\s*[ØO]?\))?/i;
// Global copy for matchAll iteration. matchAll clones the regex internally, so no shared
// lastIndex state leaks between calls (do NOT add 'g' to STRUCT_RE itself and call exec in a loop).
const STRUCT_RE_G = new RegExp(STRUCT_RE.source, 'gi');

// Chambers are written id-first ("C100 CHAMBER", "OGS100 CHAMBER"), so they need
// their own pattern rather than another alternation branch.
const CHAMBER_RE = /(?:^|\s)(EX\.?\s+)?([A-Z]{1,4}\d+[A-Z]?)\s+CHAMBER\b/i;

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

  // No candidate matched all validation rules
  return null;
}

const ELEV_RE = /^\s*(?:([NSEW]{1,2})\s+)?(T\/G|INV(?:ERT)?\.?)\s*=?\s*(\d{2,3}(?:\.\d{1,3})?)\s*±?\s*$/i;

export function parseElevation(line: string): ParsedElevation | null {
  const m = ELEV_RE.exec(line);
  if (!m) return null;
  return {
    type: m[2].toUpperCase().startsWith('T/G') ? 'TG' : 'INV',
    direction: m[1] ? m[1].toUpperCase() : null,
    value: parseFloat(m[3]),
  };
}

export function parseWatermainCallout(line: string): ParsedWatermain | null {
  if (!WM_RE.test(line)) return null;
  const dia = DIA_MM_RE.exec(line);
  if (!dia) return null;
  const len = /(\d+(?:\.\d+)?)\s*m\b(?!m)/i.exec(line);
  const mat = /\b(PVC|HDPE|CONC|DI|CPP)\b/i.exec(line);
  return {
    diameterMm: parseInt(dia[1], 10),
    lengthM: len ? parseFloat(len[1]) : null,
    material: mat ? mat[1].toUpperCase() : null,
    existing: EX_RE.test(line),
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
