import { extractFromPDF } from '../lib/extraction';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const projName = "2026-025 INDUSTRIAL DEVELOPMENT-ULTIMATE DRIVE";
  const projDir = path.resolve(__dirname, `../../../existing_projects_training_data/${projName}`);
  const files = fs.readdirSync(projDir);
  const pdfFiles = files.filter(f =>
    f.toLowerCase().endsWith(".pdf") &&
    !f.toLowerCase().includes("quote") &&
    !f.toLowerCase().includes("quotation") &&
    !f.toLowerCase().includes("schedule") &&
    !f.toLowerCase().includes("bid") &&
    !f.toLowerCase().includes("geotechnical") &&
    !f.toLowerCase().includes("appendix 4") &&
    !f.toLowerCase().includes("report")
  );

  if (pdfFiles.length === 0) {
    console.error("No valid PDF found");
    return;
  }
  
  const pdfFile = pdfFiles.map(f => ({
    name: f,
    size: fs.statSync(path.join(projDir, f)).size
  })).sort((a, b) => b.size - a.size)[0].name;
  
  const pdfPath = path.join(projDir, pdfFile);
  console.log(`Extracting from: ${pdfPath}`);
  
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const rawJson = await extractFromPDF(pdfBuffer, projName);
    const outPath = path.resolve(__dirname, `../../scratch/${projName}-raw.json`);
    fs.writeFileSync(outPath, JSON.stringify(rawJson, null, 2), 'utf-8');
    console.log(`Saved raw JSON to ${outPath}`);
  } catch (err) {
    console.error(err);
  }
}

main();
