# AutoInfra — Diagnosis & Redesign

> Status: proposal. Supersedes `optimization_plan.md` (kept for history).
> Companion: `CLAUDE.md` (operational map).

This document explains **what the system is trying to do**, **why it underperforms a simple
RAG baseline**, and a **simpler, testable target design** plus a concrete cleanup list.

---

## 1. Intent — what the codebase is actually for

A civil-construction estimator is handed a PDF set of **servicing drawings** (plan +
profile sheets, plus MH/pipe schedules) and produces a **cost estimate** in a fixed Excel
workbook with three tabs — `MANHOLES`, `SEWERS`, `WATERMAIN`. Each tab has heavy embedded
formulas; the estimator only types a handful of **input cells** per row (label, length,
diameter, class, slope, depth, a few cost overrides), and the workbook computes the price.

AutoInfra automates the typing: **PDF → structured takeoff → populated workbook + quote**.
The webapp (`/api/process`) does exactly this; the `src/scripts/*` + "flywheel" exist to
**measure and self-improve** extraction accuracy against a library of past projects whose
finished workbooks are the ground truth.

So there are really two products in one repo:
1. **The pipeline** (`extraction.ts` → `spreadsheet.ts` → `quote-generator.ts`).
2. **The eval/optimization harness** (`src/scripts/*`, `dynamic-rules.json`, CI flywheel).

---

## 2. Why it underperforms a simple RAG system

Baseline today (`dynamic-rules.json`): `baselineAccuracy ≈ 34.7%` cell-accuracy on the
golden set. The problems are structural, not model-quality:

### 2.1 The schema mixes *facts* with *judgment* (root cause)
`ExtractionResult` asks the model, in one shot, for both:
- **Drawing facts** — `length`, `pipeDiameter`, `slope`, `topElevation`, CB counts. These
  are on the page; a model can read them.
- **Estimator judgment** — `addMaterials`, `addLE`, `grateEach`, `laborRates`, and appended
  fees like `VIDEO ($25/m)`, `LAYOUT $5000`, `AS BUILT $5000`. These are **not on the
  drawing**; they come from the estimator's experience and a price book.

Asking the model for the second category guarantees hallucination, and the eval then scores
those hallucinated dollars against the estimator's real numbers. A large share of scored
cells are **unknowable from the input** — that alone caps achievable accuracy and adds
noise that drowns the signal from the facts the model *does* get right.

### 2.2 The metric is brittle and partly unfair
`compare-sheets.ts` does fuzzy **row matching by label**, then cell-by-cell equality (5%
numeric tolerance):
- If the model labels a run `CB1-CB5` but the estimator wrote `CB 3-DCBMH 2`, the row
  fails to match and **every cell in it counts as missed** — a single naming difference
  zeroes a correct pipe.
- Estimators frequently use **custom/grouped layouts** (documented in `optimization_plan.md`);
  when the truth sheet doesn't match the template, the comparator bails to "N/A" or scores
  against the wrong cells.
- Pricing cells (see 2.1) are scored with the same weight as physical facts.

Net: the number is low, jumpy, and doesn't isolate "did we read the drawing correctly?" —
which is the only thing the model controls.

### 2.3 Magic-number "heuristics" pollute the output
`applyDeterministicHeuristics()` injects hardcoded dollars — `DCBMH → $1800`,
`CBMH → $900`, `/INS → length*80`, `CONN → $500`, drop MH → `$3000`, and unconditionally
appends `$5000 LAYOUT` + `$5000 AS BUILT` + `$25/m VIDEO` to **every** project. These are
guesses scored against reality. They're also untested and undiscoverable (buried in a 1500-
line file).

### 2.4 Over-engineered extraction path
For each project: a **locator** pass, then **3 parallel agents** (manholes/sewers/watermain),
each **chunking** pages into 15-page slices, each with a large prompt + few-shot block, then
**dedup/merge** logic per category. That's a lot of moving parts and 4–7× the token cost,
and it can *lose* the easiest signal — most takeoff data is literally in **MH/pipe schedule
tables** on a page or two. A naive "find the schedule pages, transcribe the table into the
known columns" pass is both simpler and typically more accurate, which is exactly why a
plain RAG/transcription approach beats this.

### 2.5 A self-modifying flywheel optimizing a noisy objective
`analyze-failures*.ts` asks an LLM to **write new English rules**, `flywheel-gate.ts` keeps
them if the noisy cell metric ticks up, and CI commits `dynamic-rules.json` /
`few_shot_examples.json` back to `master`. Optimizing against the metric from 2.2 means
it's chasing noise; the schedule is disabled and accuracy plateaued. This is the "vibe
coded" layer — lots of machinery, weak grounding.

### 2.6 No tests, and reliability smells
- **Zero tests** in the repo, despite many pure, easily-tested functions.
- `extraction.ts` sets `NODE_TLS_REJECT_UNAUTHORIZED='0'` globally (disables TLS
  verification process-wide).
- `getCachedOrCallLLM` can **skip the model and return data derived from
  `latest_result.json`** — during eval this risks reading ground-truth-seeded values.
- Cell maps are duplicated (`constants.ts::INPUT_CELLS` vs hardcoded refs in
  `spreadsheet.ts`); golden set is defined twice; local vs `*-cloud` scripts are forks.

---

## 3. Target design — simpler, separable, testable

**Principle: split the ML problem from the business problem, and measure them apart.**

```
PDF ──▶ [1] Extraction (LLM)         ──▶ TakeoffFacts   (facts only, no $)
            │  schedule-first, single structured pass
            ▼
        [2] Costing (deterministic)  ──▶ PricedTakeoff  (facts + $ from rule table)
            │  one versioned rule/price table + user overrides
            ▼
        [3] Template fill (declarative cell map) ──▶ .xlsx + quote
```

### 3.1 Stage 1 — Extraction returns only facts
New `TakeoffFacts` schema — **no dollar fields**:
```ts
interface TakeoffFacts {
  project: { name: string; jobNumber: string; date: string };
  structures: {                 // manholes + catchbasins as found
    label: string;              // exact label from drawing
    kind: 'MH' | 'CBMH' | 'DCBMH' | 'CB' | 'DICB' | 'OTHER';
    topElevation?: number; invert?: number; pipeOutDiameter?: number;
    diameter?: number; existing: boolean;   // existing-to-remain flag, not silently dropped
  }[];
  sewerRuns: {
    from?: string; to?: string; label?: string;
    length?: number; diameter?: number; class?: number; slope?: number; depth?: number;
    system: 'STORM' | 'SAN' | 'UNKNOWN';
  }[];
  watermainRuns: { sizeAndType: string; length?: number; diameter?: number }[];
  evidence: { field: string; page: number }[];   // page each value came from (auditing)
  confidence: number;
}
```
- One structured call (use the provider's JSON/structured-output mode) over the
  **schedule + profile pages** (keep a cheap locator only for very large sets). Drop the
  3-agent split and per-category dedup unless a measured win justifies it.
- Keep deterministic *normalization* (snap diameters, ‰→% slope) — but as small, **tested**
  pure functions, not inline.
- Never invent pricing here.

### 3.2 Stage 2 — Costing is explicit, versioned, testable
Move every dollar rule out of `extraction.ts` into one declarative table, e.g.
`src/lib/costing-rules.ts` (or JSON), seeded from `DEFAULT_PARAMS` and the estimator's price
book, overridable from the existing settings page:
```ts
costing = {
  structureSurcharge: { CBMH: 900, DCBMH: 1800, DROP_MH: 3000, ... },
  pipeAddOns: { insulation: { mtrlPerM: 80, lePerM: 40 }, connection: { mtrl: 500, le: 250 } },
  standardFees: { video: { perM: 25 }, layout: 5000, asBuilt: 5000 },
  laborRates: { scb: 200, dcb: 250, dicbFC: 465, ddicbFC: 715 },
}
```
A pure `priceTakeoff(facts, costing) -> PricedTakeoff` does the mapping. Now pricing is
inspectable, diff-able, unit-tested, and per-client tunable — and excluded from the
*extraction* metric.

### 3.3 Stage 3 — One declarative cell map
Make `constants.ts::INPUT_CELLS` the single source of truth and have `spreadsheet.ts`
iterate it, instead of re-hardcoding `B${row}`/`C${row}`. Keep `breakSharedFormulas` (it's
correct and necessary).

### 3.4 Evaluation redesign — measure the two stages apart
Replace the single cell-% with:

- **Extraction quality** (what the model controls): entity match first (sewer runs by
  endpoint set; structures by normalized label), then per-field scoring on matched entities
  → report **precision / recall / F1 for entity detection** and **field accuracy** (exact
  for diameter/class, ±tolerance for length/slope/depth). This isolates reading skill from
  pricing.
- **Costing coverage** (what rules control): does `priceTakeoff` reproduce the estimator's
  dollar cells given correct facts? Scored separately so a missing price rule doesn't look
  like a model failure.
- **One** comparison module and **one** golden-set definition. Commit a handful of **small
  synthetic fixtures** (a fake TakeoffFacts + expected priced output + a tiny xlsx) so the
  eval logic itself is unit-tested **without** the gitignored datasets.

### 3.5 Flywheel — shelve until the metric is trustworthy
Self-writing prompt rules optimizing a noisy metric is the wrong loop. Recommended: freeze
`dynamic-rules.json` (don't auto-commit), keep the human-in-the-loop golden eval, and only
revisit automated optimization once 3.4 gives a stable extraction-F1 to optimize against.

---

## 4. Cleanup inventory (proposed deletions)

**Safe — scratch/throwaway (all under `webapp/`):**
`read_gt.js`, `read_gt2.js`, `read_gt3.js`, `read_template.js`, `analyze_gt.js`,
`extract_fewshot.js`.

**Legacy / superseded scripts:**
- `src/scripts/evaluate.ts` — old count-based eval, writes `ground_truth_dataset.json`;
  replaced by the golden/compare path.
- `src/scripts/evaluate-single.ts`, `extract-single.ts`, `list-eval-files.ts`,
  `test-gcs.ts` — one-off scratch CLIs.

**Duplicate local/cloud forks — collapse to one parametrized script each:**
- `batch-evaluate.ts` ⊕ `batch-evaluate-cloud.ts`
- `analyze-failures.ts` ⊕ `analyze-failures-cloud.ts`

**Broken/unused infra:**
- `Dockerfile.flywheel` references `src/scripts/flywheel.ts`, **which does not exist**.
- Reconcile the three Dockerfiles (`Dockerfile`, `Dockerfile.eval`, `Dockerfile.flywheel`)
  + `cloudbuild-eval.yaml`.

**Consolidate (not delete):**
- Two eval comparators (`compare-sheets.ts` cell-level + `compare-jsons.ts` semantic) →
  keep the entity/field-level one from §3.4.
- Golden set defined twice (`evaluate-golden.ts` + `constants.ts::GOLDEN_PROJECTS`).
- Cell maps duplicated (`constants.ts` vs `spreadsheet.ts`).

**Decouple (product call):** `quote-generator.ts` is orthogonal to extraction accuracy;
fine to keep, but it shouldn't sit on the accuracy-improvement critical path.

---

## 5. Suggested sequence

1. **Tests + safety first (no behavior change):** add `vitest`; cover `normalizeSlope`,
   `snapToPipeDiameter`, `repairTruncatedJson`, `deduplicate*`, `adjustFormulaForRow`,
   `keysMatch`. Remove the global TLS-disable. Delete the §4 "safe" scratch files.
2. **Split the schema:** introduce `TakeoffFacts` + `costing-rules.ts` + `priceTakeoff`;
   move magic numbers out of `extraction.ts`. Pipeline output stays identical → guarded by
   tests.
3. **New eval (§3.4)** with committed synthetic fixtures; unify the golden set; retire the
   duplicate comparators/scripts.
4. **Simplify extraction** to a schedule-first single structured pass; A/B against the old
   3-agent path on the golden set using the new extraction-F1.
5. **Revisit the flywheel** only after step 4 yields a stable metric.

Each step is independently shippable and leaves the app runnable.
</content>
