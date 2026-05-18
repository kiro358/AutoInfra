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
  pdfFile: string;
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

  for (const folder of folders) {
    const folderFiles = fileNames.filter(f => f.startsWith(`${folder}/`));
    const basenameFiles = folderFiles.map(f => path.basename(f));

    const pdfFiles = basenameFiles.filter(f =>
      f.toLowerCase().endsWith(".pdf") &&
      !f.toLowerCase().includes("quote") &&
      !f.toLowerCase().includes("quotation") &&
      !f.toLowerCase().includes("schedule") &&
      !f.toLowerCase().includes("bid") &&
      !f.toLowerCase().includes("geotechnical") &&
      !f.toLowerCase().includes("appendix 4") &&
      !f.toLowerCase().includes("report")
    );

    const xlsxFiles = basenameFiles.filter(f =>
      f.toLowerCase().endsWith('.xlsx') &&
      !f.toLowerCase().includes('quote') &&
      !f.toLowerCase().includes('budget') &&
      !f.toLowerCase().includes('backup') &&
      !f.toLowerCase().includes('sand') &&
      !f.toLowerCase().includes('appendix') &&
      !f.toLowerCase().includes('estimate') &&
      !f.toLowerCase().includes('additional') &&
      !f.includes('eval_') // Exclude previously generated sheets
    );

    if (pdfFiles.length > 0 && xlsxFiles.length > 0) {
      // Find the largest PDF
      let largestPdf = pdfFiles[0];
      let maxSize = 0;
      for (const pdf of pdfFiles) {
        const fileObj = files.find(f => f.name === `${folder}/${pdf}`);
        const size = parseInt(fileObj?.metadata.size?.toString() || '0', 10);
        if (size > maxSize) {
          maxSize = size;
          largestPdf = pdf;
        }
      }

      projects.push({
        folder,
        pdfFile: largestPdf,
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
    console.log(`   PDF: ${project.pdfFile}`);
    console.log(`   Truth: ${project.truthFile}`);

    // Download PDF
    const pdfDest = path.join(tmpDir, project.pdfFile);
    await storage.bucket(BUCKET_NAME).file(`${project.folder}/${project.pdfFile}`).download({ destination: pdfDest });
    
    // Download Truth
    const truthDest = path.join(tmpDir, project.truthFile);
    await storage.bucket(BUCKET_NAME).file(`${project.folder}/${project.truthFile}`).download({ destination: truthDest });

    const pdfBuffer = fs.readFileSync(pdfDest);
    const pdfSizeMB = (pdfBuffer.length / 1024 / 1024).toFixed(1);
    console.log(`   PDF size: ${pdfSizeMB} MB`);

    if (pdfBuffer.length > 50 * 1024 * 1024) {
      console.log(`   ⚠️ Skipping: PDF too large (${pdfSizeMB} MB)`);
      return null;
    }

    console.log(`   🤖 Extracting data via Gemini...`);
    const startTime = Date.now();
    const result = await extractFromPDF(pdfBuffer, project.folder);
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
    // Note: compareSpreadsheets needs the actual files on disk
    // But since the template might be needed, we must ensure it can find it.
    // However, compareSpreadsheets itself looks for templates? No, it compares 2 files.
    // wait, compareSpreadsheets takes truthPath and genPath.
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
