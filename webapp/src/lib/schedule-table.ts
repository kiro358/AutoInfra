/**
 * Reconstructs schedule TABLES from positioned PDF text.
 *
 * A table is just text on a grid, so it is recoverable deterministically from
 * coordinates. Pure, no I/O.
 *
 * DORMANT as of 2026-08-31: no golden-corpus PDF text layer contains a
 * header-row schedule table, so this module fires on ZERO golden projects and
 * its behaviour is proven only by its unit tests. In particular it does NOT
 * fire on Ultimate Drive — the plan that motivated this module claimed that
 * project's 29 runs "live in a schedule table (ST 1 … ST 25)", but those ids
 * are plan annotations scattered along the drawn pipes (ST1's text-layer
 * neighbours are "U/G", "GAS", "CONC. SIDEWALK", "MH 101"), and the one page
 * dense with FROM/TO/GRADE tokens is a general-notes sheet where those words
 * appear inside prose. Recovering Ultimate Drive needs geometric association
 * of an id with a nearby length callout, which is not this module.
 */
import { PageText, PositionedText } from './pdf-text';
import { snapToPipeDiameter, normalizeSlope } from './geometry';
import { SewerFact } from './types';

export interface TableRow { cells: string[] }
export interface DetectedTable { header: string[]; rows: TableRow[] }

// Column headers seen across the corpus' sewer schedules.
const HEADER_KEYWORDS = [
  'RUN', 'FROM', 'TO', 'LENGTH', 'LEN', 'DIA', 'DIAM', 'SIZE', 'SLOPE', 'GRADE',
  'TYPE', 'CLASS', 'MATERIAL', 'INV', 'STRUCTURE', 'MH', 'PIPE',
];

// "EX"/"EX." flags existing infrastructure, excluded from the takeoff — same
// convention as callout-parser's EX_RE, applied here to the RUN/id cell (the
// only cell a schedule row uses to identify itself as a whole existing pipe).
const EX_ROW_RE = /(^|\s)EX\.?(\s|$)/i;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Group items into visual rows by y proximity, each ordered left-to-right. */
function groupRows(items: PositionedText[]): PositionedText[][] {
  if (!items.length) return [];
  const tol = Math.max(2, median(items.map((i) => i.height)) * 0.6);
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PositionedText[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) <= tol) row.push(it);
    else rows.push([it]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

function splitOnThreshold(row: PositionedText[], threshold: number): string[] {
  const cells: string[] = [];
  let cur = [row[0].text];
  for (let i = 1; i < row.length; i++) {
    const gap = row[i].x - (row[i - 1].x + row[i - 1].width);
    if (gap > threshold) { cells.push(cur.join(' ').trim()); cur = [row[i].text]; }
    else cur.push(row[i].text);
  }
  cells.push(cur.join(' ').trim());
  return cells;
}

/**
 * Split a visual row into cells on x-gaps. Two threshold candidates:
 *  1. 1.5x the row's median inter-item gap — works when a row mixes small
 *     intra-cell word-gaps with a few large inter-cell gaps.
 *  2. 2x the row's median item WIDTH — a fallback for the common schedule-table
 *     shape where every cell is exactly one item at a uniform column pitch, so
 *     every gap in the row is the same order of magnitude and nothing in the
 *     gap distribution itself marks a boundary (candidate 1 degenerates to "no
 *     split" — confirmed against the brief's own reference fixture, a uniform
 *     5-column header/data grid: median gap ~105, 1.5x that exceeds every gap
 *     in the row, so it never splits at all).
 * Try (1) first since it's more information-sensitive when it works; fall back
 * to (2) only when (1) produced no split whatsoever.
 */
function toCells(row: PositionedText[]): string[] {
  if (row.length <= 1) return row.map((i) => i.text);
  const gaps: number[] = [];
  for (let i = 1; i < row.length; i++) gaps.push(row[i].x - (row[i - 1].x + row[i - 1].width));
  const byGap = splitOnThreshold(row, Math.max(4, median(gaps) * 1.5));
  if (byGap.length > 1) return byGap;
  const widthThreshold = Math.max(4, median(row.map((i) => i.width)) * 2);
  return splitOnThreshold(row, widthThreshold);
}

const headerScore = (cells: string[]) =>
  cells.filter((c) => HEADER_KEYWORDS.includes(c.toUpperCase().replace(/[^A-Z]/g, ''))).length;

export function detectTables(page: PageText): DetectedTable[] {
  const rows = groupRows(page.items).map(toCells);
  const tables: DetectedTable[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length < 3 || headerScore(rows[i]) < 3) continue;
    const header = rows[i];
    const data: TableRow[] = [];
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].length !== header.length) break;
      if (headerScore(rows[j]) >= 3) break; // a second header ends this table
      data.push({ cells: rows[j] });
    }
    if (data.length) { tables.push({ header, rows: data }); i += data.length; }
  }
  return tables;
}

const findCol = (header: string[], ...names: string[]) =>
  header.findIndex((h) => names.includes(h.toUpperCase().replace(/[^A-Z]/g, '')));

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  return m ? parseFloat(m[0]) : null;
};

export function tableToSewers(t: DetectedTable): SewerFact[] {
  const cFrom = findCol(t.header, 'FROM');
  const cTo = findCol(t.header, 'TO');
  const cRun = findCol(t.header, 'RUN', 'PIPE');
  const cLen = findCol(t.header, 'LENGTH', 'LEN');
  const cDia = findCol(t.header, 'DIA', 'DIAM', 'SIZE');
  const cSlope = findCol(t.header, 'SLOPE', 'GRADE');
  const cClass = findCol(t.header, 'CLASS', 'TYPE');
  if (cLen === -1 || cDia === -1) return [];

  const out: SewerFact[] = [];
  for (const { cells } of t.rows) {
    if (cRun !== -1 && EX_ROW_RE.test(cells[cRun] ?? '')) continue; // existing — excluded
    const length = num(cells[cLen]);
    const dia = num(cells[cDia]);
    if (length == null || dia == null) continue;
    // Prefer FROM-TO endpoints; they match the estimator's own run labels.
    const label = cFrom !== -1 && cTo !== -1 && cells[cFrom] && cells[cTo]
      ? `${cells[cFrom]}-${cells[cTo]}`
      : cRun !== -1 ? cells[cRun] : `${length}m-${dia}mm`;
    const slope = cSlope !== -1 ? num(cells[cSlope]) : null;
    out.push({
      runLabel: label,
      isLineItem: false,
      length,
      pipeDiameter: snapToPipeDiameter(dia),
      typeClass: cClass !== -1 ? num(cells[cClass]) : null,
      slope: slope != null ? normalizeSlope(slope) : null,
      depth: null,
    });
  }
  return out;
}
