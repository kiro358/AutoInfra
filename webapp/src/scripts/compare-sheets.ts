/**
 * compare-sheets.ts
 *
 * Deep comparison of generated spreadsheets vs ground truth.
 * Reads the data cells from both and produces a detailed per-cell diff report.
 *
 * Usage:
 *   npx tsx src/scripts/compare-sheets.ts <project-folder> [truth-file] [gen-file]
 *
 * Example:
 *   npx tsx src/scripts/compare-sheets.ts "2026-067 201 GEORGIAN DR,BARRIE"
 *   npx tsx src/scripts/compare-sheets.ts "2026-067 201 GEORGIAN DR,BARRIE" "201 GEORGIAN.xlsx" "eval_run_123.xlsx"
 */

import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';

// ======================== CONFIG ========================

const TRAINING_DIR = path.resolve(
  __dirname,
  '../../..',
  'existing_projects_training_data'
);

// Which sheets and cell ranges to compare
const SHEET_CONFIGS: SheetConfig[] = [
  {
    sheetName: 'MANHOLES (1)',
    sectionLabel: 'MANHOLES - Structures',
    headerRow: 10,
    dataStartRow: 11,
    dataEndRow: 50,
    columns: ['B', 'H', 'I'],
    columnNames: ['Description', 'Add Mtrls', 'Add L&E'],
    keyColumn: 'B',
  },
  {
    sheetName: 'MANHOLES (1)',
    sectionLabel: 'MANHOLES - Catchbasins',
    headerRow: 52,
    dataStartRow: 53,
    dataEndRow: 56,
    columns: ['B', 'C', 'E', 'F', 'G'],
    columnNames: ['CB Type', 'QNTY', 'DPTHm', '$GT ea', '$/ADDMAT'],
    keyColumn: 'B',
  },
  {
    sheetName: 'SEWERS (1)',
    sectionLabel: 'SEWERS',
    headerRow: 13,
    dataStartRow: 14,
    dataEndRow: 55,
    columns: ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
    columnNames: ['Run Label', 'Length', 'Pipe Dia', 'Type/Class', 'Slope', 'Depth', 'Add Mtrls', 'Add L&E'],
    keyColumn: 'B',
  },
  {
    sheetName: 'WATERMAIN (1)',
    sectionLabel: 'WATERMAIN',
    headerRow: 12,
    dataStartRow: 13,
    dataEndRow: 19,
    columns: ['B', 'C', 'D', 'F', 'J'],
    columnNames: ['Size & Type', 'Length', 'Pipe Dia', 'OC/SC', 'Avg Cover'],
    keyColumn: 'B',
  },
];

interface SheetConfig {
  sheetName: string;
  sectionLabel: string;
  headerRow: number;
  dataStartRow: number;
  dataEndRow: number;
  columns: string[];
  columnNames: string[];
  keyColumn: string;
}

interface CellDiff {
  row: number;
  col: string;
  colName: string;
  truthValue: string | number | null;
  genValue: string | number | null;
  isMatch: boolean;
  pctError?: number;
}

export interface SheetReport {
  sheetName: string;
  sectionLabel: string;
  totalCells: number;
  matchingCells: number;
  missingRows: number;
  extraRows: number;
  diffs: CellDiff[];
  avgPctError: number;
}

export interface CompareResult {
  projectName: string;
  truthFile: string;
  genFile: string;
  reports: SheetReport[];
  overallAccuracy: number;
  totalCells: number;
  totalMatching: number;
}

// ======================== CORE FUNCTIONS ========================

function getCellValue(
  sheet: ExcelJS.Worksheet,
  cellRef: string
): string | number | null {
  const cell = sheet.getCell(cellRef);
  if (cell.value === null || cell.value === undefined) return null;
  if (typeof cell.value === 'object') {
    const formula = cell.value as ExcelJS.CellFormulaValue;
    if ('result' in formula) {
      const result = formula.result;
      // Formula result may itself be an object (e.g., error, richText)
      if (result === null || result === undefined) return null;
      if (typeof result === 'object') {
        if ('error' in (result as any)) return null;
        if ('richText' in (result as any)) {
          return ((result as any).richText || []).map((r: any) => r.text || '').join('');
        }
        return String(result);
      }
      return result as string | number;
    }
    if ('text' in (cell.value as { text?: string })) {
      return (cell.value as { text: string }).text;
    }
    // Last resort — try to extract any numeric value
    if ('sharedFormula' in (cell.value as any)) {
      const sf = cell.value as any;
      if (sf.result !== undefined) {
        return typeof sf.result === 'object' ? null : sf.result;
      }
    }
    return null; // Return null instead of "[object Object]"
  }
  return cell.value as string | number;
}

function readDataRows(
  sheet: ExcelJS.Worksheet,
  config: SheetConfig
): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  for (let r = config.dataStartRow; r <= config.dataEndRow; r++) {
    const keyVal = getCellValue(sheet, `${config.keyColumn}${r}`);
    if (keyVal === null || keyVal === '' || keyVal === 0) continue;

    const row: (string | number | null)[] = [];
    for (const col of config.columns) {
      row.push(getCellValue(sheet, `${col}${r}`));
    }
    rows.push(row);
  }
  return rows;
}

function valuesMatch(
  a: string | number | null,
  b: string | number | null
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;

  const numA = typeof a === 'number' ? a : parseFloat(String(a));
  const numB = typeof b === 'number' ? b : parseFloat(String(b));

  if (!isNaN(numA) && !isNaN(numB)) {
    if (numA === 0 && numB === 0) return true;
    const pctDiff = Math.abs(numA - numB) / Math.max(Math.abs(numA), Math.abs(numB));
    return pctDiff < 0.05; // 5% tolerance for numeric values
  }

  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function compareSheet(
  truthWb: ExcelJS.Workbook,
  genWb: ExcelJS.Workbook,
  config: SheetConfig
): SheetReport {
  const truthSheet = truthWb.getWorksheet(config.sheetName);
  const genSheet = genWb.getWorksheet(config.sheetName);

  const report: SheetReport = {
    sheetName: config.sheetName,
    sectionLabel: config.sectionLabel,
    totalCells: 0,
    matchingCells: 0,
    missingRows: 0,
    extraRows: 0,
    diffs: [],
    avgPctError: 0,
  };

  if (!truthSheet || !genSheet) {
    return report;
  }

  const truthRows = readDataRows(truthSheet, config);
  const genRows = readDataRows(genSheet, config);

  report.missingRows = Math.max(0, truthRows.length - genRows.length);
  report.extraRows = Math.max(0, genRows.length - truthRows.length);

  const maxRows = Math.max(truthRows.length, genRows.length);
  let totalPctError = 0;
  let numericCount = 0;

  for (let r = 0; r < maxRows; r++) {
    const rowNum = config.dataStartRow + r;

    for (let c = 0; c < config.columns.length; c++) {
      const col = config.columns[c];
      const colName = config.columnNames[c];
      const truthVal = r < truthRows.length ? truthRows[r][c] : null;
      const genVal = r < genRows.length ? genRows[r][c] : null;

      if (
        (truthVal === null || truthVal === '' || truthVal === 0) &&
        (genVal === null || genVal === '' || genVal === 0)
      ) {
        continue;
      }

      report.totalCells++;
      const isMatch = valuesMatch(truthVal, genVal);
      if (isMatch) report.matchingCells++;

      let pctError: number | undefined;
      if (typeof truthVal === 'number' && typeof genVal === 'number' && truthVal !== 0) {
        pctError = Math.abs((genVal - truthVal) / truthVal) * 100;
        totalPctError += pctError;
        numericCount++;
      }

      if (!isMatch) {
        report.diffs.push({
          row: rowNum,
          col,
          colName,
          truthValue: truthVal,
          genValue: genVal,
          isMatch,
          pctError,
        });
      }
    }
  }

  report.avgPctError = numericCount > 0 ? totalPctError / numericCount : 0;
  return report;
}

/**
 * Compare a generated spreadsheet against ground truth.
 * Exported so batch-evaluate can use it programmatically.
 */
export async function compareSpreadsheets(
  truthPath: string,
  genPath: string,
  projectName: string
): Promise<CompareResult> {
  const truthWb = new ExcelJS.Workbook();
  await truthWb.xlsx.readFile(truthPath);

  const genWb = new ExcelJS.Workbook();
  await genWb.xlsx.readFile(genPath);

  const reports: SheetReport[] = [];
  for (const config of SHEET_CONFIGS) {
    reports.push(compareSheet(truthWb, genWb, config));
  }

  const totalCells = reports.reduce((s, r) => s + r.totalCells, 0);
  const totalMatching = reports.reduce((s, r) => s + r.matchingCells, 0);
  const overallAccuracy = totalCells > 0 ? (totalMatching / totalCells) * 100 : 0;

  return {
    projectName,
    truthFile: path.basename(truthPath),
    genFile: path.basename(genPath),
    reports,
    overallAccuracy,
    totalCells,
    totalMatching,
  };
}

function printCompareResult(result: CompareResult) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔬 ${result.projectName}`);
  console.log(`   Truth: ${result.truthFile} | Generated: ${result.genFile}`);
  console.log(`${'='.repeat(80)}`);

  for (const report of result.reports) {
    const accuracy =
      report.totalCells > 0
        ? ((report.matchingCells / report.totalCells) * 100).toFixed(1)
        : 'N/A';

    console.log(`\n  📊 ${report.sectionLabel}`);
    console.log(`     Accuracy: ${accuracy}% (${report.matchingCells}/${report.totalCells})`);
    console.log(`     Missing rows: ${report.missingRows} | Extra rows: ${report.extraRows}`);

    if (report.diffs.length > 0) {
      console.log(`     ❌ ${report.diffs.length} mismatches:`);
      for (const d of report.diffs.slice(0, 15)) {
        const errStr = d.pctError !== undefined ? ` (${d.pctError.toFixed(1)}% err)` : '';
        console.log(
          `        Row ${d.row} [${d.colName}]: truth="${d.truthValue}" vs gen="${d.genValue}"${errStr}`
        );
      }
      if (report.diffs.length > 15) {
        console.log(`        ... and ${report.diffs.length - 15} more`);
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📊 OVERALL ACCURACY: ${result.overallAccuracy.toFixed(1)}% (${result.totalMatching}/${result.totalCells} cells)`);
  console.log(`${'─'.repeat(60)}\n`);
}

// ======================== MAIN (CLI) ========================

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx src/scripts/compare-sheets.ts <project-folder> [truth-file] [gen-file]');
    process.exit(1);
  }

  const projectFolder = args[0];
  const projectDir = path.join(TRAINING_DIR, projectFolder);

  if (!fs.existsSync(projectDir)) {
    console.error(`❌ Project directory not found: ${projectDir}`);
    process.exit(1);
  }

  // Find truth file
  const allFiles = fs.readdirSync(projectDir);
  let truthFile = args[1];
  if (!truthFile) {
    const xlsxFiles = allFiles.filter(f =>
      f.endsWith('.xlsx') &&
      !f.toLowerCase().includes('quote') &&
      !f.toLowerCase().includes('budget') &&
      !f.toLowerCase().includes('backup') &&
      !f.toLowerCase().includes('sand') &&
      !f.toLowerCase().includes('appendix') &&
      !f.toLowerCase().includes('estimate')
    );
    if (xlsxFiles.length === 0) {
      console.error(`❌ No truth XLSX found in ${projectDir}`);
      process.exit(1);
    }
    truthFile = xlsxFiles[0];
  }

  const truthPath = path.join(projectDir, truthFile);

  // Find generated file(s)
  const genDirPath = path.join(projectDir, 'generated_spreadsheets');
  let genFiles: string[];
  if (args[2]) {
    genFiles = [args[2]];
  } else if (fs.existsSync(genDirPath)) {
    genFiles = fs.readdirSync(genDirPath).filter(f => f.endsWith('.xlsx'));
  } else {
    console.error(`❌ No generated_spreadsheets directory found`);
    process.exit(1);
  }

  if (genFiles.length === 0) {
    console.error(`❌ No generated XLSX files found`);
    process.exit(1);
  }

  console.log(`📋 Ground Truth: ${truthFile}`);
  console.log(`📁 Generated: ${genFiles.length} file(s)\n`);

  for (const genFile of genFiles) {
    const genPath = path.join(genDirPath, genFile);
    const result = await compareSpreadsheets(truthPath, genPath, projectFolder);
    printCompareResult(result);
  }
}

// Only run when executed directly (not when imported)
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
