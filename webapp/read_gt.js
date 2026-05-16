const ExcelJS = require('exceljs');
const path = require('path');

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(__dirname, '..', 'existing_projects_training_data', '2026-067 201 GEORGIAN DR,BARRIE', '201 GEORGIAN.xlsx'));
  const sheet = workbook.getWorksheet('MANHOLES (1)');
  
  for (let i = 11; i <= 20; i++) {
    const row = sheet.getRow(i);
    const vals = [];
    for (let c = 2; c <= 12; c++) vals.push(row.getCell(c).value);
    console.log(`Row ${i}: ${vals.join(' | ')}`);
  }
}
main();
