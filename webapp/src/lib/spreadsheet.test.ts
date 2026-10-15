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

  it('leaves the diameter blank on a row with no depth (LONG prices 1200mm @ 0m as #N/A)', async () => {
    const { wb } = await build(facts({ structures: [
      { ...st('HEADWALL 1'), topElevation: null, lowInvert: null },
      ...Array.from({ length: 40 }, (_, i) => st(`MH ${i + 1}`)),
    ] }));
    expect(val(wb, 'MANHOLES (1)', 'B11')).toBe('HEADWALL 1');
    // The template's own size formula stays (it yields 0 with no pipe size), as on the
    // estimator's sheet for "HW 1 / RIP RAP" and "902 HD".
    expect(formulaOf(wb.getWorksheet('MANHOLES (1)')!, 'L11')).toContain('HLOOKUP');
    expect(val(wb, 'MANHOLES (1)', 'L12')).toBe(1200);
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

describe('populateTemplate — AUDIT sheet (PR 8)', () => {
  it('lists withheld, defaulted and derived values on an AUDIT sheet', async () => {
    const { wb } = await build(facts({
      catchbasins: [{ type: 'SINGLE_CB', quantity: 2, wallThickness: null, depth: null }],
      watermain: [{ sizeAndType: '200mm PVC', length: 40, pipeDiameter: 200, ocSc: null, avgCover: null }],
      withheld: [{ entity: '200mm PVC', field: 'length', kind: 'withheld', question: 'Length not stated?', defaultApplied: null }],
    }));
    const audit = wb.getWorksheet('AUDIT');
    expect(audit, 'AUDIT sheet exists').toBeTruthy();
    const texts: string[] = [];
    audit!.eachRow({ includeEmpty: false }, (r) => r.eachCell({ includeEmpty: false }, (c) => texts.push(String(c.value))));
    const joined = texts.join('\n');
    expect(joined).toContain('WITHHELD — left blank');
    expect(joined).toContain('DEFAULTED — default applied');
    expect(joined).toContain('wallThickness');
    expect(joined).toContain('ocSc');
    expect(joined).toContain('Length not stated?');
  });

  it('still writes an AUDIT sheet for a legacy extraction with no withheld list', async () => {
    const ex = priceTakeoff(facts({}));
    delete ex.withheld; // simulate a pre-PR-8 extraction record
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await populateTemplate(ex, PARAMS)) as unknown as ArrayBuffer);
    const audit = wb.getWorksheet('AUDIT');
    expect(audit).toBeTruthy();
    const texts: string[] = [];
    audit!.eachRow({ includeEmpty: false }, (r) => r.eachCell({ includeEmpty: false }, (c) => texts.push(String(c.value))));
    expect(texts.join('\n')).toContain('predates provenance/withheld recording');
  });

  it('summarizes pipeline diagnostics on the AUDIT sheet when the run recorded them (PR18)', async () => {
    const { wb } = await build(facts({
      structures: [st('MH 1')],
      diagnostics: {
        version: 1, mode: 'hybrid', durationMs: 1000,
        locator: {
          ran: true, rawPicks: [1], unionAdded: [{ page: 3, reason: 'text-yield' }],
          finalPages: [1, 3], tileAllFallback: false,
        },
        pages: [],
        tiles: { planned: 24, rendered: 24, uploaded: 24, transcribed: 16, missingAfterRetry: 8, degenerateDiscarded: 0, blocks: 40 },
        assembly: {
          sources: [{ path: 'transcript', counts: { structures: 1, sewers: 0, watermain: 0, catchbasins: 0 } }],
          final: { structures: 1, sewers: 0, watermain: 0, catchbasins: 0 },
        },
      },
    }));
    const audit = wb.getWorksheet('AUDIT');
    const texts: string[] = [];
    audit!.eachRow({ includeEmpty: false }, (r) => r.eachCell({ includeEmpty: false }, (c) => texts.push(String(c.value))));
    const joined = texts.join('\n');
    expect(joined).toContain('PIPELINE DIAGNOSTICS');
    expect(joined).toContain('Located pages: 1, 3');
    expect(joined).toContain('locator union added p3 (text-yield)');
    expect(joined).toContain('24 planned, 24 rendered, 16 transcribed');
    expect(joined).toContain('8 lost after retry');
    expect(joined).toContain('transcript: 1 structures');
  });

  it('says so when nothing was withheld', async () => {
    const { ex } = await build(facts({}));
    ex.withheld = [];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await populateTemplate(ex, PARAMS)) as unknown as ArrayBuffer);
    const audit = wb.getWorksheet('AUDIT');
    const texts: string[] = [];
    audit!.eachRow({ includeEmpty: false }, (r) => r.eachCell({ includeEmpty: false }, (c) => texts.push(String(c.value))));
    expect(texts.join('\n')).toContain('Nothing withheld');
  });
});

// ---------------------------------------------------------------------------
// Storm/sanitary sections (PR21): the estimator's workbooks keep the systems
// in headed sections — storm first, sanitary second — inside MANHOLES and
// SEWERS. Generation groups the same way; unclassed entities go under
// UNSPECIFIED, never under a guessed system.
// ---------------------------------------------------------------------------
import fs from 'fs';
import os from 'os';
import { readTruthFacts } from './truth-facts';

const dimRun = (runLabel: string, length = 10, pipeDiameter = 300): SewerFact => ({
  runLabel, isLineItem: false, length, pipeDiameter, typeClass: null, slope: 1, depth: null,
});
const colB = (wb: ExcelJS.Workbook, sheet: string, from: number, to: number): (string | null)[] => {
  const out: (string | null)[] = [];
  for (let r = from; r <= to; r++) {
    const v = val(wb, sheet, `B${r}`);
    out.push(v == null ? null : String(v));
  }
  return out;
};
const auditText = (wb: ExcelJS.Workbook): string => {
  const texts: string[] = [];
  wb.getWorksheet('AUDIT')!.eachRow({ includeEmpty: false }, (r) =>
    r.eachCell({ includeEmpty: false }, (c) => texts.push(String(c.value))));
  return texts.join('\n');
};
async function buildToFile(f: TakeoffFacts): Promise<{ ex: ExtractionResult; wb: ExcelJS.Workbook; file: string }> {
  const { ex, wb } = await build(f);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr21-')), 'gen.xlsx');
  await wb.xlsx.writeFile(file);
  return { ex, wb, file };
}

describe('populateTemplate — storm/sanitary sections', () => {
  it('groups manholes and sewers under STORM / SANITARY / UNSPECIFIED headings (SHORT)', async () => {
    const { ex, wb } = await build(facts({
      structures: [st('STMH 1'), st('SAN MH 1'), st('MH 7')],
      sewers: [dimRun('10m-300mm STM'), dimRun('20m-200mm SAN', 20, 200), dimRun('5m-150mm', 5, 150)],
    }));
    expect(ex.templateType).toBe('SHORT');
    expect(colB(wb, 'MANHOLES (1)', 10, 16)).toEqual([
      'STORM', 'STMH 1', 'SANITARY', 'SAN MH 1', 'UNSPECIFIED', 'MH 7', null,
    ]);
    expect(colB(wb, 'SEWERS (1)', 13, 19)).toEqual([
      'STORM:', '10m-300mm STM', 'SANITARY', '20m-200mm SAN', 'UNSPECIFIED', '5m-150mm', null,
    ]);
  });

  it('flags unclassed entities in the warnings and on the AUDIT sheet — and writes everything', async () => {
    const { ex, wb, file } = await buildToFile(facts({
      structures: [st('STMH 1'), st('SAN MH 1'), st('MH 7')],
      sewers: [dimRun('10m-300mm STM'), dimRun('20m-200mm SAN', 20, 200), dimRun('5m-150mm', 5, 150)],
    }));
    expect(ex.warnings.some((w) => /1 structure\(s\) and 1 sewer run\(s\) could not be classed/.test(w))).toBe(true);
    const audit = auditText(wb);
    expect(audit).toContain('STORM / SANITARY SEPARATION');
    expect(audit).toContain('1 structure(s) and 1 sewer run(s)');
    // Round-trip through the workbook reader: every entity survives, and no
    // heading row parses back as an entity.
    const parsed = await readTruthFacts(file, 'T');
    expect(parsed.structures.map((s) => s.description).sort()).toEqual(['MH 7', 'SAN MH 1', 'STMH 1']);
    // (The SHORT template's fee rows — VIDEO / LAYOUT / AS BUILT — also parse
    // back, as line items, exactly as they did before sections existed.)
    expect(parsed.sewers.filter((s) => !s.isLineItem).map((s) => s.runLabel).sort())
      .toEqual(['10m-300mm STM', '20m-200mm SAN', '5m-150mm']);
    expect(parsed.sewers.map((s) => s.runLabel)).not.toContain('UNSPECIFIED');
    expect(parsed.sewers.map((s) => s.runLabel)).not.toContain('SANITARY');
  });

  it('emits no UNSPECIFIED section and no separation note when everything is classed', async () => {
    const { ex, wb } = await build(facts({
      structures: [st('STMH 1'), st('SAN MH 1')],
      sewers: [dimRun('10m-300mm STM'), dimRun('20m-200mm SAN', 20, 200)],
    }));
    expect(colB(wb, 'MANHOLES (1)', 10, 14)).toEqual(['STORM', 'STMH 1', 'SANITARY', 'SAN MH 1', null]);
    expect(colB(wb, 'SEWERS (1)', 13, 17)).toEqual(['STORM:', '10m-300mm STM', 'SANITARY', '20m-200mm SAN', null]);
    expect(ex.warnings.join(' ')).not.toMatch(/could not be classed/);
    expect(auditText(wb)).not.toContain('STORM / SANITARY SEPARATION');
  });

  it('counts headings in the SHORT fit test: 36 two-system structures go LONG rather than lose a row', async () => {
    const structures = [...Array.from({ length: 35 }, (_, i) => st(`STMH ${i + 1}`)), st('SAN MH 1')];
    const { ex, wb } = await build(facts({ structures }));
    expect(ex.templateType).toBe('LONG'); // 36 items + 1 in-flow heading > SHORT's 36 rows
    expect(ex.warnings.join(' ')).not.toMatch(/did not fit/);
    expect(val(wb, 'MANHOLES (1)', 'B45')).toBe('STMH 35');
    // Orphan rule: the SANITARY heading would sit alone on sheet 1's last row,
    // so the section starts sheet 2 under its header-row heading instead.
    expect(val(wb, 'MANHOLES (1)', 'B46')).toBeNull();
    expect(val(wb, 'MANHOLES (2)', 'B10')).toBe('SANITARY');
    expect(val(wb, 'MANHOLES (2)', 'B11')).toBe('SAN MH 1');
  });

  it('repeats the heading in the header row when a section continues onto the next sheet (LONG)', async () => {
    const structures = Array.from({ length: 40 }, (_, i) => st(`STMH ${i + 1}`));
    const { wb } = await build(facts({ structures }));
    expect(val(wb, 'MANHOLES (1)', 'B10')).toBe('STORM');
    expect(val(wb, 'MANHOLES (2)', 'B10')).toBe('STORM');
    expect(val(wb, 'MANHOLES (2)', 'B11')).toBe('STMH 37');

    const runs = await build(facts({ sewers: Array.from({ length: 45 }, () => dimRun('10m-300mm STM')) }));
    expect(val(runs.wb, 'SEWERS (1)', 'B13')).toBe('STORM:');
    expect(val(runs.wb, 'SEWERS (2)', 'B13')).toBe('STORM:');
    expect(val(runs.wb, 'SEWERS (2)', 'B14')).toBe('10m-300mm STM');
  });

  it('capacity accounting includes heading rows: the overflow warning counts them honestly', async () => {
    // 110 structures, LONG capacity 108 slots. Storm takes 107; the SANITARY
    // heading lands on the last sheet's last row and consumes it, so only 107
    // structures fit and the warning must say exactly that.
    const structures = [
      ...Array.from({ length: 107 }, (_, i) => st(`STMH ${i + 1}`)),
      st('SAN MH 1'), st('SAN MH 2'), st('SAN MH 3'),
    ];
    const { ex, wb } = await build(facts({ structures }));
    expect(val(wb, 'MANHOLES (3)', 'B45')).toBe('STMH 107');
    expect(val(wb, 'MANHOLES (3)', 'B46')).toBe('SANITARY');
    expect(ex.warnings.some((w) => /3 of 110 structures did not fit the LONG template \(max 107\)/.test(w))).toBe(true);
  });
});
