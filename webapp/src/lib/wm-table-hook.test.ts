/**
 * PR50 — the S2 vision hook (wm-table-hook.ts) after the detector
 * rebase: the page-intrinsic signature (glyph garbage + located +
 * claimed P2/P5 classification + the sheet's own SERVICING title),
 * fill eligibility, and the fail-closed read prompt/parser.
 *
 * The PR49 signature keyed candidates off a fragment of the table in
 * the page's general transcript tile; the PR49 live gate proved that
 * fragment a frozen-cache artifact (the live roll never produced the
 * tile). The rebased detector therefore takes NO transcript input at
 * all — the positive fixture below is a stroke-font servicing sheet
 * (81 text items, 86% single-character, its title item reading
 * "SERVICING PLAN") and fires with no transcript in sight.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PageText, PositionedText } from './pdf-text';
import { countCalloutKeywordHits, countElevationItems, hasAnnotationForm, isTextyPage } from './pdf-text';
import { classifyPage } from './page-classifier';
import type { PageClassification, TakeoffFacts, WatermainFact } from './types';
import {
  buildWmTableReadPrompt, detectWmTableCandidates, fillEligibleWmDiameters,
  glyphGarbageStats, parseWmTableReadResponse, servicingTitleOf,
  WM_HOOK_MAX_CALLS_PER_JOB,
} from './wm-table-hook';

const savedDisable = process.env.DISABLE_WM_TABLE_MINER;
afterEach(() => {
  if (savedDisable === undefined) delete process.env.DISABLE_WM_TABLE_MINER;
  else process.env.DISABLE_WM_TABLE_MINER = savedDisable;
});

// ---- fixtures ---------------------------------------------------------------

/** A stroke-font sheet: many items, most of them single glyphs, plus
 *  one readable sheet-title item (the Panattoni shape: the title block
 *  is TrueType, the annotations are stroke-font glyphs). */
const glyphPage = (page: number, title: string | null = 'SERVICING PLAN'): PageText => {
  const items: PositionedText[] = [];
  for (let i = 0; i < 70; i++) items.push({ text: 'X', x: i * 10, y: 100, width: 8, height: 10 });
  for (let i = 0; i < 10; i++) items.push({ text: 'GLYPH', x: i * 10, y: 200, width: 40, height: 10 });
  if (title) items.push({ text: title, x: 324, y: 257, width: 168, height: 20 });
  return { page, width: 3456, height: 2592, items };
};

/** A readable text page (long words, callout density — texty). */
const readablePage = (page: number): PageText => {
  const items: PositionedText[] = [];
  const words = ['250mmØ', 'PVC', 'STM', '@', '0.50%', '300mmØ', 'SAN', 'INV=223.35', 'T/G=224.95', '375mmØ', '450mmØ'];
  for (let r = 0; r < 6; r++) {
    for (const w of words) items.push({ text: w, x: r * 90, y: 100 + r * 20, width: 50, height: 10 });
  }
  items.push({ text: 'SERVICING PLAN', x: 324, y: 700, width: 168, height: 20 });
  return { page, width: 612, height: 792, items };
};

const cls = (page: number, kind: PageClassification['kind'] = 'P5', kindTier: PageClassification['kindTier'] = 'claimed'): PageClassification => ({
  page, kind, kindTier, families: [],
  signals: {
    items: null, chars: null, texty: false, annotationForm: false, soloYield: null,
    soloRunYield: null, elevationItems: null, keywordHits: null, pathOps: null,
    imageOps: null, symbolFontItems: null,
  },
});

/** The classification the production seam computes for a page: the
 *  real classifier over attachDiagnostics-mirrored inputs. */
const realCls = (pt: PageText): PageClassification => classifyPage({
  page: pt.page,
  items: pt.items.length,
  chars: pt.items.reduce((a, i) => a + i.text.length, 0),
  texty: isTextyPage(pt),
  annotationForm: hasAnnotationForm(pt),
  soloYield: null, soloRunYield: null,
  elevationItems: countElevationItems(pt),
  keywordHits: countCalloutKeywordHits(pt),
  pathOps: null, imageOps: null, symbolFontItems: pt.symbolFontItems ?? null,
});

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
  locatedPages: [9],
  classifications: new Map([[9, cls(9)]]),
  facts: factsWith([wm(250), wm(150), wm(100)]),
  tablesClaimed: 0,
  ...over,
});

// ---- sheet-title gate ---------------------------------------------------------

describe('servicingTitleOf', () => {
  it('reads the sheet title as printed ("SERVICING PLAN", "SITE SERVICING PLAN")', () => {
    expect(servicingTitleOf(glyphPage(9))).toBe('SERVICING PLAN');
    expect(servicingTitleOf(glyphPage(9, 'SITE SERVICING PLAN'))).toBe('SITE SERVICING PLAN');
    expect(servicingTitleOf(glyphPage(9, 'SERVICING'))).toBe('SERVICING');
  });

  it('a grading sheet\'s title does not qualify', () => {
    expect(servicingTitleOf(glyphPage(9, 'GRADING PLAN'))).toBeNull();
  });

  it('a prose sentence mentioning servicing is not a title (the Milton note shape)', () => {
    const prose = glyphPage(9, null);
    prose.items.push({ text: 'ALL SERVICING INFORMATION IS TO BE VERIFIED ON SITE BEFORE CONSTRUCTION', x: 100, y: 700, width: 600, height: 8 });
    expect(servicingTitleOf(prose)).toBeNull();
  });

  it('no readable title (titles are glyphs too) — fails closed', () => {
    expect(servicingTitleOf(glyphPage(9, null))).toBeNull();
  });
});

// ---- glyph gate -----------------------------------------------------------------

describe('glyph-garbage gate', () => {
  it('measures the single-character fraction', () => {
    expect(glyphGarbageStats(glyphPage(9))).toEqual({ items: 81, singleCharFraction: 70 / 81 });
    expect(glyphGarbageStats(readablePage(9)).singleCharFraction).toBeLessThan(0.4);
    expect(glyphGarbageStats({ page: 1, width: 100, height: 100, items: [] })).toEqual({ items: 0, singleCharFraction: 0 });
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

describe('detectWmTableCandidates (PR50 rebased signature)', () => {
  it('fires on the full Panattoni shape — no transcript involved at all', () => {
    const out = detectWmTableCandidates(candidateInput());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ page: 9, kind: 'P5', title: 'SERVICING PLAN', items: 81 });
    expect(out[0].singleCharFraction).toBeCloseTo(70 / 81);
  });

  it('fires with the classification the production seam really computes', () => {
    const page = glyphPage(9);
    const real = realCls(page);
    expect(real.kind).toBe('P5');
    expect(real.kindTier).toBe('claimed');
    const out = detectWmTableCandidates(candidateInput({
      pageTexts: [page], classifications: new Map([[9, real]]),
    }));
    expect(out.map((c) => c.page)).toEqual([9]);
  });

  it('does not fire on a grading sheet — the title gate separates the C100s from the C101s', () => {
    const page = glyphPage(9, 'GRADING PLAN');
    expect(detectWmTableCandidates(candidateInput({
      pageTexts: [page], classifications: new Map([[9, realCls(page)]]),
    }))).toEqual([]);
  });

  it('does not fire when the sheet\'s title is itself glyphs (C300/C301 shape) — fail-closed miss', () => {
    expect(detectWmTableCandidates(candidateInput({ pageTexts: [glyphPage(9, null)] }))).toEqual([]);
  });

  it('does not fire on a details/spec sheet: no servicing title, whatever its layer', () => {
    const page = glyphPage(9, 'STANDARD DETAILS');
    expect(detectWmTableCandidates(candidateInput({ pageTexts: [page] }))).toEqual([]);
  });

  it('does not fire on an unlocated page, even with every other gate green', () => {
    expect(detectWmTableCandidates(candidateInput({ locatedPages: [3] }))).toEqual([]);
    expect(detectWmTableCandidates(candidateInput({ locatedPages: [] }))).toEqual([]);
  });

  it('does not fire when the classification is only suspect (unmeasured evidence)', () => {
    expect(detectWmTableCandidates(candidateInput({
      classifications: new Map([[9, cls(9, 'P5', 'suspect')]]),
    }))).toEqual([]);
  });

  it('does not fire when the claimed kind is not a text-bearing sheet kind', () => {
    expect(detectWmTableCandidates(candidateInput({
      classifications: new Map([[9, cls(9, 'P1', 'claimed')]]),
    }))).toEqual([]);
    expect(detectWmTableCandidates(candidateInput({
      classifications: new Map([[9, cls(9, 'P6', 'claimed')]]),
    }))).toEqual([]);
  });

  it('does not fire when classification is unmeasured (null map, or page missing)', () => {
    expect(detectWmTableCandidates(candidateInput({ classifications: null }))).toEqual([]);
    expect(detectWmTableCandidates(candidateInput({ classifications: new Map() }))).toEqual([]);
  });

  it('does not fire when a table was already claimed (hook is last resort)', () => {
    expect(detectWmTableCandidates(candidateInput({ tablesClaimed: 1 }))).toEqual([]);
  });

  it('does not fire when no fill is possible (every diameter stated)', () => {
    expect(detectWmTableCandidates(candidateInput({ facts: factsWith([wm(250, 66), wm(150, 237)]) }))).toEqual([]);
  });

  it('does not fire on a texty page even with a servicing title', () => {
    const page = readablePage(9);
    expect(isTextyPage(page)).toBe(true);
    expect(detectWmTableCandidates(candidateInput({
      pageTexts: [page], classifications: new Map([[9, realCls(page)]]),
    }))).toEqual([]);
  });

  it('does not fire on a clean raster page (no glyph layer to speak of)', () => {
    const scan: PageText = { page: 9, width: 612, height: 792, items: [] };
    expect(detectWmTableCandidates(candidateInput({ pageTexts: [scan] }))).toEqual([]);
  });

  it('does not fire when the glyph fraction is low (readable layer)', () => {
    const mostlyReadable = glyphPage(9);
    // Swap 50 glyph items for words: single-char fraction drops to 20/81.
    mostlyReadable.items = [
      ...Array.from({ length: 20 }, (_, i) => ({ text: 'X', x: i * 10, y: 100, width: 8, height: 10 })),
      ...Array.from({ length: 60 }, (_, i) => ({ text: 'WORD', x: i * 10, y: 200, width: 40, height: 10 })),
      { text: 'SERVICING PLAN', x: 324, y: 257, width: 168, height: 20 },
    ];
    expect(detectWmTableCandidates(candidateInput({ pageTexts: [mostlyReadable] }))).toEqual([]);
  });

  it('returns multiple candidates in page order', () => {
    const pages = [glyphPage(12), glyphPage(9), glyphPage(10, 'SITE SERVICING PLAN')];
    const out = detectWmTableCandidates(candidateInput({
      pageTexts: pages,
      locatedPages: [9, 10, 12],
      classifications: new Map([[9, cls(9)], [10, cls(10, 'P2')], [12, cls(12)]]),
    }));
    expect(out.map((c) => c.page)).toEqual([9, 10, 12]);
  });

  it('the S2 kill switch disables the detector (and so the hook)', () => {
    process.env.DISABLE_WM_TABLE_MINER = '1';
    expect(detectWmTableCandidates(candidateInput())).toEqual([]);
  });

  it('the per-job spend cap is a small constant (registry budget)', () => {
    expect(WM_HOOK_MAX_CALLS_PER_JOB).toBe(3);
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
