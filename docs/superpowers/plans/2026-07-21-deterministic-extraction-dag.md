# Deterministic Extraction DAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure AutoInfra's extraction stage into a hybrid DAG — deterministic text-layer parsing where the PDF allows it, LLM-as-*transcriber* (never LLM-as-estimator) where it doesn't, and a deterministic assembly/reconciliation layer that owns all entity logic — so accuracy iteration becomes free/offline and the variance + cost of the current "takeoff-per-tile-batch + string dedup" loop disappears.

**Architecture:** Three new pure layers feed the existing `TakeoffFacts` schema: (1) `pdf-text.ts` extracts positioned text from PDF text layers (≈1/3 of the corpus has full callout text — including the two best-scoring golden projects); (2) `callout-parser.ts` is a grammar for the highly formulaic callout language (`83.7m-375mmØ SAN @ 0.02%`, `EX CBMH1035 (1200Ø)`, `T/G=224.95`); (3) `reconcile.ts` enforces global entity consistency (dedup, dual-label kills, CB counting). For raster/SHX pages the LLM's job shrinks to verbatim callout *transcription* per tile batch; transcripts are persisted so assembly logic can be re-run offline forever at $0. Costing, spreadsheet fill, `compare-facts`, and the truth manifest are untouched.

**Tech Stack:** TypeScript (Next.js webapp), `pdfjs-dist` (already a dep, used by `rasterize.ts`), `pdf-lib` (already a dep, used for test-fixture PDFs), `vitest`, `tsx` scripts, Gemini via `@google/genai`.

## Global Constraints

- All work happens in `webapp/` on branch `claude/codebase-redesign-eval-yyocrq`. Never commit to `main`.
- `npm test` (vitest) and `npx tsc --noEmit` must be green after every task. Run both from `webapp/`.
- The ground-truth dataset (`existing_projects_training_data/`) is **gitignored**. Unit tests must NEVER read it — generate fixture PDFs in-test with `pdf-lib`. Scripts (`src/scripts/*`) MAY read it.
- **No pricing in the extraction path.** New code never emits dollar amounts, labor rates, or fees (`costing-rules.ts` is the only place dollars live).
- New extraction behavior is additive behind `EXTRACTION_MODE` env values (`transcribe`, `hybrid`). The current default path must behave byte-identically when those modes are not set.
- Existing exports that new code reuses (do not re-implement): `normalizeLabel`, `runSignature`, `stripSystemPrefix` from `src/lib/compare-facts.ts`; `snapToPipeDiameter`, `normalizeSlope` from `src/lib/geometry.ts`; `mergeCatchbasinGroups`, `deduplicateSewers`, `parseFacts` from `src/lib/extraction.ts`; `compareFacts`, `formatFactsComparison` from `src/lib/compare-facts.ts`; `resolveTruthFacts`, `loadTruthManifest` from `src/lib/truth-facts.ts`; the `TakeoffFacts` family from `src/lib/types.ts`.
- `TakeoffFacts` shape (from `src/lib/types.ts`, verbatim — do not change existing fields): `structures: StructureFact[]` (`description, topElevation, lowInvert, highInvert, pipeOutDiameter, structureType, depth`), `catchbasins: CatchbasinGroupFact[]` (`type: 'SINGLE_CB'|'DOUBLE_CB'|'DITCH_INLET_CB'|'DOUBLE_DITCH_INLET_CB', quantity, wallThickness, depth`), `sewers: SewerFact[]` (`runLabel, isLineItem, length, pipeDiameter, typeClass, slope, depth`), `watermain: WatermainFact[]` (`sizeAndType, length, pipeDiameter, ocSc, avgCover`), plus `watermainSpecials`, `watermainValves`, `confidence`, `warnings`.
- Domain rule that appears everywhere: callouts prefixed `EX` / `EX.` denote **existing** infrastructure and are excluded from the takeoff (the estimator prices proposed works only). Parsers must *detect* the flag; assemblers *filter* on it.
- Drawings may express slope in ‰; `normalizeSlope` (divides by 10 when > 10) handles it — always pass parsed slopes through it. Diameters snap via `snapToPipeDiameter`.

## Why (context for implementers)

Empirical findings this plan is built on (verified 2026-07-21 against the local dataset):

1. Of the 16 golden projects, ~5 (Bradford `2026-002`, Oakville FH `2026-006`, Matthews `2026-021`, Ultimate Drive `2026-025`, Holiday Inn `2026-068`) have PDF **text layers containing the actual callouts** — hundreds of parseable strings per sheet. The two best LLM scores (Matthews 74%, Ultimate Drive 71%) are exactly the two richest text layers. The rest are AutoCAD SHX plots/scans (callouts are vector strokes; vision genuinely required).
2. Real callout text is rigidly formulaic. Verbatim samples pulled from the corpus:
   - Runs: `83.7m-375mmØ SAN @ 0.02%`, `EX SAN 7.2m - 250mmØ DR 35 @ 0.05%`, and split-line continuations: `EX SAN 87.4m - 250mmØ` + `DR 35 @ 0.05%`
   - Structures: `EX CBMH1035 (1200Ø)`, `STMH 1`, `MH 101`, `EX SAN MH 02`
   - Elevations: `T/G=224.95`, `N INV=223.350`, `SW INV = 310.60`, `T/G = 312.46`
   - Watermain: `EX. 300 mmØ PVC WATERMAIN`, `EX WM - 250 mm`
3. The current LLM loop (each ≤16-tile batch independently emits a *complete takeoff*; merge = concat + string dedup) is the structural cause of dual-label duplicates, CB over-counts, and the huge run-to-run variance that forces `GOLDEN_REPEATS=3` VM runs (~$ + ~20 min each).
4. `evaluate-golden.ts` persists the full facts JSON to `<project>/generated_spreadsheets/predicted_facts.json` (line ~122). Anything attached to the facts object persists for free — this is how transcripts get cached.

## File Structure

```
webapp/src/lib/
  pdf-text.ts              NEW  positioned text extraction + page classification (pdfjs-dist)
  pdf-text.test.ts         NEW
  callout-parser.ts        NEW  pure callout grammar (runs/structures/elevations/watermain)
  callout-parser.test.ts   NEW
  reconcile.ts             NEW  pure global consistency layer + takeoff merging
  reconcile.test.ts        NEW
  text-takeoff.ts          NEW  positioned text -> TakeoffFacts (spatial assembly)
  text-takeoff.test.ts     NEW
  transcript-takeoff.ts    NEW  tile transcripts -> TakeoffFacts
  transcript-takeoff.test.ts NEW
  golden-set.ts            NEW  single source of truth for GOLDEN_PROJECTS/FOCUS_SET
  types.ts                 MOD  add TileTranscript + optional TakeoffFacts.transcript
  modular-prompts.ts       MOD  add getTranscriptionPrompt()
  extraction.ts            MOD  add EXTRACTION_MODE=transcribe|hybrid branches
webapp/src/scripts/
  evaluate-golden.ts       MOD  import golden set from lib/golden-set.ts
  evaluate-text.ts         NEW  $0 eval: text-layer path vs truth vs cached LLM predictions
  score-manual-facts.ts    NEW  ceiling-calibration harness (score hand-transcribed facts)
  assemble-from-transcripts.ts NEW  $0 re-assembly + re-scoring from persisted transcripts
webapp/package.json        MOD  scripts: evaluate:text, score:manual, assemble:transcripts
EVAL_METHODOLOGY.md        MOD  ceiling-calibration + offline transcript loop sections
CLAUDE.md                  MOD  pipeline description update (final task)
```

Dependency order: Task 1 → 2 → 3 → 4 → 5 (Phase A, shippable alone). Task 6 (Phase B) depends only on existing code. Tasks 7 → 8 → 9 → 10 (Phase C) depend on Tasks 2 and 3.

---

## Phase A — Deterministic text-layer path

### Task 1: `pdf-text.ts` — positioned text extraction + page classification

**Files:**
- Create: `webapp/src/lib/pdf-text.ts`
- Test: `webapp/src/lib/pdf-text.test.ts`

**Interfaces:**
- Consumes: `pdfjs-dist/legacy/build/pdf.mjs` (same import pattern as `src/lib/rasterize.ts:50-64` — read that file first and mirror its `NodeCanvasFactory`-free document loading).
- Produces (later tasks import these exact names):

```ts
export interface PositionedText {
  text: string;   // the item's string, trimmed
  x: number;      // PDF user-space coords (origin bottom-left)
  y: number;
  width: number;
  height: number;
}
export interface PageText {
  page: number;             // 1-indexed
  width: number;            // page width in PDF points
  height: number;
  items: PositionedText[];
}
export async function extractPageText(pdfBuffer: Buffer, pages?: number[]): Promise<PageText[]>;
export function isTextyPage(pt: PageText): boolean;
```

- [ ] **Step 1: Write the failing test.** `pdf-lib` (already a dependency) generates the fixture in-test — no dataset access.

```ts
// webapp/src/lib/pdf-text.test.ts
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPageText, isTextyPage } from './pdf-text';

async function makeFixturePdf(lines: { text: string; x: number; y: number }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const l of lines) page.drawText(l.text, { x: l.x, y: l.y, size: 10, font });
  return Buffer.from(await doc.save());
}

describe('extractPageText', () => {
  it('returns items with text and coordinates', async () => {
    const buf = await makeFixturePdf([
      { text: '83.7m-375mm SAN @ 0.02%', x: 100, y: 700 },
      { text: 'STMH 1', x: 100, y: 650 },
    ]);
    const pages = await extractPageText(buf);
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(1);
    const texts = pages[0].items.map((i) => i.text);
    expect(texts.join(' ')).toContain('83.7m-375mm SAN @ 0.02%');
    expect(texts.join(' ')).toContain('STMH 1');
    const stmh = pages[0].items.find((i) => i.text.includes('STMH'))!;
    expect(stmh.x).toBeGreaterThan(50);
    expect(stmh.y).toBeGreaterThan(600);
  });

  it('respects the pages filter and skips out-of-range pages', async () => {
    const buf = await makeFixturePdf([{ text: 'only page', x: 50, y: 700 }]);
    const pages = await extractPageText(buf, [1, 99]);
    expect(pages).toHaveLength(1);
  });
});

describe('isTextyPage', () => {
  it('is false for pages with only title-block noise, true for callout-dense pages', async () => {
    const noise = await extractPageText(await makeFixturePdf([{ text: 'DRAWN BY: ML  SCALE 1:500', x: 50, y: 700 }]));
    expect(isTextyPage(noise[0])).toBe(false);
    const dense = await extractPageText(await makeFixturePdf(
      Array.from({ length: 12 }, (_, i) => ({ text: `${10 + i}.5m-250mm STM @ 0.50%  INV=221.${i}0`, x: 60, y: 700 - i * 20 }))
    ));
    expect(isTextyPage(dense[0])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run from `webapp/`: `npx vitest run src/lib/pdf-text.test.ts`. Expected: FAIL — cannot resolve `./pdf-text`.

- [ ] **Step 3: Implement `pdf-text.ts`.**

```ts
// webapp/src/lib/pdf-text.ts
/**
 * Positioned text extraction from PDF text layers.
 *
 * ~1/3 of the drawing corpus (TrueType CAD plots) carries the servicing callouts
 * as real text objects; for those, this module replaces vision entirely: exact
 * strings, exact coordinates, zero LLM cost. SHX plots/scans yield only
 * title-block text and are detected by isTextyPage() so the vision path can
 * take over (see extraction.ts EXTRACTION_MODE=hybrid).
 *
 * Coordinates are PDF user space (origin BOTTOM-LEFT, y grows upward).
 */

export interface PositionedText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageText {
  page: number;
  width: number;
  height: number;
  items: PositionedText[];
}

let pdfjsPromise: Promise<any> | null = null;
async function getPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
      try {
        lib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      } catch {
        lib.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
      }
      return lib;
    });
  }
  return pdfjsPromise;
}

export async function extractPageText(pdfBuffer: Buffer, pages?: number[]): Promise<PageText[]> {
  const lib = await getPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(pdfBuffer), isEvalSupported: false, useSystemFonts: true }).promise;
  const out: PageText[] = [];
  try {
    const wanted = pages && pages.length > 0 ? pages : Array.from({ length: doc.numPages }, (_, i) => i + 1);
    for (const pageNum of wanted) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items: PositionedText[] = [];
        for (const it of content.items as any[]) {
          const text = String(it.str || '').trim();
          if (!text) continue;
          // transform = [a, b, c, d, e, f]; e/f are the glyph origin in user space.
          items.push({ text, x: it.transform[4], y: it.transform[5], width: it.width ?? 0, height: it.height ?? 0 });
        }
        out.push({ page: pageNum, width: viewport.width, height: viewport.height, items });
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.destroy?.();
  }
  return out;
}

// A page is "texty" (text-layer path viable) when its callout-keyword density is
// high enough that the drawing annotations — not just the title block — are text.
// Thresholds calibrated on the golden corpus: texty servicing sheets show 100+
// keyword hits; SHX/raster sheets show <10 (all from the title block).
const CALLOUT_KW = /\b(STM|SAN(?:ITARY)?|STORM|INV|PVC|HDPE|CBMH|DCBMH|DICB|WATERMAIN|WM|T\/G)\b|\d+\s*mm|@\s*\d/gi;

export function isTextyPage(pt: PageText): boolean {
  const joined = pt.items.map((i) => i.text).join(' ');
  const hits = joined.match(CALLOUT_KW)?.length ?? 0;
  return hits >= 10;
}
```

- [ ] **Step 4: Run test to verify it passes.** `npx vitest run src/lib/pdf-text.test.ts` → PASS. Also run `npx tsc --noEmit`.
- [ ] **Step 5: Smoke-check against a real texty PDF (manual verification, not a unit test).** Run: `npx tsx -e "import('./src/lib/pdf-text').then(async m => { const fs = require('fs'); const buf = fs.readFileSync('../existing_projects_training_data/2026-021 MATTHEWS HANGER WATERLOO/Field Aerospace Hanger - Drawing Package - 13 FEB 2026.pdf'); const pages = await m.extractPageText(buf); for (const p of pages) console.log('page', p.page, 'items', p.items.length, 'texty', m.isTextyPage(p)); })"` — expect page 3 to report hundreds of items and `texty true`. (Skip without failing if the dataset is absent.)
- [ ] **Step 6: Commit.** `git add webapp/src/lib/pdf-text.ts webapp/src/lib/pdf-text.test.ts && git commit -m "feat(extraction): positioned PDF text-layer extraction + texty-page classifier"`

---

### Task 2: `callout-parser.ts` — the callout grammar (pure)

**Files:**
- Create: `webapp/src/lib/callout-parser.ts`
- Test: `webapp/src/lib/callout-parser.test.ts`

**Interfaces:**
- Consumes: `snapToPipeDiameter`, `normalizeSlope` from `./geometry`.
- Produces (later tasks import these exact names):

```ts
export interface ParsedRun { length: number; diameterMm: number; system: 'STORM' | 'SAN' | 'UNKNOWN'; material: string | null; typeClass: number | null; slopePct: number | null; existing: boolean; }
export interface ParsedStructure { label: string; kind: 'MH' | 'CBMH' | 'DCBMH' | 'CB' | 'DCB' | 'DICB' | 'DDICB' | 'HS' | 'OS'; diameterMm: number | null; existing: boolean; }
export interface ParsedElevation { type: 'TG' | 'INV'; direction: string | null; value: number; }
export interface ParsedWatermain { diameterMm: number; lengthM: number | null; material: string | null; existing: boolean; }
export function parseRunCallout(line: string): ParsedRun | null;
export function parseStructureLabel(line: string): ParsedStructure | null;
export function parseElevation(line: string): ParsedElevation | null;
export function parseWatermainCallout(line: string): ParsedWatermain | null;
export function isDanglingRunHead(line: string): boolean;   // "EX SAN 87.4m - 250mmØ" (no slope yet)
export function isRunContinuation(line: string): boolean;   // "DR 35 @ 0.05%"
```

- [ ] **Step 1: Write the failing test.** Every fixture string below is verbatim from the corpus — do not "clean them up".

```ts
// webapp/src/lib/callout-parser.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseRunCallout, parseStructureLabel, parseElevation, parseWatermainCallout,
  isDanglingRunHead, isRunContinuation,
} from './callout-parser';

describe('parseRunCallout', () => {
  it('parses the dash form with system and slope', () => {
    expect(parseRunCallout('83.7m-375mmØ SAN @ 0.02%')).toEqual({
      length: 83.7, diameterMm: 375, system: 'SAN', material: null, typeClass: null, slopePct: 0.02, existing: false,
    });
  });
  it('parses the EX + material form', () => {
    expect(parseRunCallout('EX SAN 7.2m - 250mmØ DR 35 @ 0.05%')).toEqual({
      length: 7.2, diameterMm: 250, system: 'SAN', material: 'DR 35', typeClass: 35, slopePct: 0.05, existing: true,
    });
  });
  it('parses storm with PVC material', () => {
    const r = parseRunCallout('45.0m - 250mm PVC STM @ 0.5%')!;
    expect(r.system).toBe('STORM');
    expect(r.material).toBe('PVC');
    expect(r.diameterMm).toBe(250);
    expect(r.slopePct).toBe(0.5);
  });
  it('normalizes per-mille slope', () => {
    // 20‰ written as "@ 20‰" or "@ 20" on some sets -> 2.0%
    expect(parseRunCallout('30.0m-200mmØ SAN @ 20‰')!.slopePct).toBe(2.0);
  });
  it('snaps near-miss diameters to the standard series', () => {
    expect(parseRunCallout('12.0m-374mmØ STM @ 1.0%')!.diameterMm).toBe(375);
  });
  it('returns null for non-run text', () => {
    expect(parseRunCallout('T/G=224.95')).toBeNull();
    expect(parseRunCallout('DRAWN BY: ML')).toBeNull();
    expect(parseRunCallout('EX. 300 mmØ PVC WATERMAIN')).toBeNull(); // watermain, not sewer
  });
});

describe('dangling run heads (callout split across two text lines)', () => {
  it('detects head and continuation', () => {
    expect(isDanglingRunHead('EX SAN 87.4m - 250mmØ')).toBe(true);
    expect(isDanglingRunHead('83.7m-375mmØ SAN @ 0.02%')).toBe(false);
    expect(isRunContinuation('DR 35 @ 0.05%')).toBe(true);
    expect(isRunContinuation('STMH 1')).toBe(false);
  });
  it('parses head+continuation when joined', () => {
    const r = parseRunCallout('EX SAN 87.4m - 250mmØ DR 35 @ 0.05%')!;
    expect(r.length).toBe(87.4);
    expect(r.typeClass).toBe(35);
  });
});

describe('parseStructureLabel', () => {
  it('parses concatenated CAD ids with diameter', () => {
    expect(parseStructureLabel('EX CBMH1035 (1200Ø)')).toEqual({
      label: 'CBMH1035', kind: 'CBMH', diameterMm: 1200, existing: true,
    });
  });
  it('parses spaced ids', () => {
    expect(parseStructureLabel('STMH 1')).toEqual({ label: 'STMH 1', kind: 'MH', diameterMm: null, existing: false });
    expect(parseStructureLabel('EX SAN MH 02')).toEqual({ label: 'MH 02', kind: 'MH', diameterMm: null, existing: true });
    expect(parseStructureLabel('MH 101')).toEqual({ label: 'MH 101', kind: 'MH', diameterMm: null, existing: false });
    expect(parseStructureLabel('DCBMH 2')!.kind).toBe('DCBMH');
    expect(parseStructureLabel('DICB 3')!.kind).toBe('DICB');
  });
  it('requires an id number (legend-entry "CB" alone is not a structure)', () => {
    expect(parseStructureLabel('CB')).toBeNull();
    expect(parseStructureLabel('WM')).toBeNull();
    expect(parseStructureLabel('CB 10')!.kind).toBe('CB');
  });
});

describe('parseElevation', () => {
  it('parses T/G and directional inverts, both = styles', () => {
    expect(parseElevation('T/G=224.95')).toEqual({ type: 'TG', direction: null, value: 224.95 });
    expect(parseElevation('T/G = 312.46')).toEqual({ type: 'TG', direction: null, value: 312.46 });
    expect(parseElevation('N INV=223.350')).toEqual({ type: 'INV', direction: 'N', value: 223.35 });
    expect(parseElevation('SW INV = 310.60')).toEqual({ type: 'INV', direction: 'SW', value: 310.6 });
  });
  it('rejects run callouts and plain numbers', () => {
    expect(parseElevation('83.7m-375mmØ SAN @ 0.02%')).toBeNull();
    expect(parseElevation('224.95')).toBeNull();
  });
});

describe('parseWatermainCallout', () => {
  it('parses the corpus forms', () => {
    expect(parseWatermainCallout('EX. 300 mmØ PVC WATERMAIN')).toEqual({
      diameterMm: 300, lengthM: null, material: 'PVC', existing: true,
    });
    expect(parseWatermainCallout('EX WM - 250 mm')).toEqual({ diameterMm: 250, lengthM: null, material: null, existing: true });
    expect(parseWatermainCallout('124.0m - 150mmØ PVC WM')).toEqual({ diameterMm: 150, lengthM: 124.0, material: 'PVC', existing: false });
  });
  it('rejects sewer callouts', () => {
    expect(parseWatermainCallout('83.7m-375mmØ SAN @ 0.02%')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** `npx vitest run src/lib/callout-parser.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `callout-parser.ts`.**

```ts
// webapp/src/lib/callout-parser.ts
/**
 * Grammar for civil-drawing callout strings. Pure, no I/O.
 *
 * The callout language on Ontario servicing drawings is rigidly formulaic:
 *   runs:        "83.7m-375mmØ SAN @ 0.02%", "EX SAN 7.2m - 250mmØ DR 35 @ 0.05%"
 *   structures:  "EX CBMH1035 (1200Ø)", "STMH 1", "MH 101"
 *   elevations:  "T/G=224.95", "N INV=223.350", "SW INV = 310.60"
 *   watermain:   "EX. 300 mmØ PVC WATERMAIN", "EX WM - 250 mm"
 * These parsers are the single place that grammar lives; both the text-layer
 * path (text-takeoff.ts) and the vision-transcript path (transcript-takeoff.ts)
 * feed through them.
 */
import { snapToPipeDiameter, normalizeSlope } from './geometry';

export interface ParsedRun {
  length: number;
  diameterMm: number;
  system: 'STORM' | 'SAN' | 'UNKNOWN';
  material: string | null;
  typeClass: number | null;
  slopePct: number | null;
  existing: boolean;
}
export interface ParsedStructure {
  label: string;
  kind: 'MH' | 'CBMH' | 'DCBMH' | 'CB' | 'DCB' | 'DICB' | 'DDICB' | 'HS' | 'OS';
  diameterMm: number | null;
  existing: boolean;
}
export interface ParsedElevation { type: 'TG' | 'INV'; direction: string | null; value: number; }
export interface ParsedWatermain { diameterMm: number; lengthM: number | null; material: string | null; existing: boolean; }

const EX_RE = /(^|\s)EX\.?(\s|$)/i;
// length + diameter core: "83.7m-375mmØ", "7.2m - 250mmØ", "45.0m - 250mm"
const LEN_DIA_RE = /(\d+(?:\.\d+)?)\s*m\b\s*(?:-|–|of)?\s*(\d{2,4})\s*mm/i;
const SLOPE_RE = /@\s*(\d+(?:\.\d+)?)\s*(%|‰)?/;
const MATERIAL_RE = /\b(PVC|HDPE|CONC|CSP|(?:S?DR)\s*(\d{1,3}))\b/i;
const WM_RE = /\b(WATERMAIN|WM)\b/i;

export function parseRunCallout(line: string): ParsedRun | null {
  if (WM_RE.test(line)) return null; // watermain callouts share the mm form
  const core = LEN_DIA_RE.exec(line);
  if (!core) return null;
  const slope = SLOPE_RE.exec(line);
  const mat = MATERIAL_RE.exec(line);
  const system = /\b(SAN|SANITARY)\b/i.test(line) ? 'SAN'
    : /\b(STM|STORM)\b/i.test(line) ? 'STORM' : 'UNKNOWN';
  let slopePct: number | null = null;
  if (slope) {
    const v = parseFloat(slope[1]);
    slopePct = slope[2] === '‰' ? v / 10 : normalizeSlope(v);
  }
  return {
    length: parseFloat(core[1]),
    diameterMm: snapToPipeDiameter(parseInt(core[2], 10)),
    system,
    material: mat ? mat[1].replace(/\s+/g, ' ').trim() : null,
    typeClass: mat && mat[2] ? parseInt(mat[2], 10) : null,
    slopePct,
    existing: EX_RE.test(line),
  };
}

export function isDanglingRunHead(line: string): boolean {
  return LEN_DIA_RE.test(line) && !SLOPE_RE.test(line) && !MATERIAL_RE.test(line) && !WM_RE.test(line);
}
export function isRunContinuation(line: string): boolean {
  return !LEN_DIA_RE.test(line) && (SLOPE_RE.test(line) || MATERIAL_RE.test(line)) && !WM_RE.test(line)
    && parseElevation(line) === null;
}

// Longest-first so CBMH wins over CB, DCBMH over DCB, etc. STMH/SANMH normalize to MH
// (the estimator's sheet drops the system qualifier — see compare-facts stripSystemPrefix).
const STRUCT_RE = /(?:^|\s)(?:EX\.?\s+)?(?:(?:SAN(?:ITARY)?|STM|STORM)\s+)?(DDICB|DCBMH|DICB|CBMH|DCB|STMH|SANMH|CB|MH|HS|OS)\s?-?\s?(\d+[A-Z]?)\s*(?:\((\d{3,4})\s*[ØO]?\))?/i;

export function parseStructureLabel(line: string): ParsedStructure | null {
  const m = STRUCT_RE.exec(line);
  if (!m) return null;
  const rawKind = m[1].toUpperCase();
  const kind = (rawKind === 'STMH' || rawKind === 'SANMH' ? 'MH' : rawKind) as ParsedStructure['kind'];
  // Preserve the drawing's own label text (normalizeLabel handles matching later),
  // but keep the STMH/SANMH prefix in the label — compare-facts strips it.
  const hadSpace = /\s/.test(line.slice(m.index).trim().slice(m[1].length, m[1].length + 1));
  const label = `${m[1].toUpperCase()}${hadSpace ? ' ' : ''}${m[2].toUpperCase()}`;
  return {
    label,
    kind,
    diameterMm: m[3] ? parseInt(m[3], 10) : null,
    existing: EX_RE.test(line.slice(0, m.index + 1)) || /^EX\.?\s/i.test(line),
  };
}

const ELEV_RE = /^\s*(?:([NSEW]{1,2})\s+)?(T\/G|INV(?:ERT)?\.?)\s*=?\s*(\d{2,3}(?:\.\d{1,3})?)\s*±?\s*$/i;

export function parseElevation(line: string): ParsedElevation | null {
  const m = ELEV_RE.exec(line);
  if (!m) return null;
  return {
    type: m[2].toUpperCase().startsWith('T/G') ? 'TG' : 'INV',
    direction: m[1] ? m[1].toUpperCase() : null,
    value: parseFloat(m[3]),
  };
}

export function parseWatermainCallout(line: string): ParsedWatermain | null {
  if (!WM_RE.test(line)) return null;
  const dia = /(\d{2,4})\s*mm/i.exec(line);
  if (!dia) return null;
  const len = /(\d+(?:\.\d+)?)\s*m\b(?!m)/i.exec(line);
  const mat = /\b(PVC|HDPE|CONC|DI|CPP)\b/i.exec(line);
  return {
    diameterMm: parseInt(dia[1], 10),
    lengthM: len ? parseFloat(len[1]) : null,
    material: mat ? mat[1].toUpperCase() : null,
    existing: EX_RE.test(line),
  };
}
```

Note for the implementer: `parseStructureLabel` on `'STMH 1'` must return label `'STMH 1'` but kind `'MH'`; the test asserts label `'STMH 1'`. For `'EX SAN MH 02'` the SAN qualifier is consumed by the optional system group so label is `'MH 02'`. For `'EX CBMH1035 (1200Ø)'` there is no space between code and id so label is `'CBMH1035'`. If the regex as written fights you on the label-spacing detail, simplify: reconstruct label as `m[1].toUpperCase() + (line.includes(m[1] + ' ') ? ' ' : '') + m[2]` — the tests define the contract.

- [ ] **Step 4: Run tests.** `npx vitest run src/lib/callout-parser.test.ts` → PASS. Check `snapToPipeDiameter`/`normalizeSlope` signatures in `src/lib/geometry.ts` first if anything type-errors. `npx tsc --noEmit` green.
- [ ] **Step 5: Commit.** `git commit -am "feat(extraction): pure callout grammar parser (runs/structures/elevations/watermain)"`

---

### Task 3: `reconcile.ts` — global consistency layer (pure)

Built before the assemblers because both (text + transcript) end with it.

**Files:**
- Create: `webapp/src/lib/reconcile.ts`
- Test: `webapp/src/lib/reconcile.test.ts`

**Interfaces:**
- Consumes: `normalizeLabel`, `runSignature` from `./compare-facts`; `mergeCatchbasinGroups` from `./extraction`; `TakeoffFacts` from `./types`.
- Produces:

```ts
export function reconcileTakeoff(facts: TakeoffFacts): TakeoffFacts;   // pure; returns a new object
export function mergeTakeoffs(primary: TakeoffFacts, secondary: TakeoffFacts): TakeoffFacts; // primary wins on label conflicts
```

Reconciliation rules (this is the layer that kills the failure classes the LLM loop couldn't):
1. **Structures**: group by `normalizeLabel(description)`; merge each group into one record keeping the first non-null value per field. Drop records whose normalized label is empty.
2. **Dual-labeled run kill**: two sewer runs are the *same pipe* when `pipeDiameter` matches and `|lengthA - lengthB| <= max(1, 0.02 * length)`. When one's `runSignature` contains a `-`-separated endpoint pair (2+ tokens) and the other's is a single schedule token (e.g. `ST11`), keep the endpoint-labeled one. When both have the same signature, keep the one with more non-null fields.
3. **Catchbasin groups**: pass through `mergeCatchbasinGroups` (max-per-type across fragments).
4. Watermain: dedupe exact duplicates on (`pipeDiameter`, `length`).

- [ ] **Step 1: Write the failing test.**

```ts
// webapp/src/lib/reconcile.test.ts
import { describe, it, expect } from 'vitest';
import { reconcileTakeoff, mergeTakeoffs } from './reconcile';
import { TakeoffFacts, SewerFact, StructureFact } from './types';

const emptyFacts = (over: Partial<TakeoffFacts> = {}): TakeoffFacts => ({
  projectName: 'T', jobNumber: '', date: '',
  structures: [], catchbasins: [], sewers: [], watermain: [],
  watermainSpecials: [], watermainValves: [], confidence: 1, warnings: [], ...over,
});
const run = (over: Partial<SewerFact>): SewerFact => ({
  runLabel: '', isLineItem: false, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, ...over,
});
const struct = (over: Partial<StructureFact>): StructureFact => ({
  description: '', topElevation: null, lowInvert: null, highInvert: null,
  pipeOutDiameter: null, structureType: null, depth: null, ...over,
});

describe('reconcileTakeoff', () => {
  it('kills the dual-label duplicate, keeping the endpoint-labeled run', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'STMH 10-STMH 11', length: 42.0, pipeDiameter: 300, slope: 1.0 }),
        run({ runLabel: 'ST11', length: 42.3, pipeDiameter: 300 }), // same physical pipe, schedule id
        run({ runLabel: 'ST12', length: 18.0, pipeDiameter: 250 }), // different pipe — must survive
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(2);
    expect(r.sewers.map((s) => s.runLabel)).toContain('STMH 10-STMH 11');
    expect(r.sewers.map((s) => s.runLabel)).toContain('ST12');
  });

  it('merges duplicate structures across fragments, keeping the most complete data', () => {
    const facts = emptyFacts({
      structures: [
        struct({ description: 'STMH 1', topElevation: 224.95 }),
        struct({ description: 'MH 1', lowInvert: 221.4 }),   // same structure: STMH 1 == MH 1 after normalizeLabel
        struct({ description: 'CBMH 2', topElevation: 225.1 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.structures).toHaveLength(2);
    const mh1 = r.structures.find((s) => s.description.includes('1'))!;
    expect(mh1.topElevation).toBe(224.95);
    expect(mh1.lowInvert).toBe(221.4);
  });

  it('is idempotent', () => {
    const facts = emptyFacts({ sewers: [run({ runLabel: 'MH 1-MH 2', length: 10, pipeDiameter: 200 })] });
    expect(reconcileTakeoff(reconcileTakeoff(facts))).toEqual(reconcileTakeoff(facts));
  });
});

describe('mergeTakeoffs', () => {
  it('primary wins on structure-label conflicts; union otherwise', () => {
    const a = emptyFacts({ structures: [struct({ description: 'MH 1', topElevation: 100 })] });
    const b = emptyFacts({
      structures: [struct({ description: 'MH 1', topElevation: 999 }), struct({ description: 'MH 2' })],
      sewers: [run({ runLabel: 'MH 1-MH 2', length: 20, pipeDiameter: 250 })],
    });
    const m = mergeTakeoffs(a, b);
    expect(m.structures).toHaveLength(2);
    expect(m.structures.find((s) => s.description === 'MH 1')!.topElevation).toBe(100);
    expect(m.sewers).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify FAIL.** `npx vitest run src/lib/reconcile.test.ts`.

- [ ] **Step 3: Implement.**

```ts
// webapp/src/lib/reconcile.ts
/**
 * Global consistency layer for TakeoffFacts. Every extraction path (text-layer,
 * vision transcript, legacy LLM) ends here: one entity per physical thing.
 * Pure — the offline re-assembly loop (assemble-from-transcripts.ts) depends on
 * being able to re-run this for free against cached inputs.
 */
import { TakeoffFacts, StructureFact, SewerFact } from './types';
import { normalizeLabel, runSignature } from './compare-facts';
import { mergeCatchbasinGroups } from './extraction';

const nonNullCount = (o: object) => Object.values(o).filter((v) => v !== null && v !== '').length;

function mergeStructureGroup(group: StructureFact[]): StructureFact {
  const out = { ...group[0] };
  for (const s of group.slice(1)) {
    for (const k of ['topElevation', 'lowInvert', 'highInvert', 'pipeOutDiameter', 'structureType', 'depth'] as const) {
      if (out[k] == null && s[k] != null) (out as any)[k] = s[k];
    }
  }
  return out;
}

function samePipe(a: SewerFact, b: SewerFact): boolean {
  if (a.pipeDiameter == null || b.pipeDiameter == null || a.pipeDiameter !== b.pipeDiameter) return false;
  if (a.length == null || b.length == null) return false;
  return Math.abs(a.length - b.length) <= Math.max(1, 0.02 * Math.max(a.length, b.length));
}

const isEndpointPair = (s: SewerFact) => runSignature(s.runLabel).includes('|');

export function reconcileTakeoff(facts: TakeoffFacts): TakeoffFacts {
  // 1. structures: merge by normalized label
  const byLabel = new Map<string, StructureFact[]>();
  for (const s of facts.structures) {
    const k = normalizeLabel(s.description);
    if (!k) continue;
    (byLabel.get(k) ?? byLabel.set(k, []).get(k)!).push(s);
  }
  const structures = Array.from(byLabel.values()).map(mergeStructureGroup);

  // 2. sewers: exact-signature dedupe (keep most complete), then dual-label kill
  const bySig = new Map<string, SewerFact>();
  const sewers: SewerFact[] = [];
  for (const s of facts.sewers) {
    const sig = runSignature(s.runLabel);
    const prev = sig ? bySig.get(sig) : undefined;
    if (prev) {
      if (nonNullCount(s) > nonNullCount(prev)) { sewers[sewers.indexOf(prev)] = s; bySig.set(sig, s); }
      continue;
    }
    if (sig) bySig.set(sig, s);
    sewers.push(s);
  }
  const kill = new Set<SewerFact>();
  for (const a of sewers) {
    if (kill.has(a) || !isEndpointPair(a)) continue;
    for (const b of sewers) {
      if (a === b || kill.has(b) || isEndpointPair(b)) continue;
      if (samePipe(a, b)) kill.add(b); // b is the schedule-id duplicate of endpoint-labeled a
    }
  }

  // 4. watermain exact dedupe
  const wmSeen = new Set<string>();
  const watermain = facts.watermain.filter((w) => {
    const k = `${w.pipeDiameter}|${w.length}`;
    if (wmSeen.has(k)) return false;
    wmSeen.add(k);
    return true;
  });

  return {
    ...facts,
    structures,
    sewers: sewers.filter((s) => !kill.has(s)),
    catchbasins: mergeCatchbasinGroups(facts.catchbasins) as TakeoffFacts['catchbasins'],
    watermain,
  };
}

export function mergeTakeoffs(primary: TakeoffFacts, secondary: TakeoffFacts): TakeoffFacts {
  const primaryLabels = new Set(primary.structures.map((s) => normalizeLabel(s.description)));
  return reconcileTakeoff({
    ...primary,
    structures: [...primary.structures, ...secondary.structures.filter((s) => !primaryLabels.has(normalizeLabel(s.description)))],
    sewers: [...primary.sewers, ...secondary.sewers],
    catchbasins: [...primary.catchbasins, ...secondary.catchbasins],
    watermain: [...primary.watermain, ...secondary.watermain],
    watermainSpecials: [...primary.watermainSpecials, ...secondary.watermainSpecials],
    watermainValves: [...primary.watermainValves, ...secondary.watermainValves],
    warnings: [...primary.warnings, ...secondary.warnings],
  });
}
```

Implementation note: check `mergeCatchbasinGroups`'s actual signature in `extraction.ts` (~line 947) — it takes/returns the raw `groups` array shape. If its input type is `any[]`, the cast shown is fine; if it expects `{type, quantity, ...}` objects it maps 1:1 onto `CatchbasinGroupFact`.

- [ ] **Step 4: Run tests.** `npx vitest run src/lib/reconcile.test.ts` → PASS; `npm test` full suite green (importing `extraction.ts` pulls in its module-level env reads — if that breaks vitest, extract `mergeCatchbasinGroups` into `reconcile.ts` (move, not copy: update `extraction.ts` to import it from `./reconcile`) and note it in the commit message). `npx tsc --noEmit` green.
- [ ] **Step 5: Commit.** `git commit -am "feat(extraction): reconcile layer — structure merge, dual-label run kill, CB consolidation"`

---

### Task 4: `text-takeoff.ts` — spatial assembly of the text layer

**Files:**
- Create: `webapp/src/lib/text-takeoff.ts`
- Test: `webapp/src/lib/text-takeoff.test.ts`

**Interfaces:**
- Consumes: `PageText`, `PositionedText` from `./pdf-text`; all parsers from `./callout-parser`; `reconcileTakeoff` from `./reconcile`; `TakeoffFacts` from `./types`.
- Produces:

```ts
export function assembleTextTakeoff(pages: PageText[], projectName: string): TakeoffFacts;
```

Assembly algorithm (deterministic, all steps):
1. For each page, take items in document order. Merge split callouts: if `isDanglingRunHead(item.text)`, find the spatially nearest item within 40pt (euclidean, same page) whose text `isRunContinuation`; join with a space and consume both.
2. Classify every (merged) line: `parseRunCallout` → run; else `parseStructureLabel` → structure; else `parseElevation` → elevation; else `parseWatermainCallout` → watermain; else ignore.
3. Elevation association: attach each elevation to the nearest structure item on the same page within 100pt (euclidean between item origins). `TG` → `topElevation`; `INV` values accumulate → `lowInvert = min`, `highInvert = max` (only set `highInvert` when ≥2 inverts). Unassociated elevations are dropped.
4. Filter `existing: true` everywhere (EX = not in the takeoff).
5. Structures whose kind is `CB | DCB | DICB | DDICB` become catchbasin group counts, NOT structure rows: count distinct normalized labels per kind → `SINGLE_CB | DOUBLE_CB | DITCH_INLET_CB | DOUBLE_DITCH_INLET_CB` with `wallThickness: null, depth: null`. Kinds `MH | CBMH | DCBMH | HS | OS` become `StructureFact`s (`structureType: null, depth: null`, `pipeOutDiameter: null` — the CAD `(1200Ø)` is the *barrel* diameter, not pipe-out; do not put it in `pipeOutDiameter`).
6. Runs become `SewerFact`s with `runLabel = `${length}m-${diameterMm}mm${system === 'SAN' ? ' SAN' : system === 'STORM' ? ' STM' : ''}``, `isLineItem: false`, `slope = slopePct`, `depth: null`. (Dimension-style labels are intentional: `compare-facts.ts` phase-2 attribute matching pairs them with the estimator's endpoint labels by diameter+length.)
7. Watermain callouts with a `lengthM` become `WatermainFact`s (`ocSc: 1.1, avgCover: 1.8` — the defaults `truth-facts.ts` uses); without a length they are dropped (v1 — lengths come from schedules we can't see here; YAGNI).
8. Return `reconcileTakeoff({...})` with `confidence: 1`, `warnings: []`, `jobNumber: ''`, `date: ''`.

- [ ] **Step 1: Write the failing test.** Build `PageText` fixtures directly (no PDF needed — that's Task 1's job).

```ts
// webapp/src/lib/text-takeoff.test.ts
import { describe, it, expect } from 'vitest';
import { assembleTextTakeoff } from './text-takeoff';
import { PageText } from './pdf-text';

const page = (items: { text: string; x: number; y: number }[]): PageText => ({
  page: 1, width: 2592, height: 1728,
  items: items.map((i) => ({ ...i, width: 50, height: 8 })),
});

describe('assembleTextTakeoff', () => {
  it('assembles structures with associated elevations', () => {
    const facts = assembleTextTakeoff([page([
      { text: 'EX SAN MH 02', x: 100, y: 500 },   // existing — excluded
      { text: 'STMH 1', x: 400, y: 500 },
      { text: 'T/G=224.95', x: 402, y: 490 },
      { text: 'N INV=223.350', x: 402, y: 480 },
      { text: 'S INV=223.250', x: 402, y: 470 },
      { text: 'T/G=999.99', x: 2000, y: 100 },     // orphan elevation — dropped
    ])], 'T');
    expect(facts.structures).toHaveLength(1);
    const s = facts.structures[0];
    expect(s.description).toBe('STMH 1');
    expect(s.topElevation).toBe(224.95);
    expect(s.lowInvert).toBe(223.25);
    expect(s.highInvert).toBe(223.35);
  });

  it('assembles runs, merging split callouts, excluding existing', () => {
    const facts = assembleTextTakeoff([page([
      { text: '83.7m-375mmØ SAN @ 0.02%', x: 100, y: 800 },
      { text: '45.0m - 250mmØ', x: 300, y: 700 },       // dangling head…
      { text: 'PVC STM @ 0.50%', x: 305, y: 692 },      // …continuation just below
      { text: 'EX SAN 7.2m - 250mmØ DR 35 @ 0.05%', x: 900, y: 600 }, // existing — excluded
    ])], 'T');
    expect(facts.sewers).toHaveLength(2);
    const dims = facts.sewers.map((s) => `${s.length}/${s.pipeDiameter}`).sort();
    expect(dims).toEqual(['45/250', '83.7/375']);
    expect(facts.sewers.find((s) => s.pipeDiameter === 250)!.slope).toBe(0.5);
  });

  it('counts CB kinds as catchbasin groups, not structures', () => {
    const facts = assembleTextTakeoff([page([
      { text: 'CB 1', x: 100, y: 500 }, { text: 'CB 2', x: 300, y: 500 },
      { text: 'CB 2', x: 700, y: 200 },  // duplicate label (appears on 2 sheets) — counted once
      { text: 'DCB 1', x: 500, y: 500 },
      { text: 'CBMH 3', x: 600, y: 400 }, // CBMH is a structure, not a CB group
    ])], 'T');
    expect(facts.structures.map((s) => s.description)).toEqual(['CBMH 3']);
    expect(facts.catchbasins).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'SINGLE_CB', quantity: 2 }),
      expect.objectContaining({ type: 'DOUBLE_CB', quantity: 1 }),
    ]));
  });

  it('keeps watermain only when a length is present', () => {
    const facts = assembleTextTakeoff([page([
      { text: '124.0m - 150mmØ PVC WM', x: 100, y: 500 },
      { text: 'EX WM - 250 mm', x: 300, y: 500 },
    ])], 'T');
    expect(facts.watermain).toHaveLength(1);
    expect(facts.watermain[0]).toMatchObject({ length: 124, pipeDiameter: 150 });
  });
});
```

- [ ] **Step 2: Run to verify FAIL**, then **Step 3: implement** following the 8-step algorithm above (it maps 1:1 onto code; the CB-kind→group-type map is `{ CB: 'SINGLE_CB', DCB: 'DOUBLE_CB', DICB: 'DITCH_INLET_CB', DDICB: 'DOUBLE_DITCH_INLET_CB' }`). Keep it one exported function plus small local helpers; ~120 lines.
- [ ] **Step 4: Run tests + tsc.** `npx vitest run src/lib/text-takeoff.test.ts && npx tsc --noEmit` → PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(extraction): deterministic text-layer takeoff assembly"`

---

### Task 5: `evaluate-text.ts` — the $0 validation gate for Phase A

**Files:**
- Create: `webapp/src/lib/golden-set.ts`
- Create: `webapp/src/scripts/evaluate-text.ts`
- Modify: `webapp/src/scripts/evaluate-golden.ts` (lines ~31-56: move `GOLDEN_PROJECTS` + `FOCUS_SET` out, import from `../lib/golden-set`)
- Modify: `webapp/package.json` (add script `"evaluate:text": "tsx src/scripts/evaluate-text.ts"`)

**Interfaces:**
- Consumes: `extractPageText`, `isTextyPage` (Task 1); `assembleTextTakeoff` (Task 4); `resolveTruthFacts`, `loadTruthManifest` from `../lib/truth-facts`; `compareFacts`, `formatFactsComparison` from `../lib/compare-facts`; `dataset-manifest.json` at repo root (array of `{folder, drawingPdfs: [{name, pages}], truth: {...}}`).
- Produces: `golden-set.ts` exporting `export const GOLDEN_PROJECTS: { folder: string; label: string }[]` and `export const FOCUS_SET: string[]` — copy the arrays verbatim from `evaluate-golden.ts` (16 entries starting `2026-067 201 GEORGIAN DR,BARRIE`). This becomes the single golden-set definition; `evaluate-golden.ts` imports it.

Script behavior (no LLM calls anywhere):
1. For each golden project: read its `drawingPdfs` from `dataset-manifest.json`, run `extractPageText` on each, count texty pages via `isTextyPage`.
2. If ≥1 texty page: `assembleTextTakeoff(textyPagesOnly)` → `compareFacts` vs `resolveTruthFacts(projectDir, folder, loadTruthManifest(<repoRoot>/truth-manifest.json))`.
3. Read the cached LLM baseline from `<projectDir>/generated_spreadsheets/predicted_facts.json` if present, score it with `compareFacts` against the same truth.
4. Print a table: `project | textyPages/totalPages | textF1 | llmF1(cached) | truth counts`. Non-texty projects print `—` for textF1.
5. Exit 0 always (it's an analysis tool, not a gate).

- [ ] **Step 1: Create `golden-set.ts`** by cutting the two arrays from `evaluate-golden.ts` verbatim and re-importing them there. Run `npx tsc --noEmit` — green means the wiring is right. There is a second, older `GOLDEN_PROJECTS` in `constants.ts`; leave it (legacy consumers) but add a one-line comment there pointing at `golden-set.ts` as canonical.
- [ ] **Step 2: Write `evaluate-text.ts`.** Model the structure on `analyze-eval.ts` (same repo-root/dataset path resolution — read it first). Core loop:

```ts
// webapp/src/scripts/evaluate-text.ts  (skeleton — flesh out with the behavior spec above)
import fs from 'fs';
import path from 'path';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { extractPageText, isTextyPage } from '../lib/pdf-text';
import { assembleTextTakeoff } from '../lib/text-takeoff';
import { resolveTruthFacts, loadTruthManifest } from '../lib/truth-facts';
import { compareFacts, formatFactsComparison } from '../lib/compare-facts';

const ROOT = path.resolve(__dirname, '../../..');
const DATA = path.join(ROOT, 'existing_projects_training_data');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dataset-manifest.json'), 'utf8'));
const truthManifest = loadTruthManifest(path.join(ROOT, 'truth-manifest.json'));

async function main() {
  const rows: string[] = [];
  for (const g of GOLDEN_PROJECTS) {
    const entry = manifest.find((m: any) => m.folder === g.folder);
    const projectDir = path.join(DATA, g.folder);
    if (!entry || !fs.existsSync(projectDir)) { rows.push(`${g.label}: missing`); continue; }
    const truth = await resolveTruthFacts(projectDir, g.folder, truthManifest);
    if (!truth) { rows.push(`${g.label}: no truth`); continue; }

    let texty = 0, total = 0;
    const textyPages: import('../lib/pdf-text').PageText[] = [];
    for (const pdf of entry.drawingPdfs ?? []) {
      const p = path.join(projectDir, pdf.name);
      if (!fs.existsSync(p)) continue;
      const pages = await extractPageText(fs.readFileSync(p));
      total += pages.length;
      for (const pt of pages) if (isTextyPage(pt)) { texty++; textyPages.push(pt); }
    }

    let textF1 = null as number | null;
    if (textyPages.length > 0) {
      const facts = assembleTextTakeoff(textyPages, g.folder);
      const cmp = compareFacts(facts, truth.facts);
      textF1 = cmp.detectionF1;
      if (process.env.VERBOSE === 'true') console.log(g.label, formatFactsComparison(cmp));
    }

    let llmF1 = null as number | null;
    const pf = path.join(projectDir, 'generated_spreadsheets', 'predicted_facts.json');
    if (fs.existsSync(pf)) {
      llmF1 = compareFacts(JSON.parse(fs.readFileSync(pf, 'utf8')), truth.facts).detectionF1;
    }
    const pct = (v: number | null) => (v == null ? '   —' : `${(v * 100).toFixed(1)}%`);
    rows.push(`${g.label.padEnd(28)} texty ${String(texty).padStart(2)}/${String(total).padEnd(3)} textF1 ${pct(textF1)}  llmF1(cached) ${pct(llmF1)}`);
  }
  console.log('\nTEXT-LAYER PATH vs CACHED LLM (both scored with compare-facts vs manifest truth)\n');
  for (const r of rows) console.log('  ' + r);
}
main();
```

- [ ] **Step 3: Add the npm script and run it.** `npm run evaluate:text`. Expected outcome (this is the Phase A acceptance check): the ~5 texty projects (Bradford, Oakville, Matthews, Ultimate Drive, Holiday Inn) report a non-null textF1. **Success bar: textF1 ≥ cached llmF1 on at least 2 of them.** If textF1 is 0 on a texty project, debug with `VERBOSE=true` — the most likely causes are (a) callout variants the grammar misses (add them to `callout-parser.test.ts` as new fixtures — extend the grammar, never weaken existing tests) or (b) elevation-association radius; both are offline-iterable for free, which is the whole point.
- [ ] **Step 4: Full suite.** `npm test && npx tsc --noEmit` green (the golden-set move must not break `evaluate-golden.ts` — it still compiles and its `--help`-free top-level runs only under `tsx`, so compilation is the check).
- [ ] **Step 5: Commit.** `git commit -am "feat(eval): zero-cost text-layer eval + single golden-set module"`

---

## Phase B — Measure the ceiling (independent of Phase A/C)

### Task 6: `score-manual-facts.ts` — ceiling-calibration harness

**Why:** ground truth is an estimator's *stylistic* document (grouping conventions, label styles differ per project), so detF1 has an unknown per-project ceiling < 100%. Scoring a careful **human** transcription of a drawing against truth measures that ceiling. If a human scores ~75%, the model gap is real; if ~55%, effort must go to truth curation, not extraction. The human work happens outside this plan; this task builds the tooling.

**Files:**
- Create: `webapp/src/scripts/score-manual-facts.ts`
- Modify: `webapp/package.json` (add `"score:manual": "tsx src/scripts/score-manual-facts.ts"`)
- Modify: `EVAL_METHODOLOGY.md` (new section, content below)

**Interfaces:**
- Consumes: `resolveTruthFacts`, `loadTruthManifest`, `compareFacts`, `formatFactsComparison`, `TakeoffFacts` — all existing.
- Produces: CLI contract:
  - `npm run score:manual -- --init "<folder name>"` → writes `<projectDir>/manual_facts.json` skeleton (a valid empty `TakeoffFacts` with `projectName` set and a `_instructions` key explaining each array, listing the truth's entity counts so the transcriber knows the expected scale — read counts via `resolveTruthFacts` and embed e.g. `"_instructions": "Transcribe from the drawing PDFs only. Truth has 19 structures / 29 runs / 2 CB groups / 3 watermain — do NOT copy from the truth workbook."`). Refuses to overwrite an existing file.
  - `npm run score:manual -- "<folder name>"` → reads `manual_facts.json` (strip `_instructions` before parsing), scores with `compareFacts` vs resolved truth, prints `formatFactsComparison` PLUS a diff listing: every unmatched truth entity (`MISSED: <label/dims>`) and every unmatched prediction (`EXTRA: <label/dims>`), for structures and runs. The diff is the calibration payload — it shows *which* mismatches are convention vs. reading errors.

- [ ] **Step 1: Write the script.** No unit test needed for the CLI shell itself, but the diff logic must be a small exported pure function with a test:

```ts
// exported from score-manual-facts.ts and tested in webapp/src/scripts/score-manual-facts.test.ts
export function diffEntities(pred: TakeoffFacts, truth: TakeoffFacts): { missed: string[]; extra: string[] };
```

Test (place in `webapp/src/scripts/score-manual-facts.test.ts`): one truth with runs `[MH 1-MH 2 (20m/250mm)]` and structures `[MH 1]`, pred with runs `[MH 1-MH 2 (20m/250mm), ST9 (5m/200mm)]`, structures `[]` → `missed` contains `structure MH 1`, `extra` contains `run ST9`. Implement by re-using `matchSewerRuns` and `matchByKey`-equivalent matching from `compare-facts.ts` — `matchSewerRuns` is exported; for structures use `normalizeLabel` set-difference (matching there is per-label anyway).

- [ ] **Step 2: Run the test, implement, re-run.** `npx vitest run src/scripts/score-manual-facts.test.ts` → PASS.
- [ ] **Step 3: Add the EVAL_METHODOLOGY.md section** (append after "Bug-class checklist"):

```markdown
## Measuring the ceiling (do this before more extraction tuning)

The truth workbooks encode per-estimator conventions (CB-lead grouping, label styles,
scope choices), so detF1 has an unknown ceiling below 100%. Calibrate it:

1. `npm run score:manual -- --init "<project folder>"` → creates `manual_facts.json`.
2. A human transcribes the DRAWING PDFs into it (30-60 min; never look at the truth xlsx).
3. `npm run score:manual -- "<project folder>"` → human detF1 + a MISSED/EXTRA diff.

Interpretation: human ≈ 75%+ → the model gap is real, keep improving extraction.
Human ≈ 55% → we are near the convention ceiling; invest in truth curation
(manifest entries, grouping rules) instead of extraction. Do this for one texty
project (e.g. Matthews) and one raster bottom-cluster project (e.g. Proposed
Commercial) — the ceilings will differ.
```

- [ ] **Step 4: Manual smoke.** `npm run score:manual -- --init "2026-021 MATTHEWS HANGER WATERLOO"` creates the skeleton; running the scorer on the untouched skeleton prints detF1 0% with the full truth listed as MISSED (proves the diff path). Delete the skeleton afterwards unless the user wants to keep it (`git status` must stay clean — the dataset dir is gitignored anyway).
- [ ] **Step 5: Full suite + commit.** `npm test && npx tsc --noEmit` → `git commit -am "feat(eval): manual-transcription ceiling-calibration harness"`

---

## Phase C — Vision as transcription (raster/SHX pages)

### Task 7: Transcript types + transcription prompt

**Files:**
- Modify: `webapp/src/lib/types.ts` (append after the `TakeoffFacts` interface)
- Modify: `webapp/src/lib/modular-prompts.ts` (new exported function)

**Interfaces — produces (Tasks 8-10 depend on these exact shapes):**

```ts
// types.ts additions
/** Verbatim per-tile callout transcription (vision path). A block is a group of
 *  lines that visually belong together on the drawing (a structure label with its
 *  T/G + INV lines, or one pipe callout possibly split across lines). */
export interface TileTranscript {
  tile: number;          // 1-indexed across the whole extraction (not per-batch)
  blocks: string[][];
}
// TakeoffFacts gains:  transcript?: TileTranscript[];   (optional — persisted via predicted_facts.json)
```

```ts
// modular-prompts.ts addition
export function getTranscriptionPrompt(tileCount: number, tileOffset: number): string;
```

- [ ] **Step 1: Add `TileTranscript` + the optional `transcript` field to `TakeoffFacts`.** `npx tsc --noEmit` green (optional field — nothing else changes).
- [ ] **Step 2: Add the prompt.** Follow the file's existing style (it already has `NO_PRICING_RULE` and `getPageLocatorPrompt` — read them first). Content:

```ts
/**
 * Vision-as-TRANSCRIBER prompt (EXTRACTION_MODE=transcribe|hybrid). The model is
 * never asked to produce a takeoff — only to transcribe callout text verbatim.
 * All entity assembly happens deterministically in transcript-takeoff.ts, which
 * makes accuracy iteration offline and free once transcripts are cached.
 */
export function getTranscriptionPrompt(tileCount: number, tileOffset: number): string {
  return `You are transcribing text from ${tileCount} image tiles of a civil-engineering servicing drawing. The tiles are numbered ${tileOffset + 1} to ${tileOffset + tileCount} in the order the images appear.

TRANSCRIBE, DO NOT INTERPRET. For each tile, list every servicing annotation you can read, VERBATIM — exact characters, including "EX", "Ø", units, and ± marks. Do not normalize, translate, dedupe across tiles, sum, or infer anything that is not literally printed.

Transcribe these annotation kinds (skip title blocks, legends, general notes, dimensions of buildings/parking):
- Pipe callouts: e.g. "83.7m-375mmØ SAN @ 0.02%", "EX SAN 7.2m - 250mmØ DR 35 @ 0.05%"
- Structure labels: e.g. "STMH 1", "EX CBMH1035 (1200Ø)", "CB 10", "DCBMH 2"
- Elevations: e.g. "T/G=224.95", "N INV=223.350"
- Watermain callouts: e.g. "150mmØ PVC WM", "EX. 300 mmØ PVC WATERMAIN"
- Schedule-table rows (pipe/MH schedules): transcribe each row as one line, cells separated by " | "

GROUPING: a "block" is the small cluster of lines that visually belong to ONE thing on the drawing — a structure label together with its T/G and INV lines, or one pipe callout (including its second line when the text wraps). Keep blocks separate; do not merge neighbouring structures.

If a tile has no servicing annotations, return it with an empty blocks array. If text is too small or cut off to read confidently, transcribe what is legible and append "?" to the uncertain characters — never guess whole values.

${'' /* NO_PRICING_RULE is about takeoffs; transcription has no numbers to price, but keep the guard: */}
Never output dollar amounts or quantities that are not literally printed on the drawing.

Return ONLY JSON, no prose:
{"tiles":[{"tile":${tileOffset + 1},"blocks":[["EX SAN MH 02","T/G = 311.85","SW INV = 310.56"],["83.7m-375mmØ SAN @ 0.02%"]]}, ...]}`;
}
```

- [ ] **Step 3: `npx tsc --noEmit` + `npm test` green. Commit.** `git commit -am "feat(extraction): transcript types + vision-as-transcriber prompt"`

---

### Task 8: `transcript-takeoff.ts` — assembler for tile transcripts

**Files:**
- Create: `webapp/src/lib/transcript-takeoff.ts`
- Test: `webapp/src/lib/transcript-takeoff.test.ts`

**Interfaces:**
- Consumes: `TileTranscript`, `TakeoffFacts` from `./types`; all parsers from `./callout-parser`; `reconcileTakeoff` from `./reconcile`.
- Produces:

```ts
export function assembleTranscriptTakeoff(transcripts: TileTranscript[], projectName: string): TakeoffFacts;
```

Algorithm: for each block in each tile — (1) join dangling run head + continuation lines *within the block* (blocks carry the visual grouping, so no spatial search is needed: if line N `isDanglingRunHead` and line N+1 `isRunContinuation`, join them); (2) if any line parses as a structure label, the block is a structure block: remaining lines parsed as elevations attach to it (`TG`→top, `INV`s→min/max, same rule as Task 4); (3) else lines parse independently as runs / watermain / CB labels with the same kind-mapping, EX-filtering, runLabel construction, and CB counting rules as Task 4 steps 4-7 (extract those rules into small shared helpers in `callout-parser.ts` or a shared `takeoff-assembly.ts` if duplication exceeds ~30 lines — implementer's call, DRY but don't force it); (4) schedule-table rows (contain `" | "`) are split on the delimiter and each cell tried against the parsers — a row like `ST11 | 42.3 | 300 | 1.0%` won't parse in v1 and that is acceptable (log a warning string into `facts.warnings`, never guess); (5) cross-tile duplicates (10% tile overlap makes the same callout appear twice) die in `reconcileTakeoff` — structures by label, runs by the exact-signature/dual-label rules. Finish with `reconcileTakeoff`.

- [ ] **Step 1: Write the failing test.**

```ts
// webapp/src/lib/transcript-takeoff.test.ts
import { describe, it, expect } from 'vitest';
import { assembleTranscriptTakeoff } from './transcript-takeoff';

describe('assembleTranscriptTakeoff', () => {
  it('assembles structure blocks with elevations and run blocks', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['EX SAN MH 02', 'T/G = 311.85', 'SW INV = 310.56'],   // existing — excluded
        ['STMH 4', 'T/G=224.95', 'N INV=223.350', 'S INV=223.250'],
        ['83.7m-375mmØ SAN @ 0.02%'],
      ]},
      { tile: 2, blocks: [
        ['STMH 4', 'T/G=224.95'],                     // same structure re-seen in overlap tile
        ['EX SAN 87.4m - 250mmØ', 'DR 35 @ 0.05%'],   // split callout + existing — excluded
        ['45.0m - 250mmØ', 'PVC STM @ 0.50%'],        // split callout, proposed — kept
      ]},
    ], 'T');
    expect(facts.structures).toHaveLength(1);
    expect(facts.structures[0]).toMatchObject({ description: 'STMH 4', topElevation: 224.95, lowInvert: 223.25 });
    expect(facts.sewers).toHaveLength(2);
    expect(facts.sewers.find((s) => s.pipeDiameter === 250)!.slope).toBe(0.5);
  });

  it('warns (not guesses) on unparseable schedule rows', () => {
    const facts = assembleTranscriptTakeoff([{ tile: 1, blocks: [['ST11 | 42.3 | 300 | 1.0%']] }], 'T');
    expect(facts.sewers).toHaveLength(0);
    expect(facts.warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: FAIL → Step 3: implement → Step 4: PASS + `npm test` + `npx tsc --noEmit`.**
- [ ] **Step 5: Commit.** `git commit -am "feat(extraction): deterministic assembly of vision tile transcripts"`

---

### Task 9: `EXTRACTION_MODE=transcribe` in `extraction.ts`

**Files:**
- Modify: `webapp/src/lib/extraction.ts` — inside `extractFromPDF()`, branch after the tile batches are built (~line 662-707: read that whole region first; the batch loop, `getCachedOrCallLLM` keying, streaming, `addUsage`, and `tryParseJSONWithRepair` are the pattern to mirror exactly).
- Test: extend `webapp/src/lib/extraction.test.ts` only if it already tests mode plumbing; otherwise the pure logic is all in Task 8 and this task is deliberately thin glue (the LLM call itself is not unit-testable).

**Interfaces:**
- Consumes: `getTranscriptionPrompt` (Task 7), `assembleTranscriptTakeoff` (Task 8), `reconcileTakeoff` (Task 3), `TileTranscript`.
- Produces: behavior — when `process.env.EXTRACTION_MODE === 'transcribe'`:
  1. Same locator + tiling + upload as today (unchanged code path up to the batch loop).
  2. Each batch call uses `getTranscriptionPrompt(batch.length, batchStartIndex)` instead of the takeoff prompt; cache key suffix `_transcribe_b${bi}of${n}` (MUST differ from the `_single_b…` keys — a shared key would replay takeoff JSON into the transcript parser).
  3. Parse each response with `tryParseJSONWithRepair`; accept `{tiles: [{tile, blocks}]}`; skip malformed tiles with a console.warn (never throw away the whole batch).
  4. Concatenate all `TileTranscript`s, then `const facts = assembleTranscriptTakeoff(all, projectName)`; attach `facts.transcript = all`, `facts.locatorIndex`, `facts.cost` exactly as the existing path does (lines ~730-733).
  5. Any other `EXTRACTION_MODE` value (or unset): byte-identical current behavior.

- [ ] **Step 1: Implement the branch.** Keep it to one `if (process.env.EXTRACTION_MODE === 'transcribe') { ... return facts; }` block placed before the existing single-pass batch loop, reusing `tileBatches`, `mapLimit`, `callWithRetry`, streaming, and `addUsage` verbatim from the existing loop (copy the loop, swap prompt + parse + merge). Do not refactor the existing loop in this task.
- [ ] **Step 2: Verify no behavior change without the env.** `npm test && npx tsc --noEmit` green.
- [ ] **Step 3: Live smoke (needs credentials + dataset; skip-if-absent, do not fail the task):** `EXTRACTION_MODE=transcribe GOLDEN_FILTER="king forest" npm run evaluate:golden` — King Forest is small (3 pages, raster). Success: run completes, `existing_projects_training_data/2026-020 559 KING FOREST BURLINGTON/generated_spreadsheets/predicted_facts.json` now contains a non-empty `transcript` array, and the scoreboard prints a detF1 (any value — quality tuning is Task 10's offline loop, not this task).
- [ ] **Step 4: Commit.** `git commit -am "feat(extraction): EXTRACTION_MODE=transcribe — vision transcribes, code assembles"`

---

### Task 10: Hybrid mode + offline re-assembly loop + docs

**Files:**
- Modify: `webapp/src/lib/extraction.ts` (hybrid branch)
- Create: `webapp/src/scripts/assemble-from-transcripts.ts`
- Modify: `webapp/package.json` (add `"assemble:transcripts": "tsx src/scripts/assemble-from-transcripts.ts"`)
- Modify: `EVAL_METHODOLOGY.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above; `mergeTakeoffs` (Task 3); `extractPageText`, `isTextyPage` (Task 1); `assembleTextTakeoff` (Task 4).
- Produces: behavior —
  - `EXTRACTION_MODE=hybrid`: after the locator, run `extractPageText(pdfBuffer, unionPages)`; split pages into texty vs raster via `isTextyPage`. Texty pages → `assembleTextTakeoff` (no LLM, no tiles). Raster pages → the Task 9 transcribe path, tiling ONLY those pages. Final: `mergeTakeoffs(textFacts, transcriptFacts)` (text layer is `primary` — it is exact). When ALL pages are texty: zero LLM extraction calls (locator still runs); `cost.llmCalls` reflects that — this is the visible cost win.
  - `assemble-from-transcripts.ts`: for each golden project (from `golden-set.ts`), read `generated_spreadsheets/predicted_facts.json`; if it has a `transcript` array → re-run `assembleTranscriptTakeoff` + `reconcileTakeoff` on it, score with `compareFacts` vs manifest-resolved truth, print old-vs-recomputed detF1 per project. Honors `PREDICTIONS_DIR` env override exactly like `analyze-eval.ts` does (read its path handling, ~lines 15-47). This is the free iteration loop: change parser/assembler/reconciler → `npm test` → `npm run assemble:transcripts` → see golden movement, $0.

- [ ] **Step 1: Implement the hybrid branch** in `extractFromPDF` (same placement pattern as Task 9's branch; the transcribe machinery is now called with a filtered page list). Reuse — don't duplicate — the transcribe batch loop: extract it into a local `async function transcribeTiles(pages: number[]): Promise<TileTranscript[]>` inside `extractFromPDF` that both branches call.
- [ ] **Step 2: Write `assemble-from-transcripts.ts`** (mirror the `evaluate-text.ts` loop shape from Task 5 — golden set, truth resolution, `compareFacts`, table print).
- [ ] **Step 3: Tests + types.** `npm test && npx tsc --noEmit` green. Default-mode behavior still byte-identical (no env → old path).
- [ ] **Step 4: Live smoke (credentials + dataset; skip-if-absent):** `EXTRACTION_MODE=hybrid GOLDEN_FILTER="matthews" npm run evaluate:golden` — Matthews is fully texty, so expect `cost` to show ~0 extraction tiles and the detF1 to match `npm run evaluate:text`'s Matthews number. Then `npm run assemble:transcripts` re-scores whatever transcripts exist.
- [ ] **Step 5: Update docs.**
  - `CLAUDE.md`: in the Pipeline section, document `EXTRACTION_MODE=transcribe|hybrid`, the new lib files (`pdf-text`, `callout-parser`, `text-takeoff`, `transcript-takeoff`, `reconcile`, `golden-set`), and the new scripts (`evaluate:text`, `score:manual`, `assemble:transcripts`). Also correct the stale scripts list (the flywheel `*-cloud` scripts no longer exist in `src/scripts/`).
  - `EVAL_METHODOLOGY.md`: extend "The loop" step 1 with: *"if predictions carry transcripts, `npm run assemble:transcripts` re-runs the whole assembly+reconcile stack offline — parser/assembler changes never need an LLM run to validate."*
- [ ] **Step 6: Commit.** `git commit -am "feat(extraction): hybrid text-first/transcribe mode + offline transcript re-assembly loop"`

---

## Acceptance / exit criteria for the whole plan

1. `npm test` and `npx tsc --noEmit` green; default extraction path byte-identical without new env vars.
2. `npm run evaluate:text` shows textF1 on ≥5 projects, beating the cached LLM baseline on ≥2 (Phase A validated at $0).
3. `manual_facts.json` workflow runs end-to-end on one project (Phase B tooling ready; the human transcription itself is scheduled separately).
4. One VM/Vertex run with `EXTRACTION_MODE=hybrid GOLDEN_REPEATS=3` produces per-project transcripts in `predicted_facts.json`, after which `npm run assemble:transcripts` re-scores offline. **Decision gate:** compare hybrid detF1 band vs the 44.4% baseline band. If hybrid ≥ baseline, flip it to the recommended mode in CLAUDE.md; if not, the transcripts + offline loop still exist — iterate the parser/reconciler offline before spending another run.
5. All follow-on accuracy work (grammar variants, grouping rules, reconciliation heuristics) is demonstrably possible without LLM calls.

## Out of scope (deliberately — YAGNI)

- Vector-geometry analysis of SHX line work (pipe topology from `get_drawings()`-style data) — a future lever, not needed to validate the transcription architecture.
- Schedule-table structured parsing (v1 transcribes rows and warns).
- Changing models/providers, DPI tuning, deleting the legacy single-pass mode, and re-enabling any flywheel automation.
- Truth-workbook curation beyond what `truth-manifest.json` already does (Phase B's measurements will tell us whether that becomes the priority).
- Expanding the golden set past 16 projects (54 exist on disk). Do it AFTER exit criterion 5 holds — once iteration is offline/free, a bigger set costs nothing to score and shrinks the noise bands; before that it just multiplies VM cost.
