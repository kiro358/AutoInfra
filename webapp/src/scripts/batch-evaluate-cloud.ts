import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { extractFromPDF } from '../lib/extraction';
import { populateTemplate } from '../lib/spreadsheet';
import { DEFAULT_PARAMS } from '../lib/constants';
import { compareSpreadsheets, CompareResult, formatCompareResult } from './compare-sheets';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'autoinfra-ai-eval-data';

export interface ProjectFile {
  name: string;
  basename: string;
  sizeBytes: number;
}

export interface ProjectInfo {
  folder: string;
  pdfFiles: ProjectFile[];
  truthFile?: string;
}

// Simple concurrency helper
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<any>[] = [];
  
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p as any);
    
    if (limit < items.length) {
      const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  
  return Promise.all(results);
}

export async function findProjectsCloud(): Promise<ProjectInfo[]> {
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
    
    // Find the ground truth XLSX (using full relative path in the bucket)
    const xlsxFiles = folderFiles.filter(f => {
      // Ensure the file is directly under the project folder (ignore subfolders)
      const relativePath = f.slice(folder.length + 1);
      if (relativePath.includes('/')) return false;

      const name = path.basename(f).toLowerCase();
      return name.endsWith('.xlsx') &&
        !name.includes('quote') &&
        !name.includes('budget') &&
        !name.includes('backup') &&
        !name.includes('sand') &&
        !name.includes('appendix') &&
        !name.includes('estimate') &&
        !name.includes('additional') &&
        !name.includes('eval_')
    });

    const truthFile = xlsxFiles.length > 0 ? xlsxFiles[0] : undefined;

    // Check manual override
    if (manualOverrides[folder]) {
      const projectFiles: ProjectFile[] = [];
      for (const overridePdf of manualOverrides[folder]) {
        // Resolve manual overrides (could be a basename or full path)
        const matchedFile = folderFiles.find(f => 
          f === overridePdf || f === `${folder}/${overridePdf}` || f.endsWith(`/${overridePdf}`)
        );
        if (matchedFile) {
          const fileObj = files.find(f => f.name === matchedFile);
          const sizeBytes = parseInt(fileObj?.metadata.size?.toString() || '0', 10);
          projectFiles.push({
            name: matchedFile,
            basename: path.basename(matchedFile),
            sizeBytes,
          });
        }
      }
      if (projectFiles.length > 0) {
        projects.push({
          folder,
          pdfFiles: projectFiles,
          truthFile, // Keep full GCS path for truthFile
        });
      }
      continue;
    }

    // Filter drawing PDFs preserving full relative paths
    const pdfPaths = folderFiles.filter(f => {
      const name = path.basename(f).toLowerCase();
      return name.endsWith(".pdf") && !blocklist.some(b => name.includes(b));
    });

    if (pdfPaths.length > 0) {
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

      const sortedPdfPaths = pdfPaths.sort((a, b) => {
        const scoreA = scorePDF(a);
        const scoreB = scorePDF(b);
        if (scoreA !== scoreB) return scoreB - scoreA;
        
        const fileAObj = files.find(f => f.name === a);
        const fileBObj = files.find(f => f.name === b);
        const sizeA = parseInt(fileAObj?.metadata.size?.toString() || '0', 10);
        const sizeB = parseInt(fileBObj?.metadata.size?.toString() || '0', 10);
        return sizeB - sizeA;
      });

      const projectFiles: ProjectFile[] = sortedPdfPaths.map(pdfPath => {
        const fileObj = files.find(f => f.name === pdfPath);
        const sizeBytes = parseInt(fileObj?.metadata.size?.toString() || '0', 10);
        return {
          name: pdfPath,
          basename: path.basename(pdfPath),
          sizeBytes,
        };
      });

      projects.push({
        folder,
        pdfFiles: projectFiles,
        truthFile,
      });
    }
  }

  return projects;
}

export async function processProjectCloud(project: ProjectInfo): Promise<CompareResult | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoinfra-eval-'));
  
  try {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`📂 ${project.folder}`);
    console.log(`   PDFs (${project.pdfFiles.length}):`);
    project.pdfFiles.forEach((f, i) => console.log(`     ${i + 1}. ${f.basename} (${(f.sizeBytes / 1024 / 1024).toFixed(1)} MB)`));
    console.log(`   Truth: ${project.truthFile ? path.basename(project.truthFile) : 'None (Unsupervised Run)'}`);

    const downloadPromises: Promise<any>[] = [];

    // Download Truth if exists
    let truthDest: string | null = null;
    if (project.truthFile) {
      truthDest = path.join(tmpDir, path.basename(project.truthFile));
      downloadPromises.push(
        storage.bucket(BUCKET_NAME).file(project.truthFile).download({ destination: truthDest })
      );
    }

    const filesToDownload: typeof project.pdfFiles = [];
    let totalSizeMB = 0;
    for (const fileInfo of project.pdfFiles) {
      const sizeMB = fileInfo.sizeBytes / 1024 / 1024;
      
      // Cap at 48MB to stay strictly under Gemini's 50MB PDF upload size limit
      if (totalSizeMB + sizeMB > 48) {
        console.log(`   ⚠️ Capping PDF merge: skipping ${fileInfo.basename} (${sizeMB.toFixed(1)} MB) to stay under 48MB limit.`);
        continue;
      }
      
      totalSizeMB += sizeMB;
      filesToDownload.push(fileInfo);
    }

    const pdfBuffers: Buffer[] = new Array(filesToDownload.length);
    filesToDownload.forEach((fileInfo, index) => {
      const pdfDest = path.join(tmpDir, fileInfo.basename);
      downloadPromises.push(
        storage.bucket(BUCKET_NAME).file(fileInfo.name).download({ destination: pdfDest }).then(() => {
          pdfBuffers[index] = fs.readFileSync(pdfDest);
        })
      );
    });

    await Promise.all(downloadPromises);

    console.log(`   Total PDF size merged: ${totalSizeMB.toFixed(1)} MB (${pdfBuffers.length} files)`);
    if (pdfBuffers.length === 0) {
      console.log(`   ❌ No valid PDFs found under size limits.`);
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

    if (truthDest) {
      console.log(`   🔍 Comparing against ground truth...`);
      const compareResult = await compareSpreadsheets(truthDest, genPath, project.folder);

      for (const report of compareResult.reports) {
        if (report.totalCells > 0) {
          const acc = ((report.matchingCells / report.totalCells) * 100).toFixed(1);
          console.log(`      ${report.sectionLabel}: ${acc}% (${report.matchingCells}/${report.totalCells})`);
          
          // Print the first 15 mismatches to stdout
          if (report.diffs.length > 0) {
            console.log(`         ❌ ${report.diffs.length} mismatches:`);
            for (const d of report.diffs.slice(0, 15)) {
              const errStr = d.pctError !== undefined ? ` (${d.pctError.toFixed(1)}% err)` : '';
              console.log(`            Row ${d.row} [${d.colName}]: truth="${d.truthValue}" vs gen="${d.genValue}"${errStr}`);
            }
            if (report.diffs.length > 15) {
              console.log(`            ... and ${report.diffs.length - 15} more`);
            }
          }
        }
      }
      console.log(`   📊 Overall: ${compareResult.overallAccuracy.toFixed(1)}%`);

      // Write text report of diffs and upload to GCS next to generated spreadsheet
      const diffReport = formatCompareResult(compareResult);
      const diffFilename = `eval_${timestamp}_diff.txt`;
      const diffPath = path.join(tmpDir, diffFilename);
      fs.writeFileSync(diffPath, diffReport);

      const gcsDiffPath = `${project.folder}/generated_spreadsheets/${diffFilename}`;
      await storage.bucket(BUCKET_NAME).upload(diffPath, { destination: gcsDiffPath });
      console.log(`   ☁️ Uploaded discrepancy report to GCS: ${gcsDiffPath}`);

      // Upload metadata to GCS
      const metadataFilename = `eval_${timestamp}_metadata.json`;
      const metadataPath = path.join(tmpDir, metadataFilename);
      fs.writeFileSync(metadataPath, JSON.stringify({
        confidence: result.confidence,
        warnings: result.warnings,
        extractTime,
        overallAccuracy: compareResult.overallAccuracy
      }, null, 2));

      const gcsMetadataPath = `${project.folder}/generated_spreadsheets/${metadataFilename}`;
      await storage.bucket(BUCKET_NAME).upload(metadataPath, { destination: gcsMetadataPath });
      console.log(`   ☁️ Uploaded metadata to GCS: ${gcsMetadataPath}`);

      return compareResult;
    } else {
      console.log(`   📊 Unsupervised Run: Generated spreadsheet successfully (no Ground Truth available).`);
      
      // Upload metadata to GCS
      const metadataFilename = `eval_${timestamp}_metadata.json`;
      const metadataPath = path.join(tmpDir, metadataFilename);
      fs.writeFileSync(metadataPath, JSON.stringify({
        confidence: result.confidence,
        warnings: result.warnings,
        extractTime,
        overallAccuracy: null
      }, null, 2));

      const gcsMetadataPath = `${project.folder}/generated_spreadsheets/${metadataFilename}`;
      await storage.bucket(BUCKET_NAME).upload(metadataPath, { destination: gcsMetadataPath });
      console.log(`   ☁️ Uploaded metadata to GCS: ${gcsMetadataPath}`);

      return { overallAccuracy: null, reports: [] } as any;
    }
  } catch (e: any) {
    console.error(`   ❌ Error: ${e.message?.slice(0, 200)}`);
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const taskIndex = process.env.CLOUD_RUN_TASK_INDEX ? parseInt(process.env.CLOUD_RUN_TASK_INDEX) : null;
  const taskCount = process.env.CLOUD_RUN_TASK_COUNT ? parseInt(process.env.CLOUD_RUN_TASK_COUNT) : 1;

  const args = process.argv.slice(2);
  let targetProject: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      targetProject = args[i + 1];
      i++;
    }
  }

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          AutoInfra CLOUD Evaluation Pipeline                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  let projects = await findProjectsCloud();
  console.log(`Found ${projects.length} projects in GCS\n`);

  if (targetProject) {
    projects = projects.filter(p => p.folder.toLowerCase().includes(targetProject!.toLowerCase()));
    console.log(`Targeting project folder: ${targetProject} (matched ${projects.length} project(s))`);
  }

  if (taskIndex !== null) {
    projects = projects.filter((_, i) => i % taskCount === taskIndex);
    console.log(`Task ${taskIndex}/${taskCount} processing ${projects.length} projects`);
  }

  const results: CompareResult[] = [];
  let processed = 0;
  let failed = 0;

  // Optimised runtime: process 8 projects in parallel in the cloud using Gemini 2.5 Flash
  const CONCURRENCY_LIMIT = 8;
  console.log(`🚀 Starting execution of ${projects.length} projects with concurrency = ${CONCURRENCY_LIMIT}...\n`);

  await runWithConcurrency(projects, CONCURRENCY_LIMIT, async (project) => {
    const result = await processProjectCloud(project);
    if (result) {
      results.push(result);
      processed++;
    } else {
      failed++;
    }
  });

  console.log(`\n🏁 Completed batch run: ${processed} succeeded, ${failed} failed.\n`);

  // Upload scoreboard to GCS
  const validResults = results.filter(r => r.overallAccuracy !== null && r.overallAccuracy !== undefined);
  if (validResults.length > 0) {
    const suffix = taskIndex !== null ? `_task${taskIndex}` : '';
    const csvFilename = `evaluation_scoreboard_${new Date().toISOString().slice(0, 10)}${suffix}.csv`;
    const csvPath = path.join(os.tmpdir(), csvFilename);
    const csvRows = [
      'Project,MH_Structures,MH_Catchbasins,Sewers,Watermain,Overall,TotalCells,MatchingCells',
      ...validResults.map(r => {
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

if (require.main === module) {
  main().catch(console.error);
}
