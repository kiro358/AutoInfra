import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  readTruthFacts,
  mergeTruthFacts,
  listTruthCandidates,
  loadTruthManifest,
  resolveTruthFacts,
} from './truth-facts';
import { TakeoffFacts } from './types';

const tf = (o: Partial<TakeoffFacts> = {}): TakeoffFacts => ({
  projectName: 'T', jobNumber: '', date: '',
  structures: [], catchbasins: [], sewers: [], watermain: [],
  watermainSpecials: [], watermainValves: [], confidence: 1, warnings: [], ...o,
});
const sewer = (runLabel: string) => ({ runLabel, isLineItem: false, length: 10, pipeDiameter: 250, typeClass: null, slope: null, depth: null });

// Smoke test against the real (empty) SHORT template that ships in the repo.
// Confirms the sheet/column wiring is valid and an unfilled template yields no
// facts — the full metric is exercised by compare-facts.test.ts.
const TEMPLATE = path.resolve(__dirname, '../../../empty_templates/SHORT-NEW - Copy (3).xlsx');

describe('readTruthFacts', () => {
  it.skipIf(!fs.existsSync(TEMPLATE))('parses a workbook into the TakeoffFacts shape', async () => {
    const facts = await readTruthFacts(TEMPLATE, 'EMPTY TEMPLATE');
    expect(Array.isArray(facts.structures)).toBe(true);
    expect(Array.isArray(facts.sewers)).toBe(true);
    expect(Array.isArray(facts.watermain)).toBe(true);
    // An unfilled template has no structures and no real pipe runs — the only
    // pre-printed sewer rows are the standard fee line-items (VIDEO/LAYOUT/AS BUILT).
    expect(facts.structures).toHaveLength(0);
    expect(facts.watermain).toHaveLength(0);
    expect(facts.sewers.every((s) => s.isLineItem)).toBe(true);
  });
});

describe('mergeTruthFacts (genuine multi-workbook site splits)', () => {
  it('concatenates runs/structures and sums catchbasins by type', () => {
    const a = tf({ sewers: [sewer('MH 1-MH 2')], structures: [{ description: 'MH 1' } as any], catchbasins: [{ type: 'SINGLE_CB', quantity: 3, wallThickness: null, depth: null }] });
    const b = tf({ sewers: [sewer('MH 3-MH 4')], structures: [{ description: 'MH 3' } as any], catchbasins: [{ type: 'SINGLE_CB', quantity: 2, wallThickness: null, depth: null }, { type: 'DOUBLE_CB', quantity: 1, wallThickness: null, depth: null }] });
    const m = mergeTruthFacts([a, b], 'SITE');
    expect(m.sewers.map((s) => s.runLabel)).toEqual(['MH 1-MH 2', 'MH 3-MH 4']);
    expect(m.structures).toHaveLength(2);
    expect(m.catchbasins.find((c) => c.type === 'SINGLE_CB')!.quantity).toBe(5); // 3 + 2
    expect(m.catchbasins.find((c) => c.type === 'DOUBLE_CB')!.quantity).toBe(1);
  });
});

describe('listTruthCandidates (junk filter)', () => {
  it('drops generated/backup/quote/material-quote/sand&gravel but KEEPS budget estimates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthcand-'));
    for (const f of [
      'PROJECT.xlsx', '1220 WILSON AVE. BUDGET.xlsx',      // real truth (budget no longer wrongly excluded)
      'eval_run_golden_123.xlsx', 'PROJECT backup.xlsx', 'QUOTE.xlsx',
      'Sand & Gravel Material Quotes.xlsx', 'notes.pdf',
    ]) fs.writeFileSync(path.join(dir, f), '');
    const got = listTruthCandidates(dir).sort();
    expect(got).toEqual(['1220 WILSON AVE. BUDGET.xlsx', 'PROJECT.xlsx']);
  });
});

describe('loadTruthManifest / resolveTruthFacts', () => {
  it('returns {} for a missing manifest and strips the _readme key', () => {
    expect(loadTruthManifest('/no/such/manifest.json')).toEqual({});
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'man-')), 'm.json');
    fs.writeFileSync(p, JSON.stringify({ _readme: 'x', 'PROJ': { truth: 'a.xlsx' } }));
    const m = loadTruthManifest(p);
    expect(m._readme).toBeUndefined();
    expect(m['PROJ']).toEqual({ truth: 'a.xlsx' });
  });
  it('excludes a project marked exclude in the manifest', async () => {
    const got = await resolveTruthFacts('/anything', 'PROJ', { PROJ: { exclude: true } });
    expect(got).toBeNull();
  });
});

describe('readTruthFacts — structure-label admission (PR20: compact IDs)', () => {
  // Build a one-sheet MANHOLES workbook: [row, label, physicals?] in rows 11+.
  async function manholesWorkbook(rows: Array<[number, string, Record<string, unknown>?]>): Promise<string> {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('MANHOLES (1)');
    for (const [r, label, cells] of rows) {
      ws.getCell(`B${r}`).value = label;
      for (const [col, v] of Object.entries(cells ?? {})) ws.getCell(`${col}${r}`).value = v as never;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthmh-'));
    const file = path.join(dir, 'T.xlsx');
    await wb.xlsx.writeFile(file);
    return file;
  }

  it('keeps compact structure IDs with NO physical values (MH6N, DCBMH5N, DICB2, CB3, MH10A, STMH1)', async () => {
    const file = await manholesWorkbook([
      [11, 'MH6N'], [12, 'DCBMH5N'], [13, 'DICB2'], [14, 'CB3'], [15, 'MH10A'], [16, 'STMH1'],
    ]);
    const facts = await readTruthFacts(file, 'T');
    expect(facts.structures.map((s) => s.description)).toEqual(['MH6N', 'DCBMH5N', 'DICB2', 'CB3', 'MH10A', 'STMH1']);
  });

  it('keeps a formula-depth row by label (generated workbooks write depth as an unevaluated formula)', async () => {
    // Depth cell holds a formula with NO cached result — exactly what the
    // spreadsheet writer emits when rim/invert weren't both read. Every
    // physical field parses null, so only the label can admit the row.
    const file = await manholesWorkbook([
      [11, 'MH6N', { J: { formula: '(C11-D11)*IF(F$7=1,1,0.3049)' } }],
    ]);
    const facts = await readTruthFacts(file, 'T');
    expect(facts.structures).toHaveLength(1);
    expect(facts.structures[0].description).toBe('MH6N');
    expect(facts.structures[0].depth).toBeNull();
  });

  it('still keeps spaced/standalone IDs and physical-value rows (original admission paths)', async () => {
    const file = await manholesWorkbook([
      [11, 'MH 12'], [12, 'MH'], [13, 'CHAMBER 1'],
      [14, 'HEADWALL', { C: 250.5 }], // no ID token — admitted on physicals alone
    ]);
    const facts = await readTruthFacts(file, 'T');
    expect(facts.structures.map((s) => s.description)).toEqual(['MH 12', 'MH', 'CHAMBER 1', 'HEADWALL']);
  });

  it('excludes template chrome, headers and labor rows on the label path', async () => {
    const file = await manholesWorkbook([
      [11, 'MH F&C $'], [12, 'CB F&C $'],          // template price chrome — not structures
      [13, 'CATCHBASINS'], [14, 'ITEMS'],           // block headers inside the row range
      [15, 'STORM'], [16, 'SANITARY'],              // section headers
      [17, 'LABOR SCB'], [18, 'LABOR DCB'],         // labor rows
      [19, 'EXISTING MH1 REMOVAL'],                 // junk filter beats the compact-ID match
      [20, 'SEE DRAWING NOTES'],                    // prose, no structure ID
    ]);
    const facts = await readTruthFacts(file, 'T');
    expect(facts.structures).toHaveLength(0);
  });
});

describe('readTruthFacts — watermain ocSc/avgCover carry no invented defaults (PR2)', () => {
  it('leaves blank ocSc/avgCover null and keeps stated values', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('WATERMAIN (1)');
    // Row 13: length + diameter stated, ocSc (F) and avgCover (J) blank.
    ws.getCell('B13').value = '200mm PVC';
    ws.getCell('C13').value = 50;
    ws.getCell('D13').value = 200;
    // Row 14: everything stated.
    ws.getCell('B14').value = '300mm PVC';
    ws.getCell('C14').value = 30;
    ws.getCell('D14').value = 300;
    ws.getCell('F14').value = 1.2;
    ws.getCell('J14').value = 2.1;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthwm-'));
    const file = path.join(dir, 'T.xlsx');
    await wb.xlsx.writeFile(file);
    const facts = await readTruthFacts(file, 'T');
    expect(facts.watermain).toHaveLength(2);
    expect(facts.watermain[0].ocSc).toBeNull();
    expect(facts.watermain[0].avgCover).toBeNull();
    expect(facts.watermain[1].ocSc).toBe(1.2);
    expect(facts.watermain[1].avgCover).toBe(2.1);
  });
});
