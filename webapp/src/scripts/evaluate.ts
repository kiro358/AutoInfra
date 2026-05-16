/**
 * Evaluation Script
 * Runs the AI extraction pipeline against training projects and compares to ground truth.
 * 
 * Usage: npx ts-node src/scripts/evaluate.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';

const TRAINING_DIR = path.join(process.cwd(), '..', 'existing_projects_training_data');
const TESTING_DIR = path.join(process.cwd(), '..', 'existing_projects_testing_data');

interface GroundTruth {
  projectName: string;
  projectDir: string;
  pdfFiles: string[];
  manholes: Array<{
    description: string;
    topElevation: number;
    lowInvert: number;
    highInvert: number;
    pipeOutDiameter: number;
    structureType: number;
  }>;
  sewers: Array<{
    runLabel: string;
    length: number;
    pipeDiameter: number;
    typeClass: number;
    slope: number;
    depth: number;
  }>;
  watermain: Array<{
    sizeAndType: string;
    length: number;
    pipeDiameter: number;
    ocSc: number;
    avgCover: number;
  }>;
  totals: {
    sewerLength: number;
    manholeCount: number;
    watermainLength: number;
  };
}

/**
 * Extract ground truth data from a filled spreadsheet
 */
async function extractGroundTruth(xlsxPath: string, projectDir: string): Promise<GroundTruth | null> {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);

    const sheetNames = workbook.worksheets.map(s => s.name);
    
    // Only process files that match our template structure
    if (!sheetNames.includes('MANHOLES (1)') || !sheetNames.includes('SEWERS (1)')) {
      return null;
    }

    const mhSheet = workbook.getWorksheet('MANHOLES (1)')!;
    const swSheet = workbook.getWorksheet('SEWERS (1)')!;
    const wmSheet = workbook.getWorksheet('WATERMAIN (1)');

    const projectName = String(getCellValue(mhSheet, 'B2') || path.basename(projectDir));

    // Extract manholes
    const manholes: GroundTruth['manholes'] = [];
    for (let row = 11; row <= 60; row++) {
      const desc = getCellValue(mhSheet, `B${row}`);
      const topEl = getCellValue(mhSheet, `C${row}`);
      if (!desc && !topEl) continue;
      
      manholes.push({
        description: String(desc || ''),
        topElevation: Number(topEl) || 0,
        lowInvert: Number(getCellValue(mhSheet, `D${row}`)) || 0,
        highInvert: Number(getCellValue(mhSheet, `E${row}`)) || 0,
        pipeOutDiameter: Number(getCellValue(mhSheet, `F${row}`)) || 0,
        structureType: Number(getCellValue(mhSheet, `G${row}`)) || 1,
      });
    }

    // Extract sewers
    const sewers: GroundTruth['sewers'] = [];
    for (let row = 14; row <= 55; row++) {
      const runLabel = getCellValue(swSheet, `B${row}`);
      const length = getCellValue(swSheet, `C${row}`);
      if (!runLabel && !length) continue;

      sewers.push({
        runLabel: String(runLabel || ''),
        length: Number(length) || 0,
        pipeDiameter: Number(getCellValue(swSheet, `D${row}`)) || 0,
        typeClass: Number(getCellValue(swSheet, `E${row}`)) || 0,
        slope: Number(getCellValue(swSheet, `F${row}`)) || 0,
        depth: Number(getCellValue(swSheet, `G${row}`)) || 0,
      });
    }

    // Extract watermain
    const watermain: GroundTruth['watermain'] = [];
    if (wmSheet) {
      for (let row = 13; row <= 19; row++) {
        const sizeAndType = getCellValue(wmSheet, `B${row}`);
        const length = getCellValue(wmSheet, `C${row}`);
        if (!sizeAndType && !length) continue;

        watermain.push({
          sizeAndType: String(sizeAndType || ''),
          length: Number(length) || 0,
          pipeDiameter: Number(getCellValue(wmSheet, `D${row}`)) || 0,
          ocSc: Number(getCellValue(wmSheet, `F${row}`)) || 1.1,
          avgCover: Number(getCellValue(wmSheet, `J${row}`)) || 1.8,
        });
      }
    }

    // Find PDF files in the project directory
    const allFiles = fs.readdirSync(projectDir);
    const pdfFiles = allFiles.filter(f => 
      f.toLowerCase().endsWith('.pdf') && 
      !f.toLowerCase().includes('quote') &&
      !f.toLowerCase().includes('breakdown')
    );

    return {
      projectName,
      projectDir,
      pdfFiles,
      manholes,
      sewers,
      watermain,
      totals: {
        sewerLength: sewers.reduce((s, r) => s + r.length, 0),
        manholeCount: manholes.length,
        watermainLength: watermain.reduce((s, r) => s + r.length, 0),
      },
    };
  } catch (err) {
    console.error(`Error processing ${xlsxPath}:`, err);
    return null;
  }
}

function getCellValue(sheet: ExcelJS.Worksheet, ref: string): string | number | null {
  const cell = sheet.getCell(ref);
  if (cell.value === null || cell.value === undefined) return null;
  
  // Handle formula results
  if (typeof cell.value === 'object' && 'result' in cell.value) {
    return (cell.value as { result: string | number }).result;
  }
  return cell.value as string | number;
}

/**
 * Compare extracted data to ground truth
 */
function compareResults(
  predicted: GroundTruth,
  actual: GroundTruth
): Record<string, number> {
  const metrics: Record<string, number> = {};

  // Count accuracy
  metrics['manhole_count_pred'] = predicted.manholes.length;
  metrics['manhole_count_actual'] = actual.manholes.length;
  metrics['manhole_count_accuracy'] = 
    actual.manholes.length > 0 
      ? 1 - Math.abs(predicted.manholes.length - actual.manholes.length) / actual.manholes.length 
      : predicted.manholes.length === 0 ? 1 : 0;

  metrics['sewer_count_pred'] = predicted.sewers.length;
  metrics['sewer_count_actual'] = actual.sewers.length;
  metrics['sewer_count_accuracy'] =
    actual.sewers.length > 0
      ? 1 - Math.abs(predicted.sewers.length - actual.sewers.length) / actual.sewers.length
      : predicted.sewers.length === 0 ? 1 : 0;

  metrics['watermain_count_pred'] = predicted.watermain.length;
  metrics['watermain_count_actual'] = actual.watermain.length;
  metrics['watermain_count_accuracy'] =
    actual.watermain.length > 0
      ? 1 - Math.abs(predicted.watermain.length - actual.watermain.length) / actual.watermain.length
      : predicted.watermain.length === 0 ? 1 : 0;

  // Total length accuracy
  metrics['total_sewer_length_pred'] = predicted.totals.sewerLength;
  metrics['total_sewer_length_actual'] = actual.totals.sewerLength;
  metrics['sewer_length_pct_error'] =
    actual.totals.sewerLength > 0
      ? Math.abs(predicted.totals.sewerLength - actual.totals.sewerLength) / actual.totals.sewerLength * 100
      : 0;

  metrics['total_wm_length_pred'] = predicted.totals.watermainLength;
  metrics['total_wm_length_actual'] = actual.totals.watermainLength;

  // Diameter accuracy (for matched runs)
  let diaMatches = 0;
  let diaTotal = 0;
  for (const predSewer of predicted.sewers) {
    const match = actual.sewers.find(a => 
      a.runLabel.toLowerCase().trim() === predSewer.runLabel.toLowerCase().trim()
    );
    if (match) {
      diaTotal++;
      if (match.pipeDiameter === predSewer.pipeDiameter) diaMatches++;
    }
  }
  metrics['sewer_diameter_accuracy'] = diaTotal > 0 ? diaMatches / diaTotal : 0;

  return metrics;
}

// ---- Main ----
async function main() {
  console.log('=== AutoInfra Evaluation Script ===\n');
  
  // Step 1: Extract ground truth from all training projects
  const projects = fs.readdirSync(TRAINING_DIR).filter(d => 
    fs.statSync(path.join(TRAINING_DIR, d)).isDirectory() && !d.startsWith('.')
  );

  console.log(`Found ${projects.length} training projects\n`);

  let validCount = 0;
  const allGroundTruths: GroundTruth[] = [];

  for (const proj of projects) {
    const projDir = path.join(TRAINING_DIR, proj);
    const files = fs.readdirSync(projDir);
    const xlsxFiles = files.filter(f => 
      f.toLowerCase().endsWith('.xlsx') && 
      !f.toLowerCase().includes('quote') &&
      !f.toLowerCase().includes('sand') &&
      !f.toLowerCase().includes('appendix') &&
      !f.toLowerCase().includes('estimate moe') &&
      !f.toLowerCase().includes('budget') &&
      !f.toLowerCase().includes('additional')
    );

    for (const xlsx of xlsxFiles) {
      const gt = await extractGroundTruth(path.join(projDir, xlsx), projDir);
      if (gt && (gt.manholes.length > 0 || gt.sewers.length > 0)) {
        allGroundTruths.push(gt);
        validCount++;
        console.log(
          `✓ ${proj} → ${gt.manholes.length} MH, ${gt.sewers.length} SW, ${gt.watermain.length} WM ` +
          `(${gt.totals.sewerLength}m sewer, ${gt.totals.watermainLength}m WM)`
        );
      }
    }
  }

  console.log(`\n=== Dataset Summary ===`);
  console.log(`Valid projects: ${validCount}`);
  console.log(`Total manholes: ${allGroundTruths.reduce((s, g) => s + g.manholes.length, 0)}`);
  console.log(`Total sewer runs: ${allGroundTruths.reduce((s, g) => s + g.sewers.length, 0)}`);
  console.log(`Total watermain runs: ${allGroundTruths.reduce((s, g) => s + g.watermain.length, 0)}`);
  console.log(`Total sewer length: ${allGroundTruths.reduce((s, g) => s + g.totals.sewerLength, 0).toFixed(0)}m`);
  console.log(`Projects with PDFs: ${allGroundTruths.filter(g => g.pdfFiles.length > 0).length}`);

  // Pipe diameter distribution
  const diaDist: Record<number, number> = {};
  for (const gt of allGroundTruths) {
    for (const sw of gt.sewers) {
      if (sw.pipeDiameter > 0) {
        diaDist[sw.pipeDiameter] = (diaDist[sw.pipeDiameter] || 0) + 1;
      }
    }
  }
  console.log(`\nSewer pipe diameter distribution:`);
  for (const [dia, count] of Object.entries(diaDist).sort((a, b) => Number(b[1]) - Number(a[1]))) {
    console.log(`  ${dia}mm: ${count} runs`);
  }

  // Depth distribution
  const depths = allGroundTruths.flatMap(g => g.sewers.map(s => s.depth)).filter(d => d > 0);
  if (depths.length > 0) {
    console.log(`\nSewer depth stats:`);
    console.log(`  Min: ${Math.min(...depths).toFixed(1)}m`);
    console.log(`  Max: ${Math.max(...depths).toFixed(1)}m`);
    console.log(`  Avg: ${(depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1)}m`);
  }

  // Write ground truth JSON for future use
  const outputPath = path.join(process.cwd(), 'ground_truth_dataset.json');
  fs.writeFileSync(outputPath, JSON.stringify(allGroundTruths, null, 2));
  console.log(`\nGround truth dataset saved to: ${outputPath}`);
}

main().catch(console.error);
