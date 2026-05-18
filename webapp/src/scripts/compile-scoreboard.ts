/**
 * compile-scoreboard.ts
 *
 * Scans all training projects, finds the latest generated evaluation spreadsheet (if any),
 * compares it against ground truth, and writes a consolidated scoreboard CSV.
 *
 * Usage:
 *   npx tsx src/scripts/compile-scoreboard.ts
 */

import fs from 'fs';
import path from 'path';
import { compareSpreadsheets, CompareResult } from './compare-sheets';

const TRAINING_DIR = path.resolve(__dirname, '../../..', 'existing_projects_training_data');

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

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║        AutoInfra Scoreboard Compilation Pipeline             ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const projects = findProjects();
  console.log(`Found ${projects.length} projects with PDF + XLSX ground truth\n`);

  const results: CompareResult[] = [];
  let skippedCount = 0;

  for (const project of projects) {
    const projectDir = path.join(TRAINING_DIR, project.folder);
    const genDir = path.join(projectDir, 'generated_spreadsheets');

    if (!fs.existsSync(genDir)) {
      skippedCount++;
      continue;
    }

    const genFiles = fs.readdirSync(genDir).filter(f => f.endsWith('.xlsx')).sort();
    if (genFiles.length === 0) {
      skippedCount++;
      continue;
    }

    // Latest file
    const latestGenFile = genFiles[genFiles.length - 1];
    const genPath = path.join(genDir, latestGenFile);
    const truthPath = path.join(projectDir, project.truthFile);

    console.log(`Analyzing project: ${project.folder}`);
    console.log(`  Truth: ${project.truthFile}`);
    console.log(`  Generated: ${latestGenFile}`);

    try {
      const compareResult = await compareSpreadsheets(truthPath, genPath, project.folder);
      results.push(compareResult);
      console.log(`  -> Accuracy: ${compareResult.overallAccuracy.toFixed(1)}%\n`);
    } catch (e: any) {
      console.error(`  -> Error: ${e.message}\n`);
    }
  }

  console.log(`\nProcessed: ${results.length} | No generated files found: ${skippedCount}`);

  if (results.length === 0) {
    console.log('No scores to report.');
    return;
  }

  // Sort by accuracy descending
  results.sort((a, b) => b.overallAccuracy - a.overallAccuracy);

  // Print scoreboard to console
  const header = [
    'Project'.padEnd(50),
    'MH Str'.padStart(8),
    'MH CB'.padStart(8),
    'Sewers'.padStart(8),
    'WM'.padStart(8),
    'Overall'.padStart(8),
    'Cells'.padStart(6),
  ].join(' │ ');
  console.log('\n📊 BATCH EVALUATION SCOREBOARD');
  console.log('═'.repeat(header.length));
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
  console.log('═'.repeat(header.length));

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
  console.log(`\n📄 Consolidated Scoreboard saved to: ${csvPath}`);
}

main().catch(console.error);
