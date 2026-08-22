# Phase 0 — Free Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every measured, deterministic gap between the current extraction output and the drawing's actual content — without a single new LLM call — and re-baseline the golden set so Phases 1–3 build on a truthful number.

**Architecture:** All work is in existing pure modules (`dataset.ts`, `compare-facts.ts`, `callout-parser.ts`, `text-takeoff.ts`, `reconcile.ts`) plus one new pure module (`schedule-table.ts`). Nothing calls a model. Every change is validated by `vitest` on synthetic fixtures and then by `npm run score:offline` / `npm run analyze:eval`, both of which re-score cached predictions at zero cost. One task (Task 7) changes tiling and therefore needs a single focused LLM run to verify.

**Tech Stack:** TypeScript (Next.js webapp), `pdfjs-dist`, `pdf-lib` (test fixtures), `exceljs`, `vitest`, `tsx` scripts.

## Global Constraints

- All work happens in `webapp/` on branch `claude/codebase-redesign-eval-yyocrq`. Never commit to `main`.
- `npm test` and `npx tsc --noEmit` must be green after every task. Run both from `webapp/`.
- The dataset (`existing_projects_training_data/`) is **gitignored**. Unit tests must NEVER read it — build fixtures in-test. Scripts under `src/scripts/` MAY read it.
- **No pricing in the extraction path.** `costing-rules.ts` is the only place dollars live.
- Do not reintroduce prompt-rule auto-commit, and do not retry the three rejected structure filters (long-contiguous-run, missing-data, sewer-endpoint corroboration) — all three were measured and rejected; see `CLAUDE.md`.
- `score-offline.ts` writes `golden-results-offline.json` only. It must never write `golden-results.json` (that is `evaluate-golden.ts`'s resume cache).
- Reuse, do not re-implement: `normalizeLabel`, `runSignature`, `stripSystemPrefix` (`compare-facts.ts`); `snapToPipeDiameter`, `normalizeSlope` (`geometry.ts`); `reconcileTakeoff`, `mergeTakeoffs`, `aggregateWatermainByDiameter` (`reconcile.ts`); `selectDrawingPdfs`, `walkProjectPdfs`, `chooseDrawingPdfs` (`dataset.ts`).
- `TakeoffFacts` field shapes (from `types.ts`, do not change): `structures: StructureFact[]` (`description, topElevation, lowInvert, highInvert, pipeOutDiameter, structureType, depth`), `catchbasins: CatchbasinGroupFact[]` (`type, quantity, wallThickness, depth`), `sewers: SewerFact[]` (`runLabel, isLineItem, length, pipeDiameter, typeClass, slope, depth`), `watermain: WatermainFact[]` (`sizeAndType, length, pipeDiameter, ocSc, avgCover`).
- Domain rule: callouts prefixed `EX` / `EX.` denote **existing** infrastructure and are excluded from the takeoff. Parsers *detect* the flag; assemblers *filter* on it.
- **Metric changes are ruler changes.** Tasks 2 and 6 alter matching. After each, run `npm run score:offline` and confirm the delta is explained by the intended mechanism — not by new false matches.

## Why (context for implementers)

Measured 2026-08-21/22 against the local dataset. See `docs/superpowers/specs/2026-08-21-vector-native-takeoff-design.md`.

1. `dataset-manifest.json` was generated **2026-07-03 11:18** and never regenerated. It predates six truth/selection fixes, including `7994e8d` (Jul 4, "…(Eric Smith)") and `0f0320e` (Jul 9, "read watermain runs (were dropped)"). It is the single cause of both the Eric Smith 0.0% and the `watermain: 0` counts.
2. On projects with a text layer, an **exact** read scores 60–68% detF1 and beats the LLM on Oakville (68.3 vs 45.9) and Bradford (60.7 vs 53.7). The residual is bookkeeping, not vision.
3. Matthews loses **6 of 6** structures purely to `MH01` vs `MH 1`. Bradford loses 2 more to `DIV.MH 2` vs `MH2`.
4. Ultimate Drive emits **0 runs** from 7 texty pages: its 29 runs live in a schedule table (`ST 1 … ST 25`, `SA 1`, `SA 2`) and nothing reads tables.
5. Bradford emits **10 phantom runs** — pipes already matched via the schedule, re-emitted from plan callouts.
6. `text-takeoff.ts:99` drops every watermain callout without a stated length. Corpus watermain recall is 10%.
7. `PER_PAGE = 16` is hardcoded at `extraction.ts:629` and `:766`, but a 36×48 sheet at 150 DPI needs **4×5 = 20** tiles. Tiles are row-major and truncated, so the **bottom 20% of every E-size sheet is never rendered**. Panattoni needs 260 tiles against a global cap of 192.

## File Structure

```
webapp/src/lib/
  dataset.ts             MOD  servicing-sheet-code preference in selectDrawingPdfs
  dataset.test.ts        NEW  pure regression test incl. the Eric Smith filename set
  compare-facts.ts       MOD  numeric label identity in normalizeLabel
  callout-parser.ts      MOD  multi-part ids, new structure kinds, SUBDRAIN runs
  text-takeoff.ts        MOD  emit length-less watermain; feed schedule tables
  schedule-table.ts      NEW  positioned text -> table rows -> facts (pure)
  schedule-table.test.ts NEW
  reconcile.ts           MOD  cross-source dedup (schedule row vs plan callout)
  extraction.ts          MOD  tile budget from page geometry, not a constant
webapp/src/scripts/
  check-manifest-fresh.ts NEW staleness guard
webapp/package.json      MOD  script: manifest:check
```

Dependency order: Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Tasks 2–6 are independently shippable.

---

## Task 1: Regenerate the manifest and guard it against staleness

**Files:**
- Modify: `dataset-manifest.json` (regenerated artifact, repo root)
- Create: `webapp/src/scripts/check-manifest-fresh.ts`
- Create: `webapp/src/lib/dataset.test.ts`
- Modify: `webapp/package.json` (add `manifest:check`)

**Interfaces:**
- Consumes: `selectDrawingPdfs` from `./dataset` (exists).
- Produces: `npm run manifest:check` exiting non-zero when stale.

- [ ] **Step 1: Record the "before" state so the fix is provable.**

```bash
cd /Users/kirolosyoussef/Github/AutoInfra
python3 -c "
import json; m=json.load(open('dataset-manifest.json'))
e=[x for x in m if x['folder'].startswith('2026-009')][0]
print('BEFORE drawingPdfs:', [p['name'] for p in e['drawingPdfs']])
print('BEFORE usable-with-watermain:', sum(1 for x in m if x['usable'] and x['truth']['watermain']>0))
"
```
Expected: the two `Topsite bid leveling …` PDFs, and `0`.

- [ ] **Step 2: Write the pure regression test** (no dataset access — filenames only).

```ts
// webapp/src/lib/dataset.test.ts
import { describe, it, expect } from 'vitest';
import { selectDrawingPdfs } from './dataset';

// Verbatim basenames from 2026-009 55 ERIC T. SMITH WAY,AURORA.
const ERIC_SMITH = [
  '55ETS-A01D1-Imperv-Liner-Jan30-25 (1).pdf',
  '55EricTSmithWay-A01D2-SPA-Nov15-24 - Copy.pdf',
  '55EricTSmithWay-A01EC-SPA-Nov15-24 - Copy.pdf',
  '55EricTSmithWay-A01SG-SPA-Nov15-24.pdf',
  '55EricTSmithWay-A01SS-SPA-Nov15-24.pdf',
  '55EricTSmithWay-A01T-SPA-Nov15-24 - Copy.pdf',
  'January 27\'26 2026-009 55 Eric T. Smith Way QUOTE.pdf',
  'QUOTE_2026-009-Excavation_Backfill_55_EricT.SmithWay_Aurora_Rev01_2026-01-28.pdf',
  'Rice - quote.pdf',
  'Topsite bid leveling 2026-04-15 completed.pdf',
  'Topsite bid leveling 2026-04-15.pdf',
];

describe('selectDrawingPdfs', () => {
  it('keeps the site-servicing drawing and drops quotes and bid-levelling sheets', () => {
    const picked = selectDrawingPdfs(ERIC_SMITH);
    expect(picked).toContain('55EricTSmithWay-A01SS-SPA-Nov15-24.pdf');
    expect(picked.some((p) => /bid leveling/i.test(p))).toBe(false);
    expect(picked.some((p) => /quote/i.test(p))).toBe(false);
  });

  it('ranks the servicing sheet ahead of grading/erosion/detail sheets', () => {
    const picked = selectDrawingPdfs(ERIC_SMITH);
    const idx = (frag: string) => picked.findIndex((p) => p.includes(frag));
    expect(idx('A01SS')).toBeGreaterThanOrEqual(0);
    expect(idx('A01SS')).toBeLessThan(idx('A01EC'));
    expect(idx('A01SS')).toBeLessThan(idx('A01D1'));
  });
});
```

- [ ] **Step 3: Run to verify the second test fails.**

Run: `cd webapp && npx vitest run src/lib/dataset.test.ts`
Expected: first test PASSES (logic already correct); second FAILS — selection currently returns readdir order with no ranking.

- [ ] **Step 4: Add sheet-code ranking to `selectDrawingPdfs`.**

Replace the `return` at `webapp/src/lib/dataset.ts:60` with:

```ts
  const chosen = civil.length > 0 ? civil : keep;
  return rankBySheetCode(chosen);
}

// Servicing sheets carry the takeoff; grading/erosion/detail sheets rarely do.
// Ranking (not filtering) means nothing is lost — the servicing plan is simply
// decoded first when a page/tile budget applies.
const SHEET_CODE_RANK: [RegExp, number][] = [
  [/(?:^|[^a-z0-9])(?:ss|site\s*servicing|servicing)(?:[^a-z0-9]|$)/i, 0],
  [/(?:^|[^a-z0-9])(?:sg|grading)(?:[^a-z0-9]|$)/i, 1],
  [/(?:^|[^a-z0-9])(?:ec|erosion)(?:[^a-z0-9]|$)/i, 2],
  [/(?:^|[^a-z0-9])(?:d\d|det|detail)(?:[^a-z0-9]|$)/i, 3],
];

export function rankBySheetCode(paths: string[]): string[] {
  const rank = (p: string) => {
    const base = path.basename(p);
    for (const [re, r] of SHEET_CODE_RANK) if (re.test(base)) return r;
    return 2.5; // unknown code: ahead of details, behind servicing/grading
  };
  return [...paths].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
```

- [ ] **Step 5: Run tests to verify they pass.**

Run: `cd webapp && npx vitest run src/lib/dataset.test.ts && npx tsc --noEmit`
Expected: both PASS, tsc clean.

- [ ] **Step 6: Regenerate the manifest.**

```bash
cd webapp && npm run dataset:manifest
```
Expected console: `53 projects; … usable for extraction eval.`

- [ ] **Step 7: Verify the regeneration fixed both symptoms.**

```bash
cd /Users/kirolosyoussef/Github/AutoInfra
python3 -c "
import json; m=json.load(open('dataset-manifest.json'))
e=[x for x in m if x['folder'].startswith('2026-009')][0]
print('AFTER drawingPdfs:', [p['name'] for p in e['drawingPdfs']])
print('AFTER usable-with-watermain:', sum(1 for x in m if x['usable'] and x['truth']['watermain']>0))
"
```
Expected: `55EricTSmithWay-A01SS-SPA-Nov15-24.pdf` present and ranked first; watermain count now **> 0**. If watermain is still 0, stop — `readTruthFacts` is genuinely broken and that is a ruler bug outranking everything else in this plan.

- [ ] **Step 8: Write the staleness guard.**

```ts
// webapp/src/scripts/check-manifest-fresh.ts
/**
 * Fails when dataset-manifest.json is older than any module that produces it.
 * The manifest silently encoded 2026-07-03 code for seven weeks, costing one
 * golden project its entire score and hiding every watermain row. Derived
 * artifacts need a staleness signal, not good intentions.
 *
 * Usage: npm run manifest:check
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const MANIFEST = path.join(ROOT, 'dataset-manifest.json');
const SOURCES = [
  'webapp/src/lib/dataset.ts',
  'webapp/src/lib/truth-facts.ts',
  'webapp/src/scripts/build-dataset-manifest.ts',
  'truth-manifest.json',
];

if (!fs.existsSync(MANIFEST)) {
  console.error('dataset-manifest.json missing — run: npm run dataset:manifest');
  process.exit(1);
}
const manifestMtime = fs.statSync(MANIFEST).mtimeMs;
const stale = SOURCES.filter((rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) && fs.statSync(p).mtimeMs > manifestMtime;
});

if (stale.length) {
  console.error(`dataset-manifest.json is STALE — newer than:\n  ${stale.join('\n  ')}\nRun: npm run dataset:manifest`);
  process.exit(1);
}
console.log('dataset-manifest.json is up to date.');
```

- [ ] **Step 9: Register the script.**

In `webapp/package.json` `"scripts"`, after `"dataset:manifest"`, add:

```json
    "manifest:check": "tsx src/scripts/check-manifest-fresh.ts",
```

- [ ] **Step 10: Run the guard.**

Run: `cd webapp && npm run manifest:check`
Expected: `dataset-manifest.json is up to date.` (exit 0). If it reports stale, re-run `npm run dataset:manifest` — mtimes can invert if sources were touched during this task.

- [ ] **Step 11: Commit.**

```bash
cd /Users/kirolosyoussef/Github/AutoInfra
git add dataset-manifest.json webapp/src/lib/dataset.ts webapp/src/lib/dataset.test.ts \
        webapp/src/scripts/check-manifest-fresh.ts webapp/package.json
git commit -m "fix(eval-ruler): regenerate stale dataset manifest + staleness guard

The manifest was generated 2026-07-03 and predated six truth/selection fixes,
which is why Eric Smith Way was scored against a bid-levelling sheet and every
usable project reported watermain: 0. Adds a pure regression test on the Eric
Smith filename set, servicing-sheet-code ranking, and npm run manifest:check."
```

---

## Task 2: Numeric label identity

**Files:**
- Modify: `webapp/src/lib/compare-facts.ts:61-69` (`normalizeLabel`)
- Test: `webapp/src/lib/compare-facts.test.ts` (append)

**Interfaces:**
- Consumes: `stripSystemPrefix` (already in the same file).
- Produces: `normalizeLabel(label: string): string` — unchanged signature; `MH01`, `MH 1` and `MH1` now all return `MH1`, while `MH10` still returns `MH10`.

- [ ] **Step 1: Write the failing test.** Append to `webapp/src/lib/compare-facts.test.ts`:

```ts
describe('normalizeLabel — numeric identity', () => {
  it('treats zero-padded ids as the same structure', () => {
    expect(normalizeLabel('MH01')).toBe(normalizeLabel('MH 1'));
    expect(normalizeLabel('MH 02')).toBe(normalizeLabel('MH2'));
  });

  it('does NOT collapse different numbers', () => {
    expect(normalizeLabel('MH01')).not.toBe(normalizeLabel('MH 10'));
    expect(normalizeLabel('MH 1')).not.toBe(normalizeLabel('MH11'));
  });

  it('keeps alphabetic id suffixes distinct', () => {
    expect(normalizeLabel('MH 6A')).not.toBe(normalizeLabel('MH 6'));
    expect(normalizeLabel('MH06A')).toBe(normalizeLabel('MH 6A'));
  });

  it('strips estimator qualifier prefixes', () => {
    expect(normalizeLabel('DIV.MH 2')).toBe(normalizeLabel('MH2'));
    expect(normalizeLabel('CTRL MH 5')).toBe(normalizeLabel('MH 5'));
  });

  it('still strips the storm/sanitary system qualifier', () => {
    expect(normalizeLabel('STMH 1')).toBe(normalizeLabel('MH 1'));
  });

  it('leaves labels with no numeric part alone', () => {
    expect(normalizeLabel('VC')).toBe('VC');
    expect(normalizeLabel('CTRL MH')).toBe('CTRLMH');
  });
});
```

Note the last case: `CTRL MH` has no id number, so the qualifier strip (which requires a following digit) deliberately does not fire. Unnumbered structures are handled in Phase 1, not here.

- [ ] **Step 2: Run to verify it fails.**

Run: `cd webapp && npx vitest run src/lib/compare-facts.test.ts`
Expected: FAIL — `MH01` ≠ `MH1`, `DIVMH2` ≠ `MH2`.

- [ ] **Step 3: Implement.** In `webapp/src/lib/compare-facts.ts`, add below `SYS_PREFIX`/`stripSystemPrefix`:

```ts
// Estimator note prefixes that qualify a structure without changing its identity:
// "DIV.MH 2" is MH 2 on a diversion, "CTRL MH 5" is MH 5 used as a control. The
// digit lookahead keeps them anchored to a real structure id.
const QUALIFIER_PREFIX = /^(?:DIV|CTRL|CONTROL)(?=(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|HS|OS)\d)/;

// A structure id is (letters)(number)(optional letter suffix). Comparing the number
// NUMERICALLY is what makes "MH01" and "MH 1" the same structure while keeping
// "MH10" distinct — stripping zeros textually would merge them.
const LABEL_PARTS = /^([A-Z]+)0*(\d+)([A-Z]*)$/;
```

Then replace `normalizeLabel` (lines 61-69) with:

```ts
export function normalizeLabel(label: string): string {
  const flat = stripSystemPrefix(
    (label || '')
      .toUpperCase()
      .replace(/\(.*?\)/g, '')
      .split('/')[0] // drop note suffix after the first slash
      .replace(/[^A-Z0-9]/g, '')
      .replace(QUALIFIER_PREFIX, '')
  );
  const m = LABEL_PARTS.exec(flat);
  return m ? `${m[1]}${Number(m[2])}${m[3]}` : flat;
}
```

`stripSystemPrefix` runs on the already-flattened string, and `QUALIFIER_PREFIX` is applied inside so `DIV.MH 2` → `DIVMH2` → `MH2` → parts → `MH2`.

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd webapp && npm test && npx tsc --noEmit`
Expected: all PASS. If other suites fail, they encode the old textual behaviour — read each failure and confirm the new value is the *correct* one before editing that expectation.

- [ ] **Step 5: Re-score offline and confirm the mechanism.**

```bash
cd webapp && npm run score:offline && npm run analyze:eval 2>&1 | head -40
```
Expected: Matthews structures move from 5/6 matched with 0 label hits toward 6/6; aggregate structure F1 rises. **Guard against false matches:** confirm structure `predCount` is unchanged (this task adds no entities — it only changes matching). If precision rises while `predCount` moves, something else changed.

- [ ] **Step 6: Commit.**

```bash
cd /Users/kirolosyoussef/Github/AutoInfra
git add webapp/src/lib/compare-facts.ts webapp/src/lib/compare-facts.test.ts golden-results-offline.json
git commit -m "fix(metric): numeric structure-label identity (MH01 == MH 1)

Matthews lost 6 of 6 structures to zero-padding alone. Compares the id
numerically so MH01/MH 1/MH1 unify while MH10 stays distinct, and strips
DIV./CTRL estimator qualifiers."
```

---

## Task 3: Grammar coverage — multi-part ids, new kinds, subdrain runs

**Files:**
- Modify: `webapp/src/lib/callout-parser.ts:26-28` (kind union), `:83` (`STRUCT_RE`)
- Test: `webapp/src/lib/callout-parser.test.ts` (append)

**Interfaces:**
- Produces: `ParsedStructure['kind']` gains `'JF' | 'EF' | 'CHAMBER'`. `parseStructureLabel` accepts hyphenated ids (`JF 6-3-1`). New `parseSubdrainCallout(line: string): { length: number; diameterMm: number } | null`.

- [ ] **Step 1: Write the failing test.** Append to `webapp/src/lib/callout-parser.test.ts`:

```ts
import { parseSubdrainCallout } from './callout-parser';

describe('grammar coverage (Phase 0)', () => {
  it('parses multi-part junction ids', () => {
    const jf = parseStructureLabel('JF 6-3-1')!;
    expect(jf.kind).toBe('JF');
    expect(jf.label).toBe('JF 6-3-1');
  });

  it('parses EF structures with zero-padded ids', () => {
    const ef = parseStructureLabel('EF 04')!;
    expect(ef.kind).toBe('EF');
    expect(ef.label).toBe('EF 04');
  });

  it('parses a chamber written id-first', () => {
    const ch = parseStructureLabel('C100 CHAMBER')!;
    expect(ch.kind).toBe('CHAMBER');
    expect(ch.label).toBe('C100');
  });

  it('does not mistake EF/JF prefixes inside other words', () => {
    expect(parseStructureLabel('OFFSET 12')).toBeNull();
  });

  it('parses subdrain runs', () => {
    expect(parseSubdrainCallout('67.0m - 150mmØ SUBDRAIN')).toEqual({ length: 67, diameterMm: 150 });
    expect(parseSubdrainCallout('83.7m-375mmØ SAN @ 0.02%')).toBeNull();
  });

  it('keeps EX detection working on the new kinds', () => {
    expect(parseStructureLabel('EX JF 4-1-1')!.existing).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd webapp && npx vitest run src/lib/callout-parser.test.ts`
Expected: FAIL — `parseSubdrainCallout` undefined, `JF`/`EF`/`CHAMBER` unmatched.

- [ ] **Step 3: Implement.** In `webapp/src/lib/callout-parser.ts`:

Extend the kind union at line 26:

```ts
  kind: 'MH' | 'CBMH' | 'DCBMH' | 'CB' | 'DCB' | 'DICB' | 'DDICB' | 'HS' | 'OS' | 'JF' | 'EF' | 'CHAMBER';
```

Replace `STRUCT_RE` (line 83) and add a chamber pattern:

```ts
// Group layout unchanged from the original (1=EX, 2=kind, 3=separator, 4=id,
// 5=parenthesized diameter). Two additions:
//   - JF/EF joined the kind alternation (junction and end-of-flow structures)
//   - the id now accepts hyphenated parts, e.g. "JF 6-3-1"
const STRUCT_RE = /(?:^|\s)(EX\.?\s+)?(?:(?:SAN(?:ITARY)?|STM|STORM)\s+)?(DDICB|DCBMH|DICB|CBMH|DCB|STMH|SANMH|CB|MH|HS|OS|JF|EF)(\s?-?\s?)(\d+(?:-\d+)*[A-Z]?)\s*(?:\((\d{3,4})\s*[ØO]?\))?/i;

// Chambers are written id-first ("C100 CHAMBER", "OGS100 CHAMBER"), so they need
// their own pattern rather than another alternation branch.
const CHAMBER_RE = /(?:^|\s)(EX\.?\s+)?([A-Z]{1,4}\d+[A-Z]?)\s+CHAMBER\b/i;
```

At the top of `parseStructureLabel`, before the existing `STRUCT_RE.exec`:

```ts
  const chamber = CHAMBER_RE.exec(line);
  if (chamber) {
    return { label: chamber[2].toUpperCase(), kind: 'CHAMBER', diameterMm: null, existing: Boolean(chamber[1]) };
  }
```

Append the subdrain parser at the end of the file:

```ts
/**
 * Subdrains are perforated pipe under the road base. They carry a length and a
 * diameter but no system tag and no slope, so parseRunCallout ignores them —
 * yet the estimator prices them as a sewer line item (Oakville: "SUBDRAIN 67m").
 */
const SUBDRAIN_RE = /\bSUB[\s-]?DRAIN\b/i;

export function parseSubdrainCallout(line: string): { length: number; diameterMm: number } | null {
  if (!SUBDRAIN_RE.test(line)) return null;
  const core = LEN_DIA_RE.exec(line);
  if (!core) return null;
  return { length: parseFloat(core[1]), diameterMm: snapToPipeDiameter(parseInt(core[2], 10)) };
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd webapp && npm test && npx tsc --noEmit`
Expected: PASS. The `structureType` field stays `null` for new kinds — Phase 0 does not map them to costing.

- [ ] **Step 5: Wire subdrains into the text assembler.** In `webapp/src/lib/text-takeoff.ts`, import `parseSubdrainCallout` and insert immediately after the `parseRunCallout` block (after line 85's `continue;`):

```ts
      const subdrain = parseSubdrainCallout(line.text);
      if (subdrain) {
        sewers.push({
          runLabel: 'SUBDRAIN',
          isLineItem: false,
          length: subdrain.length,
          pipeDiameter: subdrain.diameterMm,
          typeClass: null,
          slope: null,
          depth: null,
        });
        continue;
      }
```

- [ ] **Step 6: Re-score and commit.**

```bash
cd webapp && npm run score:offline && npm test
cd /Users/kirolosyoussef/Github/AutoInfra
git add webapp/src/lib/callout-parser.ts webapp/src/lib/callout-parser.test.ts \
        webapp/src/lib/text-takeoff.ts golden-results-offline.json
git commit -m "feat(extraction): grammar coverage for JF/EF/CHAMBER, hyphenated ids, subdrains

Oakville (C100 CHAMBER, SUBDRAIN), Bradford (JF 6-3-1, JF 4-1-1) and Ultimate
Drive (EF 04) each lose real structures to gaps in the callout grammar."
```

---

## Task 4: Stop discarding length-less watermain

**Files:**
- Modify: `webapp/src/lib/text-takeoff.ts:98-107`
- Modify: `webapp/src/lib/reconcile.ts:40-59` (`aggregateWatermainByDiameter` null handling)
- Test: `webapp/src/lib/text-takeoff.test.ts`, `webapp/src/lib/reconcile.test.ts` (append)

**Interfaces:**
- `WatermainFact.length` may now be `0` for a detected-but-unmeasured main. `matchWatermain` phase 3 already matches on diameter alone, so detection is scored while the length fails as a field — the intended split.

- [ ] **Step 1: Write the failing test.** Append to `webapp/src/lib/text-takeoff.test.ts`:

```ts
describe('watermain detection without a stated length', () => {
  it('emits a proposed main whose callout carries no length', () => {
    const facts = assembleTextTakeoff([page([
      { text: '200mmØ PVC WATERMAIN', x: 100, y: 600 },
      { text: 'EX. 300 mmØ PVC WATERMAIN', x: 100, y: 500 }, // existing — excluded
    ])], 'T');
    expect(facts.watermain).toHaveLength(1);
    expect(facts.watermain[0].pipeDiameter).toBe(200);
    expect(facts.watermain[0].length).toBe(0);
  });

  it('prefers a stated length over an unmeasured duplicate of the same size', () => {
    const facts = assembleTextTakeoff([page([
      { text: '150mmØ PVC WATERMAIN', x: 100, y: 600 },
      { text: '124.0m - 150mmØ PVC WM', x: 100, y: 400 },
    ])], 'T');
    expect(facts.watermain).toHaveLength(1);
    expect(facts.watermain[0].length).toBe(124);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd webapp && npx vitest run src/lib/text-takeoff.test.ts`
Expected: FAIL — first case yields 0 watermain rows.

- [ ] **Step 3: Implement.** In `webapp/src/lib/text-takeoff.ts` replace the watermain block (lines 98-107):

```ts
      const wm = parseWatermainCallout(line.text);
      if (wm && !wm.existing) {
        // Emit even with no stated length. Most drawings label the main
        // ("200mmØ PVC WATERMAIN") and leave the length implied by the drawn
        // line, so requiring a length dropped the pipe entirely — scoring a
        // correct read as a miss. Detection and measurement are separate
        // failures; matchWatermain phase 3 pairs on diameter alone.
        watermain.push({
          sizeAndType: `${wm.diameterMm}mm${wm.material ? ` ${wm.material}` : ''}`,
          length: wm.lengthM ?? 0,
          pipeDiameter: wm.diameterMm,
          ocSc: 1.1,
          avgCover: 1.8,
        });
      }
```

- [ ] **Step 4: Run tests.**

Run: `cd webapp && npx vitest run src/lib/text-takeoff.test.ts src/lib/reconcile.test.ts`
Expected: the first new case PASSES. The second may FAIL if `aggregateWatermainByDiameter` sums `0 + 124` correctly (it does) but the exact-dedupe key `${pipeDiameter}|${length}` treats `150|0` and `150|124` as distinct rows and then sums them to 124 — verify the assertion holds; if the aggregate yields 124 with one row, it passes.

- [ ] **Step 5: Re-score, confirm the mechanism, commit.**

```bash
cd webapp && npm run score:offline && npm run analyze:eval 2>&1 | grep -i watermain
```
Expected: watermain recall rises above 10%; `watermain.length` field accuracy may *fall* — that is correct and intended, because previously-invisible unmeasured mains are now scored as found-but-unmeasured rather than not found.

```bash
cd /Users/kirolosyoussef/Github/AutoInfra
git add webapp/src/lib/text-takeoff.ts webapp/src/lib/text-takeoff.test.ts golden-results-offline.json
git commit -m "fix(extraction): detect watermain callouts that state no length

text-takeoff dropped every watermain without an explicit length, which is most
of them — 0 of 7 found across Oakville/Bradford/Ultimate. Emits the pipe with
length 0 so detection is scored separately from measurement."
```

---

## Task 5: Schedule-table reader

**Files:**
- Create: `webapp/src/lib/schedule-table.ts`
- Create: `webapp/src/lib/schedule-table.test.ts`
- Modify: `webapp/src/lib/text-takeoff.ts` (consume tables before free-text classification)

**Interfaces:**
- Consumes: `PageText`, `PositionedText` from `./pdf-text`; `snapToPipeDiameter`, `normalizeSlope` from `./geometry`.
- Produces:

```ts
export interface TableRow { cells: string[] }
export interface DetectedTable { header: string[]; rows: TableRow[] }
export function detectTables(page: PageText): DetectedTable[];
export function tableToSewers(t: DetectedTable): SewerFact[];
```

Algorithm: cluster items into rows by y within half a median glyph height; within a row, order by x and split into cells on x-gaps wider than 1.5× the median intra-row gap; find the header row as the first row matching ≥3 known column keywords; take following rows with the same cell count as data.

- [ ] **Step 1: Write the failing test.**

```ts
// webapp/src/lib/schedule-table.test.ts
import { describe, it, expect } from 'vitest';
import { detectTables, tableToSewers } from './schedule-table';
import { PageText } from './pdf-text';

// A storm-sewer schedule in the shape Ultimate Drive uses.
const rows: [string, string, string, string, string][] = [
  ['RUN', 'FROM', 'TO', 'LENGTH', 'DIA'],
  ['ST 1', 'MH 1', 'MH 2', '30.0', '250'],
  ['ST 2', 'MH 2', 'MH 3', '13.0', '200'],
  ['ST 3', 'MH 3', 'CB 4', '25.0', '250'],
];

const schedulePage = (): PageText => ({
  page: 1, width: 2592, height: 1728,
  items: rows.flatMap((cells, r) =>
    cells.map((text, c) => ({ text, x: 100 + c * 120, y: 800 - r * 14, width: text.length * 5, height: 8 }))
  ),
});

describe('detectTables', () => {
  it('finds the header and its data rows', () => {
    const tables = detectTables(schedulePage());
    expect(tables).toHaveLength(1);
    expect(tables[0].header).toEqual(['RUN', 'FROM', 'TO', 'LENGTH', 'DIA']);
    expect(tables[0].rows).toHaveLength(3);
    expect(tables[0].rows[0].cells).toEqual(['ST 1', 'MH 1', 'MH 2', '30.0', '250']);
  });

  it('ignores a page with no header-like row', () => {
    const noise: PageText = {
      page: 1, width: 2592, height: 1728,
      items: [{ text: 'GENERAL NOTES', x: 10, y: 10, width: 60, height: 8 }],
    };
    expect(detectTables(noise)).toHaveLength(0);
  });
});

describe('tableToSewers', () => {
  it('maps columns to SewerFacts with endpoint run labels', () => {
    const sewers = tableToSewers(detectTables(schedulePage())[0]);
    expect(sewers).toHaveLength(3);
    expect(sewers[0].runLabel).toBe('MH 1-MH 2');
    expect(sewers[0].length).toBe(30);
    expect(sewers[0].pipeDiameter).toBe(250);
    expect(sewers[0].isLineItem).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd webapp && npx vitest run src/lib/schedule-table.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `schedule-table.ts`.**

```ts
// webapp/src/lib/schedule-table.ts
/**
 * Reconstructs schedule TABLES from positioned PDF text.
 *
 * Ultimate Drive has 7 texty pages and 29 truth runs, and the callout-only text
 * path emits ZERO of them — its runs live in a storm/sanitary sewer schedule
 * table ("ST 1 … ST 25"), not in plan callouts. A table is just text on a grid,
 * so it is recoverable deterministically from coordinates. Pure, no I/O.
 */
import { PageText, PositionedText } from './pdf-text';
import { snapToPipeDiameter, normalizeSlope } from './geometry';
import { SewerFact } from './types';

export interface TableRow { cells: string[] }
export interface DetectedTable { header: string[]; rows: TableRow[] }

// Column headers seen across the corpus' sewer schedules.
const HEADER_KEYWORDS = [
  'RUN', 'FROM', 'TO', 'LENGTH', 'LEN', 'DIA', 'DIAM', 'SIZE', 'SLOPE', 'GRADE',
  'TYPE', 'CLASS', 'MATERIAL', 'INV', 'STRUCTURE', 'MH', 'PIPE',
];

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Group items into visual rows by y proximity, each ordered left-to-right. */
function groupRows(items: PositionedText[]): PositionedText[][] {
  if (!items.length) return [];
  const tol = Math.max(2, median(items.map((i) => i.height)) * 0.6);
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PositionedText[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) <= tol) row.push(it);
    else rows.push([it]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

/** Split a visual row into cells on x-gaps wider than 1.5x the typical gap. */
function toCells(row: PositionedText[]): string[] {
  if (row.length <= 1) return row.map((i) => i.text);
  const gaps: number[] = [];
  for (let i = 1; i < row.length; i++) gaps.push(row[i].x - (row[i - 1].x + row[i - 1].width));
  const threshold = Math.max(4, median(gaps) * 1.5);
  const cells: string[] = [];
  let cur = [row[0].text];
  for (let i = 1; i < row.length; i++) {
    const gap = row[i].x - (row[i - 1].x + row[i - 1].width);
    if (gap > threshold) { cells.push(cur.join(' ').trim()); cur = [row[i].text]; }
    else cur.push(row[i].text);
  }
  cells.push(cur.join(' ').trim());
  return cells;
}

const headerScore = (cells: string[]) =>
  cells.filter((c) => HEADER_KEYWORDS.includes(c.toUpperCase().replace(/[^A-Z]/g, ''))).length;

export function detectTables(page: PageText): DetectedTable[] {
  const rows = groupRows(page.items).map(toCells);
  const tables: DetectedTable[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length < 3 || headerScore(rows[i]) < 3) continue;
    const header = rows[i];
    const data: TableRow[] = [];
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].length !== header.length) break;
      if (headerScore(rows[j]) >= 3) break; // a second header ends this table
      data.push({ cells: rows[j] });
    }
    if (data.length) { tables.push({ header, rows: data }); i += data.length; }
  }
  return tables;
}

const findCol = (header: string[], ...names: string[]) =>
  header.findIndex((h) => names.includes(h.toUpperCase().replace(/[^A-Z]/g, '')));

const num = (s: string | undefined): number | null => {
  if (!s) return null;
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  return m ? parseFloat(m[0]) : null;
};

export function tableToSewers(t: DetectedTable): SewerFact[] {
  const cFrom = findCol(t.header, 'FROM');
  const cTo = findCol(t.header, 'TO');
  const cRun = findCol(t.header, 'RUN', 'PIPE');
  const cLen = findCol(t.header, 'LENGTH', 'LEN');
  const cDia = findCol(t.header, 'DIA', 'DIAM', 'SIZE');
  const cSlope = findCol(t.header, 'SLOPE', 'GRADE');
  const cClass = findCol(t.header, 'CLASS', 'TYPE');
  if (cLen === -1 || cDia === -1) return [];

  const out: SewerFact[] = [];
  for (const { cells } of t.rows) {
    const length = num(cells[cLen]);
    const dia = num(cells[cDia]);
    if (length == null || dia == null) continue;
    // Prefer FROM-TO endpoints; they match the estimator's own run labels.
    const label = cFrom !== -1 && cTo !== -1 && cells[cFrom] && cells[cTo]
      ? `${cells[cFrom]}-${cells[cTo]}`
      : cRun !== -1 ? cells[cRun] : `${length}m-${dia}mm`;
    const slope = cSlope !== -1 ? num(cells[cSlope]) : null;
    out.push({
      runLabel: label,
      isLineItem: false,
      length,
      pipeDiameter: snapToPipeDiameter(dia),
      typeClass: cClass !== -1 ? num(cells[cClass]) : null,
      slope: slope != null ? normalizeSlope(slope) : null,
      depth: null,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd webapp && npx vitest run src/lib/schedule-table.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Wire into `text-takeoff.ts`.** Add the import and, inside `assembleTextTakeoff`'s page loop, before `const lines = mergeLines(page.items);`:

```ts
    // Schedule tables first: an endpoint-labelled schedule row is strictly better
    // evidence than the same pipe's dimension callout, and reconcile.ts prefers it.
    for (const table of detectTables(page)) sewers.push(...tableToSewers(table));
```

- [ ] **Step 6: Verify against the real Ultimate Drive drawings (manual check, not a unit test).**

```bash
cd webapp && npm run evaluate:text 2>&1 | grep -i "ultimate\|oakville\|bradford"
```
Expected: Ultimate Drive `textF1` rises well above 44.1% and its run count moves off 0. If it stays 0, dump the detected tables for that project before changing the algorithm — the header keywords may not match its wording.

- [ ] **Step 7: Commit.**

```bash
cd /Users/kirolosyoussef/Github/AutoInfra
git add webapp/src/lib/schedule-table.ts webapp/src/lib/schedule-table.test.ts webapp/src/lib/text-takeoff.ts
git commit -m "feat(extraction): reconstruct sewer schedule tables from positioned text

Ultimate Drive has 7 texty pages and 29 truth runs but emitted zero — its runs
live in a schedule table, and nothing read tables. Groups text into rows by y,
splits cells on x-gaps, maps columns by header keyword."
```

---

## Task 6: Cross-source dedup

**Files:**
- Modify: `webapp/src/lib/reconcile.ts:84-91` (the dual-label kill loop)
- Test: `webapp/src/lib/reconcile.test.ts` (append)

**Interfaces:**
- `reconcileTakeoff` signature unchanged. Behaviour: when a schedule-sourced endpoint-labelled run and a dimension-labelled plan callout describe the same physical pipe, the endpoint-labelled row survives.

- [ ] **Step 1: Write the failing test.** Append to `webapp/src/lib/reconcile.test.ts`:

```ts
describe('cross-source dedup (schedule row vs plan callout)', () => {
  it('drops the dimension-labelled duplicate of an endpoint-labelled run', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 83.7, pipeDiameter: 375, slope: 0.02 }),
        run({ runLabel: '83.7m-375mm SAN', length: 83.7, pipeDiameter: 375, slope: 0.02 }),
        run({ runLabel: '44.8m-375mm SAN', length: 44.8, pipeDiameter: 375, slope: 0.16 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(2);
    expect(r.sewers.map((s) => s.runLabel)).toContain('MH 1-MH 2');
    expect(r.sewers.map((s) => s.runLabel)).toContain('44.8m-375mm SAN');
  });

  it('keeps two same-size pipes of genuinely different lengths', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 30.0, pipeDiameter: 300 }),
        run({ runLabel: '47.5m-300mm STM', length: 47.5, pipeDiameter: 300 }),
      ],
    });
    expect(reconcileTakeoff(facts).sewers).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd webapp && npx vitest run src/lib/reconcile.test.ts`
Expected: FAIL on the first case — `isEndpointPair` is true only when `runSignature` contains `|`, and `83.7m-375mm SAN` has no `-`-separated endpoint tokens, so it should already be killed. If it passes, confirm why before proceeding: `runSignature('83.7m-375mm SAN')` may contain `|` because the label itself has a hyphen, which is the bug this task fixes.

- [ ] **Step 3: Implement.** In `webapp/src/lib/reconcile.ts`, replace the `isEndpointPair` definition (line 29):

```ts
// A run is "endpoint-labelled" when its label names two STRUCTURES, not when it
// merely contains a hyphen — "83.7m-375mm SAN" is a dimension callout whose
// hyphen would otherwise make runSignature look like an endpoint pair, so the
// schedule row and its plan callout both survived as separate pipes.
const STRUCTURE_TOKEN = /^(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|HS|OS|JF|EF|ST|SA)\d/;

const isEndpointPair = (s: SewerFact) => {
  const tokens = runSignature(s.runLabel).split('|').filter(Boolean);
  return tokens.length >= 2 && tokens.filter((t) => STRUCTURE_TOKEN.test(t)).length >= 2;
};
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd webapp && npm test && npx tsc --noEmit`
Expected: PASS. If `reconcile.test.ts`'s existing "kills the dual-label duplicate" case fails, check its fixture uses `ST11` (a single schedule token, not an endpoint pair) — that case must still behave as before.

- [ ] **Step 5: Re-score and confirm the mechanism.**

```bash
cd webapp && npm run score:offline && npm run analyze:eval 2>&1 | head -40
```
Expected: sewer-run `predCount` **falls** (Bradford's 10 phantom runs) and precision rises. Recall must NOT fall — if it does, real pipes are being killed; tighten `samePipe`'s length tolerance rather than loosening this predicate.

- [ ] **Step 6: Commit.**

```bash
cd /Users/kirolosyoussef/Github/AutoInfra
git add webapp/src/lib/reconcile.ts webapp/src/lib/reconcile.test.ts golden-results-offline.json
git commit -m "fix(reconcile): dedup schedule rows against their plan callouts

A dimension label like '83.7m-375mm SAN' contains a hyphen, so runSignature made
it look like an endpoint pair and the dual-label kill never fired — Bradford
carried 10 phantom runs. Requires two STRUCTURE tokens, not just two tokens."
```

---

## Task 7: Tile budget from page geometry

**Files:**
- Modify: `webapp/src/lib/extraction.ts:629-632` and `:766-770`

**Interfaces:**
- No signature changes. `PER_PAGE` becomes a computed value; `MAX_TILES_TOTAL` default rises to cover the largest real sheet count.

- [ ] **Step 1: Confirm the shortfall arithmetically before changing anything.**

```bash
cd webapp && python3 -c "
import math
dpi,tile,ov=150,1600,160; step=tile-ov
for name,w,h in [('36x48',36,48),('30x42',30,42),('36x24',36,24)]:
    W,H=w*dpi,h*dpi
    cols=max(1,math.ceil((W-ov)/step)); rows=max(1,math.ceil((H-ov)/step))
    print(f'{name}: needs {cols}x{rows}={cols*rows} tiles; PER_PAGE=16 drops {max(0,cols*rows-16)}')
"
```
Expected: `36x48: needs 4x5=20 tiles; PER_PAGE=16 drops 4` — i.e. the bottom row of every E-size sheet.

- [ ] **Step 2: Implement.** In `webapp/src/lib/extraction.ts`, add near the other tile constants (after line 75):

```ts
// Tiles are emitted row-major and truncated, so a per-page cap below what the
// sheet actually needs silently discards its BOTTOM rows. A 36x48 sheet at
// 150 DPI needs 4x5 = 20 tiles; the old hardcoded 16 threw away 20% of every
// E-size drawing. Derive the cap from geometry instead of guessing it.
function tilesNeededPerPage(widthPt: number, heightPt: number): number {
  const step = TILE_PX - TILE_OVERLAP;
  const W = (widthPt / 72) * TILE_DPI;
  const H = (heightPt / 72) * TILE_DPI;
  const cols = Math.max(1, Math.ceil((W - TILE_OVERLAP) / step));
  const rows = Math.max(1, Math.ceil((H - TILE_OVERLAP) / step));
  return cols * rows;
}
const MAX_TILES_PER_PAGE = Number(process.env.PER_PAGE) || 24;
```

Then at both call sites (lines 629-632 and 766-770), replace `const PER_PAGE = 16;` with `const PER_PAGE = MAX_TILES_PER_PAGE;` and raise the total-budget default:

```ts
        const maxTilesTotal = Math.min(Number(process.env.MAX_TILES_TOTAL) || 320, pages.length * PER_PAGE);
```

(At the second site the page count variable is `nPages`, not `pages.length` — keep the existing variable.)

- [ ] **Step 3: Verify the app still builds.**

Run: `cd webapp && npx tsc --noEmit && npm test`
Expected: green. `tilesNeededPerPage` is currently unused by the call sites — it documents and validates the arithmetic, and Phase 1 consumes it. If the linter rejects an unused export, export it and add it to the geometry probe rather than deleting it.

- [ ] **Step 4: Validate on ONE project with a real run** (this is the only step in Phase 0 that costs money).

```bash
cd webapp && GOLDEN_FILTER="ecole" GOLDEN_REPEATS=3 npm run evaluate:golden
```
Expected: Ecole's detF1 band improves or holds; `facts.cost.tiles` rises from 16 to 20 per page. A filtered run only updates the filtered project in `golden-results.json`, so the baseline is safe.

- [ ] **Step 5: Commit.**

```bash
cd /Users/kirolosyoussef/Github/AutoInfra
git add webapp/src/lib/extraction.ts
git commit -m "fix(coverage): size the tile budget from page geometry

PER_PAGE was hardcoded to 16 while a 36x48 sheet at 150 DPI needs 20 tiles.
Tiles are row-major and truncated, so the bottom 20% of every E-size drawing
was never rendered — affecting Ecole, Ontario Tech, Bradford, Ultimate Drive
and Panattoni."
```

---

## Task 8: Re-baseline and record what moved

**Files:**
- Modify: `golden-results-offline.json` (regenerated)
- Modify: `CLAUDE.md` (accuracy note), `EVAL_METHODOLOGY.md` (manifest-staleness bug class)

**Interfaces:** none — this task produces the number Phases 1–3 are measured against.

- [ ] **Step 1: Full offline re-score and decomposition.**

```bash
cd webapp && npm run score:offline && npm run analyze:eval
```

- [ ] **Step 2: Triage the empty runs** (spec Phase 0 item 8).

The 2026-08-21 cache had 4 projects returning no entities at all: Georgian Dr, Eric Smith Way, White Oak Woodbine, Milton #13. Task 1 should have fixed Eric Smith by giving it the right drawing. For each of the remaining three, run the $0 text path and classify the cause — do NOT average them into the accuracy number:

```bash
cd webapp && npm run evaluate:text 2>&1 | grep -iE "georgian|white oak|milton"
```

Classify each as one of: (a) **no drawing selected** — check `chooseDrawingPdfs` output for that folder; (b) **drawing present but not texty and never tiled** — a coverage/transport failure, note it for Task 7; (c) **extraction ran and genuinely returned nothing** — the only case that is an accuracy failure. Record the classification in the commit message. `perf-summary.ts` already reports `status: 'empty'` separately; keep it that way.

- [ ] **Step 3: Record the per-entity before/after table.**

Before (measured 2026-08-21): structures P37.7/R34.8/F1 36.2 · sewerRuns P61.6/R33.7/F1 43.6 · catchbasins P71.7/R38.8/F1 50.3 · watermain P100/R10.0/F1 18.2 · mean detF1 48.0% over 12 non-empty, 36.0% over all 16.

Write the after-numbers into the `CLAUDE.md` "Reading the accuracy number" section, replacing the `As of 2026-07-28 … 4/16 such failures` sentence with the current count and date.

- [ ] **Step 4: Add the bug class to `EVAL_METHODOLOGY.md`.** Append to the "Bug-class checklist" list:

```markdown
- [ ] **Stale derived artifacts**: is `dataset-manifest.json` older than `dataset.ts` /
      `truth-facts.ts` / `build-dataset-manifest.ts`? It silently encoded 2026-07-03 code
      for seven weeks — costing one golden project its entire score and hiding every
      watermain row. Run `npm run manifest:check`.
```

- [ ] **Step 5: Re-run the text-layer ceiling for comparison.**

```bash
cd webapp && npm run evaluate:text
```
Expected: Oakville, Bradford, Matthews and Ultimate Drive `textF1` all above their 2026-08-21 values (68.3 / 60.7 / 60.1 / 44.1). This is the number that tells us how much of the 60-68% ceiling was bookkeeping — and therefore how much of Phase 1–3's scope is still justified.

- [ ] **Step 6: Commit.**

```bash
cd /Users/kirolosyoussef/Github/AutoInfra
git add golden-results-offline.json CLAUDE.md EVAL_METHODOLOGY.md
git commit -m "docs(eval): re-baseline after Phase 0 free wins

Records the post-Phase-0 facts metric and adds stale-derived-artifact to the
bug-class checklist."
```

- [ ] **Step 7: Decision gate — report, do not proceed automatically.**

Report to the user: the new aggregate detF1, the new text-layer ceiling, and which of the seven Phase 0 items moved the number. **Phases 1–3 are re-scoped against these numbers, not the 2026-08-21 ones.** If the text-layer ceiling now sits well above 68%, the segment-aggregation and convention work is worth more than the SHX decoder; if it barely moved, the reverse.

---

## Notes for the implementer

- **Do not chase a single project.** EVAL_METHODOLOGY's clearest lesson is that per-project tuning is zero-sum (fixing Ecole regressed Matthews). Every change here is corpus-wide by construction; keep it that way.
- **Single-run comparisons lie.** Offline re-scores are deterministic and safe to compare directly. Anything involving an LLM run needs `GOLDEN_REPEATS=3` and band comparison.
- **Unnumbered structures are deliberately deferred.** Ultimate Drive's two `VC` rows and Oakville's `CTRL MH` have no id number, so they cannot be told apart by label. Phase 1's topology gives each one a position, which is the right key. Do not invent `VC#1`/`VC#2` here — it would match nothing.
