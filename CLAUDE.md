# CLAUDE.md — AutoInfra

Working notes for AI agents (and humans) iterating on this repo. Keep it current:
when you change the architecture, update this file in the same commit.

See `REDESIGN.md` for the full diagnosis and the target architecture. This file is the
quick operational map.

## What this is

Turns civil-engineering servicing **drawings (PDF)** into a populated **cost-estimating
spreadsheet (.xlsx)** + quote PDF, for Ontario municipal infrastructure: storm/sanitary
**sewers**, **manholes/catchbasins**, and **watermain**.

## Layout

```
webapp/                       Next.js app (everything lives here)
  src/app/api/process/        main endpoint: PDF -> extraction -> xlsx + quote
  src/app/page.tsx            upload UI + accuracy scoreboard
  src/lib/
    extraction.ts             ⭐ LLM extraction pipeline (locator + 3 agents + heuristics)
    spreadsheet.ts            writes ExtractionResult into the .xlsx template
    quote-generator.ts        renders the quote PDF
    constants.ts              DEFAULT_PARAMS, INPUT_CELLS (template cell map), PIPE/MH sizes
    types.ts                  ExtractionResult & related schema
    modular-prompts.ts        per-agent system prompts
    few-shot-examples.ts      builds few-shot block from few_shot_examples.json
    dynamic-rules.json        "flywheel"-appended English rules (machine-written)
  src/scripts/                eval + "flywheel" CLIs (see below)
  empty_templates/            the real .xlsx templates (SHORT / LONG)
empty_templates/              (also at repo root) template source
existing_projects_*_data/     ground-truth PDFs+XLSX — GITIGNORED, not in the repo
```

> The ground-truth data is **gitignored**, so eval cannot run from a clean clone. You need
> the datasets locally to reproduce accuracy numbers.

## Run it

```bash
cd webapp
npm install
npm run dev                     # http://localhost:3000

# Local golden-set eval (needs existing_projects_training_data/ present):
npm run evaluate:golden
```

Model access: **Gemini** via either Vertex AI (`USE_VERTEX_AI=true`, needs
`GCP_PROJECT_ID`) or Google AI Studio (`GEMINI_API_KEY`). The current code uses
`gemini-2.5-flash`. When choosing/﻿changing models or providers, check current model IDs
and pricing rather than guessing.

## The core problem to keep in mind

Accuracy stalled around **~35%** (cell-by-cell vs the estimator's real sheet) and
underperforms a naive RAG baseline. The root cause is **not the model** — it's that the
schema and the metric mix two different things:

- **Facts** that are physically on the drawing (lengths, diameters, slopes, elevations,
  counts) — the model *can* get these.
- **Pricing judgment** that lives in the estimator's head (dollar surcharges, labor rates,
  standard fees) — the model *cannot* read these off a drawing, yet the code guesses them
  with magic numbers and the eval scores the guesses.

**North star:** separate Extraction (facts, LLM) from Costing (rules, deterministic) and
evaluate each separately. Details + target schema in `REDESIGN.md`.

## Where the levers are

- **Prompts**: `src/lib/modular-prompts.ts` (+ the big system prompt inside
  `extraction.ts::getSystemPrompt`). Few-shot: `few_shot_examples.json`.
- **Pricing magic numbers** (today): `extraction.ts::applyDeterministicHeuristics`
  — these should move into one explicit costing rule table (see redesign).
- **Template cells**: `constants.ts::INPUT_CELLS` is the intended source of truth;
  `spreadsheet.ts` currently re-hardcodes them — keep them in sync (or unify).
- **Eval comparison**: `src/scripts/compare-sheets.ts` (cell) and `compare-jsons.ts`
  (semantic). Golden set is defined in **two** places today
  (`evaluate-golden.ts` and `constants.ts::GOLDEN_PROJECTS`) — unify before trusting it.

## Scripts (`src/scripts/`) — what's live vs legacy

- **Live / wired**: `batch-evaluate-cloud.ts` & `flywheel-gate.ts` (CI `flywheel.yml`,
  currently disabled), `batch-evaluate.ts` + `flywheel-gate.ts` (`npm run flywheel:local`),
  `evaluate-golden.ts` (`npm run evaluate:golden`), `compare-sheets.ts`.
- **Legacy / scratch (candidates for deletion — see REDESIGN.md §4)**: `evaluate.ts`,
  `evaluate-single.ts`, `extract-single.ts`, `list-eval-files.ts`, `test-gcs.ts`, and the
  `*-cloud.ts` forks duplicate their local twins.
- `Dockerfile.flywheel` points at `src/scripts/flywheel.ts`, **which does not exist**.

## Conventions & gotchas

- **No test suite exists yet.** Add `vitest` and start with the pure functions in
  `extraction.ts` (`normalizeSlope`, `snapToPipeDiameter`, `repairTruncatedJson`,
  `deduplicate*`) and `spreadsheet.ts` (`adjustFormulaForRow`). They're pure and high-value.
- `extraction.ts` sets `NODE_TLS_REJECT_UNAUTHORIZED='0'` globally — **don't rely on this;
  remove it.** It disables TLS verification for the whole process.
- `getCachedOrCallLLM` can return a cache entry derived from `latest_result.json` *instead
  of calling the model*. Be careful: during eval this can read data seeded from ground
  truth. Disable with `ENABLE_EVAL_CACHE=false`.
- Excel templates use **shared formula chains**; `spreadsheet.ts::breakSharedFormulas`
  must run before force-writing calculated columns (depth/drop/diameter). Don't reorder it.
- Slopes: drawings may use ‰ (per-mille); code divides by 10 when slope > 10. Pipe
  diameters snap to a fixed standard set (`PIPE_DIAMETERS`).
- The "flywheel" rewrites `dynamic-rules.json` / `few_shot_examples.json` and commits them
  to `master` from CI. It's gated on the (noisy) cell metric and currently disabled.

## Deploy / CI

- `.github/workflows/deploy.yml` — pushes to `master`/`main` deploy to Cloud Run.
- `.github/workflows/flywheel.yml` — scheduled optimization loop (**schedule disabled**;
  manual `workflow_dispatch` only).

## Working agreement for changes here

1. Keep each change shippable; the app must still run.
2. Add a test with any change to a pure function or to costing/eval logic.
3. When you touch architecture, update this file and `REDESIGN.md`.
4. Don't reintroduce magic-number pricing into the extraction path — it belongs in the
   costing rule table.
</content>
</invoke>
