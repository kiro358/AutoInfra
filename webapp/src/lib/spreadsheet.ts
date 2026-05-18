import ExcelJS from 'exceljs';
import path from 'path';
import { ExtractionResult, GlobalParams } from './types';
import { DEFAULT_PARAMS } from './constants';

import fs from 'fs';

let TEMPLATES_DIR = path.resolve(__dirname, '../../../empty_templates');
if (!fs.existsSync(TEMPLATES_DIR)) {
  TEMPLATES_DIR = path.join(process.cwd(), '..', 'empty_templates');
  if (!fs.existsSync(TEMPLATES_DIR)) {
    TEMPLATES_DIR = path.join(process.cwd(), 'empty_templates');
  }
}

export async function populateTemplate(
  extraction: ExtractionResult,
  params: GlobalParams = DEFAULT_PARAMS as unknown as GlobalParams
): Promise<Buffer> {
  const templateFile =
    extraction.templateType === 'LONG' ? 'LONG-NEW.xlsx' : 'SHORT-NEW - Copy (3).xlsx';
  const templatePath = path.join(TEMPLATES_DIR, templateFile);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(templatePath);

  // Break shared formula chains in columns that forceSetCellValue will write to.
  // This must happen BEFORE any fill functions are called.
  const mhSheet = workbook.getWorksheet('MANHOLES (1)');
  if (mhSheet) {
    breakSharedFormulas(mhSheet, ['J', 'K', 'L'], 11, 50);
  }

  // Fill MANHOLES sheet(s)
  fillManholes(workbook, extraction, params);

  // Fill SEWERS sheet(s)
  fillSewers(workbook, extraction, params);

  // Fill WATERMAIN sheet(s)
  fillWatermain(workbook, extraction, params);

  // Write to buffer
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function fillManholes(
  workbook: ExcelJS.Workbook,
  extraction: ExtractionResult,
  params: GlobalParams
) {
  const sheet = workbook.getWorksheet('MANHOLES (1)');
  if (!sheet) return;

  // Fill header / project info
  setCellValue(sheet, 'B2', extraction.projectName);
  setCellValue(sheet, 'B3', extraction.jobNumber);
  setCellValue(sheet, 'B5', extraction.date);

  // Fill global params
  setCellValue(sheet, 'F3', params.manholes.truckingPerCM);
  setCellValue(sheet, 'F4', params.manholes.concretePerCM);
  setCellValue(sheet, 'F5', params.manholes.discount);
  setCellValue(sheet, 'F6', params.manholes.marginFactor);
  setCellValue(sheet, 'F7', params.manholes.metric ? 1 : 0);
  setCellValue(sheet, 'I3', params.manholes.fstFactor);
  setCellValue(sheet, 'I4', params.manholes.pstFactor);
  setCellValue(sheet, 'I5', params.manholes.modPerM);
  setCellValue(sheet, 'I6', params.manholes.mhFC);
  setCellValue(sheet, 'I7', params.manholes.cbFC);
  setCellValue(sheet, 'L4', params.manholes.laborPerHr);
  setCellValue(sheet, 'L7', params.manholes.frameCoverM);

  // Fill data rows (starting at row 11)
  const startRow = 11;
  extraction.manholes.forEach((mh, idx) => {
    const row = startRow + idx;
    if (row > 50) return; // Don't overflow template into catchbasins

    setCellValue(sheet, `B${row}`, mh.description);
    setCellValue(sheet, `C${row}`, mh.topElevation || undefined);
    setCellValue(sheet, `D${row}`, mh.lowInvert || undefined);
    setCellValue(sheet, `E${row}`, mh.highInvert || undefined);
    setCellValue(sheet, `F${row}`, mh.pipeOutDiameter || undefined);
    setCellValue(sheet, `G${row}`, mh.structureType ?? undefined);
    if (mh.addMaterials) setCellValue(sheet, `H${row}`, mh.addMaterials);
    if (mh.addLE) setCellValue(sheet, `I${row}`, mh.addLE);
    if (mh.depth != null) forceSetCellValue(sheet, `J${row}`, mh.depth);
    if (mh.drop != null) forceSetCellValue(sheet, `K${row}`, mh.drop);
    if (mh.diameter != null) forceSetCellValue(sheet, `L${row}`, mh.diameter);
  });

  // Fill catchbasin groups (Rows 53-56)
  if (extraction.catchbasins && extraction.catchbasins.groups) {
    const cbMap: Record<string, number> = {
      'SINGLE_CB': 53,
      'DOUBLE_CB': 54,
      'DITCH_INLET_CB': 55,
      'DOUBLE_DITCH_INLET_CB': 56
    };
    extraction.catchbasins.groups.forEach(g => {
      const row = cbMap[g.type];
      if (row) {
        setCellValue(sheet, `C${row}`, g.quantity || undefined);
        setCellValue(sheet, `D${row}`, g.wallThickness || undefined);
        setCellValue(sheet, `E${row}`, g.depth || undefined);
        setCellValue(sheet, `F${row}`, g.grateEach || undefined);
        setCellValue(sheet, `G${row}`, g.addMaterials || undefined);
      }
    });
  }

  // Fill catchbasin labor rates (Rows 59-60)
  if (extraction.catchbasins && extraction.catchbasins.laborRates) {
    const lr = extraction.catchbasins.laborRates;
    setCellValue(sheet, `C59`, lr.scbLabor || undefined);
    setCellValue(sheet, `C60`, lr.dcbLabor || undefined);
    setCellValue(sheet, `F59`, lr.dicbFC || undefined);
    setCellValue(sheet, `F60`, lr.ddicbFC || undefined);
  }
}

function fillSewers(
  workbook: ExcelJS.Workbook,
  extraction: ExtractionResult,
  params: GlobalParams
) {
  const sheet = workbook.getWorksheet('SEWERS (1)');
  if (!sheet) return;

  // Fill header params
  setCellValue(sheet, 'F3', params.sewers.minTrenchWidth);
  setCellValue(sheet, 'F4', params.sewers.pipeCover);
  setCellValue(sheet, 'F5', params.sewers.mFinGrade);
  setCellValue(sheet, 'F6', params.sewers.dayCostPerDay);
  setCellValue(sheet, 'F7', params.sewers.extraPerDay);
  setCellValue(sheet, 'F8', params.sewers.productionMPerDay);
  setCellValue(sheet, 'I3', params.sewers.stoneImpT);
  setCellValue(sheet, 'I4', params.sewers.stoneMt);
  setCellValue(sheet, 'I5', params.sewers.granImpTn);
  setCellValue(sheet, 'I6', params.sewers.granMt);
  setCellValue(sheet, 'I7', params.sewers.truckingPerCM);
  setCellValue(sheet, 'P3', params.sewers.efficiency);
  setCellValue(sheet, 'P4', params.sewers.metric ? 1 : 0);
  setCellValue(sheet, 'P5', params.sewers.marginFactor);
  setCellValue(sheet, 'P6', params.sewers.openCutFactor);
  setCellValue(sheet, 'P7', params.sewers.dualTrSep);
  setCellValue(sheet, 'P8', params.sewers.concPipePct);
  setCellValue(sheet, 'P9', params.sewers.trenchClear);
  setCellValue(sheet, 'V3', params.sewers.provTax);
  setCellValue(sheet, 'V4', params.sewers.fedTax);

  // Fill data rows (starting at row 14)
  const startRow = 14;
  extraction.sewers.forEach((sw, idx) => {
    const row = startRow + idx;
    if (row > 55) return;

    setCellValue(sheet, `B${row}`, sw.runLabel);
    setCellValue(sheet, `C${row}`, sw.length || undefined);
    setCellValue(sheet, `D${row}`, sw.pipeDiameter || undefined);
    setCellValue(sheet, `E${row}`, sw.typeClass || undefined);
    setCellValue(sheet, `F${row}`, sw.slope || undefined);
    forceSetCellValue(sheet, `G${row}`, sw.depth || undefined);
    if (sw.addMaterials) setCellValue(sheet, `H${row}`, sw.addMaterials);
    if (sw.addLE) setCellValue(sheet, `I${row}`, sw.addLE);
  });
}

function fillWatermain(
  workbook: ExcelJS.Workbook,
  extraction: ExtractionResult,
  params: GlobalParams
) {
  const sheet = workbook.getWorksheet('WATERMAIN (1)');
  if (!sheet) return;

  // Fill header params
  setCellValue(sheet, 'F3', params.watermain.minTrenchWidth);
  setCellValue(sheet, 'F4', params.watermain.pipeCover);
  setCellValue(sheet, 'F5', params.watermain.mFinGrade);
  setCellValue(sheet, 'F6', params.watermain.dayCostPerDay);
  setCellValue(sheet, 'F7', params.watermain.extraPerDay);
  setCellValue(sheet, 'F8', params.watermain.productionMPerDay);
  setCellValue(sheet, 'I3', params.watermain.stoneImpTon);
  setCellValue(sheet, 'I4', params.watermain.stoneMtne);
  setCellValue(sheet, 'I5', params.watermain.granImpTon);
  setCellValue(sheet, 'I6', params.watermain.granMtne);
  setCellValue(sheet, 'I7', params.watermain.truckingPerCM);
  setCellValue(sheet, 'I8', params.watermain.peelRegionCover);
  setCellValue(sheet, 'O3', params.watermain.efficiency);
  setCellValue(sheet, 'O4', params.watermain.metric ? 1 : 0);
  setCellValue(sheet, 'O6', params.watermain.openCutFactor);
  setCellValue(sheet, 'O7', params.watermain.dualTrSep);
  setCellValue(sheet, 'O8', params.watermain.trenchClear);
  setCellValue(sheet, 'R4', params.watermain.precastPct);
  setCellValue(sheet, 'R7', params.watermain.modulocPerM);
  setCellValue(sheet, 'L3', params.watermain.c900_100);
  setCellValue(sheet, 'L4', params.watermain.c900_150);
  setCellValue(sheet, 'L5', params.watermain.c900_200);
  setCellValue(sheet, 'L6', params.watermain.c900_250);
  setCellValue(sheet, 'L7', params.watermain.c900_300);
  setCellValue(sheet, 'L8', params.watermain.concPerCM);
  setCellValue(sheet, 'U3', params.watermain.provTax);
  setCellValue(sheet, 'U4', params.watermain.fedTax);

  // Fill watermain runs (starting at row 13)
  const startRow = 13;
  extraction.watermain.forEach((wm, idx) => {
    const row = startRow + idx;
    if (row > 19) return;

    setCellValue(sheet, `B${row}`, wm.sizeAndType);
    setCellValue(sheet, `C${row}`, wm.length || undefined);
    setCellValue(sheet, `D${row}`, wm.pipeDiameter || undefined);
    setCellValue(sheet, `F${row}`, wm.ocSc);
    if (wm.addMaterials) setCellValue(sheet, `G${row}`, wm.addMaterials);
    if (wm.addLE) setCellValue(sheet, `H${row}`, wm.addLE);
    forceSetCellValue(sheet, `J${row}`, wm.avgCover);
  });

  // Fill specials (starting at row 24)
  const specialsStart = 24;
  extraction.watermainSpecials.forEach((sp, idx) => {
    const row = specialsStart + idx;
    if (row > 40) return;

    setCellValue(sheet, `B${row}`, sp.specialName);
    setCellValue(sheet, `C${row}`, sp.quantity || undefined);
    setCellValue(sheet, `D${row}`, sp.costEach || undefined);
    setCellValue(sheet, `E${row}`, sp.thrustBlock);
    setCellValue(sheet, `F${row}`, sp.anodeCost || undefined);
    setCellValue(sheet, `G${row}`, sp.laborEach || undefined);
  });

  // Fill valves (columns N-T, starting at row 24)
  extraction.watermainValves.forEach((v, idx) => {
    const row = specialsStart + idx;
    if (row > 40) return;

    setCellValue(sheet, `O${row}`, v.valveSize);
    setCellValue(sheet, `P${row}`, v.quantity || undefined);
    setCellValue(sheet, `Q${row}`, v.valveCost || undefined);
    setCellValue(sheet, `R${row}`, v.boxCost || undefined);
    setCellValue(sheet, `S${row}`, v.anodeCost || undefined);
    setCellValue(sheet, `T${row}`, v.laborPerValve || undefined);
  });
}

/**
 * Set a cell value WITHOUT destroying formulas in other cells.
 * Only writes if the value is defined and non-empty.
 */
function setCellValue(
  sheet: ExcelJS.Worksheet,
  cellRef: string,
  value: string | number | undefined
) {
  if (value === undefined || value === null || value === '') return;
  const cell = sheet.getCell(cellRef);
  if (cell.type === ExcelJS.ValueType.Formula || (cell as any).sharedFormula) {
    return; // Do not overwrite existing formulas in the template
  }
  cell.value = value;
}

/**
 * Break shared formula chains on a sheet for specific columns.
 * Converts each shared formula (master or clone) into a standalone formula
 * so that individual cells can be overwritten without breaking the chain.
 *
 * Must be called ONCE after loading the template, before any forceSetCellValue calls.
 */
function breakSharedFormulas(
  sheet: ExcelJS.Worksheet,
  columns: string[],
  startRow: number,
  endRow: number
) {
  for (const col of columns) {
    // First pass: find master formulas and their templates
    const masters: Record<string, { formula: string; ref: string }> = {};

    for (let r = startRow; r <= endRow; r++) {
      const cell = sheet.getCell(`${col}${r}`);
      const v = cell.value as any;
      if (v && typeof v === 'object' && v.formula && v.ref) {
        // This is a master cell
        masters[`${col}${r}`] = { formula: v.formula, ref: v.ref };
      }
    }

    // Second pass: convert all cells (masters and clones) to individual formulas
    for (let r = startRow; r <= endRow; r++) {
      const cellRef = `${col}${r}`;
      const cell = sheet.getCell(cellRef);
      const v = cell.value as any;

      if (v && typeof v === 'object') {
        if (v.formula && v.ref) {
          // Master cell — convert to standalone formula (drop the ref/shareType)
          cell.value = { formula: v.formula } as ExcelJS.CellFormulaValue;
        } else if (v.sharedFormula) {
          // Clone cell — derive the formula from the master by row offset
          const masterRef = v.sharedFormula; // e.g., "J11"
          const masterCol = masterRef.replace(/\d+/g, '');
          const masterRow = parseInt(masterRef.replace(/\D+/g, ''), 10);
          const masterInfo = masters[masterRef];

          if (masterInfo) {
            // Adjust the master formula for this row's offset
            const rowOffset = r - masterRow;
            const adjustedFormula = adjustFormulaForRow(masterInfo.formula, rowOffset);
            cell.value = { formula: adjustedFormula } as ExcelJS.CellFormulaValue;
          }
        }
      }
    }
  }
}

/**
 * Adjust a formula for a row offset.
 * Replaces non-absolute row references (e.g., C11 → C15 for offset 4).
 * Preserves absolute references (e.g., F$7 stays F$7).
 */
function adjustFormulaForRow(formula: string, rowOffset: number): string {
  if (rowOffset === 0) return formula;

  // Match cell references: column letters followed by optional $ and digits
  return formula.replace(/([A-Z]+)(\$?)(\d+)/g, (match, col, abs, row) => {
    if (abs === '$') {
      // Absolute row reference — don't change
      return match;
    }
    // Relative row reference — adjust
    return `${col}${parseInt(row, 10) + rowOffset}`;
  });
}

/**
 * Force-set a cell value, even if it contains a formula.
 * Used for calculated fields (like depth, diameter) where the estimator
 * manually overrides the formula with a known value.
 *
 * IMPORTANT: breakSharedFormulas() must be called first on the relevant columns
 * to avoid corrupting ExcelJS shared formula chains.
 */
function forceSetCellValue(
  sheet: ExcelJS.Worksheet,
  cellRef: string,
  value: string | number | undefined
) {
  if (value === undefined || value === null || value === '') return;
  try {
    const cell = sheet.getCell(cellRef);
    // Overwrite regardless of whether it's a formula or plain value.
    // Safe because breakSharedFormulas already converted shared formulas to standalone.
    cell.value = value;
  } catch {
    // Silently skip if we can't write
  }
}


