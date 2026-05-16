const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const TRAINING_DIR = path.join(__dirname, '..', 'existing_projects_training_data');

function getCellValue(sheet, ref) {
  const cell = sheet.getCell(ref);
  if (cell.value === null || cell.value === undefined) return null;
  if (typeof cell.value === 'object') {
    if ('result' in cell.value) return cell.value.result;
    if ('text' in cell.value) return cell.value.text;
    return null;
  }
  return cell.value;
}

async function extractFull(folder) {
  const dir = path.join(TRAINING_DIR, folder);
  const files = fs.readdirSync(dir);
  const xlsxFiles = files.filter(f => f.endsWith('.xlsx') && !f.toLowerCase().includes('quote') && !f.toLowerCase().includes('budget') && !f.toLowerCase().includes('backup') && !f.toLowerCase().includes('sand') && !f.toLowerCase().includes('appendix') && !f.toLowerCase().includes('estimate'));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(dir, xlsxFiles[0]));

  const mhSheet = wb.getWorksheet('MANHOLES (1)');
  const swSheet = wb.getWorksheet('SEWERS (1)');

  const result = { projectName: String(getCellValue(mhSheet, 'B2') || folder), jobNumber: String(getCellValue(mhSheet, 'B3') || ''), date: String(getCellValue(mhSheet, 'B5') || '') };

  // Manholes
  result.manholes = [];
  for (let r = 11; r <= 50; r++) {
    const desc = getCellValue(mhSheet, `B${r}`);
    if (!desc) continue;
    result.manholes.push({
      description: String(desc),
      depth: getCellValue(mhSheet, `J${r}`),
      addMaterials: Number(getCellValue(mhSheet, `H${r}`)) || 0,
      addLE: Number(getCellValue(mhSheet, `I${r}`)) || 0,
    });
  }

  // Catchbasins
  result.catchbasins = { groups: [], laborRates: {} };
  const cbTypes = {53:'SINGLE_CB', 54:'DOUBLE_CB', 55:'DITCH_INLET_CB', 56:'DOUBLE_DITCH_INLET_CB'};
  for (const [row, type] of Object.entries(cbTypes)) {
    const qty = getCellValue(mhSheet, `C${row}`);
    if (qty) {
      result.catchbasins.groups.push({
        type,
        quantity: Number(qty),
        wallThickness: Number(getCellValue(mhSheet, `D${row}`)) || 4,
        depth: Number(getCellValue(mhSheet, `E${row}`)) || 2.2,
        grateEach: Number(getCellValue(mhSheet, `F${row}`)) || 0,
        addMaterials: Number(getCellValue(mhSheet, `G${row}`)) || 0,
      });
    }
  }
  result.catchbasins.laborRates = {
    scbLabor: Number(getCellValue(mhSheet, 'C59')) || 200,
    dcbLabor: Number(getCellValue(mhSheet, 'C60')) || 250,
    dicbFC: Number(getCellValue(mhSheet, 'F59')) || 465,
    ddicbFC: Number(getCellValue(mhSheet, 'F60')) || 715,
  };

  // Sewers
  result.sewers = [];
  for (let r = 14; r <= 55; r++) {
    const label = getCellValue(swSheet, `B${r}`);
    if (!label) continue;
    const length = getCellValue(swSheet, `C${r}`);
    const pipeDia = getCellValue(swSheet, `D${r}`);
    const isLineItem = !length && !pipeDia;
    result.sewers.push({
      runLabel: String(label),
      isLineItem,
      length: length != null ? Number(length) : null,
      pipeDiameter: pipeDia != null ? Number(pipeDia) : null,
      typeClass: getCellValue(swSheet, `E${r}`) != null ? Number(getCellValue(swSheet, `E${r}`)) : null,
      slope: getCellValue(swSheet, `F${r}`) != null ? Number(getCellValue(swSheet, `F${r}`)) : null,
      depth: getCellValue(swSheet, `G${r}`) != null ? Number(getCellValue(swSheet, `G${r}`)) : null,
      addMaterials: Number(getCellValue(swSheet, `H${r}`)) || 0,
      addLE: Number(getCellValue(swSheet, `I${r}`)) || 0,
    });
  }

  return result;
}

async function main() {
  // 3 projects: simple, medium, complex
  const projects = [
    '2026-067 201 GEORGIAN DR,BARRIE',  // simple: 3 MH, 7 SW, CB data
    '2026-068 HOLIDAY INN,TRENTON',      // medium: 11 MH, 17 SW, CB data
    '2026-021 MATTHEWS HANGER WATERLOO',  // complex: 13 MH, 21 SW, lots of CB
  ];

  const fewshots = [];
  for (const p of projects) {
    try {
      const data = await extractFull(p);
      fewshots.push(data);
      console.log(`✓ ${p}: ${data.manholes.length} MH, ${data.sewers.length} SW, ${data.catchbasins.groups.length} CB groups`);
    } catch(e) {
      console.error(`✗ ${p}: ${e.message}`);
    }
  }

  fs.writeFileSync(path.join(__dirname, 'few_shot_examples.json'), JSON.stringify(fewshots, null, 2));
  console.log('\nSaved to few_shot_examples.json');
}

main();
