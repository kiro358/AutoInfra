import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { extractFromPDF } from '../lib/extraction';
import { populateTemplate } from '../lib/spreadsheet';
import { DEFAULT_PARAMS } from '../lib/constants';
import { compareSpreadsheets, CompareResult } from './compare-sheets';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'autoinfra-ai-eval-data';

interface ProjectInfo {
  folder: string;
  pdfFiles: string[];
  truthFile: string;
}

async function findProjectsCloud(): Promise<ProjectInfo[]> {
  const [files] = await storage.bucket(BUCKET_NAME).getFiles();
  const fileNames = files.map(f => f.name);
  
  const folders = new Set<string>();
  fileNames.forEach(name => {
    const parts = name.split('/');
    if (parts.length > 1 && parts[0]) {
      folders.add(parts[0]);
    }
  });

  const projects: ProjectInfo[] = [];

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
    const folderFiles = fileNames.filter(f => f.startsWith(`${folder}/`));
    const basenameFiles = folderFiles.map(f => path.basename(f));

    const xlsxFiles = basenameFiles.filter(f =>
      f.toLowerCase().endsWith('.xlsx') &&
      !f.toLowerCase().includes('quote') &&
      !f.toLowerCase().includes('budget') &&
      !f.toLowerCase().includes('backup') &&
      !f.toLowerCase().includes('sand') &&
      !f.toLowerCase().includes('appendix') &&
      !f.toLowerCase().includes('estimate') &&
      !f.toLowerCase().includes('additional') &&
      !f.toLowerCase().includes('eval_')
    );

    if (xlsxFiles.length === 0) continue;

    if (manualOverrides[folder]) {
      projects.push({
        folder,
        pdfFiles: manualOverrides[folder],
        truthFile: xlsxFiles[0],
      });
      continue;
    }

    const pdfFiles = basenameFiles.filter(f =>
      f.toLowerCase().endsWith(".pdf") &&
      !blocklist.some(b => f.toLowerCase().includes(b))
    );

    if (pdfFiles.length > 0) {
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
        
        // Find size in GCS files
        const fileAObj = files.find(f => f.name === `${folder}/${a}`);
        const fileBObj = files.find(f => f.name === `${folder}/${b}`);
        const sizeA = parseInt(fileAObj?.metadata.size?.toString() || '0', 10);
        const sizeB = parseInt(fileBObj?.metadata.size?.toString() || '0', 10);
        return sizeB - sizeA;
      });

      projects.push({
        folder,
        pdfFiles: sortedPdfs,
        truthFile: xlsxFiles[0],
      });
    }
  }

  return projects;
}

async function processProjectCloud(project: ProjectInfo): Promise<CompareResult | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoinfra-eval-'));
  
  try {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📂 ${project.folder}`);
    console.log(`   PDFs (${project.pdfFiles.length}):`);
    project.pdfFiles.forEach((f, i) => console.log(`     ${i + 1}. ${f}`));
    console.log(`   Truth: ${project.truthFile}`);

    // Download Truth
    const truthDest = path.join(tmpDir, project.truthFile);
    await storage.bucket(BUCKET_NAME).file(`${project.folder}/${project.truthFile}`).download({ destination: truthDest });

    const pdfBuffers: Buffer[] = [];
    let totalSizeMB = 0;
    for (const pdfFile of project.pdfFiles) {
      // Find GCS file path. Note that pdfFile might contain folder prefix or be a basename
      // If it starts with folder name, use it. Otherwise prefix with folder.
      let gcsPath = pdfFile;
      if (!gcsPath.startsWith(`${project.folder}/`)) {
        gcsPath = `${project.folder}/${pdfFile}`;
      }
      
      const destFilename = path.basename(pdfFile);
      const pdfDest = path.join(tmpDir, destFilename);
      
      await storage.bucket(BUCKET_NAME).file(gcsPath).download({ destination: pdfDest });
      const buf = fs.readFileSync(pdfDest);
      totalSizeMB += buf.length / 1024 / 1024;
      pdfBuffers.push(buf);
    }

    console.log(`   Total PDF size: ${totalSizeMB.toFixed(1)} MB (${pdfBuffers.length} files)`);

    if (totalSizeMB > 80) {
      console.log(`   ⚠️ Skipping: Combined PDFs too large (${totalSizeMB.toFixed(1)} MB)`);
      return null;
    }

    console.log(`   🤖 Extracting data via Gemini...`);
    const startTime = Date.now();
    const result = await extractFromPDF(pdfBuffers, project.folder);
    const extractTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   ✅ Extraction complete in ${extractTime}s`);
    console.log(`      Confidence: ${result.confidence}`);
    if (result.warnings.length > 0) {
      console.log(`      ⚠️ Warnings: ${result.warnings.slice(0, 3).join('; ')}`);
    }

    console.log(`   📝 Generating spreadsheet...`);
    const genBuffer = await populateTemplate(result, DEFAULT_PARAMS as any);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const genFilename = `eval_${timestamp}.xlsx`;
    const genPath = path.join(tmpDir, genFilename);
    fs.writeFileSync(genPath, genBuffer);

    // Upload generated to GCS
    const gcsGenPath = `${project.folder}/generated_spreadsheets/${genFilename}`;
    await storage.bucket(BUCKET_NAME).upload(genPath, { destination: gcsGenPath });
    console.log(`   ☁️ Uploaded generated sheet to GCS: ${gcsGenPath}`);

    console.log(`   🔍 Comparing against ground truth...`);
    const compareResult = await compareSpreadsheets(truthDest, genPath, project.folder);

    for (const report of compareResult.reports) {
      if (report.totalCells > 0) {
        const acc = ((report.matchingCells / report.totalCells) * 100).toFixed(1);
        console.log(`      ${report.sectionLabel}: ${acc}% (${report.matchingCells}/${report.totalCells})`);
      }
    }
    console.log(`   📊 Overall: ${compareResult.overallAccuracy.toFixed(1)}%`);

    return compareResult;
  } catch (e: any) {
    console.error(`   ❌ Error: ${e.message?.slice(0, 200)}`);
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  // If running in Cloud Run Jobs, we can get CLOUD_RUN_TASK_INDEX
  const taskIndex = process.env.CLOUD_RUN_TASK_INDEX ? parseInt(process.env.CLOUD_RUN_TASK_INDEX) : null;
  const taskCount = process.env.CLOUD_RUN_TASK_COUNT ? parseInt(process.env.CLOUD_RUN_TASK_COUNT) : 1;

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          AutoInfra CLOUD Evaluation Pipeline                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  let projects = await findProjectsCloud();
  console.log(`Found ${projects.length} projects with PDF + XLSX in GCS\n`);

  if (taskIndex !== null) {
    // Process only a slice for this task
    projects = projects.filter((_, i) => i % taskCount === taskIndex);
    console.log(`Task ${taskIndex}/${taskCount} processing ${projects.length} projects`);
  }

  const results: CompareResult[] = [];
  let processed = 0;
  let failed = 0;

  for (const project of projects) {
    const result = await processProjectCloud(project);
    if (result) {
      results.push(result);
      processed++;
    } else {
      failed++;
    }

    if (projects.indexOf(project) < projects.length - 1 && taskIndex === null) {
      console.log(`   ⏳ Waiting 5s before next project...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Upload scoreboard to GCS
  if (results.length > 0) {
    const suffix = taskIndex !== null ? `_task${taskIndex}` : '';
    const csvFilename = `evaluation_scoreboard_${new Date().toISOString().slice(0, 10)}${suffix}.csv`;
    const csvPath = path.join(os.tmpdir(), csvFilename);
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
    await storage.bucket(BUCKET_NAME).upload(csvPath, { destination: `scoreboards/${csvFilename}` });
    console.log(`\n📄 Scoreboard uploaded to GCS: scoreboards/${csvFilename}`);
  }
}

main().catch(console.error);
