/**
 * assemble-from-transcripts.ts — the $0 re-assembly loop for the vision-transcript
 * path (EXTRACTION_MODE=transcribe|hybrid).
 *
 * Reads each golden project's ALREADY-CACHED predicted_facts.json (written by a
 * prior evaluate-golden.ts run) and, when it carries a non-empty `transcript`
 * array, re-runs assembleTranscriptTakeoff (Task 8) + reconcileTakeoff (Task 3)
 * on the SAME transcript — no LLM call — then re-scores with compareFacts against
 * manifest-resolved truth. Prints the OLD (already-cached) detF1 next to the
 * RECOMPUTED detF1 so a parser/assembler/reconciler change's effect on accuracy is
 * visible without spending a cent. This is the loop EVAL_METHODOLOGY.md refers to:
 * change callout-parser.ts / transcript-takeoff.ts / reconcile.ts -> npm test ->
 * npm run assemble:transcripts -> see golden movement, $0.
 *
 * Path resolution mirrors analyze-eval.ts: truth always comes from the canonical
 * training dir; predictions can come from a separate dir (e.g. a fresh VM export
 * overlaid to a scratch dir) via PREDICTIONS_DIR.
 *
 * Usage:  npm run assemble:transcripts
 *         PREDICTIONS_DIR=/path npm run assemble:transcripts
 */
import fs from 'fs';
import path from 'path';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { assembleTranscriptTakeoff } from '../lib/transcript-takeoff';
import { reconcileTakeoff } from '../lib/reconcile';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { compareFacts } from '../lib/compare-facts';
import { TakeoffFacts, TileTranscript } from '../lib/types';

const ROOT = path.resolve(__dirname, '../../..');
const TRUTH_DIR = path.join(ROOT, 'existing_projects_training_data');
// Truth xlsx always come from the canonical training dir; predictions can come from a
// separate dir (e.g. a fresh export overlaid to a scratch dir) via PREDICTIONS_DIR.
const PRED_DIR = process.env.PREDICTIONS_DIR || TRUTH_DIR;

let truthManifest: ReturnType<typeof loadTruthManifest> = {};
try {
  truthManifest = loadTruthManifest(path.join(ROOT, 'truth-manifest.json'));
} catch (e: any) {
  console.error(`Could not read truth-manifest.json: ${e.message}`);
}

const pct = (v: number | null) => (v == null ? '   —' : `${(v * 100).toFixed(1)}%`);

async function main() {
  const rows: string[] = [];

  for (const g of GOLDEN_PROJECTS) {
    try {
      const predPath = path.join(PRED_DIR, g.folder, 'generated_spreadsheets', 'predicted_facts.json');
      if (!fs.existsSync(predPath)) {
        rows.push(`${g.label.padEnd(28)} — no predicted_facts.json`);
        continue;
      }

      const pred = JSON.parse(fs.readFileSync(predPath, 'utf8')) as TakeoffFacts;
      const transcript = pred.transcript as TileTranscript[] | undefined;
      if (!Array.isArray(transcript) || transcript.length === 0) {
        rows.push(`${g.label.padEnd(28)} — (no transcript cached)`);
        continue;
      }

      const truthDir = path.join(TRUTH_DIR, g.folder);
      const truth = await resolveTruthFacts(truthDir, g.folder, truthManifest);
      if (!truth) {
        rows.push(`${g.label.padEnd(28)} — no usable ground truth`);
        continue;
      }

      const oldF1 = compareFacts(pred, truth.facts).detectionF1;

      const reassembled = reconcileTakeoff(assembleTranscriptTakeoff(transcript, g.folder));
      const newF1 = compareFacts(reassembled, truth.facts).detectionF1;

      const delta = newF1 - oldF1;
      const deltaStr = delta === 0 ? '  =  ' : `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`;

      rows.push(
        `${g.label.padEnd(28)} old detF1 ${pct(oldF1)}  ->  recomputed ${pct(newF1)}  (${deltaStr})  [${transcript.length} tiles]`
      );
    } catch (e: any) {
      rows.push(`${g.label.padEnd(28)} — error (${e.message})`);
    }
  }

  console.log('\nOFFLINE TRANSCRIPT RE-ASSEMBLY (assembleTranscriptTakeoff + reconcileTakeoff re-run on cached transcripts, $0)\n');
  for (const r of rows) console.log('  ' + r);
  console.log('');
}

main().catch((e) => {
  console.error(e);
});
