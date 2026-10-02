import { describe, it, expect } from 'vitest';
import { adjustFormulaForRow } from './spreadsheet';

describe('adjustFormulaForRow', () => {
  it('is a no-op for a zero offset', () => {
    expect(adjustFormulaForRow('C11+F$7', 0)).toBe('C11+F$7');
  });
  it('shifts relative row references by the offset', () => {
    expect(adjustFormulaForRow('C11', 4)).toBe('C15');
    expect(adjustFormulaForRow('SUM(A1:A2)', 1)).toBe('SUM(A2:A3)');
  });
  it('preserves absolute ($) row references', () => {
    expect(adjustFormulaForRow('C11+F$7', 4)).toBe('C15+F$7');
  });
});

// ---------------------------------------------------------------------------
// Template layout + populateTemplate, verified by writing a real workbook from the
// real empty_templates/*.xlsx and reading the cells back.
// ---------------------------------------------------------------------------
import path from 'path';
import ExcelJS from 'exceljs';
import { populateTemplate, parseSizeMm } from './spreadsheet';
import { priceTakeoff } from './costing-rules';
import { TEMPLATE_LAYOUT, DEFAULT_PARAMS, TemplateType } from './constants';
import { ExtractionResult, GlobalParams, TakeoffFacts, StructureFact, SewerFact } from './types';

const TEMPLATES = path.resolve(__dirname, '../../../empty_templates');
const PARAMS = DEFAULT_PARAMS as unknown as GlobalParams;

async function loadTemplate(t: TemplateType): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(TEMPLATES, TEMPLATE_LAYOUT[t].file));
  return wb;
}
function formulaOf(ws: ExcelJS.Worksheet, ref: string): string | undefined {
  const v = ws.getCell(ref).value as { formula?: string; ref?: string } | null;
  return v && typeof v === 'object' ? v.formula : undefined;
}
function sharedRefOf(ws: ExcelJS.Worksheet, ref: string): string | undefined {
  const v = ws.getCell(ref).value as { ref?: string } | null;
  return v && typeof v === 'object' ? v.ref : undefined;
}

describe('TEMPLATE_LAYOUT matches the real templates', () => {
  for (const t of ['SHORT', 'LONG'] as const) {
    const L = TEMPLATE_LAYOUT[t];
    it(`${t}: manhole block is exactly the formula/totals range`, async () => {
      const wb = await loadTemplate(t);
      for (const name of L.manholes.sheets) {
        const ws = wb.getWorksheet(name)!;
        expect(ws, name).toBeTruthy();
        expect(sharedRefOf(ws, `J${L.manholes.firstRow}`)).toBe(`J${L.manholes.firstRow}:J${L.manholes.lastRow}`);
        expect(formulaOf(ws, 'U48')).toBe(`SUM(U${L.manholes.firstRow}:U${L.manholes.lastRow})`);
        expect(String(ws.getCell('A48').value)).toContain('MANHOLE TOTALS');
      }
    });

    it(`${t}: sewer block ends where the quantity total ends`, async () => {
      const wb = await loadTemplate(t);
      for (const name of L.sewers.sheets) {
        const ws = wb.getWorksheet(name)!;
        expect(ws, name).toBeTruthy();
        expect(formulaOf(ws, 'C57')).toBe(`SUM(C${L.sewers.firstRow}:C54)`);
        expect(L.sewers.lastRow).toBeLessThanOrEqual(54);
      }
      const ws = wb.getWorksheet(L.sewers.sheets[0])!;
      if (L.sewerFeeRows) {
        expect(L.sewers.lastRow).toBe(L.sewerFeeRows.VIDEO - 1);
        for (const [kind, row] of Object.entries(L.sewerFeeRows)) {
          expect(String(ws.getCell(`B${row}`).value)).toContain(kind);
        }
      } else {
        expect(L.sewers.lastRow).toBe(54);
        for (let r = 52; r <= 54; r++) expect(ws.getCell(`B${r}`).value).toBeNull();
      }
    });

    it(`${t}: watermain runs / specials / valve table rows`, async () => {
      const wb = await loadTemplate(t);
      const { firstRow, lastRow } = L.watermainRuns;
      for (const name of L.watermainRuns.sheets) {
        const ws = wb.getWorksheet(name)!;
        expect(ws, name).toBeTruthy();
        expect(formulaOf(wb.getWorksheet(name)!, `G${lastRow + 2}`) ?? formulaOf(ws, `P${lastRow + 2}`)).toBeTruthy();
        expect(String(ws.getCell(`A${lastRow + 2}`).value)).toContain('Pipe Totals');
      }
      const w1 = wb.getWorksheet('WATERMAIN (1)')!;
      expect(formulaOf(w1, `G${lastRow + 2}`)).toBe(`SUM(G${firstRow}:G${lastRow})`);
      expect(sharedRefOf(w1, `U${firstRow}`)).toBe(`U${firstRow}:U${lastRow}`);

      const sp = L.watermainSpecials;
      expect(formulaOf(w1, `H${sp.firstRow}`)).toBe(`G${sp.firstRow}*C${sp.firstRow}`);
      expect(w1.getCell(`B${sp.firstRow - 1}`).value).toBeNull(); // gap row, not data
      expect(String(w1.getCell(`B${sp.lastRow + 1}`).value)).toContain('One Locks');

      const vt = L.valveTable;
      expect(parseSizeMm(w1.getCell(`O${vt.firstRow}`).value)).toBe(50);
      expect(parseSizeMm(w1.getCell(`O${vt.lastRow}`).value)).toBe(300);
      expect(String(w1.getCell(`N${vt.lastRow + 1}`).value)).toContain('Totals');
    });
  }
});

const st = (description: string): StructureFact => ({
  description, topElevation: 100, lowInvert: 97, highInvert: null, pipeOutDiameter: 300, structureType: null, depth: null,
});
const run = (i: number): SewerFact => ({
  runLabel: `MH${i}-MH${i + 1}`, isLineItem: false, length: 10, pipeDiameter: 300, typeClass: null, slope: 1, depth: null,
});
function facts(o: Partial<TakeoffFacts>): TakeoffFacts {
  return {
    projectName: 'P', jobNumber: 'J', date: 'D', confidence: 1, warnings: [],
    structures: [], catchbasins: [], sewers: [], watermain: [], watermainSpecials: [], watermainValves: [],
    ...o,
  };
}
async function build(f: TakeoffFacts): Promise<{ ex: ExtractionResult; wb: ExcelJS.Workbook }> {
  const ex = priceTakeoff(f);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await populateTemplate(ex, PARAMS)) as unknown as ArrayBuffer);
  return { ex, wb };
}
const val = (wb: ExcelJS.Workbook, sheet: string, ref: string) => wb.getWorksheet(sheet)!.getCell(ref).value;

describe('populateTemplate — sewer fees (SHORT)', () => {
  it('writes the standard fees into the template fee rows once, at the costing-rules rate', async () => {
    const { ex, wb } = await build(facts({ sewers: [1, 2, 3, 4, 5].map(run) }));
    expect(ex.templateType).toBe('SHORT');
    const labels: string[] = [];
    for (let r = 13; r <= 55; r++) labels.push(String(val(wb, 'SEWERS (1)', `B${r}`) ?? ''));
    expect(labels.filter((l) => l.includes('VIDEO'))).toHaveLength(1);
    expect(labels.filter((l) => l.includes('LAYOUT'))).toHaveLength(1);
    expect(labels.filter((l) => l.includes('AS BUILT'))).toHaveLength(1);
    expect(val(wb, 'SEWERS (1)', 'B19')).toBeNull(); // nothing appended after the 5 runs
    expect(val(wb, 'SEWERS (1)', 'H52')).toBe(50 * 25); // overrides the template's =15*C57
    expect(val(wb, 'SEWERS (1)', 'H53')).toBe(5000);
    expect(val(wb, 'SEWERS (1)', 'H54')).toBe(5000);
  });

  it('zeroes the template fee rows when costing charges no fees (no sewers)', async () => {
    const { wb } = await build(facts({ structures: [st('MH1')] }));
    for (const r of [52, 53, 54]) expect(val(wb, 'SEWERS (1)', `H${r}`)).toBe(0);
  });
});

describe('populateTemplate — row capacity', () => {
  it('keeps structures inside rows 11..46 and never touches the totals row', async () => {
    const structures = Array.from({ length: 40 }, (_, i) => st(`MH${i + 1}`));
    const { ex, wb } = await build(facts({ structures }));
    expect(ex.templateType).toBe('LONG'); // 40 > SHORT's 36 rows
    expect(val(wb, 'MANHOLES (1)', 'B46')).toBe('MH36');
    for (const r of [47, 48, 49, 50]) {
      expect(val(wb, 'MANHOLES (1)', `B${r}`)).toBeNull();
      expect(val(wb, 'MANHOLES (1)', `C${r}`)).toBeNull();
    }
    expect(val(wb, 'MANHOLES (2)', 'B11')).toBe('MH37');
    expect(ex.warnings.join(' ')).not.toMatch(/did not fit/);
  });

  it('warns (never silently drops) when even LONG is full', async () => {
    const structures = Array.from({ length: 110 }, (_, i) => st(`MH${i + 1}`));
    const { ex, wb } = await build(facts({ structures }));
    expect(val(wb, 'MANHOLES (3)', 'B46')).toBe('MH108');
    expect(ex.warnings.some((w) => /2 of 110 structures did not fit the LONG template/.test(w))).toBe(true);
  });

  it('puts 41 sewer runs per LONG sheet (14..54), never row 55', async () => {
    const { ex, wb } = await build(facts({ sewers: Array.from({ length: 45 }, (_, i) => run(i + 1)) }));
    expect(ex.templateType).toBe('LONG');
    expect(val(wb, 'SEWERS (1)', 'B54')).toBe('MH41-MH42');
    expect(val(wb, 'SEWERS (1)', 'B55')).toBeNull();
    expect(val(wb, 'SEWERS (2)', 'B14')).toBe('MH42-MH43');
    // LONG has no template fee rows, so ours are appended after the runs
    expect(String(val(wb, 'SEWERS (2)', 'B18'))).toContain('VIDEO');
  });

  it('SHORT run rows stop before the template fee rows (38 fits, 39 goes LONG)', async () => {
    const short = await build(facts({ sewers: Array.from({ length: 38 }, (_, i) => run(i + 1)) }));
    expect(short.ex.templateType).toBe('SHORT');
    expect(val(short.wb, 'SEWERS (1)', 'B51')).toBe('MH38-MH39');
    expect(String(val(short.wb, 'SEWERS (1)', 'B52'))).toContain('VIDEO');
    const long = await build(facts({ sewers: Array.from({ length: 39 }, (_, i) => run(i + 1)) }));
    expect(long.ex.templateType).toBe('LONG');
  });
});

describe('populateTemplate — watermain', () => {
  const wm = (d: number) => ({ sizeAndType: `${d}mm PVC`, length: 50, pipeDiameter: d, ocSc: 1.1, avgCover: 1.7 });

  it('SHORT: runs from row 13, specials from row 24', async () => {
    const { ex, wb } = await build(facts({ watermain: [wm(200)], watermainSpecials: [{ specialName: 'TEE', quantity: 2 }] }));
    expect(ex.templateType).toBe('SHORT');
    expect(val(wb, 'WATERMAIN (1)', 'B13')).toBe('200mm PVC');
    expect(val(wb, 'WATERMAIN (1)', 'B24')).toBe('TEE');
  });

  it('LONG: runs from row 14 (row 13 has no formulas), specials from row 25', async () => {
    const { ex, wb } = await build(
      facts({
        sewers: Array.from({ length: 45 }, (_, i) => run(i + 1)),
        watermain: [wm(200), wm(150)],
        watermainSpecials: [{ specialName: 'TEE', quantity: 2 }],
      })
    );
    expect(ex.templateType).toBe('LONG');
    expect(val(wb, 'WATERMAIN (1)', 'B13')).toBeNull();
    expect(val(wb, 'WATERMAIN (1)', 'B14')).toBe('200mm PVC');
    expect(val(wb, 'WATERMAIN (1)', 'C14')).toBe(50);
    expect(val(wb, 'WATERMAIN (1)', 'B24')).toBeNull();
    expect(val(wb, 'WATERMAIN (1)', 'B25')).toBe('TEE');
  });

  it('valves: matched to the fixed size table by size, quantities summed, O never overwritten', async () => {
    const { ex, wb } = await build(
      facts({
        watermainValves: [
          { valveSize: '200mm', quantity: 3 },
          { valveSize: '200mm GV', quantity: 1 },
          { valveSize: '150mm', quantity: 2 },
          { valveSize: '400mm', quantity: 1 },
        ],
      })
    );
    const sheet = 'WATERMAIN (1)';
    const before = await loadTemplate('SHORT');
    for (let r = 24; r <= 29; r++) {
      expect(val(wb, sheet, `O${r}`)).toEqual(before.getWorksheet(sheet)!.getCell(`O${r}`).value);
      expect(val(wb, sheet, `Q${r}`)).toEqual(before.getWorksheet(sheet)!.getCell(`Q${r}`).value);
    }
    expect(val(wb, sheet, 'P27')).toBe(4); // 200mm row, priced at the template's 200mm $/valve
    expect(val(wb, sheet, 'P26')).toBe(2); // 150mm row
    expect(val(wb, sheet, 'P24')).toBeNull(); // 50mm row untouched
    expect(val(wb, sheet, 'T27')).toBe(150);
    expect(ex.warnings.some((w) => /Valve "400mm".*NOT written/.test(w))).toBe(true);
  });

  it('a watermain run with no length is left blank and flagged', async () => {
    const { ex, wb } = await build(facts({ watermain: [{ ...wm(200), length: 0 }] }));
    expect(val(wb, 'WATERMAIN (1)', 'C13')).toBeNull();
    expect(ex.warnings.some((w) => /length not found/.test(w))).toBe(true);
  });
});

describe('populateTemplate — 460 Bayly St E regressions', () => {
  it('writes the discount in each template\'s own convention', async () => {
    // SHORT: precast is *(1-F$5); LONG: *(100-F$5)/100.
    const short = await build(facts({ structures: [st('MH 1')] }));
    expect(short.ex.templateType).toBe('SHORT');
    expect(val(short.wb, 'MANHOLES (1)', 'F5')).toBe(PARAMS.manholes.discount);
    // SHORT's catchbasin factor no longer reads the fraction as a percent.
    expect(formulaOf(short.wb.getWorksheet('MANHOLES (1)')!, 'L6')).toBe('(1-F5)*I3*I4');

    const long = await build(facts({ structures: Array.from({ length: 40 }, (_, i) => st(`MH ${i + 1}`)) }));
    expect(long.ex.templateType).toBe('LONG');
    expect(val(long.wb, 'MANHOLES (1)', 'F5')).toBeCloseTo(PARAMS.manholes.discount * 100);
  });

  it('never writes half an elevation pair (it makes a negative depth and #N/A totals)', async () => {
    const { ex, wb } = await build(facts({ structures: [
      { ...st('MH 13'), topElevation: null, lowInvert: 85.1 },
      { ...st('MH 2'), topElevation: 89.7, lowInvert: 85.94 },
    ] }));
    expect(val(wb, 'MANHOLES (1)', 'C11')).toBeNull();
    expect(val(wb, 'MANHOLES (1)', 'D11')).toBeNull();
    expect(ex.warnings.some((w) => w.startsWith('MH 13'))).toBe(true);
    expect(val(wb, 'MANHOLES (1)', 'C12')).toBe(89.7);
    expect(val(wb, 'MANHOLES (1)', 'D12')).toBe(85.94);
  });

  it('uses the diameter stated on the drawing, and gives a chamber none', async () => {
    const { wb } = await build(facts({ structures: [
      { ...st('MH 100'), diameter: 2400 },
      { ...st('902 HD'), topElevation: null, lowInvert: null, structureType: 'CHAMBER' },
    ] }));
    expect(val(wb, 'MANHOLES (1)', 'L11')).toBe(2400);
    expect(val(wb, 'MANHOLES (1)', 'B12')).toBe('902 HD');
    expect(val(wb, 'MANHOLES (1)', 'L12')).not.toBe(1200);
  });
});
