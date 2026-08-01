/**
 * /api/performance — serves the FACTS-metric accuracy summary the dashboard renders.
 *
 * Reads whichever golden-set artifact is more current:
 *   golden-results-offline.json  — written by `npm run score:offline` ($0 rescore of
 *                                  cached predictions; carries a per-entity breakdown)
 *   golden-results.json          — written by `npm run evaluate:golden` (a real run)
 *
 * Deliberately NOT the legacy scoreboards/*.csv cell-accuracy files (/api/scoreboard):
 * cell accuracy scores guessed dollars cell-by-cell and is not this system's accuracy
 * metric. See CLAUDE.md and REDESIGN.md.
 */
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { GoldenRow, summarizePerformance } from '@/lib/perf-summary';

export const dynamic = 'force-dynamic';

const ROOT = path.resolve(process.cwd(), '..');
const OFFLINE_FILE = path.join(ROOT, 'golden-results-offline.json');
const EVAL_FILE = path.join(ROOT, 'golden-results.json');

interface Source {
  rows: GoldenRow[];
  origin: 'offline-rescore' | 'eval-run';
  generatedAt: string;
}

function readSource(file: string, origin: Source['origin']): Source | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // score-offline.ts wraps rows in { _meta, rows }; evaluate-golden.ts writes a
    // bare folder-keyed map. Accept both.
    const map = raw && typeof raw === 'object' && raw.rows ? raw.rows : raw;
    const rows = Object.values(map).filter(
      (r): r is GoldenRow => !!r && typeof r === 'object' && 'folder' in (r as object)
    );
    if (rows.length === 0) return null;
    return {
      rows,
      origin,
      generatedAt: raw?._meta?.generatedAt ?? fs.statSync(file).mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const candidates = [
    readSource(OFFLINE_FILE, 'offline-rescore'),
    readSource(EVAL_FILE, 'eval-run'),
  ].filter((s): s is Source => s !== null);

  if (candidates.length === 0) {
    return NextResponse.json(
      {
        success: false,
        error:
          'No golden-set results found. Run `npm run evaluate:golden` for a fresh run, or `npm run score:offline` to re-score cached predictions.',
      },
      { status: 404 }
    );
  }

  // Most recent wins — an offline rescore of fresh predictions supersedes an older
  // eval run, and vice versa.
  candidates.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  const chosen = candidates[0];

  return NextResponse.json({
    success: true,
    source: chosen.origin,
    generatedAt: chosen.generatedAt,
    summary: summarizePerformance(chosen.rows),
  });
}
