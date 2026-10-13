/**
 * locator-audit.ts — the $0 locator audit (fix plan Phase 2.1 / H5).
 *
 * For every golden project, census EVERY page of its drawing PDFs from the
 * PDF text layer and classify it as takeoff-bearing (structure/run/watermain
 * callouts, elevations, or a schedule table) vs not. Then compare against the
 * pages the cached vision run actually used (predicted_facts.json's
 * locatorIndex — tile→page attribution is not stored, so the locator's
 * selection is the finest "used" signal the cache carries; see fix plan 2.2).
 *
 * Output per project: total pages, texty pages, takeoff-bearing pages, pages
 * the locator selected, bearing pages it MISSED, and which truth structures
 * are visible in the text layer ONLY on missed pages (i.e. entities the
 * vision run could not possibly have extracted). Pages whose text layer is
 * silent (SHX/raster) are reported as "unknown", never as "not bearing" —
 * the census can only convict where the text layer can see.
 *
 * PDF merge order replicates evaluate-golden.ts (chooseDrawingPdfs, then
 * relevance score desc, file size desc) because the cached locatorIndex page
 * numbers refer to the merged document in that order.
 *
 * Usage: npm run audit:locator [-- --json]   (JSON also written to
 *        eval-results/locator-audit.json)
 */
import fs from 'fs';
import path from 'path';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { chooseDrawingPdfs } from '../lib/dataset';
import { extractPageText, isTextyPage, PageText } from '../lib/pdf-text';
import {
  parseStructureLabel, parseRunCallout, parseWatermainCallout, parseElevation,
} from '../lib/callout-parser';
import { detectTables } from '../lib/schedule-table';
import { normalizeLabel } from '../lib/compare-facts';
import { getEndpointSignature } from '../lib/reconcile';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { TakeoffFacts } from '../lib/types';

const ROOT = path.resolve(__dirname, '../../..');
const TRAINING_DIR = path.join(ROOT, 'existing_projects_training_data');
const truthManifest = loadTruthManifest(path.join(ROOT, 'truth-manifest.json'));

// Label-shaped candidates in running text (items may split a label across
// fragments; each candidate is still validated through the real grammar).
const LABEL_CANDIDATE =
  /\b(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|STMH|SANITARY\s+MH|SAN\s+MH)\s*#?\s*\d+\s*[A-Z]?\b/gi;
const RUN_CANDIDATE = /\d+(?:\.\d+)?\s*m\s*[-–]\s*\d+\s*mm/gi;

interface PageCensus {
  page: number; // global, 1-indexed in merged order
  file: string;
  texty: boolean;
  labels: Set<string>;
  bearing: boolean;
  signals: string[];
}

function censusPage(pt: PageText, file: string): PageCensus {
  const labels = new Set<string>();
  let runs = 0;
  let wm = 0;
  let elevations = 0;
  for (const item of pt.items) {
    const s = parseStructureLabel(item.text);
    if (s && !s.existing) {
      const n = normalizeLabel(s.label);
      if (n) labels.add(n);
    }
    if (parseRunCallout(item.text)) runs++;
    if (parseWatermainCallout(item.text)) wm++;
    if (parseElevation(item.text)) elevations++;
  }
  const joined = pt.items.map((i) => i.text).join(' ');
  for (const m of joined.matchAll(LABEL_CANDIDATE)) {
    const s = parseStructureLabel(m[0]);
    if (s && !s.existing) {
      const n = normalizeLabel(s.label);
      if (n) labels.add(n);
    }
  }
  if (runs === 0 && RUN_CANDIDATE.test(joined)) runs = 1;
  let tables = 0;
  try { tables = detectTables(pt).length; } catch { tables = 0; }

  const texty = isTextyPage(pt);
  const signals: string[] = [];
  if (labels.size > 0) signals.push(`${labels.size} structure labels`);
  if (runs > 0) signals.push('run callouts');
  if (wm > 0) signals.push('watermain callouts');
  if (elevations >= 2) signals.push(`${elevations} elevations`);
  if (tables > 0) signals.push('schedule table');
  return {
    page: pt.page, file, texty, labels,
    bearing: texty && signals.length > 0,
    signals,
  };
}

/** evaluate-golden.ts's PDF ordering (relevance score desc, then size desc). */
function orderedPdfs(projectDir: string): string[] {
  const scorePDF = (filename: string): number => {
    const name = filename.toLowerCase();
    let score = 0;
    if (name.includes('civil') || name.includes('servicing') || name.includes('drainage') || name.includes('plan') || name.includes('pnp') || name.includes('storm') || name.includes('sewer') || name.includes('water')) score += 1000;
    if (name.includes('detail') || name.includes('det-') || name.includes('notes')) score -= 200;
    return score;
  };
  return chooseDrawingPdfs(projectDir).sort((a, b) => {
    const d = scorePDF(b) - scorePDF(a);
    if (d !== 0) return d;
    return fs.statSync(path.join(projectDir, b)).size - fs.statSync(path.join(projectDir, a)).size;
  });
}

async function main() {
  const rows: Record<string, unknown>[] = [];
  const lines: string[] = [];
  let totPages = 0, totBearing = 0, totMissed = 0, totOnlyOnMissed = 0;

  for (const g of GOLDEN_PROJECTS) {
    const projectDir = path.join(TRAINING_DIR, g.folder);
    try {
      const pdfs = orderedPdfs(projectDir);
      const census: PageCensus[] = [];
      let offset = 0;
      for (const rel of pdfs) {
        const buf = fs.readFileSync(path.join(projectDir, rel));
        const pages = await extractPageText(buf);
        for (const pt of pages) {
          const c = censusPage(pt, path.basename(rel));
          c.page = offset + pt.page;
          census.push(c);
        }
        offset += pages.length;
      }

      const predPath = path.join(projectDir, 'generated_spreadsheets', 'predicted_facts.json');
      const pred: TakeoffFacts | null = fs.existsSync(predPath)
        ? JSON.parse(fs.readFileSync(predPath, 'utf8')) : null;
      const used = pred?.locatorIndex
        ? new Set([...pred.locatorIndex.manholePages, ...pred.locatorIndex.sewerPages, ...pred.locatorIndex.watermainPages])
        : null;

      const bearing = census.filter((c) => c.bearing);
      const textyCount = census.filter((c) => c.texty).length;
      const missed = used ? bearing.filter((c) => !used.has(c.page)) : [];
      const unknownPages = census.filter((c) => !c.texty).length;

      // Truth attribution: where is each truth structure's label visible?
      const truth = await resolveTruthFacts(projectDir, g.folder, truthManifest);
      const onlyOnMissed: string[] = [];
      const notVisible: string[] = [];
      if (truth && used) {
        const missedSet = new Set(missed.map((c) => c.page));
        for (const s of truth.facts.structures) {
          const n = normalizeLabel(s.description);
          if (!n) continue;
          const visibleOn = census.filter((c) => c.labels.has(n)).map((c) => c.page);
          if (visibleOn.length === 0) { notVisible.push(s.description); continue; }
          if (visibleOn.every((p) => missedSet.has(p))) onlyOnMissed.push(s.description);
        }
      }

      totPages += census.length; totBearing += bearing.length;
      totMissed += missed.length; totOnlyOnMissed += onlyOnMissed.length;

      const row = {
        project: g.label, pdfs: pdfs.length, pages: census.length,
        textyPages: textyCount, unknownPages, bearingPages: bearing.map((c) => c.page),
        usedPages: used ? [...used].sort((a, b) => a - b) : null,
        missedBearingPages: missed.map((c) => ({ page: c.page, file: c.file, signals: c.signals })),
        truthStructuresOnlyOnMissed: onlyOnMissed,
        truthStructuresNotVisibleInTextLayer: notVisible.length,
      };
      rows.push(row);
      lines.push(
        `${g.label.padEnd(28)} pages ${String(census.length).padStart(3)} (texty ${textyCount}, unknown ${unknownPages}) ` +
        `bearing ${String(bearing.length).padStart(2)} used ${used ? used.size : 'n/a'} ` +
        `MISSED ${missed.length}${missed.length ? ' [p' + missed.map((c) => c.page).join(', p') + ']' : ''} ` +
        `truth-only-on-missed ${onlyOnMissed.length}${onlyOnMissed.length ? ' [' + onlyOnMissed.slice(0, 6).join(', ') + ']' : ''}`
      );
    } catch (e: any) {
      lines.push(`${g.label.padEnd(28)} ERROR ${e.message}`);
      rows.push({ project: g.label, error: e.message });
    }
  }

  console.log('\nLOCATOR AUDIT — text-layer census vs cached locator selection ($0)\n');
  for (const l of lines) console.log('  ' + l);
  console.log(
    `\n  TOTALS: ${totPages} pages, ${totBearing} takeoff-bearing (text-layer-visible), ` +
    `${totMissed} bearing pages the cached locator did not select, ` +
    `${totOnlyOnMissed} truth structures visible ONLY on missed pages.\n`
  );

  const outPath = path.join(ROOT, 'eval-results', 'locator-audit.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 1));
  console.log(`  JSON written to ${path.relative(ROOT, outPath)}\n`);
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
