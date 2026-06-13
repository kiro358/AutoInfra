/**
 * flywheel-gate.ts
 *
 * Orchestration script for the gated optimization flywheel.
 * Ensures that flywheel-suggested changes only reach production
 * if they actually improve accuracy.
 *
 * Flow:
 *  1. Read baseline accuracy from the current eval scoreboard
 *  2. Run analyze-failures.ts (local) or analyze-failures-cloud.ts (cloud) --dry-run → generate candidate files
 *  3. Re-evaluate the worst projects using candidate rules
 *  4. Compare candidate accuracy vs baseline
 *  5. If improved: promote candidate → production
 *  6. If regressed: discard candidate, log rejection
 *
 * Usage:
 *   npx tsx src/scripts/flywheel-gate.ts <scoreboard.csv> [--local]
 *   npx tsx src/scripts/flywheel-gate.ts <scoreboard.csv> --skip-re-eval [--local]
 */

import fs from 'fs';
import path from 'path';
import { analyzeFailuresCloud } from './analyze-failures-cloud';
import { analyzeFailuresLocal, AnalysisReport } from './analyze-failures';
import { GOLDEN_PROJECTS } from '../lib/constants';

// ======================== CONFIG ========================

const PRODUCTION_RULES_PATH = path.resolve(__dirname, '../lib/dynamic-rules.json');
const PRODUCTION_FEW_SHOTS_PATH = path.resolve(__dirname, '../../few_shot_examples.json');
const CANDIDATE_RULES_PATH = PRODUCTION_RULES_PATH.replace('.json', '.candidate.json');
const CANDIDATE_FEW_SHOTS_PATH = PRODUCTION_FEW_SHOTS_PATH.replace('.json', '.candidate.json');

// Minimum accuracy improvement required to promote candidates (percentage points)
const MIN_IMPROVEMENT_THRESHOLD = 0.0; // ≥0 means "at least don't regress"
// Maximum number of worst projects to re-evaluate with candidate rules
const RE_EVAL_LIMIT = 5;

// ======================== HELPERS ========================

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

interface ScoreboardEntry {

  projectName: string;
  overall: number;
  totalCells: number;
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

function parseScoreboard(csvPath: string): ScoreboardEntry[] {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  const dataLines = lines.slice(1);
  
  const seen = new Map<string, ScoreboardEntry>();
  for (const line of dataLines) {
    const parts = parseCSVLine(line);
    if (parts.length < 8) continue;
    const projectName = parts[0].replace(/"/g, '').trim();
    const overall = parseFloat(parts[5]);
    const totalCells = parts[6] ? parseInt(parts[6], 10) : 0;
    if (!projectName || isNaN(overall)) continue;
    
    seen.set(projectName.toLowerCase(), { projectName, overall, totalCells });
  }

  return Array.from(seen.values()).filter(r => !isNaN(r.overall) && !isNaN(r.totalCells) && r.totalCells > 0);
}

function restoreBackups(backupRules: Buffer | null, backupFewShots: Buffer | null) {
  if (backupRules) {
    fs.writeFileSync(PRODUCTION_RULES_PATH, backupRules);
    console.log(`   📄 Restored: dynamic-rules.json backup`);
  } else if (fs.existsSync(PRODUCTION_RULES_PATH)) {
    fs.unlinkSync(PRODUCTION_RULES_PATH);
  }
  if (backupFewShots) {
    fs.writeFileSync(PRODUCTION_FEW_SHOTS_PATH, backupFewShots);
    console.log(`   📄 Restored: few_shot_examples.json backup`);
  } else if (fs.existsSync(PRODUCTION_FEW_SHOTS_PATH)) {
    fs.unlinkSync(PRODUCTION_FEW_SHOTS_PATH);
  }
  cleanup();
}

function computeBaselineAccuracy(entries: ScoreboardEntry[]): number {
  if (entries.length === 0) return 0;
  const total = entries.reduce((sum, e) => sum + e.overall, 0);
  return total / entries.length;
}

interface GateResult {
  passed: boolean;
  baselineAccuracy: number;
  candidateAccuracy: number | null;
  analysisReport: AnalysisReport;
  reason: string;
}

// ======================== GATE LOGIC ========================

async function runGate(csvPath: string, skipReEval: boolean, localMode: boolean): Promise<GateResult> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          AutoInfra Flywheel Gate                            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log(`Execution Mode: ${localMode ? '⚡ LOCAL (Zero Cloud Cost)' : '☁️ CLOUD (GCS Orchestrated)'}`);

  // ── Step 1: Compute baseline accuracy ──
  const scoreboard = parseScoreboard(csvPath);
  const baselineAccuracy = computeBaselineAccuracy(scoreboard);
  console.log(`📊 Baseline accuracy: ${baselineAccuracy.toFixed(1)}% (across ${scoreboard.length} projects)\n`);

  // ── Step 2: Run analysis in dry-run mode ──
  console.log('━'.repeat(60));
  console.log(`Phase 1: Analyzing failures (${localMode ? 'Local' : 'Cloud'} dry-run mode)...\n`);
  
  let analysisReport: AnalysisReport;
  
  if (localMode) {
    analysisReport = await analyzeFailuresLocal(csvPath, {
      limit: RE_EVAL_LIMIT,
      dryRun: true,
      candidateRulesPath: CANDIDATE_RULES_PATH,
      candidateFewShotsPath: CANDIDATE_FEW_SHOTS_PATH,
    });
  } else {
    analysisReport = await analyzeFailuresCloud(csvPath, {
      limit: RE_EVAL_LIMIT,
      dryRun: true,
      candidateRulesPath: CANDIDATE_RULES_PATH,
      candidateFewShotsPath: CANDIDATE_FEW_SHOTS_PATH,
    });
  }

  // If no changes were applied, skip re-evaluation
  if (analysisReport.changesApplied === 0) {
    console.log('\n⏭️ No changes were applied. Nothing to validate.');
    cleanup();
    return {
      passed: false,
      baselineAccuracy,
      candidateAccuracy: null,
      analysisReport,
      reason: 'No changes were applied by the analysis phase',
    };
  }

  console.log(`\n✅ Analysis complete: ${analysisReport.changesApplied} changes applied to candidates\n`);

  // ── Step 3: Gate decision ──
  if (skipReEval) {
    // Trust the analysis — promote without re-evaluation
    console.log('━'.repeat(60));
    console.log('Phase 2: SKIPPED (--skip-re-eval flag set)\n');
    console.log('⚠️ Promoting candidates WITHOUT re-evaluation verification');
    
    promoteCandidate();
    
    return {
      passed: true,
      baselineAccuracy,
      candidateAccuracy: null,
      analysisReport,
      reason: 'Promoted without re-evaluation (--skip-re-eval)',
    };
  }

  console.log('━'.repeat(60));
  console.log('Phase 2: Golden Suite validation recheck\n');
  
  // Backup production configs
  const backupRules = fs.existsSync(PRODUCTION_RULES_PATH) ? fs.readFileSync(PRODUCTION_RULES_PATH) : null;
  const backupFewShots = fs.existsSync(PRODUCTION_FEW_SHOTS_PATH) ? fs.readFileSync(PRODUCTION_FEW_SHOTS_PATH) : null;

  try {
    // Swap candidates to production paths
    if (fs.existsSync(CANDIDATE_RULES_PATH)) {
      fs.copyFileSync(CANDIDATE_RULES_PATH, PRODUCTION_RULES_PATH);
    }
    if (fs.existsSync(CANDIDATE_FEW_SHOTS_PATH)) {
      fs.copyFileSync(CANDIDATE_FEW_SHOTS_PATH, PRODUCTION_FEW_SHOTS_PATH);
    }

    console.log(`Re-evaluating Golden Suite projects with candidate pool...\n`);

    let goldenProjInfos: any[] = [];
    if (localMode) {
      const { findProjects } = require('./batch-evaluate');
      const allProjects = findProjects();
      goldenProjInfos = allProjects.filter((p: any) => GOLDEN_PROJECTS.includes(p.folder));
    } else {
      const { findProjectsCloud } = require('./batch-evaluate-cloud');
      const allProjects = await findProjectsCloud();
      goldenProjInfos = allProjects.filter((p: any) => GOLDEN_PROJECTS.includes(p.folder));
    }

    let totalBaseline = 0;
    let totalCandidate = 0;
    let count = 0;

    const CONCURRENCY_LIMIT = 16;
    await runWithConcurrency(goldenProjInfos, CONCURRENCY_LIMIT, async (projInfo) => {
      const entry = scoreboard.find(e => e.projectName.toLowerCase() === projInfo.folder.toLowerCase());
      const baselineScore = entry ? entry.overall : 0;
      
      console.log(`   🔄 Re-evaluating Golden Project: ${projInfo.folder} (Baseline: ${baselineScore.toFixed(1)}%)`);
      let candidateScore = 0;
      
      if (localMode) {
        const { processProject } = require('./batch-evaluate');
        const res = await processProject(projInfo);
        if (res) candidateScore = res.overallAccuracy;
      } else {
        const { processProjectCloud } = require('./batch-evaluate-cloud');
        const res = await processProjectCloud(projInfo);
        if (res) candidateScore = res.overallAccuracy;
      }

      console.log(`      ✨ Candidate Score for ${projInfo.folder}: ${candidateScore.toFixed(1)}% (Baseline: ${baselineScore.toFixed(1)}%)`);
      
      totalBaseline += baselineScore;
      totalCandidate += candidateScore;
      count++;
    });


    const avgBaseline = count > 0 ? totalBaseline / count : 0;
    const avgCandidate = count > 0 ? totalCandidate / count : 0;
    const delta = avgCandidate - avgBaseline;

    console.log(`\n📈 Golden Suite Recheck Results:`);
    console.log(`   Average Baseline:  ${avgBaseline.toFixed(1)}%`);
    console.log(`   Average Candidate: ${avgCandidate.toFixed(1)}%`);
    console.log(`   Delta:             ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`);

    if (delta < 0) {
      console.log(`⛔ Gate FAILED: Candidate accuracy regressed on the Golden Suite (delta: ${delta.toFixed(1)}% < 0)`);
      restoreBackups(backupRules, backupFewShots);
      return {
        passed: false,
        baselineAccuracy,
        candidateAccuracy: avgCandidate,
        analysisReport,
        reason: `Regressed accuracy on Golden Suite: delta ${delta.toFixed(1)}% < 0`,
      };
    }

    console.log(`\n✅ Gate PASSED — promoting candidates to production`);
    // Candidates are already in production paths. Just clean up candidate files.
    cleanup();

    // Update baseline accuracy in the production rules if it exists
    if (fs.existsSync(PRODUCTION_RULES_PATH)) {
      const rules = JSON.parse(fs.readFileSync(PRODUCTION_RULES_PATH, 'utf8'));
      rules.baselineAccuracy = baselineAccuracy;
      fs.writeFileSync(PRODUCTION_RULES_PATH, JSON.stringify(rules, null, 2));
    }

    return {
      passed: true,
      baselineAccuracy,
      candidateAccuracy: avgCandidate,
      analysisReport,
      reason: `Accuracy improved/maintained by ${delta.toFixed(1)}% (average: ${avgCandidate.toFixed(1)}%)`,
    };

  } catch (err: any) {
    console.error(`Error during Golden Suite re-evaluation:`, err);
    restoreBackups(backupRules, backupFewShots);
    throw err;
  }
}

function promoteCandidate() {
  if (fs.existsSync(CANDIDATE_RULES_PATH)) {
    fs.copyFileSync(CANDIDATE_RULES_PATH, PRODUCTION_RULES_PATH);
    console.log(`   📄 Promoted: dynamic-rules.json`);
  }
  if (fs.existsSync(CANDIDATE_FEW_SHOTS_PATH)) {
    fs.copyFileSync(CANDIDATE_FEW_SHOTS_PATH, PRODUCTION_FEW_SHOTS_PATH);
    console.log(`   📄 Promoted: few_shot_examples.json`);
  }
  cleanup();
}

function cleanup() {
  for (const f of [CANDIDATE_RULES_PATH, CANDIDATE_FEW_SHOTS_PATH]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// ======================== MAIN ========================

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx src/scripts/flywheel-gate.ts <scoreboard.csv> [--local] [--skip-re-eval]');
    process.exit(1);
  }

  const csvPath = args.find(arg => !arg.startsWith('--'));
  const skipReEval = args.includes('--skip-re-eval');
  const localMode = args.includes('--local');

  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error(`❌ Scoreboard file not found or not specified: ${csvPath}`);
    process.exit(1);
  }

  const result = await runGate(csvPath, skipReEval, localMode);

  // Write gate result to stdout as JSON for the CI workflow
  const resultJson = JSON.stringify({
    passed: result.passed,
    baselineAccuracy: result.baselineAccuracy,
    candidateAccuracy: result.candidateAccuracy,
    changesApplied: result.analysisReport.changesApplied,
    changesRejected: result.analysisReport.changesRejected,
    reason: result.reason,
  }, null, 2);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('GATE RESULT:');
  console.log(resultJson);
  console.log('═'.repeat(60));

  // Write to file for CI consumption
  const resultPath = path.join(process.cwd(), 'flywheel-gate-result.json');
  fs.writeFileSync(resultPath, resultJson);
  console.log(`\n📄 Result written to: ${resultPath}`);

  // Exit with non-zero if gate failed
  if (!result.passed) {
    process.exit(0); // Don't fail CI — just don't commit
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Flywheel gate error:', err);
    process.exit(1);
  });
}
