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

export function getSheetConfigs(workbook: ExcelJS.Workbook): SheetConfig[] {
  const configs: SheetConfig[] = [];

  workbook.worksheets.forEach(sheet => {
    const nameUpper = sheet.name.toUpperCase();
    if (nameUpper.startsWith('MANHOLES')) {
      configs.push({
        sheetName: sheet.name,
        sectionLabel: `${sheet.name} - Structures`,
        headerRow: 10,
        dataStartRow: 11,
        dataEndRow: 50,
        columns: ['B', 'H', 'I', 'J', 'K', 'L'],
        columnNames: ['Description', 'Add Mtrls', 'Add L&E', 'Depth', 'Drop', 'Diameter'],
        keyColumn: 'B',
      });
      configs.push({
        sheetName: sheet.name,
        sectionLabel: `${sheet.name} - Catchbasins`,
        headerRow: 52,
        dataStartRow: 53,
        dataEndRow: 56,
        columns: ['B', 'C', 'D', 'E', 'F', 'G'],
        columnNames: ['CB Type', 'QNTY', 'Wall Thickness', 'DPTHm', '$GT ea', '$/ADDMAT'],
        keyColumn: 'B',
      });
    } else if (nameUpper.startsWith('SEWERS')) {
      configs.push({
        sheetName: sheet.name,
        sectionLabel: sheet.name,
        headerRow: 13,
        dataStartRow: 14,
        dataEndRow: 55, // cap at 55 to prevent reading lookups/total rows as data runs
        columns: ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'],
        columnNames: ['Run Label', 'Length', 'Pipe Dia', 'Type/Class', 'Slope', 'Depth', 'Add Mtrls', 'Add L&E'],
        keyColumn: 'B',
      });
    } else if (nameUpper.startsWith('WATERMAIN')) {
      configs.push({
        sheetName: sheet.name,
        sectionLabel: sheet.name,
        headerRow: 12,
        dataStartRow: 13,
        dataEndRow: 19,
        columns: ['B', 'C', 'D', 'F', 'J'],
        columnNames: ['Size & Type', 'Length', 'Pipe Dia', 'OC/SC', 'Avg Cover'],
        keyColumn: 'B',
      });
    }
  });

  return configs;
}

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
  warnings?: string[];
  isCustomLayout?: boolean;
  truthSheets?: string[];
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
    if (typeof keyVal === 'string' && keyVal.toUpperCase().includes('TOTAL')) continue;

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

function keysMatch(keyA: string | number | null, keyB: string | number | null): boolean {
  if (keyA === null || keyB === null) return false;
  // Strip parenthetical notes (e.g. "(repl. DCBMH)" -> "") to avoid matching failures due to description comments
  const cleanA = String(keyA).replace(/\(.*?\)/g, '').trim();
  const cleanB = String(keyB).replace(/\(.*?\)/g, '').trim();
  
  const strA = cleanA.toLowerCase();
  const strB = cleanB.toLowerCase();
  
  if (strA === strB) return true;
  
  const normA = strA.replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  const normB = strB.replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  
  if (normA === normB) return true;
  
  // Fuzzy match: if one contains the other and they have the same numbers
  if (normA.includes(normB) || normB.includes(normA)) {
    const numA = normA.replace(/[^0-9]/g, '');
    const numB = normB.replace(/[^0-9]/g, '');
    if (numA === numB && numA.length > 0) return true;
    if (numA.length === 0 && numB.length === 0) return true;
  }
  
  return false;
}

export function getWorksheetFlex(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet | undefined {
  let ws = wb.getWorksheet(name);
  if (ws) return ws;

  const cleanName = name.replace(/\s*\(1\)$/, '');
  ws = wb.getWorksheet(cleanName);
  if (ws) return ws;

  ws = wb.worksheets.find(s => s.name.toUpperCase() === name.toUpperCase()) ||
       wb.worksheets.find(s => s.name.toUpperCase() === cleanName.toUpperCase());
  if (ws) return ws;

  // If there's only one worksheet, use it
  if (wb.worksheets.length === 1) {
    return wb.worksheets[0];
  }

  // Keyword and split sheet number matching
  const nameUpper = name.toUpperCase();
  const cleanNameUpper = cleanName.toUpperCase();
  const numMatch = name.match(/\((\d+)\)/);
  const expectedNum = numMatch ? numMatch[1] : null;

  let keywords: string[] = [];
  if (nameUpper.includes('MANHOLE') || nameUpper.includes('MH') || nameUpper.includes('STRUCTURE')) {
    keywords = ['MANHOLE', 'STRUCTURE', 'MH'];
  } else if (nameUpper.includes('SEWER')) {
    keywords = ['SEWER', 'SW'];
  } else if (nameUpper.includes('WATERMAIN') || nameUpper.includes('WM')) {
    keywords = ['WATERMAIN', 'WM', 'WATER'];
  }

  const candidateSheets = wb.worksheets.filter(s => {
    const sNameUpper = s.name.toUpperCase();
    return keywords.some(kw => sNameUpper.includes(kw));
  });

  if (candidateSheets.length > 0) {
    if (expectedNum) {
      const numMatchSheet = candidateSheets.find(s => {
        const sNumMatch = s.name.match(/\(?(\d+)\)?/);
        return sNumMatch ? sNumMatch[1] === expectedNum : false;
      });
      if (numMatchSheet) return numMatchSheet;
    }
    return candidateSheets[0];
  }

  // Fallback substring matching
  ws = wb.worksheets.find(s => s.name.toUpperCase().includes(cleanNameUpper));
  if (ws) return ws;

  // Ultimate fallback: return first sheet that isn't a summary
  if (wb.worksheets.length > 0) {
    const activeSheets = wb.worksheets.filter(s => !s.name.toUpperCase().includes('SUMMARY'));
    if (activeSheets.length > 0) return activeSheets[0];
    return wb.worksheets[0];
  }

  console.warn(`      ⚠️ getWorksheetFlex: Could not find sheet "${name}" or "${cleanName}" (case-insensitive) in workbook. Available sheets: [${wb.worksheets.map(w => w.name).join(', ')}]`);
  return undefined;
}

function compareSheet(
  truthWb: ExcelJS.Workbook,
  genWb: ExcelJS.Workbook,
  config: SheetConfig,
  warningsList: string[]
): SheetReport {
  const truthSheet = getWorksheetFlex(truthWb, config.sheetName);
  const genSheet = getWorksheetFlex(genWb, config.sheetName);

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

  if (!truthSheet) {
    const msg = `Sheet "${config.sheetName}" not found in Ground Truth workbook.`;
    console.warn(`      ⚠️ ${msg}`);
    warningsList.push(msg);
  }
  if (!genSheet) {
    const msg = `Sheet "${config.sheetName}" not found in Generated workbook.`;
    console.warn(`      ⚠️ ${msg}`);
    warningsList.push(msg);
  }

  if (!truthSheet || !genSheet) {
    return report;
  }

  const truthRows = readDataRows(truthSheet, config);
  const genRows = readDataRows(genSheet, config);

  const keyColIdx = config.columns.indexOf(config.keyColumn);

  // We will pool the gen rows to match them
  const genPool = genRows.map((row, idx) => ({
    row,
    originalIdx: idx,
    matched: false,
  }));

  let totalPctError = 0;
  let numericCount = 0;

  for (let r = 0; r < truthRows.length; r++) {
    const truthRow = truthRows[r];
    const truthKey = truthRow[keyColIdx];
    const rowNum = config.dataStartRow + r;

    // Find matching gen row
    const genMatch = genPool.find(
      g => !g.matched && keysMatch(truthKey, g.row[keyColIdx])
    );

    if (genMatch) {
      genMatch.matched = true;
      const genRow = genMatch.row;

      for (let c = 0; c < config.columns.length; c++) {
        const col = config.columns[c];
        const colName = config.columnNames[c];
        const truthVal = truthRow[c];
        const genVal = genRow[c];

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
    } else {
      // Truth row was missed entirely
      report.missingRows++;
      
      // All non-null/non-empty cells in the truth row are counted as missed
      for (let c = 0; c < config.columns.length; c++) {
        const col = config.columns[c];
        const colName = config.columnNames[c];
        const truthVal = truthRow[c];

        if (truthVal === null || truthVal === '' || truthVal === 0) {
          continue;
        }

        report.totalCells++;
        report.diffs.push({
          row: rowNum,
          col,
          colName,
          truthValue: truthVal,
          genValue: null,
          isMatch: false,
        });
      }
    }
  }

  // Any unmatched gen rows are extra rows
  const unmatchedGen = genPool.filter(g => !g.matched);
  report.extraRows = unmatchedGen.length;

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

  const warnings: string[] = [];
  const reports: SheetReport[] = [];
  const configs = getSheetConfigs(truthWb);
  const isCustomLayout = configs.length === 0;
  const truthSheets = truthWb.worksheets.map(w => w.name);

  for (const config of configs) {
    reports.push(compareSheet(truthWb, genWb, config, warnings));
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
    warnings,
    isCustomLayout,
    truthSheets,
  };
}

export function formatCompareResult(result: CompareResult): string {
  let out = '';
  out += `${'='.repeat(80)}\n`;
  out += `🔬 PROJECT: ${result.projectName}\n`;
  out += `   Truth Sheet: ${result.truthFile} | Generated: ${result.genFile}\n`;
  out += `${'='.repeat(80)}\n`;

  if (result.isCustomLayout) {
    out += `\n⚠️ Custom layout detected in Ground Truth. (Sheets: [${result.truthSheets?.join(', ')}])\n`;
    out += `   Bypassing cell-by-cell spreadsheet template comparison.\n`;
    out += `${'─'.repeat(60)}\n`;
    out += `📊 OVERALL SYSTEM ACCURACY: N/A (Custom Layout)\n`;
    out += `${'─'.repeat(60)}\n`;
    return out;
  }

  for (const report of result.reports) {
    const accuracy =
      report.totalCells > 0
        ? ((report.matchingCells / report.totalCells) * 100).toFixed(1) + '%'
        : 'N/A';

    out += `\n📊 Section: ${report.sectionLabel}\n`;
    out += `   Accuracy: ${accuracy} (${report.matchingCells}/${report.totalCells} cells matching)\n`;
    out += `   Missing rows: ${report.missingRows} | Extra rows: ${report.extraRows}\n`;

    if (report.diffs.length > 0) {
      out += `   ❌ ${report.diffs.length} discrepancy details:\n`;
      for (const d of report.diffs) {
        const errStr = d.pctError !== undefined ? ` (${d.pctError.toFixed(1)}% error)` : '';
        out += `      Row ${d.row} [${d.colName}]: Truth="${d.truthValue}" vs Generated="${d.genValue}"${errStr}\n`;
      }
    } else {
      out += `   ✅ 100% matched.\n`;
    }
  }

  out += `\n${'─'.repeat(60)}\n`;
  out += `📊 OVERALL SYSTEM ACCURACY: ${result.overallAccuracy.toFixed(1)}% (${result.totalMatching}/${result.totalCells} cells matching)\n`;
  out += `${'─'.repeat(60)}\n`;
  return out;
}

function printCompareResult(result: CompareResult) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔬 ${result.projectName}`);
  console.log(`   Truth: ${result.truthFile} | Generated: ${result.genFile}`);
  console.log(`${'='.repeat(80)}`);

  if (result.isCustomLayout) {
    console.log(`\n  ⚠️ Custom layout detected in Ground Truth. (Sheets: [${result.truthSheets?.join(', ')}])`);
    console.log(`     Bypassing cell-by-cell spreadsheet template comparison.`);
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📊 OVERALL ACCURACY: N/A (Custom Layout)`);
    console.log(`${'─'.repeat(60)}\n`);
    return;
  }

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
    let xlsxFiles = allFiles.filter(f =>
      f.endsWith('.xlsx') &&
      !f.toLowerCase().includes('quote') &&
      !f.toLowerCase().includes('budget') &&
      !f.toLowerCase().includes('backup') &&
      !f.toLowerCase().includes('sand') &&
      !f.toLowerCase().includes('appendix') &&
      !f.toLowerCase().includes('estimate') &&
      !f.toLowerCase().includes('eval_')
    );
    if (xlsxFiles.length === 0) {
      xlsxFiles = allFiles.filter(f =>
        f.endsWith('.xlsx') &&
        !f.toLowerCase().includes('quote') &&
        !f.toLowerCase().includes('backup') &&
        !f.toLowerCase().includes('sand') &&
        !f.toLowerCase().includes('appendix') &&
        !f.toLowerCase().includes('eval_')
      );
    }
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
