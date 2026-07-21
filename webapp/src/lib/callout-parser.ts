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
  kind: 'MH' | 'CBMH' | 'DCBMH' | 'CB' | 'DCB' | 'DICB' | 'DDICB' | 'HS' | 'OS';
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

export function parseRunCallout(line: string): ParsedRun | null {
  if (WM_RE.test(line)) return null; // watermain callouts share the mm form
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
//   4 = id number (may carry a trailing letter, e.g. "104A")
//   5 = parenthesized diameter in mm, if present ("(1200Ø)")
const STRUCT_RE = /(?:^|\s)(EX\.?\s+)?(?:(?:SAN(?:ITARY)?|STM|STORM)\s+)?(DDICB|DCBMH|DICB|CBMH|DCB|STMH|SANMH|CB|MH|HS|OS)(\s?-?\s?)(\d+[A-Z]?)\s*(?:\((\d{3,4})\s*[ØO]?\))?/i;

export function parseStructureLabel(line: string): ParsedStructure | null {
  const m = STRUCT_RE.exec(line);
  if (!m) return null;
  const rawKind = m[2].toUpperCase();
  const kind = (rawKind === 'STMH' || rawKind === 'SANMH' ? 'MH' : rawKind) as ParsedStructure['kind'];
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
  const dia = /(\d{2,4})\s*mm/i.exec(line);
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
