# CLAUDE.md — AutoInfra

Working notes for AI agents (and humans) iterating on this repo. Keep it current:
when you change the architecture, update this file in the same commit.

See `REDESIGN.md` for the full diagnosis and the target architecture. This file is the
quick operational map. **See `EVAL_METHODOLOGY.md` before trying to improve accuracy** — it
is the playbook (measure the ruler first, hunt bugs offline for free, batch fixes → one
regression run, `npm run analyze:eval`) that keeps us out of the per-project grinding trap.

## What this is

Turns civil-engineering servicing **drawings (PDF)** into a populated **cost-estimating
spreadsheet (.xlsx)** + quote PDF, for Ontario municipal infrastructure: storm/sanitary
**sewers**, **manholes/catchbasins**, and **watermain**.

## Pipeline (the important mental model)

Two stages, deliberately separated (this is the core of the redesign):

```
PDF ──▶ extractFromPDF()  ──▶ TakeoffFacts   facts only, NO dollars   (extraction.ts)
                                   │
                                   ▼
        priceTakeoff(facts, rules) ──▶ ExtractionResult  (priced)     (costing-rules.ts)
                                   │
                                   ▼
        populateTemplate() ──▶ .xlsx  + generateQuote() ──▶ quote.pdf  (spreadsheet.ts)
```

- **Extraction** asks the LLM ONLY for physical facts on the drawing (labels, lengths,
  diameters, slopes, elevations, counts). It must never output prices.
- **Costing** is deterministic: every dollar/labor/fee comes from one explicit, versioned,
  unit-tested rule table (`DEFAULT_COSTING` in `costing-rules.ts`).

## Layout

```
webapp/                       Next.js app (everything lives here)
  src/app/api/process/        main endpoint: PDF -> facts -> priced -> xlsx + quote
  src/app/page.tsx            upload UI + accuracy scoreboard (+ legacy flywheel buttons)
  src/lib/
    extraction.ts             ⭐ LLM extraction -> TakeoffFacts (locator + 3 agents, or single-pass)
    costing-rules.ts          ⭐ DEFAULT_COSTING table + pure priceTakeoff(facts) -> ExtractionResult
    geometry.ts               pure helpers: snapToPipeDiameter, snapToMHSize, normalizeSlope
    compare-facts.ts          ⭐ facts-level eval metric (entity F1 + field accuracy)
    truth-facts.ts            reads an estimator's filled xlsx into TakeoffFacts (for eval)
    spreadsheet.ts            writes ExtractionResult into the .xlsx template
    quote-generator.ts        renders the quote PDF
    constants.ts              DEFAULT_PARAMS, INPUT_CELLS (template cell map), PIPE/MH sizes
    types.ts                  TakeoffFacts (facts) + ExtractionResult (priced) schemas
    modular-prompts.ts        per-agent + single-pass prompts (facts only, no pricing)
    few-shot-examples.ts      builds few-shot block from few_shot_examples.json
    dynamic-rules.json        "flywheel"-appended English rules (machine-written; frozen)
    *.test.ts                 vitest unit tests (geometry, costing, facts metric, spreadsheet)
  src/scripts/                eval + "flywheel" CLIs (see below)
  empty_templates/            the real .xlsx templates (SHORT / LONG)
empty_templates/              (also at repo root) template source
existing_projects_*_data/     ground-truth PDFs+XLSX — GITIGNORED, not in the repo
```

> The ground-truth data is **gitignored**, so the golden eval cannot run from a clean clone.
> You need the datasets locally to reproduce accuracy numbers. The unit tests do NOT need it.

## Run it

```bash
cd webapp
npm install
npm run dev                     # http://localhost:3000
npm test                        # vitest unit suite (no dataset required)

# Golden-set eval (needs existing_projects_training_data/ present).
# Two-tier + variance-aware — single-run noise is large, so ALWAYS use repeats to tell
# a real change from noise, and iterate on the focus set before the full regression run.
npm run evaluate:golden                                   # full 16-project set, 1 run

# Fast FOCUS loop (the current problem projects) with variance bands:
GOLDEN_FOCUS=true  GOLDEN_REPEATS=3 npm run evaluate:golden
# Arbitrary subset (great for local iteration on a couple of projects):
GOLDEN_FILTER="orillia,king forest" GOLDEN_REPEATS=3 npm run evaluate:golden
# Full REGRESSION gate before accepting a change (VM recommended, ~15-25 min):
GOLDEN_REPEATS=3 npm run evaluate:golden

# Knobs: GOLDEN_CONCURRENCY (projects in parallel, def 3), BATCH_CONCURRENCY / BATCH_TILES
# (tile calls), GOLDEN_RESUME=true (skip cached), ENABLE_EVAL_CACHE=false (never seed cache).
# A filtered run only updates the filtered projects in golden-results.json (others kept),
# so a focus run won't clobber the full baseline. The scoreboard prints mean + [lo–hi] band.
# Metric/matching/costing changes can be re-scored OFFLINE from the persisted
# generated_spreadsheets/predicted_facts.json — no LLM calls.
```

Run the eval on stable infra: local works for a small filtered set (streaming rides the
laptop's flaky network), but the full set belongs on the throwaway GCP VM using **Vertex**
(`USE_VERTEX_AI=true`) — GCP-internal networking has none of the local `UND_ERR_SOCKET` drops.

Model access: **Gemini** via either Vertex AI (`USE_VERTEX_AI=true`, needs
`GCP_PROJECT_ID`) or Google AI Studio (`GEMINI_API_KEY`). Current model: `gemini-2.5-flash`.
When choosing/changing models or providers, check current model IDs and pricing.

## The core problem (and where it now stands)

Cell-accuracy historically stalled ~35% and underperformed a naive RAG baseline. Root cause
was **not the model**: the old schema mixed *facts* (on the drawing) with *pricing judgment*
(in the estimator's head), and the metric scored guessed dollars cell-by-cell. The redesign
splits the two (done) and measures extraction with a **facts metric** (done). Remaining work
is empirical: validate the facts metric on the dataset and A/B single-pass vs agents.

## Where the levers are

- **Prompts**: `modular-prompts.ts` (agent prompts + `getSinglePassPrompt`). Few-shot:
  `few_shot_examples.json` (still contains legacy pricing in examples — harmless, parseFacts
  ignores it; strip when convenient).
- **Pricing**: `costing-rules.ts::DEFAULT_COSTING`. This is the ONLY place dollars live.
  Do NOT put pricing back into the extraction path.
- **Template cells**: `constants.ts::INPUT_CELLS` is the intended source of truth;
  `spreadsheet.ts` still re-hardcodes them — keep in sync (or unify).
- **Eval**: `compare-facts.ts` (canonical, facts-level) + `compare-sheets.ts` (legacy cell)
  + `compare-jsons.ts` (legacy semantic). Golden set is defined in **two** disjoint places
  (`evaluate-golden.ts` and `constants.ts::GOLDEN_PROJECTS`) — reconcile against the real
  dataset before trusting it.
- **Truth selection**: a project folder holds copies, non-matching alternate designs, empty
  appendix/removals decoys, and genuine per-block/street SPLITS. `truth-facts.ts::resolveTruthFacts`
  picks canonically: `truth-manifest.json` (repo root) overrides win (merge splits / pin the
  canonical file / `exclude` unscoreable projects), else it auto-picks the **richest non-empty**
  candidate — never an empty decoy. The old `xlsxFiles[0]` (readdir order) silently scored several
  projects against empty truth. When adding projects to the golden set, audit their workbooks
  (offline count) and add a manifest entry if the auto-pick is wrong.

## Scripts (`src/scripts/`) — live vs legacy

- **Live**: `evaluate-golden.ts` (`npm run evaluate:golden`), `compare-sheets.ts`,
  `batch-evaluate.ts` + `flywheel-gate.ts` (`npm run flywheel:local`).
- **Flywheel (frozen)**: `batch-evaluate-cloud.ts`, `analyze-failures{,-cloud}.ts`,
  `flywheel-gate.ts`, `flywheel-rollback.ts`, `compile-scoreboard.ts`, `compare-jsons.ts`.
  CI `flywheel.yml` schedule is disabled. Do NOT re-enable auto-commit of prompt rules until
  the facts metric is the gate (see REDESIGN §3.5).
- `Dockerfile.flywheel` still points at a non-existent `src/scripts/flywheel.ts` (broken).

## Conventions & gotchas

- **Tests exist now** (`vitest`, `npm test`). Add a test with any change to a pure function
  or to costing/eval logic. Pure modules: `geometry.ts`, `costing-rules.ts`, `compare-facts.ts`.
- The global `NODE_TLS_REJECT_UNAUTHORIZED='0'` hack has been **removed** — rely on the
  proxy CA bundle; don't reintroduce it.
- `getCachedOrCallLLM` can return a cache entry derived from `latest_result.json` *instead
  of calling the model*. During eval this can read data seeded from ground truth. Disable
  with `ENABLE_EVAL_CACHE=false`.
- Excel templates use **shared formula chains**; `spreadsheet.ts::breakSharedFormulas` must
  run before force-writing calculated columns (depth/drop/diameter). Don't reorder it.
- Slopes: drawings may use ‰; `normalizeSlope` divides by 10 when slope > 10. Diameters snap
  to `PIPE_DIAMETERS`.

## Deploy / CI

- `.github/workflows/deploy.yml` — pushes to `master`/`main` deploy to Cloud Run.
- `.github/workflows/flywheel.yml` — scheduled optimization loop (**schedule disabled**).

## Working agreement for changes here

1. Keep each change shippable; the app must still run; `npm test` and `tsc --noEmit` stay green.
2. Add a test with any change to a pure function or to costing/eval logic.
3. When you touch architecture, update this file and `REDESIGN.md`.
4. Pricing belongs in `costing-rules.ts` — never in the extraction path.
</content>
