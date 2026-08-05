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

`extractFromPDF()` (`extraction.ts`) has three interpretation paths, chosen by the
`EXTRACTION_MODE` env var. **Unset/any other value = the original default path** (vision
both reads AND interprets tiles into TakeoffFacts JSON directly via
`getSinglePassPrompt`) — unchanged, still what runs in production today.

- `EXTRACTION_MODE=transcribe`: vision ONLY transcribes verbatim callouts off each tile
  (`getTranscriptionPrompt` → `TileTranscript[]`, no interpretation); a deterministic
  pure-code grammar (`callout-parser.ts` + `transcript-takeoff.ts::assembleTranscriptTakeoff`
  + `reconcile.ts::reconcileTakeoff`) turns that into TakeoffFacts. Splits "can the model
  read the drawing" from "can the model reason about a takeoff," and — because the parser/
  assembler/reconciler are pure — makes iterating on the interpretation step free after one
  LLM run (see `assemble-from-transcripts.ts` below).
- `EXTRACTION_MODE=hybrid`: ~1/3 of the drawing corpus carries servicing callouts as real PDF
  text objects (not SHX/scanned) — those pages are read EXACTLY via the PDF text layer
  (`pdf-text.ts::extractPageText` + `isTextyPage` + `text-takeoff.ts::assembleTextTakeoff`),
  zero LLM calls and zero tiles rendered for them. Only the remaining non-texty pages go
  through the `transcribe` path above; `reconcile.ts::mergeTakeoffs` combines the two with the
  text-layer result as `primary` (exact, wins conflicts). When every located page is texty,
  extraction cost drops to just the page-locator call.
- Both new modes are implemented and unit-tested but **not yet validated on the golden set**
  (that requires a real Vertex run — see EVAL_METHODOLOGY.md's decision gate) and are
  therefore not the recommended default; flip this note once that run happens.

## Layout

```
webapp/                       Next.js app (everything lives here)
  src/app/api/process/        main endpoint: PDF -> facts -> priced -> xlsx + quote
  src/app/api/performance/    ⭐ serves the FACTS-metric benchmark to the UI (see below)
  src/app/api/scoreboard/     LEGACY cell-accuracy CSVs from GCS — not the accuracy metric
  src/app/page.tsx            upload UI + facts-metric benchmark panel
  src/app/globals.css         design system (drafting-sheet tokens; `.cov-*` = coverage strip)
  src/lib/
    perf-summary.ts           pure: golden results -> dashboard model (entity coverage, scale split)
    extraction.ts             ⭐ LLM extraction -> TakeoffFacts (locator + 3 agents, or single-pass)
    costing-rules.ts          ⭐ DEFAULT_COSTING table + pure priceTakeoff(facts) -> ExtractionResult
    geometry.ts               pure helpers: snapToPipeDiameter, snapToMHSize, normalizeSlope
    compare-facts.ts          ⭐ facts-level eval metric (entity F1 + field accuracy)
    truth-facts.ts            reads an estimator's filled xlsx into TakeoffFacts (for eval)
    spreadsheet.ts            writes ExtractionResult into the .xlsx template
    quote-generator.ts        renders the quote PDF
    constants.ts              DEFAULT_PARAMS, INPUT_CELLS (template cell map), PIPE/MH sizes
    types.ts                  TakeoffFacts (facts) + ExtractionResult (priced) schemas
    modular-prompts.ts        per-agent + single-pass + transcription prompts (facts only, no pricing)
    few-shot-examples.ts      builds few-shot block from few_shot_examples.json
    dynamic-rules.json        "flywheel"-appended English rules (machine-written; frozen)
    pdf-text.ts               extractPageText/isTextyPage — PDF text-layer read ($0, EXTRACTION_MODE=hybrid)
    callout-parser.ts         pure grammar: run/structure/elevation/watermain callout parsing
    text-takeoff.ts           assembleTextTakeoff(pages) — text-layer PageText[] -> TakeoffFacts
    transcript-takeoff.ts     assembleTranscriptTakeoff(transcripts) — vision TileTranscript[] -> TakeoffFacts
    reconcile.ts              reconcileTakeoff/mergeTakeoffs — one entity per physical thing, any path
    golden-set.ts             ⭐ GOLDEN_PROJECTS/FOCUS_SET — canonical 16-project golden set
    *.test.ts                 vitest unit tests (geometry, costing, facts metric, spreadsheet)
  src/scripts/                eval CLIs (see below)
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

# EXTRACTION_MODE=transcribe|hybrid selects the alternate extraction paths (see Pipeline
# above); default (unset) is the original single-pass path. Example:
EXTRACTION_MODE=hybrid GOLDEN_FILTER="matthews" npm run evaluate:golden

# $0 validation loops — no LLM calls, run these before spending an eval run:
npm run score:offline          # re-score the whole golden set from cached predicted_facts.json
                                # -> golden-results-offline.json (what the UI benchmark reads)
npm run analyze:eval           # error decomposition over the same cached predictions
npm run evaluate:text          # text-layer path (Phase A) scored directly against real PDFs
npm run assemble:transcripts   # re-runs assembleTranscriptTakeoff+reconcileTakeoff on any
                                # transcript already cached in predicted_facts.json (from a
                                # prior EXTRACTION_MODE=transcribe|hybrid run) — validates
                                # parser/assembler/reconciler changes for free
```

**Reading the accuracy number.** `score:offline` reports two means and they are not
interchangeable: **detF1 over runs that returned a takeoff** (the model's accuracy) and
**detF1 counting failed runs as zero** (what a user actually gets). A run that returns *no*
entities at all is a transport/harness failure, not a 0%-accurate read — `perf-summary.ts`
classifies those separately so they can never be averaged in silently. As of 2026-07-28 the
cached predictions have 4/16 such failures.

Run the eval on stable infra: local works for a small filtered set (streaming rides the
laptop's flaky network), but the full set belongs on the throwaway GCP VM using **Vertex**
(`USE_VERTEX_AI=true`) — GCP-internal networking has none of the local `UND_ERR_SOCKET` drops.

Eval VM (`webapp/eval-vm/`): stage with `git archive HEAD`→GCS. `GOLDEN_FILTER` values must be
**space-free** (the VM word-splits `EVAL_ENV`) — use project codes, e.g. `GOLDEN_FILTER=2026-001,2026-050`.
Results (`golden-results-<results-name>.json`) land after PASS 1; the 3-pass RESUME loop then **hangs
retrying any failed project**, so pull results + `gcloud compute instances delete` rather than waiting
for self-halt. Fresh `predictions.tgz` only exports after pass 3 (kill early = no fresh predictions).

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

- **Cost**: image-token cost scales with rasterized pixel area (≈DPI²). Knobs (env):
  `TILE_DPI` (def 150), `TILE_PX` (1600), `TILE_OVERLAP` (160), `PER_PAGE`/`MAX_TILES_TOTAL`,
  `BATCH_TILES`/`BATCH_CONCURRENCY`. Every extraction records `facts.cost` (tokens/tiles/llmCalls/dpi;
  `totalTokens` includes gemini-2.5-flash thinking tokens) and the golden scoreboard prints a run-level
  COST line — so DPI/budget A/Bs are measurable. Don't cut DPI blind: validate legibility (pipe callouts).
- **Prompts**: `modular-prompts.ts` (agent prompts + `getSinglePassPrompt`). `getSinglePassPrompt` does a
  MANDATORY pipe-scan-first step (emit `pipeScan` before deriving sewers) and forces sewers-before-manholes
  output order so truncated dense responses keep the pipe runs. Few-shot:
  `few_shot_examples.json` (still contains legacy pricing in examples — harmless, parseFacts
  ignores it; strip when convenient).
- **Structure fabrication**: the single-pass path continues label sequences it never read
  ("DCBMH 1..29" where the drawing has one), with complete *arithmetically generated*
  elevations (invert −0.2/row, depth +0.2/row), so no data-completeness heuristic catches
  them. Three output-side filters were measured and **rejected**: long-contiguous-run (45%
  of REAL structures are in one too — `MH 100..109` is real), missing-data, and
  sewer-endpoint corroboration (kills 115 bogus but loses 26 real, +1.3pp). Don't retry
  them. `provenance.ts` is the approach that works — verify the label against evidence —
  but see its header: it must be fed **only the located pages**. Fed the whole document it
  REGRESSES (F1 40.5%→38.7%, 13 real structures deleted on Ultimate Drive), because
  detail/spec sheets are often the only texty ones and their labels aren't this site's.
  Structure labels are in the text layer for just **1 of 12** golden projects (Bradford),
  so this only ever fires there; the general fix is `EXTRACTION_MODE=transcribe`, where the
  grammar can only emit labels that appear in a transcript.
- **Pricing**: `costing-rules.ts::DEFAULT_COSTING`. This is the ONLY place dollars live.
  Do NOT put pricing back into the extraction path.
- **Template cells**: `constants.ts::INPUT_CELLS` is the intended source of truth;
  `spreadsheet.ts` still re-hardcodes them — keep in sync (or unify).
- **Eval**: `compare-facts.ts` (canonical, facts-level) + `compare-sheets.ts` (legacy cell).
  The golden set is canonically `golden-set.ts::GOLDEN_PROJECTS` — `evaluate-golden.ts`,
  `evaluate-text.ts`, `score-offline.ts` and `analyze-eval.ts` all import it, so they can't
  drift. `constants.ts::GOLDEN_PROJECTS` is an older, unused 10-project list kept only for
  reference — don't add new consumers of it.
- **UI / benchmark panel**: `page.tsx` renders the **facts metric** from `/api/performance`
  (which reads `golden-results-offline.json`, else `golden-results.json`, newest wins). The
  old `/api/scoreboard` + `webapp/scoreboards/*.csv` path is **legacy cell accuracy** and was
  still what the homepage displayed until 2026-07-28 — stale since May and the wrong metric.
  Don't wire new UI to it. `perf-summary.ts` is pure and unit-tested; put dashboard logic
  there, not in the component.
- **Truth selection**: a project folder holds copies, non-matching alternate designs, empty
  appendix/removals decoys, and genuine per-block/street SPLITS. `truth-facts.ts::resolveTruthFacts`
  picks canonically: `truth-manifest.json` (repo root) overrides win (merge splits / pin the
  canonical file / `exclude` unscoreable projects), else it auto-picks the **richest non-empty**
  candidate — never an empty decoy. The old `xlsxFiles[0]` (readdir order) silently scored several
  projects against empty truth. When adding projects to the golden set, audit their workbooks
  (offline count) and add a manifest entry if the auto-pick is wrong.

## Scripts (`src/scripts/`)

All scripts below currently exist in the repo and are live (the self-optimization
"flywheel" — `batch-evaluate*.ts`, `flywheel-gate.ts`, `flywheel-rollback.ts`,
`analyze-failures*.ts`, `compile-scoreboard.ts`, `compare-jsons.ts`, `Dockerfile.flywheel`,
`.github/workflows/flywheel.yml` — was fully removed, not merely disabled; `dynamic-rules.json`
is the one artifact left over from when it ran. Do NOT re-introduce prompt-rule auto-commit
without the facts metric as the gate — see REDESIGN §3.5).

- `evaluate-golden.ts` (`npm run evaluate:golden`) — the LLM golden-set eval (see "Run it").
- `evaluate-text.ts` (`npm run evaluate:text`) — $0 validation of the text-layer path: runs
  `extractPageText` + `assembleTextTakeoff` directly against each golden project's real PDFs
  (no LLM calls) and prints textF1 next to the cached LLM run's F1 for direct comparison.
- `assemble-from-transcripts.ts` (`npm run assemble:transcripts`) — $0 re-assembly loop for
  the vision-transcript path: re-runs `assembleTranscriptTakeoff` + `reconcileTakeoff` on
  whatever `transcript` array is already cached in `predicted_facts.json` (written by an
  `EXTRACTION_MODE=transcribe|hybrid` eval run) and prints old-vs-recomputed detF1 per
  project — validates parser/assembler/reconciler changes without another LLM call.
- `score-manual-facts.ts` (`npm run score:manual`) — scores a hand-transcribed
  `manual_facts.json` against truth (Phase B: measuring the ceiling above what the model
  itself can transcribe).
- `score-offline.ts` (`npm run score:offline`) — $0 re-score of the whole golden set from
  cached `predicted_facts.json`, writing `golden-results-offline.json` (the artifact the UI
  benchmark reads). Use it to validate metric/matching changes and to refresh the dashboard
  without an LLM run. It deliberately does NOT write `golden-results.json` — that file is
  `evaluate-golden.ts`'s own resume cache and must not be clobbered by a derived artifact.
- `analyze-eval.ts` (`npm run analyze:eval`) — offline error decomposition, see
  EVAL_METHODOLOGY.md. It imports `golden-set.ts` directly; it previously scraped
  `evaluate-golden.ts` for `folder: '...'` literals and silently analyzed **0 projects**
  once that list moved (fixed 2026-07-28). If either offline tool reports 0 projects, suspect
  the folder list before concluding the predictions are missing.
- `build-dataset-manifest.ts` (`npm run dataset:manifest`) — regenerates `dataset-manifest.json`.
- `compare-sheets.ts` — legacy cell-level compare, still used by `evaluate-golden.ts`.

## Conventions & gotchas

- **Tests exist now** (`vitest`, `npm test`). Add a test with any change to a pure function
  or to costing/eval logic. Pure modules: `geometry.ts`, `costing-rules.ts`, `compare-facts.ts`.
- **AI Studio ≠ Vertex for gemini-2.5-flash `thinking`.** "Dynamic" thinking runs ~8× larger on
  Vertex (~31k tok/call) than AI Studio (~4k). Thinking shares the `maxOutputTokens` budget with the
  JSON response, so uncapped it *starves* the response → truncation → keys emitted last (structures)
  collapse to 0 on dense projects. The batch call caps both: `thinkingConfig.thinkingBudget`
  (env `THINKING_BUDGET`, def 8192) + `maxOutputTokens` (env `MAX_OUTPUT_TOKENS`, def 32768).
  Capping thinking ALSO cut ~39% of token cost (thinking was the dominant cost). `facts.cost.totalTokens`
  includes thinking, so watch it.
- **Validate extraction/prompt changes on VERTEX, not local AI Studio — they diverge (see above).**
  Reproduce VM-only bugs locally: `gcloud auth application-default login` once, then
  `new GoogleGenAI({ vertexai:true, project:'autoinfra-ai', location:'us-central1' })`.
- **Local streaming to Gemini is unreliable** (UND_ERR_SOCKET, ~6KB mid-stream cutoffs). OK for one
  small probe; use the VM for dense extraction or the full eval. Capture `finishReason` +
  `usageMetadata.thoughtsTokenCount` when a call returns sparse output.
- **Truncated dense batches are salvaged, not dropped**: `repairTruncatedJson` cuts to the last complete
  element (incl. mid-array / mid-string) and closes open containers. Don't "simplify" it back to }/]-only.
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
- The scheduled flywheel optimization workflow has been removed (see "Scripts" above).

## Working agreement for changes here

1. Keep each change shippable; the app must still run; `npm test` and `tsc --noEmit` stay green.
2. Add a test with any change to a pure function or to costing/eval logic.
3. When you touch architecture, update this file and `REDESIGN.md`.
4. Pricing belongs in `costing-rules.ts` — never in the extraction path.
</content>
