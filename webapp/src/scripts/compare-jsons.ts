import ExcelJS from 'exceljs';
import path from 'path';
import { getSheetConfigs, getWorksheetFlex } from './compare-sheets';

export interface SemanticReport {
  sectionLabel: string;
  totalProperties: number;
  matchingProperties: number;
  missingCount: number;
  extraCount: number;
  accuracy: number;
  details: string[];
}

export interface SemanticResult {
  projectName: string;
  overallAccuracy: number;
  reports: SemanticReport[];
}

function parseCellValue(val: any): string | number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') {
    if ('result' in val) return val.result as string | number;
    if ('text' in val) return val.text as string;
    return null;
  }
  return val;
}

function fuzzyKeyMatch(keyA: string, keyB: string): boolean {
  const cleanA = keyA.replace(/\(.*?\)/g, '').trim().toLowerCase();
  const cleanB = keyB.replace(/\(.*?\)/g, '').trim().toLowerCase();
  if (cleanA === cleanB) return true;

  const normA = cleanA.replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  const normB = cleanB.replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
  if (normA === normB) return true;

  // Fuzzy match: if one contains the other and they contain the same numbers
  if (normA.includes(normB) || normB.includes(normA)) {
    const numA = normA.replace(/[^0-9]/g, '');
    const numB = normB.replace(/[^0-9]/g, '');
    if (numA === numB && numA.length > 0) return true;
  }
  return false;
}

function valuesMatch(a: any, b: any): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;

  const numA = typeof a === 'number' ? a : parseFloat(String(a));
  const numB = typeof b === 'number' ? b : parseFloat(String(b));

  if (!isNaN(numA) && !isNaN(numB)) {
    if (numA === 0 && numB === 0) return true;
    const pctDiff = Math.abs(numA - numB) / Math.max(Math.abs(numA), Math.abs(numB));
    return pctDiff < 0.05; // 5% tolerance for numbers
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

export async function compareSemantically(
  truthPath: string,
  genPath: string,
  projectName: string
): Promise<SemanticResult> {
  const truthWb = new ExcelJS.Workbook();
  await truthWb.xlsx.readFile(truthPath);

  const genWb = new ExcelJS.Workbook();
  await genWb.xlsx.readFile(genPath);

  const configs = getSheetConfigs(truthWb);
  const reports: SemanticReport[] = [];

  for (const config of configs) {
    const truthSheet = getWorksheetFlex(truthWb, config.sheetName);
    const genSheet = getWorksheetFlex(genWb, config.sheetName);

    if (!truthSheet || !genSheet) continue;

    // Helper to read rows into objects mapped by key column
    const readObjects = (sheet: ExcelJS.Worksheet) => {
      const objects: Record<string, Record<string, any>> = {};
      const keyColIdx = config.columns.indexOf(config.keyColumn);

      for (let r = config.dataStartRow; r <= config.dataEndRow; r++) {
        const rawKey = sheet.getCell(`${config.keyColumn}${r}`).value;
        const key = parseCellValue(rawKey);
        if (key === null || key === '' || key === 0) continue;
        if (typeof key === 'string' && key.toUpperCase().includes('TOTAL')) continue;

        const obj: Record<string, any> = {};
        config.columns.forEach((col, idx) => {
          if (idx === keyColIdx) return;
          const colName = config.columnNames[idx];
          obj[colName] = parseCellValue(sheet.getCell(`${col}${r}`).value);
        });
        objects[String(key).trim()] = obj;
      }
      return objects;
    };

    const truthData = readObjects(truthSheet);
    const genData = readObjects(genSheet);

    let totalProperties = 0;
    let matchingProperties = 0;
    let missingCount = 0;
    let extraCount = 0;
    const details: string[] = [];

    const matchedGenKeys = new Set<string>();

    // Compare truth objects against generated
    for (const truthKey of Object.keys(truthData)) {
      const truthObj = truthData[truthKey];
      
      // Find matching key in generated
      const genKey = Object.keys(genData).find(gk => !matchedGenKeys.has(gk) && fuzzyKeyMatch(truthKey, gk));

      if (genKey) {
        matchedGenKeys.add(genKey);
        const genObj = genData[genKey];

        // Compare properties
        for (const prop of Object.keys(truthObj)) {
          const truthVal = truthObj[prop];
          const genVal = genObj[prop];

          // Skip if both are empty/null/zero
          if ((truthVal === null || truthVal === '' || truthVal === 0) &&
              (genVal === null || genVal === '' || genVal === 0)) {
            continue;
          }

          totalProperties++;
          const match = valuesMatch(truthVal, genVal);
          if (match) {
            matchingProperties++;
          } else {
            details.push(`Mismatch on ${truthKey} [${prop}]: Truth="${truthVal}" vs Gen="${genVal}"`);
          }
        }
      } else {
        missingCount++;
        // Count all truth non-null properties as missed
        for (const prop of Object.keys(truthObj)) {
          const truthVal = truthObj[prop];
          if (truthVal !== null && truthVal !== '' && truthVal !== 0) {
            totalProperties++;
            details.push(`Missing entity: ${truthKey} (Property [${prop}]="${truthVal}" missed)`);
          }
        }
      }
    }

    // Extra generated objects
    for (const genKey of Object.keys(genData)) {
      if (!matchedGenKeys.has(genKey)) {
        extraCount++;
        details.push(`Extra entity generated: ${genKey}`);
      }
    }

    const accuracy = totalProperties > 0 ? (matchingProperties / totalProperties) * 100 : 100;

    reports.push({
      sectionLabel: config.sectionLabel,
      totalProperties,
      matchingProperties,
      missingCount,
      extraCount,
      accuracy,
      details,
    });
  }

  const totalProps = reports.reduce((sum, r) => sum + r.totalProperties, 0);
  const totalMatch = reports.reduce((sum, r) => sum + r.matchingProperties, 0);
  const overallAccuracy = totalProps > 0 ? (totalMatch / totalProps) * 100 : 0;

  return {
    projectName,
    overallAccuracy,
    reports,
  };
}

export function formatSemanticResult(result: SemanticResult): string {
  let out = '';
  out += `\n🧠 SEMANTIC EXTRACTION SCOREBOARD (JSON-TO-JSON)\n`;
  out += `${'='.repeat(60)}\n`;
  for (const r of result.reports) {
    out += `  📊 ${r.sectionLabel}: ${r.accuracy.toFixed(1)}% (${r.matchingProperties}/${r.totalProperties} properties matched)\n`;
    out += `     Missing: ${r.missingCount} | Extra: ${r.extraCount}\n`;
    if (r.details.length > 0) {
      out += `     Discrepancies:\n`;
      r.details.slice(0, 5).forEach(d => out += `      - ${d}\n`);
      if (r.details.length > 5) {
        out += `      - ... and ${r.details.length - 5} more\n`;
      }
    }
  }
  out += `${'─'.repeat(60)}\n`;
  out += `🏆 OVERALL SEMANTIC EXTRACTION ACCURACY: ${result.overallAccuracy.toFixed(1)}%\n`;
  out += `${'─'.repeat(60)}\n`;
  return out;
}
