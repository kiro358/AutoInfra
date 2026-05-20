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

const GOLDEN_PROJECTS = [
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

interface ProjectInfo {
  folder: string;
  pdfFile: string;
  truthFile: string;
}

function findProjects(): ProjectInfo[] {
  const folders = fs.readdirSync(TRAINING_DIR).filter(f => {
    try {
      return fs.statSync(path.join(TRAINING_DIR, f)).isDirectory() && !f.startsWith('.');
    } catch {
      return false;
    }
  });

  const projects: ProjectInfo[] = [];

  const manualOverrides: Record<string, string> = {
    "2026-059 LAY BY INSTALLATION": "Issued for Tender Drawings_13.pdf",
    "2026-061 SUNUP REALTY-57 ANDERSON BLVD": "April 22'26 2026-061 Sunup Realty - 57 Anderson Blvd (Industrial Development) Package.pdf",
    "2026-068 HOLIDAY INN,TRENTON": "05-Civil Drawings & Specs.pdf",
    "2026-069 RIOCAN GEORGIAN MALL": "1. Bid Invitation - Drawings/RioCan, Georgian Mall, Redemise, Barrie, ON/(8) Civil/509 Bayfield Street_2026-04-07.pdf",
    "2026-060 PROPOSED COMMERCIAL DEVELOPMENT": "3. 24133 - SS-1.pdf",
  };

  const blocklist = [
    "quote", "quotation", "schedule", "bid", "geotechnical", "geotech", "appendix 4",
    "report", "proposal", "estimate", "pricing", "breakdown", "budget", "letter",
    "backup", "specifications", "specs", "rpt", "contracting", "invoice", "addendum",
    "tender_form"
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
      !f.toLowerCase().includes('additional')
    );

    if (xlsxFiles.length === 0) continue;

    // Check manual override first
    if (manualOverrides[folder]) {
      projects.push({
        folder,
        pdfFile: manualOverrides[folder],
        truthFile: xlsxFiles[0],
      });
      continue;
    }

    // Find the best PDF (service drawings, not quotes/schedules/bids)
    const pdfFiles = files.filter(f => {
      const name = f.toLowerCase();
      return name.endsWith(".pdf") && !blocklist.some(b => name.includes(b));
    });

    if (pdfFiles.length > 0) {
      const pdfSizes = pdfFiles.map(f => ({
        name: f,
        size: fs.statSync(path.join(dir, f)).size,
      }));

      // Prefer civil/servicing/drainage/plan over structural/detail/spec
      const scorePDF = (filename: string): number => {
        const name = filename.toLowerCase();
        let score = 0;
        if (name.includes('civil') || name.includes('servicing') || name.includes('drainage') || name.includes('plan')) {
          score += 1000;
        }
        if (name.includes('structural') || name.includes('detail') || name.includes('spec') || name.includes('det-')) {
          score -= 500;
        }
        return score;
      };

      pdfSizes.sort((a, b) => {
        const scoreA = scorePDF(a.name);
        const scoreB = scorePDF(b.name);
        if (scoreA !== scoreB) {
          return scoreB - scoreA;
        }
        return b.size - a.size;
      });

      projects.push({
        folder,
        pdfFile: pdfSizes[0].name,
        truthFile: xlsxFiles[0],
      });
    }
  }

  return projects;
}

async function processProject(project: ProjectInfo): Promise<CompareResult | null> {
  const projectDir = path.join(TRAINING_DIR, project.folder);
  const pdfPath = path.join(projectDir, project.pdfFile);
  const truthPath = path.join(projectDir, project.truthFile);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`📂 ${project.folder}`);
  console.log(`   PDF: ${project.pdfFile}`);
  console.log(`   Truth: ${project.truthFile}`);

  try {
    // Read PDF
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfSizeMB = (pdfBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`   PDF size: ${pdfSizeMB} MB`);

    // Skip very large PDFs (>50MB) to avoid timeout
    if (pdfBuffer.length > 50 * 1024 * 1024) {
      console.log(`   ⚠️ Skipping: PDF too large (${pdfSizeMB} MB)`);
      return null;
    }

    // Extract data
    console.log(`   🤖 Extracting data via Gemini...`);
    const startTime = Date.now();
    const result = await extractFromPDF(pdfBuffer, project.folder);
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

    return compareResult;
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
