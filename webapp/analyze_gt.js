const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

const TRAINING_DIR = path.join(__dirname, '..', 'existing_projects_training_data');

async function analyzeProject(folder) {
  const dir = path.join(TRAINING_DIR, folder);
  const files = fs.readdirSync(dir);
  const xlsxFiles = files.filter(f => f.endsWith('.xlsx') && !f.toLowerCase().includes('quote') && !f.toLowerCase().includes('budget') && !f.toLowerCase().includes('backup') && !f.toLowerCase().includes('sand') && !f.toLowerCase().includes('appendix') && !f.toLowerCase().includes('estimate'));
  const pdfFiles = files.filter(f => f.endsWith('.pdf') && !f.toLowerCase().includes('quote') && !f.toLowerCase().includes('schedule') && !f.toLowerCase().includes('bid'));
  
  if (xlsxFiles.length === 0) return null;
  
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(dir, xlsxFiles[0]));
    const sheets = wb.worksheets.map(s => s.name);
    
    if (!sheets.includes('MANHOLES (1)') || !sheets.includes('SEWERS (1)')) return null;
    
    const mhSheet = wb.getWorksheet('MANHOLES (1)');
    const swSheet = wb.getWorksheet('SEWERS (1)');
    const wmSheet = wb.getWorksheet('WATERMAIN (1)');
    
    // Count manholes (rows 11-50)
    let mhCount = 0;
    const mhDescs = [];
    for (let r = 11; r <= 50; r++) {
      const desc = mhSheet.getCell(`B${r}`).value;
      if (desc) { mhCount++; mhDescs.push(String(desc)); }
    }
    
    // Count CBs (rows 53-56)
    const cbData = [];
    for (let r = 53; r <= 56; r++) {
      const qty = mhSheet.getCell(`C${r}`).value;
      const type = mhSheet.getCell(`B${r}`).value;
      if (qty) cbData.push(`${type}:${qty}`);
    }
    
    // Count sewers (rows 14-55)
    let swCount = 0;
    const swLabels = [];
    for (let r = 14; r <= 55; r++) {
      const label = swSheet.getCell(`B${r}`).value;
      if (label) { swCount++; swLabels.push(String(label)); }
    }
    
    // Count watermain
    let wmCount = 0;
    if (wmSheet) {
      for (let r = 13; r <= 19; r++) {
        const label = wmSheet.getCell(`B${r}`).value;
        if (label) wmCount++;
      }
    }
    
    return {
      folder,
      xlsx: xlsxFiles[0],
      pdfCount: pdfFiles.length,
      mhCount,
      mhDescs: mhDescs.slice(0, 5),
      cbData,
      swCount,
      swLabels: swLabels.slice(0, 3),
      wmCount,
    };
  } catch(e) {
    return null;
  }
}

async function main() {
  const folders = fs.readdirSync(TRAINING_DIR).filter(f => {
    try { return fs.statSync(path.join(TRAINING_DIR, f)).isDirectory(); } catch { return false; }
  });
  
  const results = [];
  for (const folder of folders) {
    const r = await analyzeProject(folder);
    if (r) results.push(r);
  }
  
  console.log(`\nAnalyzed ${results.length} valid projects:\n`);
  
  // Sort by complexity
  results.sort((a,b) => (b.swCount + b.mhCount) - (a.swCount + a.mhCount));
  
  for (const r of results) {
    console.log(`${r.folder}`);
    console.log(`  XLSX: ${r.xlsx} | PDFs: ${r.pdfCount}`);
    console.log(`  MH: ${r.mhCount} [${r.mhDescs.join(', ')}]`);
    console.log(`  CB: ${r.cbData.join(', ') || 'none'}`);
    console.log(`  SW: ${r.swCount} [${r.swLabels.join(', ')}...]`);
    console.log(`  WM: ${r.wmCount}`);
    console.log();
  }
  
  // Summary stats
  const withPdf = results.filter(r => r.pdfCount > 0);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total valid projects: ${results.length}`);
  console.log(`With PDFs: ${withPdf.length}`);
  console.log(`Avg manholes/project: ${(results.reduce((s,r) => s + r.mhCount, 0) / results.length).toFixed(1)}`);
  console.log(`Avg sewers/project: ${(results.reduce((s,r) => s + r.swCount, 0) / results.length).toFixed(1)}`);
  console.log(`Avg watermain/project: ${(results.reduce((s,r) => s + r.wmCount, 0) / results.length).toFixed(1)}`);
  console.log(`Projects with CB data: ${results.filter(r => r.cbData.length > 0).length}`);
  console.log(`Projects with WM data: ${results.filter(r => r.wmCount > 0).length}`);
  
  // Good few-shot candidates (have PDFs, reasonable complexity, CB data)
  console.log(`\n=== BEST FEW-SHOT CANDIDATES (has PDFs + CB + moderate complexity) ===`);
  const candidates = withPdf.filter(r => r.cbData.length > 0 && r.swCount >= 3 && r.swCount <= 20);
  for (const c of candidates.slice(0, 10)) {
    console.log(`  ${c.folder} → MH:${c.mhCount} CB:[${c.cbData}] SW:${c.swCount} WM:${c.wmCount} PDFs:${c.pdfCount}`);
  }
}

main();
