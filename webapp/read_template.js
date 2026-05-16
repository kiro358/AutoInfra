const ExcelJS = require('exceljs');
const path = require('path');

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(__dirname, '..', 'empty_templates', 'SHORT-NEW - Copy (3).xlsx'));
  const sheet = workbook.getWorksheet('MANHOLES (1)');
  
  for (let i = 11; i <= 20; i++) {
    const row = sheet.getRow(i);
    console.log(`Row ${i}: ${row.getCell(2).value} | ${row.getCell(3).value}`);
  }
  
  console.log('---');
  for (let i = 50; i <= 60; i++) {
    const row = sheet.getRow(i);
    console.log(`Row ${i}: B=${row.getCell(2).value} C=${row.getCell(3).value}`);
  }
}
main();
