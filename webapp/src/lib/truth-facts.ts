/**
 * Reads an estimator's filled workbook into TakeoffFacts (physical fields only),
 * so the redesigned facts-level metric (compare-facts.ts) can score the
 * extraction stage against ground truth. Pricing columns are deliberately ignored.
 */
import ExcelJS from 'exceljs';
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact } from './types';
import { getWorksheetFlex } from '../scripts/compare-sheets';

function cell(sheet: ExcelJS.Worksheet, ref: string): string | number | null {
  const c = sheet.getCell(ref);
  const v = c.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const f = v as ExcelJS.CellFormulaValue & { text?: string };
    if ('result' in f && f.result != null && typeof f.result !== 'object') return f.result as string | number;
    if (typeof f.text === 'string') return f.text;
    return null;
  }
  return v as string | number;
}

function num(v: string | number | null): number | null {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
}

export async function readTruthFacts(xlsxPath: string, projectName: string): Promise<TakeoffFacts> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);

  const structures: StructureFact[] = [];
  const mh = getWorksheetFlex(wb, 'MANHOLES (1)');
  if (mh) {
    for (let r = 11; r <= 50; r++) {
      const desc = cell(mh, `B${r}`);
      if (desc === null || desc === '' || String(desc).toUpperCase().includes('TOTAL')) continue;
      structures.push({
        description: String(desc),
        topElevation: num(cell(mh, `C${r}`)),
        lowInvert: num(cell(mh, `D${r}`)),
        highInvert: num(cell(mh, `E${r}`)),
        pipeOutDiameter: num(cell(mh, `F${r}`)),
        structureType: cell(mh, `G${r}`) != null ? String(cell(mh, `G${r}`)) : null,
        depth: num(cell(mh, `J${r}`)),
      });
    }
  }

  const sewers: SewerFact[] = [];
  const sw = getWorksheetFlex(wb, 'SEWERS (1)');
  if (sw) {
    for (let r = 14; r <= 55; r++) {
      const label = cell(sw, `B${r}`);
      if (label === null || label === '' || String(label).toUpperCase().includes('TOTAL')) continue;
      const length = num(cell(sw, `C${r}`));
      sewers.push({
        runLabel: String(label),
        isLineItem: length === null,
        length,
        pipeDiameter: num(cell(sw, `D${r}`)),
        typeClass: num(cell(sw, `E${r}`)),
        slope: num(cell(sw, `F${r}`)),
        depth: num(cell(sw, `G${r}`)),
      });
    }
  }

  const watermain: WatermainFact[] = [];
  const wm = getWorksheetFlex(wb, 'WATERMAIN (1)');
  if (wm) {
    for (let r = 13; r <= 19; r++) {
      const size = cell(wm, `B${r}`);
      if (size === null || size === '') continue;
      watermain.push({
        sizeAndType: String(size),
        length: num(cell(wm, `C${r}`)) ?? 0,
        pipeDiameter: num(cell(wm, `D${r}`)) ?? 0,
        ocSc: num(cell(wm, `F${r}`)) ?? 1.1,
        avgCover: num(cell(wm, `J${r}`)) ?? 1.8,
      });
    }
  }

  return {
    projectName,
    jobNumber: '',
    date: '',
    structures,
    catchbasins: [],
    sewers,
    watermain,
    watermainSpecials: [],
    watermainValves: [],
    confidence: 1,
    warnings: [],
  };
}
