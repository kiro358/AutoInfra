/**
 * PR48 — specialist S2, the WM-table miner (wm-table-miner.ts):
 * fail-pre/pass-post for the fill, and the negative battery (spec
 * prose, stated lengths, ambiguous columns, conflicting tables) that
 * keeps it fail-closed.
 *
 * The positive fixture reproduces Panattoni's printed "WATERMAIN
 * LENGTHS (METERS)" table digit-for-digit (PR 29 crop): BLDG A + BLDG B
 * per diameter, whose sums are the workbook's totals — 100→75, 150→237,
 * 200→356, 250→66, 300→44. On the golden corpus the real table is
 * stroke-font raster and reaches NO text layer, so these positioned
 * fixtures are the module's proof surface, exactly as schedule-table's
 * are (its header note is the precedent).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { PageText, PositionedText } from './pdf-text';
import type { TakeoffFacts, TileTranscript, WatermainFact, WithheldItem } from './types';
import {
  applyWmTableMiner, detectWmTablesInText, detectWmTablesInTranscript, wmTableFiring,
} from './wm-table-miner';
import { isSpecialistDisabled } from './specialists';

const savedDisable = process.env.DISABLE_WM_TABLE_MINER;
afterEach(() => {
  if (savedDisable === undefined) delete process.env.DISABLE_WM_TABLE_MINER;
  else process.env.DISABLE_WM_TABLE_MINER = savedDisable;
});

// ---- fixture builders -------------------------------------------------------

const item = (text: string, x: number, y: number, width = 16): PositionedText =>
  ({ text, x, y, width, height: 10 });

/** One visual row of [text, x, width?] cells at height y. */
const row = (y: number, cells: [string, number, number?][]): PositionedText[] =>
  cells.map(([text, x, w]) => item(text, x, y, w ?? 16));

/** The Panattoni table as positioned text (page 1). Word-split header
 *  items, as a CAD text layer emits them. */
function panattoniPage(): PageText {
  const items: PositionedText[] = [
    ...row(1000, [['WATERMAIN LENGTHS (METERS)', 100, 260]]),
    ...row(962, [['BLDG', 330, 30], ['A', 368, 8], ['BLDG', 470, 30], ['B', 508, 8]]),
    ...row(924, [['100mm', 110, 42], ['43', 345], ['32', 485]]),
    ...row(886, [['150mm', 110, 42], ['167', 345], ['70', 485]]),
    ...row(848, [['200mm', 110, 42], ['316', 345], ['40', 485]]),
    ...row(810, [['250mm', 110, 42], ['39', 345], ['27', 485]]),
    ...row(772, [['300mm', 110, 42], ['24', 345], ['20', 485]]),
  ];
  return { page: 1, width: 1224, height: 1584, items };
}

const wm = (sizeAndType: string, diameter: number, length = 0): WatermainFact => ({
  sizeAndType,
  length,
  pipeDiameter: diameter,
  ocSc: null,
  avgCover: null,
  source: { method: 'transcript', tile: 1, evidence: `${diameter}mmØ PVC DR18 WATERMAIN` },
});

const withheldFor = (entity: string): WithheldItem => ({
  entity,
  field: 'length',
  kind: 'withheld',
  question: `Length of the ${entity} watermain is not stated on the drawing — scale it off the plan. Left blank and not priced.`,
  defaultApplied: null,
});

const baseFacts = (over: Partial<TakeoffFacts>): TakeoffFacts => ({
  projectName: 'TEST',
  jobNumber: '',
  date: '',
  structures: [],
  catchbasins: [],
  sewers: [],
  watermain: [],
  watermainSpecials: [],
  watermainValves: [],
  confidence: 1,
  warnings: [],
  withheld: [],
  ...over,
});

/** Generalist state for the Panattoni shape: unstated segments for
 *  250/150/100 (the diameters the callouts found), nothing for the
 *  table's 200/300. */
const panattoniFacts = (): TakeoffFacts => baseFacts({
  watermain: [wm('250mm', 250), wm('250mm PVC', 250), wm('150mm PVC', 150), wm('100mm PVC', 100)],
  withheld: [withheldFor('250mm'), withheldFor('250mm PVC'), withheldFor('150mm PVC'), withheldFor('100mm PVC'), withheldFor('150mm')],
});

// ---- detection ----------------------------------------------------------------

describe('S2 WM-table detection (text layer)', () => {
  it('reads the Panattoni table: per-scope columns summed to the printed totals', () => {
    const { tables, rejectedTitles } = detectWmTablesInText(panattoniPage());
    expect(rejectedTitles).toBe(0);
    expect(tables).toHaveLength(1);
    expect(tables[0].page).toBe(1);
    expect(Object.fromEntries(tables[0].rows.map((r) => [r.diameterMm, r.totalLengthM]))).toEqual({
      100: 75, 150: 237, 200: 356, 250: 66, 300: 44,
    });
  });

  it('reads a headerless two-column table (diameter | length)', () => {
    const page: PageText = {
      page: 2, width: 1224, height: 1584,
      items: [
        ...row(1000, [['WATERMAIN LENGTHS', 100, 200]]),
        ...row(962, [['150mm', 110, 42], ['237', 345]]),
        ...row(924, [['100mm', 110, 42], ['75', 345]]),
      ],
    };
    const { tables } = detectWmTablesInText(page);
    expect(tables).toHaveLength(1);
    expect(Object.fromEntries(tables[0].rows.map((r) => [r.diameterMm, r.totalLengthM]))).toEqual({ 150: 237, 100: 75 });
  });

  it('an explicit TOTAL column wins over the part columns', () => {
    const page: PageText = {
      page: 1, width: 1224, height: 1584,
      items: [
        ...row(1000, [['WATERMAIN LENGTHS (METERS)', 100, 260]]),
        ...row(962, [['BLDG', 330, 30], ['A', 368, 8], ['TOTAL', 470, 40]]),
        ...row(924, [['150mm', 110, 42], ['167', 345], ['237', 485]]),
        ...row(886, [['100mm', 110, 42], ['43', 345], ['75', 485]]),
      ],
    };
    const { tables } = detectWmTablesInText(page);
    expect(tables).toHaveLength(1);
    expect(Object.fromEntries(tables[0].rows.map((r) => [r.diameterMm, r.totalLengthM]))).toEqual({ 150: 237, 100: 75 });
  });

  it('spec prose never claims: no title grid, no table', () => {
    const page: PageText = {
      page: 10, width: 1224, height: 1584,
      items: [
        ...row(1000, [['ALL SANITARY SEWERS, STORM SEWERS AND WATERMAINS CONSTRUCTED ON THIS SITE', 100, 700]]),
        ...row(962, [['WATERMAIN LENGTHS SHALL BE MEASURED ALONG THE CENTRELINE OF PIPE AS INSTALLED', 100, 700]]),
        ...row(924, [['THE COVER FOR ALL WATERMAINS AND WATER SERVICES IS TO BE A MINIMUM OF 1.8M', 100, 700]]),
        ...row(886, [['13.', 100, 20], ['MINIMUM SIZE FOR A NEW WATER SERVICE IS 19 mm DIAMETER', 140, 500]]),
      ],
    };
    const { tables } = detectWmTablesInText(page);
    expect(tables).toHaveLength(0);
  });

  it('a short prose heading over non-grid rows is a rejected title, not a table', () => {
    const page: PageText = {
      page: 1, width: 1224, height: 1584,
      items: [
        ...row(1000, [['WATERMAIN LENGTHS', 100, 200]]),
        ...row(962, [['MEASURED ALONG CENTRELINE', 100, 260], ['AS INSTALLED', 400, 120]]),
        ...row(924, [['PAYMENT PER METRE', 100, 200], ['OF PIPE', 400, 80]]),
      ],
    };
    const { tables, rejectedTitles } = detectWmTablesInText(page);
    expect(tables).toHaveLength(0);
    expect(rejectedTitles).toBe(1);
  });

  it('a sewer lengths table is not a watermain table', () => {
    const page: PageText = {
      page: 1, width: 1224, height: 1584,
      items: [
        ...row(1000, [['SANITARY SEWER LENGTHS (METERS)', 100, 300]]),
        ...row(962, [['150mm', 110, 42], ['237', 345]]),
        ...row(924, [['100mm', 110, 42], ['75', 345]]),
      ],
    };
    expect(detectWmTablesInText(page).tables).toHaveLength(0);
  });

  it('a single-row grid is rejected (a lone row is a callout fragment, not a table)', () => {
    const page: PageText = {
      page: 1, width: 1224, height: 1584,
      items: [
        ...row(1000, [['WATERMAIN LENGTHS', 100, 200]]),
        ...row(962, [['150mm', 110, 42], ['237', 345]]),
      ],
    };
    const { tables, rejectedTitles } = detectWmTablesInText(page);
    expect(tables).toHaveLength(0);
    expect(rejectedTitles).toBe(1);
  });

  it('non-scope numeric columns (EAST / WEST) make the arithmetic ambiguous: rejected', () => {
    const page: PageText = {
      page: 1, width: 1224, height: 1584,
      items: [
        ...row(1000, [['WATERMAIN LENGTHS (METERS)', 100, 260]]),
        ...row(962, [['EAST', 330, 34], ['WEST', 470, 36]]),
        ...row(924, [['150mm', 110, 42], ['167', 345], ['70', 485]]),
        ...row(886, [['100mm', 110, 42], ['43', 345], ['32', 485]]),
      ],
    };
    const { tables, rejectedTitles } = detectWmTablesInText(page);
    expect(tables).toHaveLength(0);
    expect(rejectedTitles).toBe(1);
  });

  it('a non-standard printed diameter (123mm) rejects the table', () => {
    const page: PageText = {
      page: 1, width: 1224, height: 1584,
      items: [
        ...row(1000, [['WATERMAIN LENGTHS', 100, 200]]),
        ...row(962, [['123mm', 110, 42], ['50', 345]]),
        ...row(924, [['100mm', 110, 42], ['75', 345]]),
      ],
    };
    expect(detectWmTablesInText(page).tables).toHaveLength(0);
  });
});

describe('S2 WM-table detection (transcript channel)', () => {
  it('reads a pipe-delimited table out of a transcript tile', () => {
    const tiles: TileTranscript[] = [{
      tile: 7,
      blocks: [[
        'WATERMAIN LENGTHS (METERS)',
        'SIZE | BLDG A | BLDG B',
        '150mm | 167 | 70',
        '100mm | 43 | 32',
      ]],
    }];
    const { tables } = detectWmTablesInTranscript(tiles);
    expect(tables).toHaveLength(1);
    expect(tables[0].tile).toBe(7);
    expect(Object.fromEntries(tables[0].rows.map((r) => [r.diameterMm, r.totalLengthM]))).toEqual({ 150: 237, 100: 75 });
  });
});

// ---- the fill -------------------------------------------------------------------

describe('S2 WM-table fill', () => {
  it('fills the unstated diameters, refuses the ones with no generalist row', () => {
    const facts = panattoniFacts();
    const result = applyWmTableMiner(facts, [panattoniPage()], []);
    expect(result.filled.map((f) => [f.diameterMm, f.totalLengthM])).toEqual([[250, 66], [150, 237], [100, 75]]);
    expect(result.refusals).toEqual([
      { diameterMm: 300, reason: 'no-generalist-row' },
      { diameterMm: 200, reason: 'no-generalist-row' },
    ]);
    const byDia = new Map(result.facts.watermain.map((w) => [w.sizeAndType, w]));
    expect(byDia.get('250mm')!.length).toBe(66);
    expect(byDia.get('250mm PVC')!.length).toBe(0); // only the first segment carries the total; reconcile sums
    expect(byDia.get('150mm PVC')!.length).toBe(237);
    expect(byDia.get('100mm PVC')!.length).toBe(75);
    const filledFact = byDia.get('150mm PVC')!;
    expect(filledFact.source).toMatchObject({
      method: 'schedule', producer: 'S2-wm-table-miner', family: 'wm-table', page: 1,
    });
    expect(filledFact.source!.evidence).toContain('150mm | 167 | 70');
    // Withheld: the filled diameters' "not stated" questions collapse
    // into one derived record each; nothing else remains.
    const withheld = result.facts.withheld!;
    expect(withheld).toHaveLength(3);
    expect(withheld.every((w) => w.kind === 'derived' && w.field === 'length')).toBe(true);
    expect(withheld.map((w) => Number(w.defaultApplied!.value)).sort((a, b) => a - b)).toEqual([66, 75, 237]);
    // Input facts untouched (copy-on-write).
    expect(facts.watermain.every((w) => w.length === 0)).toBe(true);
    // Firing record.
    const firing = wmTableFiring(result);
    expect(firing.fired).toBe(3);
    expect(firing.pages).toEqual([1]);
    expect(firing.detail).toMatchObject({ tables: 1, filled: 3, 'refused:no-generalist-row': 2 });
  });

  it('never overwrites a stated length: a diameter with any stated segment is refused whole', () => {
    const facts = baseFacts({
      watermain: [wm('150mm PVC', 150, 12), wm('150mm', 150), wm('100mm PVC', 100)],
      withheld: [withheldFor('150mm'), withheldFor('100mm PVC')],
    });
    const result = applyWmTableMiner(facts, [panattoniPage()], []);
    expect(result.refusals).toContainEqual({ diameterMm: 150, reason: 'generalist-length-stated' });
    expect(result.facts.watermain.find((w) => w.sizeAndType === '150mm PVC')!.length).toBe(12);
    expect(result.facts.watermain.find((w) => w.sizeAndType === '100mm PVC')!.length).toBe(75);
  });

  it('when every diameter is refused, the facts reference is untouched', () => {
    const facts = baseFacts({
      watermain: [wm('150mm PVC', 150, 12), wm('100mm PVC', 100, 30), wm('250mm', 250, 5)],
      withheld: [],
    });
    const result = applyWmTableMiner(facts, [panattoniPage()], []);
    expect(result.filled).toHaveLength(0);
    expect(result.facts).toBe(facts);
  });

  it('two tables disagreeing on a diameter poison only that diameter', () => {
    const pageB: PageText = {
      page: 2, width: 1224, height: 1584,
      items: [
        ...row(1000, [['WATERMAIN LENGTHS (METERS)', 100, 260]]),
        ...row(962, [['BLDG', 330, 30], ['A', 368, 8], ['BLDG', 470, 30], ['B', 508, 8]]),
        ...row(924, [['150mm', 110, 42], ['100', 345], ['100', 485]]),
        ...row(886, [['100mm', 110, 42], ['43', 345], ['32', 485]]),
      ],
    };
    const facts = baseFacts({
      watermain: [wm('150mm PVC', 150), wm('100mm PVC', 100)],
      withheld: [withheldFor('150mm PVC'), withheldFor('100mm PVC')],
    });
    const result = applyWmTableMiner(facts, [panattoniPage(), pageB], []);
    expect(result.refusals).toContainEqual({ diameterMm: 150, reason: 'conflicting-tables' });
    expect(result.facts.watermain.find((w) => w.pipeDiameter === 150)!.length).toBe(0);
    expect(result.facts.watermain.find((w) => w.pipeDiameter === 100)!.length).toBe(75);
  });

  it('fills from the transcript channel with tile provenance', () => {
    const tiles: TileTranscript[] = [{
      tile: 7,
      blocks: [['WATERMAIN LENGTHS (METERS)', 'SIZE | BLDG A | BLDG B', '150mm | 167 | 70', '100mm | 43 | 32']],
    }];
    const facts = baseFacts({
      watermain: [wm('150mm PVC', 150), wm('100mm PVC', 100)],
      withheld: [withheldFor('150mm PVC'), withheldFor('100mm PVC')],
    });
    const result = applyWmTableMiner(facts, [], tiles);
    expect(result.filled.map((f) => f.totalLengthM).sort((a, b) => a - b)).toEqual([75, 237]);
    expect(result.facts.watermain[0].source).toMatchObject({ method: 'schedule', producer: 'S2-wm-table-miner', tile: 7 });
  });

  it('no table anywhere: same facts reference, empty result', () => {
    const facts = panattoniFacts();
    const result = applyWmTableMiner(facts, [], []);
    expect(result.facts).toBe(facts);
    expect(result.tables).toHaveLength(0);
    expect(result.filled).toHaveLength(0);
  });

  it('kill switch: DISABLE_WM_TABLE_MINER disables; "false" never does', () => {
    const facts = panattoniFacts();
    process.env.DISABLE_WM_TABLE_MINER = '1';
    expect(isSpecialistDisabled('S2-wm-table-miner')).toBe(true);
    const off = applyWmTableMiner(facts, [panattoniPage()], []);
    expect(off.facts).toBe(facts);
    expect(off.tables).toHaveLength(0);
    process.env.DISABLE_WM_TABLE_MINER = 'false';
    expect(isSpecialistDisabled('S2-wm-table-miner')).toBe(false);
    const on = applyWmTableMiner(facts, [panattoniPage()], []);
    expect(on.filled).toHaveLength(3);
    delete process.env.DISABLE_WM_TABLE_MINER;
  });
});
