/**
 * Reads an estimator's filled workbook into TakeoffFacts (physical fields only),
 * so the redesigned facts-level metric (compare-facts.ts) can score the
 * extraction stage against ground truth. Pricing columns are deliberately ignored.
 *
 * Reads ALL numbered section sheets (MANHOLES (1)/(2)/…, SEWERS (1)…(4), etc.),
 * filters non-structure line-item rows out of the structures list, and reads the
 * grouped catchbasin block.
 */
import ExcelJS from 'exceljs';
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact, CatchbasinGroupFact } from './types';

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

const num = (v: string | number | null): number | null => {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isNaN(n) ? null : n;
};

// Rows the estimator lists in the structures column that are NOT physical structures
// (site line items, dividers, fees, special systems). Excluded from structure scoring.
const STRUCTURE_JUNK = /GRAN\s*\*|^SANITARY$|X-?ING|REMOVAL|SAW\s*CUT|ROAD\s*RESTOR|CONSULTING|RELOCATE|BIO-?SWALE|\bADS?\b|\bMOB\b|ASP[H]?[A]?LT|STM\s*TANK|GREENSTORM|LAYOUT|AS\s*BUILT|VIDEO|DEWATER|SWALE/i;

const isMHSheet = (n: string) => /manhole|structure|\bmh\b/i.test(n) && !/sewer|watermain|summary/i.test(n);
const isSWSheet = (n: string) => /sewer/i.test(n) && !/summary/i.test(n);
const isWMSheet = (n: string) => /watermain|water/i.test(n) && !/summary/i.test(n);

const CB_ROW_TYPE: Record<number, CatchbasinGroupFact['type']> = {
  53: 'SINGLE_CB', 54: 'DOUBLE_CB', 55: 'DITCH_INLET_CB', 56: 'DOUBLE_DITCH_INLET_CB',
};

export async function readTruthFacts(xlsxPath: string, projectName: string): Promise<TakeoffFacts> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);

  const structures: StructureFact[] = [];
  const catchbasins: CatchbasinGroupFact[] = [];
  const sewers: SewerFact[] = [];
  const watermain: WatermainFact[] = [];

  for (const ws of wb.worksheets) {
    const name = ws.name;

    if (isMHSheet(name)) {
      // Structures (rows 11-50)
      for (let r = 11; r <= 50; r++) {
        const desc = cell(ws, `B${r}`);
        if (desc === null || desc === '') continue;
        const label = String(desc);
        if (label.toUpperCase().includes('TOTAL') || STRUCTURE_JUNK.test(label)) continue;
        const s: StructureFact = {
          description: label,
          topElevation: num(cell(ws, `C${r}`)),
          lowInvert: num(cell(ws, `D${r}`)),
          highInvert: num(cell(ws, `E${r}`)),
          pipeOutDiameter: num(cell(ws, `F${r}`)),
          structureType: cell(ws, `G${r}`) != null ? String(cell(ws, `G${r}`)) : null,
          depth: num(cell(ws, `J${r}`)),
        };
        // Keep only rows that look like real structures: some physical value present,
        // or a structure-ID label (MH/CB/CBMH/DCBMH/DICB/… + optional number).
        const hasPhysical = [s.topElevation, s.lowInvert, s.highInvert, s.pipeOutDiameter, s.depth].some((x) => x != null);
        const looksLikeStructure = /\b(D?CBMH|DI?CB|MH|CB|HS|OS|CHAMBER)\b/i.test(label);
        if (hasPhysical || looksLikeStructure) structures.push(s);
      }
      // Catchbasin group block (rows 53-56)
      for (const rStr of Object.keys(CB_ROW_TYPE)) {
        const r = Number(rStr);
        const qty = num(cell(ws, `C${r}`));
        if (qty && qty > 0) {
          catchbasins.push({
            type: CB_ROW_TYPE[r],
            quantity: qty,
            wallThickness: num(cell(ws, `D${r}`)),
            depth: num(cell(ws, `E${r}`)),
          });
        }
      }
    } else if (isSWSheet(name)) {
      for (let r = 14; r <= 55; r++) {
        const label = cell(ws, `B${r}`);
        if (label === null || label === '' || String(label).toUpperCase().includes('TOTAL')) continue;
        // Skip "STORM:" / "SANITARY:" section-header rows — they're not sewer runs.
        if (/^(storm|sanitary|stm|san)\s*:?\s*$/i.test(String(label).trim())) continue;
        const length = num(cell(ws, `C${r}`));
        sewers.push({
          runLabel: String(label),
          isLineItem: length === null,
          length,
          pipeDiameter: num(cell(ws, `D${r}`)),
          typeClass: num(cell(ws, `E${r}`)),
          // NOTE: this estimator's sewer sheet has NO slope column — column F is a
          // constant "V/‖ O/OO" factor (always ~1.1), not the pipe slope. Reading it as
          // slope poisons attribute-matching (rejects real pipes on a bogus slope delta)
          // and makes the slope field-metric meaningless. The drawings carry slope, the
          // truth sheet doesn't, so we can't score it — leave it null.
          slope: null,
          depth: num(cell(ws, `G${r}`)),
        });
      }
    } else if (isWMSheet(name)) {
      for (let r = 13; r <= 19; r++) {
        // The "SIZE & TYPE" label (col B) is usually blank — the real data is length (C) +
        // diameter (D). Key on those, not B, or we drop every watermain run (and then score
        // the model's correct watermain as a false positive). Derive a label from the size.
        const length = num(cell(ws, `C${r}`));
        const dia = num(cell(ws, `D${r}`));
        if (length == null && dia == null) continue;
        const size = cell(ws, `B${r}`);
        if (size != null && /total/i.test(String(size))) continue;
        watermain.push({
          sizeAndType: size != null && String(size) !== '' ? String(size) : (dia != null ? `${dia}mm` : ''),
          length: length ?? 0,
          pipeDiameter: dia ?? 0,
          ocSc: num(cell(ws, `F${r}`)) ?? 1.1,
          avgCover: num(cell(ws, `J${r}`)) ?? 1.8,
        });
      }
    }
  }

  return {
    projectName,
    jobNumber: '',
    date: '',
    structures,
    catchbasins,
    sewers,
    watermain,
    watermainSpecials: [],
    watermainValves: [],
    confidence: 1,
    warnings: [],
  };
}
