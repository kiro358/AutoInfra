import fs from 'fs';
import path from 'path';
import { extractFromPDF } from '../lib/extraction';
import { populateTemplate } from '../lib/spreadsheet';
import { DEFAULT_PARAMS } from '../lib/constants';
import { execSync } from 'child_process';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');
const TARGET_FOLDER = process.argv[2] || '2026-067 201 GEORGIAN DR,BARRIE';

/** Blocklist of non-drawing PDF keywords to filter out */
const PDF_BLOCKLIST = [
  'quote', 'quotation', 'schedule', 'bid', 'geotechnical', 'geotech',
  'report', 'proposal', 'estimate', 'pricing', 'breakdown', 'budget',
  'letter', 'backup', 'specifications', 'specs', 'rpt', 'contracting',
  'invoice', 'addendum', 'tender_form', 'tender form', 'tipp',
  'structural', 'architectural', 'hydrogeological', 'landscape',
  'cover sheet', 'appendix'
];

function findDrawingPDFs(projectDir: string): string[] {
  const files = fs.readdirSync(projectDir);
  
  // Filter to drawing PDFs only (not quotes, reports, etc.)
  const pdfFiles = files.filter(f => {
    const name = f.toLowerCase();
    if (!name.endsWith('.pdf')) return false;
    return !PDF_BLOCKLIST.some(b => name.includes(b));
  });

  // Sort by relevance: civil/servicing/drainage first, then by size
  return pdfFiles.sort((a, b) => {
    const scoreA = scorePDF(a);
    const scoreB = scorePDF(b);
    if (scoreA !== scoreB) return scoreB - scoreA;
    const sizeA = fs.statSync(path.join(projectDir, a)).size;
    const sizeB = fs.statSync(path.join(projectDir, b)).size;
    return sizeB - sizeA;
  });
}

function scorePDF(filename: string): number {
  const name = filename.toLowerCase();
  let score = 0;
  if (name.includes('civil') || name.includes('servicing') || name.includes('drainage') || name.includes('plan') || name.includes('pnp') || name.includes('storm') || name.includes('sewer') || name.includes('water')) {
    score += 1000;
  }
  if (name.includes('detail') || name.includes('det-') || name.includes('notes')) {
    score -= 200;
  }
  return score;
}

async function main() {
  const projectDir = path.join(TRAINING_DIR, TARGET_FOLDER);
  if (!fs.existsSync(projectDir)) {
    console.error(`Project dir not found: ${projectDir}`);
    return;
  }

  const files = fs.readdirSync(projectDir);
  
  // Support specifying a single PDF as CLI arg
  const specifiedPdf = process.argv[3];
  const pdfFiles = specifiedPdf ? [specifiedPdf] : findDrawingPDFs(projectDir);
  
  const xlsxFiles = files.filter(f => 
    f.toLowerCase().endsWith('.xlsx') && 
    !f.toLowerCase().includes('backup') &&
    !f.toLowerCase().includes('eval_run') &&
    !f.toLowerCase().includes('quote') &&
    !f.toLowerCase().includes('sand') &&
    !f.toLowerCase().includes('budget')
  );

  if (pdfFiles.length === 0 || xlsxFiles.length === 0) {
    console.log(`Skipping (missing PDF or XLSX). Found PDFs: [${pdfFiles.join(', ')}], XLSXs: [${xlsxFiles.join(', ')}]`);
    return;
  }

  console.log(`Evaluating Project: ${TARGET_FOLDER}`);
  console.log(`Drawing PDFs (${pdfFiles.length}):`);
  pdfFiles.forEach((f, i) => {
    const size = (fs.statSync(path.join(projectDir, f)).size / 1024 / 1024).toFixed(1);
    console.log(`  ${i + 1}. ${f} (${size} MB)`);
  });
  console.log(`Truth: ${xlsxFiles[0]}`);

  try {
    // Read all PDF buffers
    const pdfBuffers = pdfFiles.map(f => fs.readFileSync(path.join(projectDir, f)));
    
    console.log(`Extracting data via Gemini (${pdfBuffers.length} PDFs)...`);
    // Pass array of buffers — extractFromPDF will merge them automatically
    const result = await extractFromPDF(pdfBuffers, TARGET_FOLDER);

    console.log(`Generating spreadsheet...`);
    const genBuffer = await populateTemplate(result, DEFAULT_PARAMS as any);

    const genDir = path.join(projectDir, 'generated_spreadsheets');
    if (!fs.existsSync(genDir)) fs.mkdirSync(genDir);

    const genPath = path.join(genDir, `eval_run_${Date.now()}.xlsx`);
    fs.writeFileSync(genPath, genBuffer);
    fs.writeFileSync(path.join(genDir, 'latest_result.json'), JSON.stringify(result, null, 2));
    console.log(`Output saved to: ${genPath}`);

    const truthPath = path.join(projectDir, xlsxFiles[0]);
    console.log(`Running compare-sheets...`);
    execSync(`npx tsx src/scripts/compare-sheets.ts "${TARGET_FOLDER}" "${xlsxFiles[0]}" "${path.basename(genPath)}"`, { stdio: 'inherit', cwd: path.resolve(__dirname, '../..') });
  } catch (e) {
    console.error(`Error processing:`, e);
  }
}
main().catch(console.error);

