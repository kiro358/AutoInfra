import { describe, it, expect } from 'vitest';
import { detectTables, tableToSewers } from './schedule-table';
import { PageText, PositionedText } from './pdf-text';

// A storm-sewer schedule in the shape Ultimate Drive uses.
const rows: [string, string, string, string, string][] = [
  ['RUN', 'FROM', 'TO', 'LENGTH', 'DIA'],
  ['ST 1', 'MH 1', 'MH 2', '30.0', '250'],
  ['ST 2', 'MH 2', 'MH 3', '13.0', '200'],
  ['ST 3', 'MH 3', 'CB 4', '25.0', '250'],
];

const schedulePage = (): PageText => ({
  page: 1, width: 2592, height: 1728,
  items: rows.flatMap((cells, r) =>
    cells.map((text, c) => ({ text, x: 100 + c * 120, y: 800 - r * 14, width: text.length * 5, height: 8 }))
  ),
});

// Build a PageText from a grid of row-strings, one PositionedText per cell,
// spaced far enough apart on x to split into distinct cells and close enough
// on y (within a row) to cluster into one row.
function gridPage(grid: string[][], opts?: { rowGapY?: number; colGapX?: number; startY?: number }): PageText {
  const rowGapY = opts?.rowGapY ?? 14;
  const colGapX = opts?.colGapX ?? 120;
  const startY = opts?.startY ?? 800;
  const items: PositionedText[] = [];
  grid.forEach((cells, r) => {
    cells.forEach((text, c) => {
      if (text === undefined || text === null) return;
      items.push({ text, x: 100 + c * colGapX, y: startY - r * rowGapY, width: text.length * 5, height: 8 });
    });
  });
  return { page: 1, width: 2592, height: 1728, items };
}

describe('detectTables', () => {
  it('finds the header and its data rows', () => {
    const tables = detectTables(schedulePage());
    expect(tables).toHaveLength(1);
    expect(tables[0].header).toEqual(['RUN', 'FROM', 'TO', 'LENGTH', 'DIA']);
    expect(tables[0].rows).toHaveLength(3);
    expect(tables[0].rows[0].cells).toEqual(['ST 1', 'MH 1', 'MH 2', '30.0', '250']);
  });

  it('ignores a page with no header-like row', () => {
    const noise: PageText = {
      page: 1, width: 2592, height: 1728,
      items: [{ text: 'GENERAL NOTES', x: 10, y: 10, width: 60, height: 8 }],
    };
    expect(detectTables(noise)).toHaveLength(0);
  });

  it('stops a table at a row whose cell it is missing (cell count drops)', () => {
    // Row for ST 2 has no TO cell at all — nothing plotted there, so that
    // physical row yields only 4 items/cells instead of 5. The table reader
    // has no way to know a cell is "missing" vs. the row just being shorter,
    // so it ends the table there; only the well-formed row above survives.
    const grid = [
      ['RUN', 'FROM', 'TO', 'LENGTH', 'DIA'],
      ['ST 1', 'MH 1', 'MH 2', '30.0', '250'],
      ['ST 2', 'MH 2', undefined as unknown as string, '13.0', '200'],
      ['ST 3', 'MH 3', 'CB 4', '25.0', '250'],
    ];
    const tables = detectTables(gridPage(grid));
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(1);
    expect(tables[0].rows[0].cells).toEqual(['ST 1', 'MH 1', 'MH 2', '30.0', '250']);
  });

  it('ends the first table at a second header row and starts a new one', () => {
    const grid = [
      ['RUN', 'FROM', 'TO', 'LENGTH', 'DIA'],
      ['ST 1', 'MH 1', 'MH 2', '30.0', '250'],
      ['ST 2', 'MH 2', 'MH 3', '13.0', '200'],
      ['RUN', 'FROM', 'TO', 'LENGTH', 'DIA'], // sanitary schedule starts here
      ['SA 1', 'MH 4', 'MH 5', '40.0', '250'],
    ];
    const tables = detectTables(gridPage(grid));
    expect(tables).toHaveLength(2);
    expect(tables[0].rows).toHaveLength(2);
    expect(tables[1].header).toEqual(['RUN', 'FROM', 'TO', 'LENGTH', 'DIA']);
    expect(tables[1].rows).toHaveLength(1);
    expect(tables[1].rows[0].cells).toEqual(['SA 1', 'MH 4', 'MH 5', '40.0', '250']);
  });

  it('does not detect a revision-block / legend as a table (no header keyword match)', () => {
    const grid = [
      ['REV', 'DATE', 'DESCRIPTION', 'BY'],
      ['1', '2024-01-01', 'ISSUED FOR REVIEW', 'KY'],
      ['2', '2024-02-15', 'ISSUED FOR CONSTRUCTION', 'KY'],
    ];
    expect(detectTables(gridPage(grid))).toHaveLength(0);
  });

  it('does not detect a general-notes list as a table (text collapses into one cell per line)', () => {
    // Notes are prose: words are packed close together (small x-gaps), so the
    // whole line clusters into a single cell — well under the 3-cell floor.
    const notes: PageText = {
      page: 1, width: 2592, height: 1728,
      items: [
        'ALL PIPE TO BE CLASS 50 DR35 PVC UNLESS NOTED OTHERWISE',
        'ALL MANHOLES TO BE PRECAST CONCRETE PER OPSD 701.010',
      ].flatMap((line, r) =>
        line.split(' ').map((word, c) => ({
          text: word, x: 100 + c * 6, y: 800 - r * 14, width: word.length * 5, height: 8,
        }))
      ),
    };
    expect(detectTables(notes)).toHaveLength(0);
  });
});

describe('tableToSewers', () => {
  it('maps columns to SewerFacts with endpoint run labels', () => {
    const sewers = tableToSewers(detectTables(schedulePage())[0]);
    expect(sewers).toHaveLength(3);
    expect(sewers[0].runLabel).toBe('MH 1-MH 2');
    expect(sewers[0].length).toBe(30);
    expect(sewers[0].pipeDiameter).toBe(250);
    expect(sewers[0].isLineItem).toBe(false);
  });

  it('falls back to the RUN id when FROM/TO are absent', () => {
    const grid = [
      ['RUN', 'LENGTH', 'DIA', 'SLOPE'],
      ['ST 1', '30.0', '250', '0.50'],
    ];
    const sewers = tableToSewers(detectTables(gridPage(grid))[0]);
    expect(sewers).toHaveLength(1);
    expect(sewers[0].runLabel).toBe('ST 1');
    expect(sewers[0].slope).toBe(0.5);
  });

  it('returns nothing for a table missing LENGTH or DIA columns', () => {
    const grid = [
      ['RUN', 'FROM', 'TO', 'TYPE', 'CLASS'],
      ['ST 1', 'MH 1', 'MH 2', 'STM', '50'],
    ];
    expect(tableToSewers(detectTables(gridPage(grid))[0])).toEqual([]);
  });

  it('excludes rows flagged EX (existing infrastructure)', () => {
    const grid = [
      ['RUN', 'FROM', 'TO', 'LENGTH', 'DIA'],
      ['ST 1', 'MH 1', 'MH 2', '30.0', '250'],
      ['EX ST 2', 'MH 2', 'MH 3', '13.0', '200'],
    ];
    const sewers = tableToSewers(detectTables(gridPage(grid))[0]);
    expect(sewers).toHaveLength(1);
    expect(sewers[0].runLabel).toBe('MH 1-MH 2');
  });
});
