import fs from 'fs';
import path from 'path';
import { extractFromPDF } from '../lib/extraction';
import { populateTemplate } from '../lib/spreadsheet';
import { DEFAULT_PARAMS } from '../lib/constants';
import { execSync } from 'child_process';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');
const TARGET_FOLDER = process.argv[2] || '2026-067 201 GEORGIAN DR,BARRIE';

async function main() {
  const projectDir = path.join(TRAINING_DIR, TARGET_FOLDER);
  if (!fs.existsSync(projectDir)) {
    console.error(`Project dir not found: ${projectDir}`);
    return;
  }

  const files = fs.readdirSync(projectDir);
  const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf') && !f.toLowerCase().includes('quote') && !f.toLowerCase().includes('schedule') && !f.toLowerCase().includes('bid'));
  const xlsxFiles = files.filter(f => f.toLowerCase().endsWith('.xlsx'));

  if (pdfFiles.length === 0 || xlsxFiles.length === 0) {
    console.log(`Skipping (missing PDF or XLSX)`);
    return;
  }

  const pdfPath = path.join(projectDir, pdfFiles[0]);
  const truthPath = path.join(projectDir, xlsxFiles[0]);

  console.log(`Evaluating Project: ${TARGET_FOLDER}`);
  console.log(`PDF: ${pdfFiles[0]}`);
  console.log(`Truth: ${xlsxFiles[0]}`);

  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    console.log(`Extracting data via Gemini...`);
    const result = await extractFromPDF(pdfBuffer, TARGET_FOLDER);

    console.log(`Generating spreadsheet...`);
    const genBuffer = await populateTemplate(result, DEFAULT_PARAMS as any);

    const genDir = path.join(projectDir, 'generated_spreadsheets');
    if (!fs.existsSync(genDir)) fs.mkdirSync(genDir);

    const genPath = path.join(genDir, `eval_run_${Date.now()}.xlsx`);
    fs.writeFileSync(genPath, genBuffer);
    console.log(`Output saved to: ${genPath}`);

    console.log(`Running compare-sheets...`);
    execSync(`npx tsx src/scripts/compare-sheets.ts "${TARGET_FOLDER}" "${xlsxFiles[0]}" "${path.basename(genPath)}"`, { stdio: 'inherit', cwd: path.resolve(__dirname, '../..') });
  } catch (e) {
    console.error(`Error processing:`, e);
  }
}
main().catch(console.error);
