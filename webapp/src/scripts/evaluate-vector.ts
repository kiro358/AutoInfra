/**
 * evaluate-vector.ts — $0 offline validation gate for the vector-native CAD takeoff path.
 *
 * Runs extractVectorTakeoff directly on each golden project's real drawing PDFs
 * (pure vector geometry + topology + conventions, 0 LLM calls, $0 cost) and scores
 * the result against ground truth with the compare-facts metric.
 *
 * Compares vector-native F1 with text-layer F1 and cached LLM F1.
 *
 * Usage:  npm run evaluate:vector
 *         VERBOSE=true npm run evaluate:vector
 */
import fs from 'fs';
import path from 'path';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { extractVectorTakeoff } from '../lib/vector-takeoff';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { compareFacts, formatFactsComparison } from '../lib/compare-facts';

const ROOT = path.resolve(__dirname, '../../..');
const DATA = path.join(ROOT, 'existing_projects_training_data');
let manifest: Array<{
  folder: string;
  drawingPdfs?: { name: string; pages?: number }[];
}> = [];
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dataset-manifest.json'), 'utf8'));
} catch (e: any) {
  console.error(`Could not read dataset-manifest.json: ${e.message}`);
}
const truthManifest = loadTruthManifest(path.join(ROOT, 'truth-manifest.json'));

const pct = (v: number | null) => (v == null ? '   —' : `${(v * 100).toFixed(1)}%`);

async function main() {
  const rows: string[] = [];

  for (const g of GOLDEN_PROJECTS) {
    const entry = manifest.find((m) => m.folder === g.folder);
    const projectDir = path.join(DATA, g.folder);
    if (!entry || !fs.existsSync(projectDir)) {
      rows.push(`${g.label.padEnd(28)} — missing project dir or manifest entry`);
      continue;
    }
    try {
      const truth = await resolveTruthFacts(projectDir, g.folder, truthManifest);
      if (!truth) {
        rows.push(`${g.label.padEnd(28)} — no usable ground truth`);
        continue;
      }

      let vectorF1: number | null = null;
      for (const pdf of entry.drawingPdfs ?? []) {
        const p = path.join(projectDir, pdf.name);
        if (!fs.existsSync(p)) continue;
        const pdfBuf = fs.readFileSync(p);
        const facts = await extractVectorTakeoff(pdfBuf, undefined, g.folder);
        const cmp = compareFacts(facts, truth.facts);
        vectorF1 = cmp.detectionF1;

        if (process.env.VERBOSE === 'true') {
          console.log(`\n${g.label} (Vector-Native Takeoff):\n` + formatFactsComparison(cmp));
        }
        break;
      }

      let llmF1: number | null = null;
      const pf = path.join(projectDir, 'generated_spreadsheets', 'predicted_facts.json');
      if (fs.existsSync(pf)) {
        const cached = JSON.parse(fs.readFileSync(pf, 'utf8'));
        llmF1 = compareFacts(cached, truth.facts).detectionF1;
      }

      const truthCounts = `S${truth.facts.structures.length} R${truth.facts.sewers.filter((s) => !s.isLineItem).length} `
        + `CB${truth.facts.catchbasins.reduce((a, c) => a + (c.quantity || 0), 0)} W${truth.facts.watermain.length}`;

      rows.push(
        `${g.label.padEnd(28)} vectorF1 ${pct(vectorF1)}  llmF1(cached) ${pct(llmF1)}  truth ${truthCounts}`
      );
    } catch (e: any) {
      rows.push(`${g.label}: error (${e.message})`);
    }
  }

  console.log('\nVECTOR-NATIVE CAD TAKEOFF vs CACHED LLM (both scored with compare-facts vs manifest truth)\n');
  for (const r of rows) console.log('  ' + r);
  console.log('');
}

main().catch((e) => {
  console.error(e);
});
