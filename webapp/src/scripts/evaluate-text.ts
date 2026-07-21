/**
 * evaluate-text.ts — the $0 validation gate for the deterministic text-layer
 * extraction path (Phase A).
 *
 * Runs extractPageText + assembleTextTakeoff directly on each golden project's
 * real drawing PDFs (no LLM calls, no vision, no network) and scores the result
 * against ground truth with the same compare-facts metric used by the LLM eval.
 * Also re-scores whatever cached LLM prediction already exists on disk
 * (generated_spreadsheets/predicted_facts.json, written by evaluate-golden.ts)
 * against the same truth, so the two numbers are directly comparable in one table.
 *
 * Path resolution mirrors analyze-eval.ts: repo root via path.resolve(__dirname, ...),
 * dataset-manifest.json + truth-manifest.json read from the repo root.
 *
 * Usage:  npm run evaluate:text
 *         VERBOSE=true npm run evaluate:text   (prints full formatFactsComparison per project)
 */
import fs from 'fs';
import path from 'path';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { extractPageText, isTextyPage, PageText } from '../lib/pdf-text';
import { assembleTextTakeoff } from '../lib/text-takeoff';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { compareFacts, formatFactsComparison } from '../lib/compare-facts';

const ROOT = path.resolve(__dirname, '../../..');
const DATA = path.join(ROOT, 'existing_projects_training_data');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dataset-manifest.json'), 'utf8')) as Array<{
  folder: string;
  drawingPdfs?: { name: string; pages?: number }[];
}>;
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
    const truth = await resolveTruthFacts(projectDir, g.folder, truthManifest);
    if (!truth) {
      rows.push(`${g.label.padEnd(28)} — no usable ground truth`);
      continue;
    }

    let texty = 0, total = 0;
    const textyPages: PageText[] = [];
    for (const pdf of entry.drawingPdfs ?? []) {
      const p = path.join(projectDir, pdf.name);
      if (!fs.existsSync(p)) continue;
      let pages: PageText[];
      try {
        pages = await extractPageText(fs.readFileSync(p));
      } catch (e: any) {
        console.warn(`   [evaluate-text] ${g.label}: failed to read ${pdf.name}: ${e.message}`);
        continue;
      }
      total += pages.length;
      for (const pt of pages) {
        if (isTextyPage(pt)) { texty++; textyPages.push(pt); }
      }
    }

    let textF1: number | null = null;
    if (textyPages.length > 0) {
      const facts = assembleTextTakeoff(textyPages, g.folder);
      const cmp = compareFacts(facts, truth.facts);
      textF1 = cmp.detectionF1;
      if (process.env.VERBOSE === 'true') console.log(`\n${g.label}:\n` + formatFactsComparison(cmp));
    }

    let llmF1: number | null = null;
    const pf = path.join(projectDir, 'generated_spreadsheets', 'predicted_facts.json');
    if (fs.existsSync(pf)) {
      try {
        const cached = JSON.parse(fs.readFileSync(pf, 'utf8'));
        llmF1 = compareFacts(cached, truth.facts).detectionF1;
      } catch (e: any) {
        console.warn(`   [evaluate-text] ${g.label}: failed to score cached prediction: ${e.message}`);
      }
    }

    const truthCounts = `S${truth.facts.structures.length} R${truth.facts.sewers.filter((s) => !s.isLineItem).length} `
      + `CB${truth.facts.catchbasins.reduce((a, c) => a + (c.quantity || 0), 0)} W${truth.facts.watermain.length}`;

    rows.push(
      `${g.label.padEnd(28)} texty ${String(texty).padStart(2)}/${String(total).padEnd(3)} `
      + `textF1 ${pct(textF1)}  llmF1(cached) ${pct(llmF1)}  truth ${truthCounts}`
    );
  }

  console.log('\nTEXT-LAYER PATH vs CACHED LLM (both scored with compare-facts vs manifest truth)\n');
  for (const r of rows) console.log('  ' + r);
  console.log('');
}

main();
