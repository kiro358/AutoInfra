/**
 * PR49 — the S2 vision hook (wm-table-hook.ts): the fragment
 * signature, the glyph-garbage gate, the tile→page attribution walk,
 * the conjunctive candidate detector, and the fail-closed read
 * prompt/parser. The positive page fixture reproduces the Panattoni
 * shape measured on the corpus: a stroke-font sheet (475 text items,
 * 55% single-character) whose general transcript tile carries the
 * printed WM table's value columns — "BLDG A | BLDG B" over bare
 * number pairs — with no title, diameters, or first row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PageText, PositionedText } from './pdf-text';
import type { TakeoffFacts, TileTranscript, WatermainFact } from './types';
import {
  attributeTilesToPages, buildWmTableReadPrompt, detectWmTableCandidates,
  fillEligibleWmDiameters, glyphGarbageStats, parseWmTableReadResponse,
  tileCarriesWmTableFragment, wmTableFragmentStats,
} from './wm-table-hook';

const savedDisable = process.env.DISABLE_WM_TABLE_MINER;
afterEach(() => {
  if (savedDisable === undefined) delete process.env.DISABLE_WM_TABLE_MINER;
  else process.env.DISABLE_WM_TABLE_MINER = savedDisable;
});

// ---- fixtures ---------------------------------------------------------------

/** The fragment tile: Panattoni tile 129's table blocks, verbatim shape. */
const fragmentTile: TileTranscript = {
  tile: 129,
  blocks: [
    ['BLDG A | BLDG B'],
    ['167 | 70'],
    ['316 | 40'],
    ['39 | 27'],
    ['24 | 20'],
  ],
};

/** A stroke-font sheet: many items, most of them single glyphs. */
const glyphPage = (page: number, singles = 70, words = 10): PageText => {
  const items: PositionedText[] = [];
  for (let i = 0; i < singles; i++) items.push({ text: 'X', x: i * 10, y: 100, width: 8, height: 10 });
  for (let i = 0; i < words; i++) items.push({ text: 'GLYPH', x: i * 10, y: 200, width: 40, height: 10 });
  return { page, width: 612, height: 792, items };
};

/** A readable text page (long words, callout density — texty). */
const readablePage = (page: number): PageText => {
  const items: PositionedText[] = [];
  const words = ['250mmØ', 'PVC', 'STM', '@', '0.50%', '300mmØ', 'SAN', 'INV=223.35', 'T/G=224.95', '375mmØ', '450mmØ'];
  for (let r = 0; r < 6; r++) {
    for (const w of words) items.push({ text: w, x: r * 90, y: 100 + r * 20, width: 50, height: 10 });
  }
  return { page, width: 612, height: 792, items };
}

const wm = (diameter: number, length = 0): WatermainFact => ({
  sizeAndType: `${diameter}mm PVC`,
  length,
  pipeDiameter: diameter,
  ocSc: null,
  avgCover: null,
  source: { method: 'transcript', tile: 1, evidence: `${diameter}mmØ PVC DR18 WATERMAIN` },
});

const factsWith = (watermain: WatermainFact[]): TakeoffFacts => ({
  projectName: 'TEST', jobNumber: '', date: '',
  structures: [], catchbasins: [], sewers: [], watermain,
  watermainSpecials: [], watermainValves: [],
  confidence: 1, warnings: [], withheld: [],
});

const candidateInput = (over: Partial<Parameters<typeof detectWmTableCandidates>[0]> = {}) => ({
  pageTexts: [glyphPage(9)],
  tilesByPage: new Map([[9, [fragmentTile]]]),
  facts: factsWith([wm(250), wm(150), wm(100)]),
  tablesClaimed: 0,
  ...over,
});

// ---- fragment signature -------------------------------------------------------

describe('WM-table fragment signature', () => {
  it('counts the scope header and the bare number pairs', () => {
    expect(wmTableFragmentStats(fragmentTile)).toEqual({ scopeHeaders: 1, pairs: 4 });
    expect(tileCarriesWmTableFragment(fragmentTile)).toBe(true);
  });

  it('scope headers alone do not carry it (the Woodbine legend shape)', () => {
    const legend: TileTranscript = { tile: 3, blocks: [['BLDG A | BLDG B'], ['PHASE 1 | PHASE 2'], ['Some note | text']] };
    expect(wmTableFragmentStats(legend)).toEqual({ scopeHeaders: 2, pairs: 0 });
    expect(tileCarriesWmTableFragment(legend)).toBe(false);
  });

  it('number pairs alone do not carry it (coincidence guard)', () => {
    const pairsOnly: TileTranscript = { tile: 4, blocks: [['167 | 70'], ['316 | 40'], ['39 | 27']] };
    expect(wmTableFragmentStats(pairsOnly).pairs).toBe(3);
    expect(tileCarriesWmTableFragment(pairsOnly)).toBe(false);
  });

  it('one pair is not enough, and labelled rows are not bare pairs', () => {
    const onePair: TileTranscript = { tile: 5, blocks: [['BLDG A | BLDG B'], ['167 | 70']] };
    expect(tileCarriesWmTableFragment(onePair)).toBe(false);
    const labelled: TileTranscript = { tile: 6, blocks: [['BLDG A | BLDG B'], ['CB-237 | 70'], ['MH 3 | 40'], ['39 | 27']] };
    expect(wmTableFragmentStats(labelled).pairs).toBe(1);
    expect(tileCarriesWmTableFragment(labelled)).toBe(false);
  });
});

// ---- glyph gate -----------------------------------------------------------------

describe('glyph-garbage gate', () => {
  it('measures the single-character fraction', () => {
    expect(glyphGarbageStats(glyphPage(9))).toEqual({ items: 80, singleCharFraction: 0.875 });
    expect(glyphGarbageStats(readablePage(9)).singleCharFraction).toBeLessThan(0.4);
    expect(glyphGarbageStats({ page: 1, width: 100, height: 100, items: [] })).toEqual({ items: 0, singleCharFraction: 0 });
  });
});

// ---- attribution walk -------------------------------------------------------------

describe('attributeTilesToPages', () => {
  const t = (tile: number): TileTranscript => ({ tile, blocks: [] });

  it('walks pages in order by planned counts', () => {
    const byPage = attributeTilesToPages(
      [{ page: 1, plannedTiles: 2 }, { page: 2, plannedTiles: 1 }],
      [t(1), t(2), t(3)], 24, 48,
    );
    expect(byPage?.get(1)?.map((x) => x.tile)).toEqual([1, 2]);
    expect(byPage?.get(2)?.map((x) => x.tile)).toEqual([3]);
  });

  it('honours the total cap the way the renderer does (later pages starve)', () => {
    const byPage = attributeTilesToPages(
      [{ page: 1, plannedTiles: 2 }, { page: 2, plannedTiles: 2 }],
      [t(1), t(2), t(3)], 24, 3,
    );
    expect(byPage?.get(1)?.map((x) => x.tile)).toEqual([1, 2]);
    expect(byPage?.get(2)?.map((x) => x.tile)).toEqual([3]);
  });

  it('tolerates missing tiles: a gap is a hole in its owner\'s range, shifting nothing', () => {
    // Tile 2 was lost in transcription; tile 3 still belongs to page 1's
    // range and tile 4 to page 2 — position-based attribution would
    // misassign both.
    const byPage = attributeTilesToPages(
      [{ page: 1, plannedTiles: 3 }, { page: 2, plannedTiles: 1 }],
      [t(1), t(3), t(4)], 24, 48,
    );
    expect(byPage?.get(1)?.map((x) => x.tile)).toEqual([1, 3]);
    expect(byPage?.get(2)?.map((x) => x.tile)).toEqual([4]);
  });

  it('returns null on a duplicate tile number', () => {
    expect(attributeTilesToPages([{ page: 1, plannedTiles: 4 }], [t(1), t(1)], 24, 48)).toBeNull();
  });

  it('returns null when a tile falls outside every planned range', () => {
    expect(attributeTilesToPages([{ page: 1, plannedTiles: 1 }], [t(1), t(2)], 24, 48)).toBeNull();
  });
});

// ---- fill eligibility ---------------------------------------------------------------

describe('fillEligibleWmDiameters', () => {
  it('a diameter is eligible only when no segment states a length', () => {
    expect(fillEligibleWmDiameters(factsWith([wm(250), wm(150, 12), wm(100)]))).toEqual([100, 250]);
    expect(fillEligibleWmDiameters(factsWith([]))).toEqual([]);
  });
});

// ---- the conjunctive detector ---------------------------------------------------------

describe('detectWmTableCandidates', () => {
  it('fires on the full Panattoni shape', () => {
    const out = detectWmTableCandidates(candidateInput());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ page: 9, tile: 129, scopeHeaders: 1, pairs: 4, items: 80 });
    expect(out[0].singleCharFraction).toBeCloseTo(0.875);
  });

  it('does not fire when a table was already claimed (hook is last resort)', () => {
    expect(detectWmTableCandidates(candidateInput({ tablesClaimed: 1 }))).toEqual([]);
  });

  it('does not fire when no fill is possible (every diameter stated)', () => {
    expect(detectWmTableCandidates(candidateInput({ facts: factsWith([wm(250, 66), wm(150, 237)]) }))).toEqual([]);
  });

  it('does not fire when attribution is unknown', () => {
    expect(detectWmTableCandidates(candidateInput({ tilesByPage: null }))).toEqual([]);
  });

  it('does not fire on a texty page even with a fragment tile', () => {
    const page = readablePage(9);
    expect(detectWmTableCandidates(candidateInput({
      pageTexts: [page], tilesByPage: new Map([[9, [fragmentTile]]]),
    }))).toEqual([]);
  });

  it('does not fire on a clean raster page (no glyph layer to speak of)', () => {
    const scan: PageText = { page: 9, width: 612, height: 792, items: [] };
    expect(detectWmTableCandidates(candidateInput({
      pageTexts: [scan], tilesByPage: new Map([[9, [fragmentTile]]]),
    }))).toEqual([]);
  });

  it('does not fire when the glyph fraction is low (readable layer, odd transcript)', () => {
    const mostlyReadable = glyphPage(9, 20, 60); // 25% single-char
    expect(detectWmTableCandidates(candidateInput({ pageTexts: [mostlyReadable] }))).toEqual([]);
  });

  it('does not fire when the page\'s tiles carry no fragment', () => {
    const plain: TileTranscript = { tile: 12, blocks: [['MH 7', 'RIM: 90.50']] };
    expect(detectWmTableCandidates(candidateInput({ tilesByPage: new Map([[9, [plain]]]) }))).toEqual([]);
  });

  it('the S2 kill switch disables the detector (and so the hook)', () => {
    process.env.DISABLE_WM_TABLE_MINER = '1';
    expect(detectWmTableCandidates(candidateInput())).toEqual([]);
  });
});

// ---- prompt + parser ---------------------------------------------------------------------

describe('targeted-read prompt and parser', () => {
  it('the prompt is fail-closed: verbatim table or nothing', () => {
    const p = buildWmTableReadPrompt('Panattoni', 9, 20);
    expect(p).toContain('WATERMAIN LENGTHS');
    expect(p).toContain('Do NOT add, estimate, measure, scale, convert or correct anything');
    expect(p).toContain('{"tablePresent": false}');
    expect(p).toContain('sheet 9');
  });

  const goodRead = {
    tablePresent: true,
    title: 'WATERMAIN LENGTHS (METERS)',
    header: ['', 'BLDG A', 'BLDG B'],
    rows: [['100mm', '43', '32'], ['150mm', '167', '70'], ['250mm', '39', '27']],
  };

  it('parses a well-formed read into one synthetic tile of pipe-joined lines', () => {
    const tile = parseWmTableReadResponse(goodRead, 9);
    expect(tile?.tile).toBe(0);
    expect(tile?.blocks).toEqual([[
      'WATERMAIN LENGTHS (METERS)',
      ' | BLDG A | BLDG B',
      '100mm | 43 | 32',
      '150mm | 167 | 70',
      '250mm | 39 | 27',
    ]]);
  });

  it('accepts numeric JSON cells and a null header', () => {
    const tile = parseWmTableReadResponse(
      { tablePresent: true, title: 'WATERMAIN LENGTH', header: null, rows: [['100mm', 75], ['150mm', 237]] }, 9,
    );
    expect(tile?.blocks[0]).toEqual(['WATERMAIN LENGTH', '100mm | 75', '150mm | 237']);
  });

  it('rejects absent, mistitled, and malformed reads whole', () => {
    expect(parseWmTableReadResponse({ tablePresent: false }, 9)).toBeNull();
    expect(parseWmTableReadResponse({ ...goodRead, title: 'PIPE SCHEDULE' }, 9)).toBeNull();
    expect(parseWmTableReadResponse({ ...goodRead, rows: [['100mm', '43', '32']] }, 9)).toBeNull();
    expect(parseWmTableReadResponse({ ...goodRead, header: 'BLDG A' }, 9)).toBeNull();
    expect(parseWmTableReadResponse({ ...goodRead, rows: [['100mm', '43', null], ['150mm', '1', '2']] }, 9)).toBeNull();
    expect(parseWmTableReadResponse('not an object', 9)).toBeNull();
    expect(parseWmTableReadResponse(null, 9)).toBeNull();
  });
});
