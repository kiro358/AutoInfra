import { Storage } from '@google-cloud/storage';
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

const BUCKET_NAME = process.env.GCS_BUCKET || 'autoinfra-ai-eval-data';

interface ScoreboardRow {
  project: string;
  mhStructures: string;
  mhCatchbasins: string;
  sewers: string;
  watermain: string;
  overall: number;
  totalCells: number;
  matchingCells: number;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(content: string): ScoreboardRow[] {
  const lines = content.split(/\r?\n/);
  const rows: ScoreboardRow[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const parts = parseCSVLine(line);
    if (parts.length < 8) continue;
    
    rows.push({
      project: parts[0],
      mhStructures: parts[1],
      mhCatchbasins: parts[2],
      sewers: parts[3],
      watermain: parts[4],
      overall: parseFloat(parts[5]) || 0,
      totalCells: parseInt(parts[6], 10) || 0,
      matchingCells: parseInt(parts[7], 10) || 0,
    });
  }
  return rows;
}

async function getScoreboardFromGCS(): Promise<ScoreboardRow[]> {
  const storage = new Storage();
  const bucket = storage.bucket(BUCKET_NAME);
  
  // List all files with prefix 'scoreboards/'
  const [files] = await bucket.getFiles({ prefix: 'scoreboards/' });
  
  // Filter for evaluation_scoreboard_*.csv
  const csvFiles = files.filter(f => f.name.endsWith('.csv') && f.name.includes('evaluation_scoreboard_'));
  
  if (csvFiles.length === 0) {
    throw new Error('No scoreboard files found in GCS');
  }

  // Find the latest date
  // e.g. evaluation_scoreboard_2026-05-17_task0.csv -> date is 2026-05-17
  const dates = csvFiles.map(f => {
    const match = f.name.match(/evaluation_scoreboard_(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
  }).filter(Boolean);

  if (dates.length === 0) {
    throw new Error('Could not extract dates from GCS scoreboard filenames');
  }

  // Sort dates descending to get the latest run
  const latestDate = [...new Set(dates)].sort().reverse()[0];
  console.log(`Latest evaluation run date in GCS: ${latestDate}`);

  // Get all files matching this latest date
  const latestFiles = csvFiles.filter(f => f.name.includes(latestDate));
  
  let allRows: ScoreboardRow[] = [];
  
  for (const file of latestFiles) {
    const [contentBuffer] = await file.download();
    const content = contentBuffer.toString('utf-8');
    const rows = parseCSV(content);
    allRows.push(...rows);
  }
  
  return allRows;
}

function getScoreboardFromLocal(): ScoreboardRow[] {
  // Try to find scoreboards in webapp/scoreboards/ or root directory
  const scoreboardsDir = path.join(process.cwd(), 'scoreboards');
  let allRows: ScoreboardRow[] = [];
  
  if (fs.existsSync(scoreboardsDir)) {
    const files = fs.readdirSync(scoreboardsDir);
    const csvFiles = files.filter(f => f.endsWith('.csv') && f.includes('evaluation_scoreboard_'));
    
    if (csvFiles.length > 0) {
      const dates = csvFiles.map(f => {
        const match = f.match(/evaluation_scoreboard_(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : '';
      }).filter(Boolean);
      
      if (dates.length > 0) {
        const latestDate = [...new Set(dates)].sort().reverse()[0];
        const latestFiles = csvFiles.filter(f => f.includes(latestDate));
        
        for (const file of latestFiles) {
          const content = fs.readFileSync(path.join(scoreboardsDir, file), 'utf-8');
          allRows.push(...parseCSV(content));
        }
        
        if (allRows.length > 0) {
          return allRows;
        }
      }
    }
    
    // Fall back to combined.csv if available
    const combinedPath = path.join(scoreboardsDir, 'combined.csv');
    if (fs.existsSync(combinedPath)) {
      const content = fs.readFileSync(combinedPath, 'utf-8');
      return parseCSV(content);
    }
  }
  
  // Try root of workspace as well
  const rootDir = path.resolve(process.cwd(), '..');
  if (fs.existsSync(rootDir)) {
    const rootFiles = fs.readdirSync(rootDir);
    const rootCsvFiles = rootFiles.filter(f => f.endsWith('.csv') && f.includes('evaluation_scoreboard_'));
    
    if (rootCsvFiles.length > 0) {
      const dates = rootCsvFiles.map(f => {
        const match = f.match(/evaluation_scoreboard_(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : '';
      }).filter(Boolean);
      
      if (dates.length > 0) {
        const latestDate = [...new Set(dates)].sort().reverse()[0];
        const content = fs.readFileSync(path.join(rootDir, `evaluation_scoreboard_${latestDate}.csv`), 'utf-8');
        return parseCSV(content);
      }
    }
  }

  throw new Error('No local scoreboard files found');
}

export async function GET() {
  try {
    let rows: ScoreboardRow[] = [];
    let source = 'gcs';
    let date = '';
    
    try {
      rows = await getScoreboardFromGCS();
      // Extract date from GCS latest run
      const storage = new Storage();
      const bucket = storage.bucket(BUCKET_NAME);
      const [files] = await bucket.getFiles({ prefix: 'scoreboards/' });
      const csvFiles = files.filter(f => f.name.endsWith('.csv') && f.name.includes('evaluation_scoreboard_'));
      const dates = csvFiles.map(f => {
        const match = f.name.match(/evaluation_scoreboard_(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : '';
      }).filter(Boolean);
      date = [...new Set(dates)].sort().reverse()[0] || '';
    } catch (gcsError: any) {
      console.warn('Failed to fetch from GCS, falling back to local files:', gcsError.message);
      rows = getScoreboardFromLocal();
      source = 'local';
      
      // Extract date from local files
      const scoreboardsDir = path.join(process.cwd(), 'scoreboards');
      if (fs.existsSync(scoreboardsDir)) {
        const files = fs.readdirSync(scoreboardsDir);
        const csvFiles = files.filter(f => f.endsWith('.csv') && f.includes('evaluation_scoreboard_'));
        const dates = csvFiles.map(f => {
          const match = f.match(/evaluation_scoreboard_(\d{4}-\d{2}-\d{2})/);
          return match ? match[1] : '';
        }).filter(Boolean);
        date = [...new Set(dates)].sort().reverse()[0] || '';
      }
      if (!date) {
        const rootDir = path.resolve(process.cwd(), '..');
        if (fs.existsSync(rootDir)) {
          const rootFiles = fs.readdirSync(rootDir);
          const rootCsvFiles = rootFiles.filter(f => f.endsWith('.csv') && f.includes('evaluation_scoreboard_'));
          const dates = rootCsvFiles.map(f => {
            const match = f.match(/evaluation_scoreboard_(\d{4}-\d{2}-\d{2})/);
            return match ? match[1] : '';
          }).filter(Boolean);
          date = [...new Set(dates)].sort().reverse()[0] || '';
        }
      }
    }
    
    // Deduplicate rows by project name
    const uniqueRowsMap = new Map<string, ScoreboardRow>();
    for (const row of rows) {
      // If we already have the row, keep the one with higher accuracy
      const existing = uniqueRowsMap.get(row.project);
      if (!existing || row.overall > existing.overall) {
        uniqueRowsMap.set(row.project, row);
      }
    }
    const deduplicatedRows = Array.from(uniqueRowsMap.values());
    
    // Sort rows by overall score descending
    deduplicatedRows.sort((a, b) => b.overall - a.overall);
    
    // Calculate summary statistics
    const validRows = deduplicatedRows.filter(r => r.totalCells > 0);
    const overallScore = validRows.length > 0 
      ? validRows.reduce((acc, r) => acc + r.overall, 0) / validRows.length
      : 0;
      
    const totalCells = validRows.reduce((acc, r) => acc + r.totalCells, 0);
    const matchingCells = validRows.reduce((acc, r) => acc + r.matchingCells, 0);
    const overallAccuracy = totalCells > 0 ? (matchingCells / totalCells) * 100 : 0;
    
    // Category specific averages
    const parseCategory = (val: string): number | null => {
      if (val === 'N/A' || !val) return null;
      const num = parseFloat(val);
      return isNaN(num) ? null : num;
    };
    
    const categories = ['mhStructures', 'mhCatchbasins', 'sewers', 'watermain'] as const;
    const catStats = categories.reduce((acc, cat) => {
      const vals = deduplicatedRows.map(r => parseCategory(r[cat])).filter((v): v is number => v !== null);
      acc[cat] = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
      return acc;
    }, {} as Record<typeof categories[number], number>);

    return NextResponse.json({
      success: true,
      source,
      date,
      overallScore: Number(overallScore.toFixed(1)),
      overallAccuracy: Number(overallAccuracy.toFixed(1)),
      totalCells,
      matchingCells,
      categoryAverages: {
        mhStructures: Number(catStats.mhStructures.toFixed(1)),
        mhCatchbasins: Number(catStats.mhCatchbasins.toFixed(1)),
        sewers: Number(catStats.sewers.toFixed(1)),
        watermain: Number(catStats.watermain.toFixed(1)),
      },
      projectsCount: deduplicatedRows.length,
      rows: deduplicatedRows,
    });
  } catch (error: any) {
    console.error('Error generating scoreboard:', error);
    return NextResponse.json({
      success: false,
      error: error.message || 'Unknown error occurred while generating scoreboard'
    }, { status: 500 });
  }
}
