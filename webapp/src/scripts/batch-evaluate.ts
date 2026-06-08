/**
 * batch-evaluate.ts
 *
 * Runs extraction on training projects and compares against ground truth.
 * Outputs a scoreboard CSV and per-project diffs.
 *
 * Usage:
 *   npx tsx src/scripts/batch-evaluate.ts [--limit N] [--project "folder-name"]
 *
 * Options:
 *   --limit N           Only process first N projects
 *   --project "name"    Only process a specific project folder
 *   --skip-existing     Skip projects that already have generated spreadsheets
 */

import fs from 'fs';
import path from 'path';
import { extractFromPDF } from '../lib/extraction';
import { populateTemplate } from '../lib/spreadsheet';
import { DEFAULT_PARAMS } from '../lib/constants';
import { compareSpreadsheets, CompareResult } from './compare-sheets';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');

export const GOLDEN_PROJECTS = [
  "2026-067 201 GEORGIAN DR,BARRIE",
  "2026-068 HOLIDAY INN,TRENTON",
  "2026-021 MATTHEWS HANGER WATERLOO",
  "2026-001 ECOLE SECONDAIRE CATHOLIQUE-BRAMPTON",
  "2026-002 BRADFORD WEST GWILLIMBURY CIVIC CENTRE",
  "2026-015 UXBRIDGE POOL SPRUNG",
  "2026-041 TFS PERFORMING ARTS CENTRE",
  "2026-050 PANATTONI-6500 MISSISSAUGA ROAD",
  "2026-060 PROPOSED COMMERCIAL DEVELOPMENT",
  "2026-069 RIOCAN GEORGIAN MALL"
];

export interface ProjectInfo {
  folder: string;
  pdfFiles: string[];  // All drawing PDFs (will be merged)
  truthFile?: string;  // Ground truth XLSX (optional)
}

export function findProjects(): ProjectInfo[] {
  const folders = fs.readdirSync(TRAINING_DIR).filter(f => {
    try {
      return fs.statSync(path.join(TRAINING_DIR, f)).isDirectory() && !f.startsWith('.');
    } catch {
      return false;
    }
  });

  const projects: ProjectInfo[] = [];

  // Manual overrides: specify a single PDF when the project has a known best drawing file
  const manualOverrides: Record<string, string[]> = {
    "2026-059 LAY BY INSTALLATION": ["Issued for Tender Drawings_13.pdf"],
    "2026-061 SUNUP REALTY-57 ANDERSON BLVD": ["April 22'26 2026-061 Sunup Realty - 57 Anderson Blvd (Industrial Development) Package.pdf"],
    "2026-068 HOLIDAY INN,TRENTON": ["05-Civil Drawings & Specs.pdf"],
    "2026-069 RIOCAN GEORGIAN MALL": ["1. Bid Invitation - Drawings/RioCan, Georgian Mall, Redemise, Barrie, ON/(8) Civil/509 Bayfield Street_2026-04-07.pdf"],
    "2026-060 PROPOSED COMMERCIAL DEVELOPMENT": ["3. 24133 - SS-1.pdf"],
  };

  const blocklist = [
    "quote", "quotation", "schedule", "bid", "geotechnical", "geotech", "appendix 4",
    "report", "proposal", "estimate", "pricing", "breakdown", "budget", "letter",
    "backup", "specifications", "specs", "rpt", "contracting", "invoice", "addendum",
    "tender_form", "tender form", "tipp", "landscape", "cover sheet", "appendix"
  ];

  for (const folder of folders) {
    const dir = path.join(TRAINING_DIR, folder);
    const files = fs.readdirSync(dir);

    // Find the ground truth XLSX
    const xlsxFiles = files.filter(f =>
      f.toLowerCase().endsWith('.xlsx') &&
      !f.toLowerCase().includes('quote') &&
      !f.toLowerCase().includes('budget') &&
      !f.toLowerCase().includes('backup') &&
      !f.toLowerCase().includes('sand') &&
      !f.toLowerCase().includes('appendix') &&
      !f.toLowerCase().includes('estimate') &&
      !f.toLowerCase().includes('additional') &&
      !f.toLowerCase().includes('eval_run')
    );

    // Check manual override first
    if (manualOverrides[folder]) {
      projects.push({
        folder,
        pdfFiles: manualOverrides[folder],
        truthFile: xlsxFiles[0] || undefined,
      });
      continue;
    }

    // Find ALL drawing PDFs (not quotes/schedules/bids)
    const pdfFiles = files.filter(f => {
      const name = f.toLowerCase();
      return name.endsWith(".pdf") && !blocklist.some(b => name.includes(b));
    });

    if (pdfFiles.length > 0) {
      // Sort by relevance: civil/servicing/drainage first, then by size
      const scorePDF = (filename: string): number => {
        const name = filename.toLowerCase();
        let score = 0;
        if (name.includes('civil') || name.includes('servicing') || name.includes('drainage') || name.includes('plan') || name.includes('pnp') || name.includes('storm') || name.includes('sewer') || name.includes('water')) {
          score += 1000;
        }
        if (name.includes('structural') || name.includes('detail') || name.includes('spec') || name.includes('det-') || name.includes('notes')) {
          score -= 500;
        }
        return score;
      };

      const sortedPdfs = pdfFiles.sort((a, b) => {
        const scoreA = scorePDF(a);
        const scoreB = scorePDF(b);
        if (scoreA !== scoreB) return scoreB - scoreA;
        const sizeA = fs.statSync(path.join(dir, a)).size;
        const sizeB = fs.statSync(path.join(dir, b)).size;
        return sizeB - sizeA;
      });

      projects.push({
        folder,
        pdfFiles: sortedPdfs,  // ALL drawing PDFs, sorted by relevance
        truthFile: xlsxFiles[0] || undefined,
      });
    }
  }

  return projects;
}

export async function processProject(project: ProjectInfo): Promise<CompareResult | null> {
  const projectDir = path.join(TRAINING_DIR, project.folder);
  const truthPath = project.truthFile ? path.join(projectDir, project.truthFile) : null;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📂 ${project.folder}`);
  console.log(`   Drawing PDFs (${project.pdfFiles.length}):`);
  project.pdfFiles.forEach((f, i) => {
    const size = fs.existsSync(path.join(projectDir, f)) 
      ? (fs.statSync(path.join(projectDir, f)).size / 1024 / 1024).toFixed(1) + ' MB'
      : 'NOT FOUND';
    console.log(`     ${i + 1}. ${f} (${size})`);
  });
  console.log(`   Truth: ${project.truthFile || 'None (Unsupervised Run)'}`);

  try {
    // Read ALL PDF buffers
    const pdfBuffers: Buffer[] = [];
    let totalSizeMB = 0;
    for (const pdfFile of project.pdfFiles) {
      const pdfPath = path.join(projectDir, pdfFile);
      if (!fs.existsSync(pdfPath)) {
        console.warn(`   ⚠️ PDF not found, skipping: ${pdfFile}`);
        continue;
      }
      const buf = fs.readFileSync(pdfPath);
      totalSizeMB += buf.length / 1024 / 1024;
      pdfBuffers.push(buf);
    }

    if (pdfBuffers.length === 0) {
      console.log(`   ❌ No valid PDFs found`);
      return null;
    }

    console.log(`   Total PDF size: ${totalSizeMB.toFixed(1)} MB (${pdfBuffers.length} files)`);

    // Skip very large combined PDFs (>80MB) to avoid timeout
    if (totalSizeMB > 80) {
      console.log(`   ⚠️ Skipping: Combined PDFs too large (${totalSizeMB.toFixed(1)} MB)`);
      return null;
    }

    // Extract data — extractFromPDF handles merging internally
    console.log(`   🤖 Extracting data via Gemini...`);
    const startTime = Date.now();
    const result = await extractFromPDF(pdfBuffers, project.folder);
    const extractTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✅ Extraction complete in ${extractTime}s`);
    console.log(`      MH: ${result.manholes.length} | SW: ${result.sewers.length} | WM: ${result.watermain.length} | CB groups: ${result.catchbasins?.groups?.length || 0}`);
    console.log(`      Confidence: ${result.confidence}`);
    if (result.warnings.length > 0) {
      console.log(`      ⚠️ Warnings: ${result.warnings.slice(0, 3).join('; ')}`);
    }

    // Generate spreadsheet
    console.log(`   📝 Generating spreadsheet...`);
    const genBuffer = await populateTemplate(result, DEFAULT_PARAMS as any);

    const genDir = path.join(projectDir, 'generated_spreadsheets');
    if (!fs.existsSync(genDir)) fs.mkdirSync(genDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const genFilename = `eval_${timestamp}.xlsx`;
    const genPath = path.join(genDir, genFilename);
    fs.writeFileSync(genPath, genBuffer);

    if (truthPath) {
      // Compare
      console.log(`   🔍 Comparing against ground truth...`);
      const compareResult = await compareSpreadsheets(truthPath, genPath, project.folder);

      // Print per-section accuracy
      for (const report of compareResult.reports) {
        if (report.totalCells > 0) {
          const acc = ((report.matchingCells / report.totalCells) * 100).toFixed(1);
          const diffCount = report.diffs.length;
          console.log(`      ${report.sectionLabel}: ${acc}% (${report.matchingCells}/${report.totalCells}) [${diffCount} diffs]`);
        }
      }
      console.log(`   📊 Overall: ${compareResult.overallAccuracy.toFixed(1)}%`);

      // Write metadata file
      const metadataFilename = `eval_${timestamp}_metadata.json`;
      const metadataPath = path.join(genDir, metadataFilename);
      fs.writeFileSync(metadataPath, JSON.stringify({
        confidence: result.confidence,
        warnings: result.warnings,
        extractTime,
        overallAccuracy: compareResult.overallAccuracy
      }, null, 2));

      return compareResult;
    } else {
      console.log(`   📊 Unsupervised Run: Generated spreadsheet successfully (no Ground Truth available).`);
      
      // Write metadata file
      const metadataFilename = `eval_${timestamp}_metadata.json`;
      const metadataPath = path.join(genDir, metadataFilename);
      fs.writeFileSync(metadataPath, JSON.stringify({
        confidence: result.confidence,
        warnings: result.warnings,
        extractTime,
        overallAccuracy: null
      }, null, 2));

      return null;
    }
  } catch (e: any) {
    console.error(`   ❌ Error: ${e.message?.slice(0, 200)}`);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Parse CLI args
  let limit = Infinity;
  let targetProject: string | null = null;
  let skipExisting = false;
  let useGolden = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--project' && args[i + 1]) {
      targetProject = args[i + 1];
      i++;
    } else if (args[i] === '--skip-existing') {
      skipExisting = true;
    } else if (args[i] === '--golden') {
      useGolden = true;
    }
  }

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          AutoInfra Batch Evaluation Pipeline                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  let projects = findProjects();
  console.log(`Found ${projects.length} projects with PDF + XLSX ground truth\n`);

  if (targetProject) {
    projects = projects.filter(p => p.folder.includes(targetProject!));
    if (projects.length === 0) {
      console.error(`❌ No project matching "${targetProject}" found`);
      process.exit(1);
    }
  } else if (useGolden) {
    projects = projects.filter(p => GOLDEN_PROJECTS.includes(p.folder));
    console.log(`Using Golden Suite: ${projects.length} projects`);
  }

  if (skipExisting) {
    projects = projects.filter(p => {
      const genDir = path.join(TRAINING_DIR, p.folder, 'generated_spreadsheets');
      return !fs.existsSync(genDir) || fs.readdirSync(genDir).filter(f => f.startsWith('eval_')).length === 0;
    });
    console.log(`After filtering existing: ${projects.length} projects to process\n`);
  }

  projects = projects.slice(0, limit);

  const results: CompareResult[] = [];
  let processed = 0;
  let failed = 0;

  for (const project of projects) {
    const result = await processProject(project);
    if (result) {
      results.push(result);
      processed++;
    } else {
      failed++;
    }

    // Rate limiting — Gemini has per-minute quotas
    if (projects.indexOf(project) < projects.length - 1) {
      console.log(`   ⏳ Waiting 5s before next project...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // ======================== SCOREBOARD ========================
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log('📊 BATCH EVALUATION SCOREBOARD');
  console.log(`${'═'.repeat(80)}\n`);

  // Sort by accuracy
  results.sort((a, b) => b.overallAccuracy - a.overallAccuracy);

  // Header
  const header = [
    'Project'.padEnd(50),
    'MH Str'.padStart(8),
    'MH CB'.padStart(8),
    'Sewers'.padStart(8),
    'WM'.padStart(8),
    'Overall'.padStart(8),
    'Cells'.padStart(6),
  ].join(' │ ');
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const r of results) {
    const sectionAccs = r.reports.map(rep =>
      rep.totalCells > 0 ? `${((rep.matchingCells / rep.totalCells) * 100).toFixed(0)}%` : 'N/A'
    );

    const row = [
      r.projectName.slice(0, 50).padEnd(50),
      sectionAccs[0]?.padStart(8) || 'N/A'.padStart(8),
      sectionAccs[1]?.padStart(8) || 'N/A'.padStart(8),
      sectionAccs[2]?.padStart(8) || 'N/A'.padStart(8),
      sectionAccs[3]?.padStart(8) || 'N/A'.padStart(8),
      `${r.overallAccuracy.toFixed(1)}%`.padStart(8),
      String(r.totalCells).padStart(6),
    ].join(' │ ');
    console.log(row);
  }

  console.log('─'.repeat(header.length));

  // Summary
  const avgAccuracy = results.length > 0
    ? results.reduce((s, r) => s + r.overallAccuracy, 0) / results.length
    : 0;
  const medianAccuracy = results.length > 0
    ? results[Math.floor(results.length / 2)].overallAccuracy
    : 0;

  console.log(`\n📈 Summary:`);
  console.log(`   Processed: ${processed} | Failed: ${failed} | Total: ${projects.length}`);
  console.log(`   Mean Accuracy:   ${avgAccuracy.toFixed(1)}%`);
  console.log(`   Median Accuracy: ${medianAccuracy.toFixed(1)}%`);
  console.log(`   Best:  ${results[0]?.projectName || 'N/A'} (${results[0]?.overallAccuracy.toFixed(1) || 0}%)`);
  console.log(`   Worst: ${results[results.length - 1]?.projectName || 'N/A'} (${results[results.length - 1]?.overallAccuracy.toFixed(1) || 0}%)`);

  // Save scoreboard as CSV
  const csvPath = path.join(process.cwd(), `evaluation_scoreboard_${new Date().toISOString().slice(0, 10)}.csv`);
  const csvRows = [
    'Project,MH_Structures,MH_Catchbasins,Sewers,Watermain,Overall,TotalCells,MatchingCells',
    ...results.map(r => {
      const accs = r.reports.map(rep =>
        rep.totalCells > 0 ? ((rep.matchingCells / rep.totalCells) * 100).toFixed(1) : 'N/A'
      );
      return `"${r.projectName}",${accs.join(',')},${r.overallAccuracy.toFixed(1)},${r.totalCells},${r.totalMatching}`;
    }),
  ];
  fs.writeFileSync(csvPath, csvRows.join('\n'));
  console.log(`\n📄 Scoreboard saved to: ${csvPath}`);
}

main().catch(console.error);
