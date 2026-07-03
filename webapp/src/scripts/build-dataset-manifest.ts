/**
 * Builds dataset-manifest.json: for each training project, the truth spreadsheet,
 * the recursively-discovered civil drawing PDF(s), page/dimension info, the truth
 * takeoff counts, and quality flags. This is the curated source of truth for the
 * eval (deterministic PDF selection + a characterized project list).
 *
 * Usage: npx tsx src/scripts/build-dataset-manifest.ts
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { readTruthFacts } from '../lib/truth-facts';
import { chooseDrawingPdfs } from '../lib/dataset';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');
const OUT = path.resolve(__dirname, '../../..', 'dataset-manifest.json');

interface Entry {
  folder: string;
  truthXlsx: string;
  standard: boolean;
  mhSheets: number;
  swSheets: number;
  drawingPdfs: { name: string; pages?: number; dimIn?: string; mb?: number; error?: boolean }[];
  totalPages: number;
  truth: { structures: number; runs: number; cbGroups: number; watermain: number };
  flags: string[];
  usable: boolean;
}

async function main() {
  const folders = fs.readdirSync(TRAINING_DIR).filter((f) => {
    try { return fs.statSync(path.join(TRAINING_DIR, f)).isDirectory() && !f.startsWith('.') && f !== 'scratch'; } catch { return false; }
  });

  const manifest: Entry[] = [];
  for (const folder of folders) {
    const projectDir = path.join(TRAINING_DIR, folder);
    const files = fs.readdirSync(projectDir);
    const xlsxAll = files.filter((f) => f.toLowerCase().endsWith('.xlsx') && !/eval_run_|backup|quote|sand|budget/i.test(f));

    let truthXlsx = '', mhSheets = 0, swSheets = 0, standard = false;
    for (const x of xlsxAll) {
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(path.join(projectDir, x));
        const names = wb.worksheets.map((w) => w.name);
        const hasMH = names.some((n) => /manhole|structure/i.test(n) && !/summary/i.test(n));
        const hasSW = names.some((n) => /sewer/i.test(n) && !/summary/i.test(n));
        if (hasMH && hasSW) {
          truthXlsx = x; standard = true;
          mhSheets = names.filter((n) => /manhole/i.test(n) && !/summary/i.test(n)).length;
          swSheets = names.filter((n) => /sewer/i.test(n) && !/summary/i.test(n)).length;
          break;
        }
        if (!truthXlsx) truthXlsx = x;
      } catch { /* ignore unreadable workbook */ }
    }

    const drawingRel = chooseDrawingPdfs(projectDir);
    let totalPages = 0;
    const drawingPdfs: Entry['drawingPdfs'] = [];
    for (const rel of drawingRel) {
      const p = path.join(projectDir, rel);
      try {
        const doc = await PDFDocument.load(fs.readFileSync(p), { ignoreEncryption: true });
        const pages = doc.getPageCount();
        const sz = doc.getPage(0).getSize();
        totalPages += pages;
        drawingPdfs.push({ name: rel, pages, dimIn: `${(sz.width / 72).toFixed(0)}x${(sz.height / 72).toFixed(0)}`, mb: +(fs.statSync(p).size / 1048576).toFixed(1) });
      } catch {
        drawingPdfs.push({ name: rel, error: true });
      }
    }

    let structures = 0, runs = 0, cbGroups = 0, watermain = 0;
    if (truthXlsx && standard) {
      try {
        const t = await readTruthFacts(path.join(projectDir, truthXlsx), folder);
        structures = t.structures.length;
        runs = t.sewers.filter((s) => !s.isLineItem).length;
        cbGroups = t.catchbasins.length;
        watermain = t.watermain.length;
      } catch { /* ignore */ }
    }

    const flags: string[] = [];
    if (!standard) flags.push('non-standard-layout');
    if (mhSheets > 1 || swSheets > 1) flags.push('multi-sheet');
    if (standard && runs === 0) flags.push('no-runs');
    if (standard && structures <= 1 && totalPages >= 6) flags.push('hand-scoped');
    if (drawingPdfs.length === 0 || drawingPdfs.every((d) => d.error)) flags.push('no-drawing-pdf');
    if (totalPages > 30) flags.push('oversize-pdf');
    if (watermain > 0) flags.push('has-watermain');

    const usable = standard && runs > 0 && drawingPdfs.length > 0 && !flags.includes('no-drawing-pdf') && !flags.includes('hand-scoped');
    manifest.push({ folder, truthXlsx, standard, mhSheets, swSheets, drawingPdfs, totalPages, truth: { structures, runs, cbGroups, watermain }, flags, usable });
  }

  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2));
  const usable = manifest.filter((m) => m.usable);
  console.log(`${manifest.length} projects; ${manifest.filter((m) => m.standard).length} standard-template; ${usable.length} usable for extraction eval.`);
  console.log(`Wrote ${OUT}`);
  console.log('\nUSABLE projects (folder | pages | struct/runs/cb | flags):');
  for (const m of usable) {
    console.log('  ' + m.folder.slice(0, 44).padEnd(46) + String(m.totalPages).padStart(3) + 'pp  ' + `${m.truth.structures}/${m.truth.runs}/${m.truth.cbGroups}`.padEnd(11) + m.flags.filter((f) => f !== 'has-watermain').join(','));
  }
  console.log('\nEXCLUDED:');
  for (const m of manifest.filter((m) => !m.usable)) {
    console.log('  ' + m.folder.slice(0, 46).padEnd(48) + m.flags.join(','));
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
