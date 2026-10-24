/**
 * wm-table-miner.ts — specialist S2: the WM-table miner (PR48, routing
 * Phase 2; registered in specialists.ts).
 *
 * WHAT IT MINES. Some designers do the estimator's watermain arithmetic
 * on the sheet itself: a printed "WATERMAIN LENGTHS" table whose rows
 * are diameters and whose columns are scopes (BLDG A / BLDG B, phases,
 * blocks), the column sums being exactly the totals the estimating
 * workbook carries. The PR 29 vision pilot proved the class: Panattoni's
 * printed table reproduced its workbook totals digit-for-digit (3/3
 * pool rows), on the same project where the stated-fragment, vector and
 * scaled-extent routes all read zero — because a workbook WM total is a
 * SCOPED estimating decision, and the table is the one place the
 * designer states it outright. This module mines those tables — and
 * nothing else. It never measures geometry, never reads a scale, never
 * sums drawn segments, and never touches a length the generalist stated.
 *
 * CHANNELS. The table can reach the pipeline two ways: positioned text
 * on a located page (grid reconstruction, the schedule-table.ts
 * pattern), or a transcript tile (pipe-delimited or line rows — the
 * channel Ultimate's sewer schedule uses). Both are inputs the hybrid
 * assembly already holds; the miner runs there, after the merge, so it
 * sees the generalist's complete segment set for every diameter.
 *
 * FILL-ONLY, FAIL-CLOSED. A diameter's printed total is attached only
 * when the generalist stated NO length for that diameter anywhere —
 * every segment fact for it carries length 0, the assemblers' "unstated"
 * marker. Attaching means ONE segment fact's length becomes the printed
 * total (reconcile sums segments by diameter, so the row lands exact);
 * the fact is re-stamped source method 'schedule', producer
 * 'S2-wm-table-miner', family 'wm-table', with the table row as its
 * evidence, and the diameter's per-callout "not stated" withheld
 * questions are replaced by one 'derived' record naming the table, so
 * the workbook's AUDIT sheet never claims a filled length was left
 * blank. Refusals — recorded, never silent:
 *   - 'no-generalist-row': the table names a diameter the generalist
 *     never emitted. Creating the row would be HARVESTING, a different
 *     specialist's scope decision — not a fill.
 *   - 'generalist-length-stated': some segment of the diameter carries
 *     a stated length. The printed total and the stated segments are
 *     different scopes of the same pipe; writing either over the other
 *     risks the Uxbridge error (stated dims 13.3 m vs the workbook's
 *     scoped 24 m).
 *   - 'conflicting-tables': two claimed tables disagree on a diameter.
 * A page that merely mentions WATERMAIN and LENGTH in prose (the spec /
 * notes sheets of Holiday Inn, Uxbridge, Loretto; Woodbine's profile
 * legend) claims nothing: the detector demands a standalone title row
 * over a strict numeric grid, the exact shape spec prose never forms.
 *
 * CORPUS STATUS (measured, PR48 census): the detector fires on ZERO of
 * the 26 golden projects — Panattoni's table is drawn in a stroke font
 * the text layer cannot read ('X' glyph items) and the tile transcripts
 * never captured it, so the one known table lives only in the raster.
 * Like schedule-table.ts before it, the module's behaviour is proven by
 * its unit fixtures (modelled digit-for-digit on that table) and it
 * stands live for the first project whose table arrives in text or
 * transcript form. Pure, no I/O.
 */
import type { PageText, PositionedText } from './pdf-text';
import { snapToPipeDiameter } from './geometry';
import { isSpecialistDisabled } from './specialists';
import type {
  SpecialistFiring, TakeoffFacts, TileTranscript, WatermainFact, WithheldItem,
} from './types';

export const WM_TABLE_MINER_ID = 'S2-wm-table-miner' as const;

/** The table's title: a standalone row/line. Prose sentences that
 *  contain the phrase are excluded by the shape rules at the call
 *  sites (short row, few cells) plus the grid demand below. */
const TITLE_RE = /WATERMAIN\s+LENGTHS?\b/i;
/** A title row is a title, not a sentence: bounded length and cells. */
const TITLE_MAX_CHARS = 64;
const TITLE_MAX_CELLS = 3;

/** First cell of a data row: a diameter, "100mm" / "100 mmØ" / "100mm DIA". */
const DIAMETER_CELL_RE = /^(\d+(?:\.\d+)?)\s*mm\s*(?:Ø|DIA\.?)?$/i;
/** A length cell: a plain positive number, nothing else. */
const NUMBER_CELL_RE = /^\d+(?:\.\d+)?$/;
/** Column headers that mark additive scope parts (the estimator sums
 *  them; Panattoni's BLDG A + BLDG B is the type case). */
const SCOPE_HEADER_RE = /^(?:BLDG|BUILDING|PHASE|BLK|BLOCK|AREA|SITE|SECTION)\b/i;
const TOTAL_HEADER_RE = /^TOTAL\b/i;
const LENGTH_HEADER_RE = /^(?:LENGTH|LEN)\b/i;

const MAX_PART_M = 10_000;
const MAX_TOTAL_M = 20_000;
const MIN_TABLE_ROWS = 2;

export interface WmTableRow {
  diameterMm: number;
  /** The printed TOTAL for the diameter (TOTAL column, or the sum of
   *  the scope parts — the estimator's own arithmetic). */
  totalLengthM: number;
  /** The numeric cells the total came from, in column order. */
  partsM: number[];
}

export interface WmTable {
  title: string;
  rows: WmTableRow[];
  channel: 'text-layer' | 'transcript';
  /** Set for the text-layer channel. */
  page?: number;
  /** Set for the transcript channel. */
  tile?: number;
  /** Title + one raw line per row, for fact evidence strings. */
  evidence: string[];
}

export type WmFillRefusalReason =
  | 'no-generalist-row'
  | 'generalist-length-stated'
  | 'conflicting-tables';

export interface WmFill {
  diameterMm: number;
  totalLengthM: number;
  /** sizeAndType of the segment fact that received the fill. */
  sizeAndType: string;
  table: WmTable;
  row: WmTableRow;
}

export interface WmFillRefusal {
  diameterMm: number;
  reason: WmFillRefusalReason;
}

export interface WmTableMiningResult {
  /** The SAME facts reference when nothing was filled (byte-identical
   *  guarantee for non-firing projects); a shallow-copied facts object
   *  otherwise, with only the filled watermain facts and the amended
   *  withheld list replaced. */
  facts: TakeoffFacts;
  tables: WmTable[];
  /** Title rows seen whose grid failed the grammar — counted so a
   *  near-miss table is visible in diagnostics, never silently eaten. */
  rejectedTitles: number;
  filled: WmFill[];
  refusals: WmFillRefusal[];
}

// ---- shared grid grammar --------------------------------------------------

type ColumnRole = 'part' | 'total' | 'length' | 'unknown';

/** Column roles from a header row's cells (index 0 is the diameter
 *  column and carries no role). No header row → null. */
function columnRoles(headerCells: string[] | null): ColumnRole[] | null {
  if (!headerCells) return null;
  const roles: ColumnRole[] = ['part'];
  for (let j = 1; j < headerCells.length; j++) {
    const h = headerCells[j].trim().toUpperCase();
    if (h === '') roles.push('part');
    else if (TOTAL_HEADER_RE.test(h)) roles.push('total');
    else if (SCOPE_HEADER_RE.test(h)) roles.push('part');
    else if (LENGTH_HEADER_RE.test(h)) roles.push('length');
    else roles.push('unknown');
  }
  return roles;
}

/** Parse + validate the data rows of one candidate table.
 *  `rawRows` are cell arrays (diameter cell first). Returns the table
 *  rows, or null when the grid fails any rule. */
function validateRows(
  rawRows: string[][],
  headerCells: string[] | null,
): WmTableRow[] | null {
  if (rawRows.length < MIN_TABLE_ROWS) return null;
  const roles = columnRoles(headerCells);
  if (roles && roles.includes('unknown')) return null;

  const seen = new Set<number>();
  const out: WmTableRow[] = [];
  for (const cells of rawRows) {
    const diaMatch = DIAMETER_CELL_RE.exec((cells[0] ?? '').trim());
    if (!diaMatch) return null;
    const rawDia = parseFloat(diaMatch[1]);
    const diameterMm = snapToPipeDiameter(rawDia);
    // The printed diameter must BE a standard size, not merely near
    // one — snapping a misprint into a real pipe is invention.
    if (diameterMm <= 0 || Math.abs(diameterMm - rawDia) > 1) return null;
    if (seen.has(diameterMm)) return null;
    seen.add(diameterMm);

    // Numeric parts, aligned to their cell indices.
    const parts: { idx: number; value: number }[] = [];
    for (let j = 1; j < cells.length; j++) {
      const c = cells[j].trim().replace(/,/g, '');
      if (c === '') continue;
      if (!NUMBER_CELL_RE.test(c)) return null;
      const v = parseFloat(c);
      if (!(v > 0) || v > MAX_PART_M) return null;
      parts.push({ idx: j, value: v });
    }
    if (parts.length === 0) return null;

    let total: number | null = null;
    if (!roles) {
      // No header row: position is the only semantics available, and
      // it speaks only for a single length column.
      total = parts.length === 1 ? parts[0].value : null;
    } else {
      const totalPart = parts.find((p) => roles[p.idx] === 'total');
      if (totalPart) {
        total = totalPart.value;
      } else if (parts.length === 1) {
        total = parts[0].value;
      } else if (parts.every((p) => roles[p.idx] === 'part')) {
        total = parts.reduce((s, p) => s + p.value, 0);
      }
    }
    if (total == null || !(total > 0) || total > MAX_TOTAL_M) return null;
    out.push({ diameterMm, totalLengthM: total, partsM: parts.map((p) => p.value) });
  }
  return out;
}

// ---- text-layer channel -----------------------------------------------------

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Group items into visual rows by y proximity, each ordered
 *  left-to-right (the schedule-table.ts pattern, kept local so this
 *  module stays dependency-light). */
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

/** Split a visual row into cells on x-gaps (same two-candidate
 *  strategy as schedule-table.ts: median-gap threshold first, median-
 *  width fallback for uniform-pitch grids). Each cell keeps the x of
 *  its first item so the caller can align columns across rows. */
function toCellsX(row: PositionedText[]): { text: string; x: number }[] {
  if (row.length <= 1) return row.map((i) => ({ text: i.text, x: i.x }));
  const split = (threshold: number): { text: string; x: number }[] => {
    const cells: { text: string; x: number }[] = [];
    let cur = [row[0]];
    for (let i = 1; i < row.length; i++) {
      const gap = row[i].x - (row[i - 1].x + row[i - 1].width);
      if (gap > threshold) { cells.push({ text: cur.map((c) => c.text).join(' ').trim(), x: cur[0].x }); cur = [row[i]]; }
      else cur.push(row[i]);
    }
    cells.push({ text: cur.map((c) => c.text).join(' ').trim(), x: cur[0].x });
    return cells;
  };
  const gaps: number[] = [];
  for (let i = 1; i < row.length; i++) gaps.push(row[i].x - (row[i - 1].x + row[i - 1].width));
  const byGap = split(Math.max(4, median(gaps) * 1.5));
  if (byGap.length > 1) return byGap;
  const widthThreshold = Math.max(4, median(row.map((i) => i.width)) * 2);
  return split(widthThreshold);
}

const texts = (cells: { text: string; x: number }[]): string[] => cells.map((c) => c.text);

const isTitleRow = (cells: string[]): boolean => {
  const joined = cells.join(' ').trim();
  return cells.length <= TITLE_MAX_CELLS && joined.length <= TITLE_MAX_CHARS && TITLE_RE.test(joined);
};

const isDiameterRow = (cells: string[]): boolean =>
  cells.length >= 2 && DIAMETER_CELL_RE.test((cells[0] ?? '').trim());

/** A header row: at least two cells, none of them a bare number or a
 *  diameter, and at least one recognisable column word. */
const isHeaderRow = (cells: string[]): boolean => {
  if (cells.length < 2 || isDiameterRow(cells)) return false;
  if (cells.some((c) => NUMBER_CELL_RE.test(c.trim()))) return false;
  return cells.some((c) =>
    SCOPE_HEADER_RE.test(c.trim()) || TOTAL_HEADER_RE.test(c.trim()) ||
    LENGTH_HEADER_RE.test(c.trim()) || /^(?:DIA|DIAM|SIZE|DIAMETER|PIPE)\b/i.test(c.trim()));
};

/** Align a table region's cells into column bands by x-start
 *  (CAD table cells are left-aligned; a blank corner cell simply
 *  leaves its band empty in the header row). Returns each row
 *  densified to a string array indexed by band. */
function alignColumns(rows: { text: string; x: number }[][]): string[][] {
  const starts: number[] = [];
  for (const row of rows) for (const cell of row) {
    if (!starts.some((s) => Math.abs(s - cell.x) <= 20)) starts.push(cell.x);
  }
  starts.sort((a, b) => a - b);
  const bandOf = (x: number): number => {
    let best = 0;
    for (let i = 0; i < starts.length; i++) if (Math.abs(starts[i] - x) <= 20) best = i;
    return best;
  };
  return rows.map((row) => {
    const dense: string[] = Array.from({ length: starts.length }, () => '');
    for (const cell of row) {
      const b = bandOf(cell.x);
      if (dense[b] !== '') dense[b] = `${dense[b]} ${cell.text}`.trim();
      else dense[b] = cell.text;
    }
    return dense;
  });
}

export function detectWmTablesInText(page: PageText): { tables: WmTable[]; rejectedTitles: number } {
  const rows = groupRows(page.items).map(toCellsX);
  const tables: WmTable[] = [];
  let rejectedTitles = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!isTitleRow(texts(rows[i]))) continue;
    const title = texts(rows[i]).join(' ').trim();
    let j = i + 1;
    let headerRow: { text: string; x: number }[] | null = null;
    if (j < rows.length && isHeaderRow(texts(rows[j]))) { headerRow = rows[j]; j++; }
    const dataRows: { text: string; x: number }[][] = [];
    while (j < rows.length && isDiameterRow(texts(rows[j]))) { dataRows.push(rows[j]); j++; }
    const region = alignColumns([...(headerRow ? [headerRow] : []), ...dataRows]);
    const headerCells = headerRow ? region[0] : null;
    const rawRows = headerRow ? region.slice(1) : region;
    const parsed = validateRows(rawRows, headerCells);
    if (!parsed) { rejectedTitles++; continue; }
    tables.push({
      title,
      rows: parsed,
      channel: 'text-layer',
      page: page.page,
      evidence: [title, ...rawRows.map((r) => r.filter((c) => c !== '').join(' | '))],
    });
    i = j - 1;
  }
  return { tables, rejectedTitles };
}

// ---- transcript channel -----------------------------------------------------

/** Split one transcript line into cells: pipe-delimited when pipes
 *  are present, else diameter-led whitespace form. Null when the line
 *  is not row-shaped at all. */
function transcriptCells(line: string): string[] | null {
  const t = line.trim();
  if (!t) return null;
  if (t.includes('|')) return t.split('|').map((c) => c.trim());
  const m = /^(\d+(?:\.\d+)?\s*mm\s*(?:Ø|DIA\.?)?)\s+(.+)$/i.exec(t);
  if (m) return [m[1], ...m[2].trim().split(/\s+/)];
  return null;
}

const isTitleLine = (line: string): boolean => {
  const t = line.trim();
  return t.length <= TITLE_MAX_CHARS && TITLE_RE.test(t) && !t.includes('|');
};

export function detectWmTablesInTranscript(
  tiles: TileTranscript[],
): { tables: WmTable[]; rejectedTitles: number } {
  const tables: WmTable[] = [];
  let rejectedTitles = 0;
  for (const tile of tiles) {
    const lines = (tile.blocks ?? []).flatMap((b) => (Array.isArray(b) ? b : [String(b)]));
    for (let i = 0; i < lines.length; i++) {
      if (!isTitleLine(lines[i])) continue;
      const title = lines[i].trim();
      let j = i + 1;
      let headerCells: string[] | null = null;
      const header = j < lines.length ? transcriptCells(lines[j]) : null;
      if (header && isHeaderRow(header)) { headerCells = header; j++; }
      const rawRows: string[][] = [];
      while (j < lines.length) {
        const cells = transcriptCells(lines[j]);
        if (!cells || !isDiameterRow(cells)) break;
        rawRows.push(cells);
        j++;
      }
      const parsed = validateRows(rawRows, headerCells);
      if (!parsed) { rejectedTitles++; continue; }
      tables.push({
        title,
        rows: parsed,
        channel: 'transcript',
        tile: tile.tile,
        evidence: [title, ...rawRows.map((r) => r.join(' | '))],
      });
      i = j - 1;
    }
  }
  return { tables, rejectedTitles };
}

// ---- the fill -----------------------------------------------------------------

/** True when a withheld entity names this diameter ("150mm",
 *  "150mm PVC" — the assemblers' sizeAndType forms). */
const withheldEntityForDiameter = (entity: string, diameterMm: number): boolean => {
  const m = /^(\d+(?:\.\d+)?)mm\b/.exec(entity.trim());
  return m != null && parseFloat(m[1]) === diameterMm;
};

/**
 * Mine every claimed WM table in the job's located pages / transcript
 * and fill the generalist's unstated WM lengths from them. Returns the
 * input facts object UNCHANGED (same reference) unless at least one
 * fill landed.
 */
export function applyWmTableMiner(
  facts: TakeoffFacts,
  pageTexts: PageText[],
  transcript: TileTranscript[],
): WmTableMiningResult {
  const empty: WmTableMiningResult = { facts, tables: [], rejectedTitles: 0, filled: [], refusals: [] };
  if (isSpecialistDisabled(WM_TABLE_MINER_ID)) return empty;

  const tables: WmTable[] = [];
  let rejectedTitles = 0;
  for (const page of pageTexts) {
    const found = detectWmTablesInText(page);
    tables.push(...found.tables);
    rejectedTitles += found.rejectedTitles;
  }
  const fromTranscript = detectWmTablesInTranscript(transcript);
  tables.push(...fromTranscript.tables);
  rejectedTitles += fromTranscript.rejectedTitles;
  if (tables.length === 0) return { ...empty, rejectedTitles };

  // One printed total per diameter across the whole job; two tables
  // that disagree poison only their shared diameters.
  const byDiameter = new Map<number, { row: WmTableRow; table: WmTable }>();
  const conflicted = new Set<number>();
  for (const table of tables) {
    for (const row of table.rows) {
      const prev = byDiameter.get(row.diameterMm);
      if (!prev) { byDiameter.set(row.diameterMm, { row, table }); continue; }
      const tol = Math.max(0.5, 0.01 * Math.max(prev.row.totalLengthM, row.totalLengthM));
      if (Math.abs(prev.row.totalLengthM - row.totalLengthM) > tol) conflicted.add(row.diameterMm);
    }
  }

  const refusals: WmFillRefusal[] = [];
  const filled: WmFill[] = [];
  const newWatermain: WatermainFact[] = [...(facts.watermain ?? [])];
  let changed = false;

  for (const diameterMm of [...byDiameter.keys()].sort((a, b) => b - a)) {
    if (conflicted.has(diameterMm)) {
      refusals.push({ diameterMm, reason: 'conflicting-tables' });
      continue;
    }
    const { row, table } = byDiameter.get(diameterMm)!;
    const candidates = newWatermain
      .map((w, idx) => ({ w, idx }))
      .filter(({ w }) => w.pipeDiameter === diameterMm);
    if (candidates.length === 0) {
      refusals.push({ diameterMm, reason: 'no-generalist-row' });
      continue;
    }
    if (candidates.some(({ w }) => (w.length ?? 0) > 0)) {
      refusals.push({ diameterMm, reason: 'generalist-length-stated' });
      continue;
    }
    const target = candidates[0];
    const rowIdx = table.rows.indexOf(row);
    newWatermain[target.idx] = {
      ...target.w,
      length: row.totalLengthM,
      source: {
        method: 'schedule',
        ...(table.page != null ? { page: table.page } : {}),
        ...(table.tile != null ? { tile: table.tile } : {}),
        evidence: `${table.title} :: ${table.evidence[rowIdx + 1] ?? ''}`.trim(),
        producer: WM_TABLE_MINER_ID,
        family: 'wm-table',
      },
    };
    filled.push({ diameterMm, totalLengthM: row.totalLengthM, sizeAndType: target.w.sizeAndType, table, row });
    changed = true;
  }

  if (!changed) return { facts, tables, rejectedTitles, filled, refusals };

  // Replace the filled diameters' per-callout "not stated" withheld
  // questions with one derived record each — the AUDIT sheet must not
  // claim a length was left blank in the same breath as pricing it.
  let withheld: WithheldItem[] = [...(facts.withheld ?? [])];
  for (const fill of filled) {
    withheld = withheld.filter(
      (w) => !(w.field === 'length' && w.kind === 'withheld' && withheldEntityForDiameter(w.entity, fill.diameterMm)),
    );
    const where = fill.table.channel === 'text-layer' ? `p.${fill.table.page}` : `tile ${fill.table.tile}`;
    withheld.push({
      entity: `${fill.diameterMm}mm`,
      field: 'length',
      kind: 'derived',
      question:
        `Length of the ${fill.diameterMm}mm watermain was not stated in a callout; it IS printed in the ` +
        `drawing's "${fill.table.title}" table (${where}), whose columns for this diameter ` +
        `(${fill.row.partsM.join(' + ')}) total ${fill.totalLengthM} m — filled from the table by the ` +
        `WM-table miner (S2), superseding the per-callout "not stated" questions for this diameter. ` +
        `Confirm against the table.`,
      defaultApplied: {
        value: fill.totalLengthM,
        source: `stated-table: ${fill.table.title} (${where})`,
      },
    });
  }

  return {
    facts: { ...facts, watermain: newWatermain, withheld },
    tables,
    rejectedTitles,
    filled,
    refusals,
  };
}

/** The diagnostics firing record for one mining pass (PR47 Phase 1
 *  shape). Built by the caller only when at least one table claimed. */
export function wmTableFiring(result: WmTableMiningResult): SpecialistFiring {
  const pages = [...new Set(result.filled.map((f) => f.table.page).filter((p): p is number => p != null))];
  const detail: Record<string, number> = {
    tables: result.tables.length,
    filled: result.filled.length,
  };
  if (result.rejectedTitles > 0) detail.rejectedTitles = result.rejectedTitles;
  for (const r of result.refusals) {
    const key = `refused:${r.reason}`;
    detail[key] = (detail[key] ?? 0) + 1;
  }
  return { fired: result.filled.length, ...(pages.length ? { pages } : {}), detail };
}
