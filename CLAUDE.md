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

`extractFromPDF()` (`extraction.ts`) has four interpretation paths, chosen per call by
`options.mode` (the web UI's engine picker), else the `EXTRACTION_MODE` env var, else
**`hybrid` — the production default** (see `extraction.ts`; this note previously said
single-pass, which stopped being true with the 2026-09-18 hybrid switch). Any unrecognised
value falls through to the original single-pass path (vision both reads AND interprets
tiles into TakeoffFacts JSON via `getSinglePassPrompt`). Mode ids live in
`extraction-modes.ts`. Model calls that fail are recorded per run (`AsyncLocalStorage`):
a partial result gets a warning, and a run where calls failed and **nothing** came back
throws instead of returning an empty "successful" takeoff.

- `EXTRACTION_MODE=transcribe`: vision ONLY transcribes verbatim callouts off each tile
  (`getTranscriptionPrompt` → `TileTranscript[]`, no interpretation); a deterministic
  pure-code grammar (`callout-parser.ts` + `transcript-takeoff.ts::assembleTranscriptTakeoff`
  + `reconcile.ts::reconcileTakeoff`) turns that into TakeoffFacts. Splits "can the model
  read the drawing" from "can the model reason about a takeoff," and — because the parser/
  assembler/reconciler are pure — makes iterating on the interpretation step free after one
  LLM run (see `assemble-from-transcripts.ts` below).
- `EXTRACTION_MODE=vector`: full CAD vector linework, topology graph, symbol dictionary,
  leader-line annotation binding, physical invariant validation, and fitted estimator conventions
  (`cad-geometry.ts` + `cad-symbols.ts` + `site-network.ts` + `cad-annotations.ts` +
  `cad-invariants.ts` + `shx-cluster.ts` + `shx-decode.ts` + `convention-rules.ts` +
  `vector-takeoff.ts`), zero LLM calls ($0 cost) across all vector drawing sets.
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
  src/app/api/process/        validates an upload (process-input.ts) and starts a background
                              takeoff job -> 202 { jobId }. route.test.ts is a zero-LLM
                              end-to-end test (synthetic CAD PDF, vector mode).
  src/app/api/jobs/[id]/      poll a job: stage + result (priced takeoff, base64 xlsx/quote)
  src/app/api/performance/    ⭐ serves the FACTS-metric benchmark to the UI (see below)
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
    golden-set.ts             ⭐ GOLDEN_PROJECTS/FOCUS_SET — canonical 26-project golden set (FOCUS_SET = 8)
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
npm run evaluate:golden                                   # full 26-project set, 1 run

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
entities at all is classified separately by `perf-summary.ts` so it can never be averaged in
silently. As of **2026-09-19** (`npm run score:offline`, whole cache freshly written by the
2026-09-18 hybrid-default run): **40.1% mean detF1 over 25 scored projects**, **38.6%
counting the 1 empty run as zero**, field accuracy 45.1%.

```
ENTITY          recall  precision      F1   truth   pred
sewerRuns       40.5%      65.5%   50.1%     605    374
structures      52.5%      20.8%   29.8%     379    956   <- pred 2.5x truth
catchbasins     45.2%      11.6%   18.4%     241    942   <- pred 3.9x truth
watermainRuns    1.6%      25.0%    2.9%      64      4    <- fixed, see below
by drawing size: <41 entities 45.2%  vs  >=41 entities 35.4%
```

**The corpus precision numbers are a TRAP for prioritisation.** Structures and catchbasins are
not over-predicted across the corpus — they are over-predicted by a handful of projects with
degenerate transcripts. 792 of the 956 structures come from three projects (White Oak 300,
Stevenson 306, Panattoni 186) and 810 of the 942 catchbasin units come from Panattoni alone.
Because the headline metric is a **mean of per-project F1**, deleting all of that junk is worth
almost nothing — measured, not guessed, 2026-09-19: a filter that removed **74% of all
predicted structures (966 → 251)** moved the mean **+0.3pp** (44.3 → 44.6). Never prioritise
off an aggregate precision row; check how many projects it actually lives in first.

**The 50.2% previously recorded here was never HEAD.** It was a re-score of the *July*
single-pass cache, which has since been overwritten by a real hybrid run. Switching hybrid on
by default cost ~10pp. Treat any number in this file as stale unless the prediction mtimes
back it — check them (`stat` the `predicted_facts.json` files) before quoting one.

**Empty-run triage, 2026-09-08 (historical — superseded by the 2026-09-18 run below):**

| project | was | now | cause |
|---|---|---|---|
| Georgian Dr | 0% | **76%** | stale cache only; recovers on default config |
| Eric Smith Way | 0% | **64%** | wrong-drawing bug; `chooseDrawingPdfs` now picks the `SS` sheet |
| Milton #13 | 0% | **37.5%** | output truncation — needs `BATCH_TILES=6 MAX_OUTPUT_TOKENS=65536` |
| White Oak Woodbine | 0% | **0%** | repetition loop, see below |

**`evaluate-golden`'s "likely transport failure" label is MISLEADING — do not trust it.**
Those runs had `facts.cost` showing real LLM calls and real token spend. They ran, cost money,
and returned zero entities. The message predates `facts.cost` telemetry; check `cost.llmCalls`
before believing it.

**Milton #13 needs non-default knobs.** At the defaults (`BATCH_TILES=16`,
`MAX_OUTPUT_TOKENS=32768`) it still returns nothing; with `BATCH_TILES=6` +
`MAX_OUTPUT_TOKENS=65536` it scores 37.5%. **The defaults were deliberately NOT changed** —
that would be a global change justified by two projects, and it must be validated against the
rest of the set with `GOLDEN_REPEATS=3` before being accepted. Note `BATCH_TILES=6` raises LLM calls
per project (24 tiles → 4 calls instead of 2), so it trades cost for completeness.

### Repetition loops are the #1 systemic defect (diagnosed 2026-09-19)

White Oak was NOT a one-off. Blocks-per-tile across the fresh cache:

```
Bradford  tile 2: 369   tile 18: 651   tile 33: 526   tile 51: 2029
Ecole     tile 3: 862   tile 17: 880
Stevenson tile 14: 314        White Oak: one callout x685
```

Two variants, one cause (decoder degeneracy):

- **Literal repeat** — Bradford tile 18 emits `["D/T 0.1","224.09","223.86"]` **x639**;
  Ecole tile 3 emits `["EX CB"]` x430. Exact-text dedup catches these.
- **Counter loop** — Bradford tile 2 emits `EX CBMH1036 → EX CBMH668`, one per block, **all
  with identical `T/G=223.43 / INV=222.680`**, truncating mid-block at the token cap. Every
  block is textually DISTINCT, so dedup cannot touch it. This is why 3 projects contribute
  792 of the corpus's 956 predicted structures (White Oak 300, Stevenson 306, Panattoni 186).

**The second-order damage is larger than the first.** A repeating tile eats the batch's whole
`maxOutputTokens`, and every later tile in that same `BATCH_TILES`-sized batch is truncated
away. `repairTruncatedJson` then silently salvages the complete prefix, so the run looks
clean. Reconstructed from returned tile indices:

```
Ecole  batch 1 (tiles 1-16):  returns 1,2,3 — tile 3 blows up — tiles 4-16 LOST
       batch 2 (tiles 17-32): returns 17    — tile 17 blows up — tiles 18-32 LOST
       batch 3 (tiles 33-40): returns ALL 8 — no repetition — complete
Bradford: 60 tiles sent, 8 returned — 87% lost
```

Ecole's clean third batch is the control. This one defect explains both the precision collapse
(fabricated structures) AND the recall collapse (`sw 0/21`, `sw 4/19`) on the bottom projects.

**The RECALL half is the prize; the precision half is not.** Deleting the fabricated rows
post-hoc is worth +0.3pp (measured — see the rejected 4th filter). Recovering the 52/60 tiles
Bradford threw away is where the points are, and that can only be done by stopping the loop
during transcription and re-issuing the tile. Do not settle for a post-hoc cleanup.

Fixing it needs a live Vertex run: capture `finishReason`, and guard on BOTH variants — a
repeated-line count AND a near-duplicate check (identical block shape with only an integer
differing). A literal-repeat guard alone will not catch Bradford.

**This invalidates the old claim that `EXTRACTION_MODE=transcribe` prevents label
fabrication** ("the grammar can only emit labels that appear in a transcript"). It does — but
the transcript itself now fabricates the sequence, so the guarantee buys nothing. See the
Structure fabrication bullet under "Where the levers are".

**Do not spend grammar effort on White Oak.** Making all 687 of its repeated lines parse moved
0.0% → 0.0%; its problem is recall (truth 31 structures / 58 sewers, pred 0 sewers), not
parsing. It needs re-transcription.

### `chooseDrawingPdfs` can select a document that is not a drawing (Gerrard, 0%)

`selectDrawingPdfs` does `const chosen = civil.length > 0 ? civil : keep` — **one weak hit
collapses the candidate set and the `keep` fallback never fires.** `isCivilPath` matches the
FULL PATH, so a parent folder named `Site Services & Rough Grading` made a *tender
acknowledgment checklist* ("PLANS (Please acknowledge the following documents have been
reviewed…)") the single chosen file for Gerrard Shelter. The run behaved correctly on garbage:
locator picked pages 1-3, 12 tiles rendered, model returned `blocks: []` for all 12, 7,845
tokens spent. Meanwhile `2535 GERRARD STREET EAST TORONTO.pdf` — **5 scanned pages at
1650x2550 px, a real drawing set** — was discarded because its filename carries no hint word.
**FIXED 2026-09-19** (`dataset.ts`): the narrowing step now uses `isCivilName` (FILENAME only)
instead of `isCivilPath` (full path). Path-level evidence keeps its other job — a STRONG civil
word anywhere in the path still rescues a file from the SOFT excludes, which only ever keeps
more. Blast radius measured across all 26 golden projects before shipping: **exactly 1 changed**
(Gerrard, 1 checklist → 6 files including the real drawing); Georgian Dr, Wigmore Park and Eric
Smith Way are byte-identical. Page 2 of `2535 GERRARD STREET EAST TORONTO.pdf` was rendered and
confirmed to be a real Burnside/Entuitive **Public Utility Plan** with storm/sanitary/watermain
callouts, so the fallback target is genuinely the right sheet. **The accuracy gain is NOT yet
measured** — Gerrard's cached prediction was made from the checklist, so it needs a live run.

**Rejected candidate — do NOT add `appendix` to `PDF_HARD_EXCLUDE`.** It looks right next to
`addendum` / `tender form` / `schedule of values`, and it does fix Gerrard. Measured across the
golden set it **breaks two healthy projects**: Georgian Dr (75.8%) keeps its drawings in
`Appendix 1.00 AMCAI Civil Plan Set.pdf`, and Wigmore Park (69.5%) in
`Part 3 - Appendix A - … IFT Drawings.pdf` — which would be left with **zero** candidate PDFs.
In this corpus an "Appendix" routinely IS the drawing set. Always diff the chosen set across all
26 projects before touching these heuristics; they are shared and the failure is silent.

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
  `TILE_DPI` (def 150), `TILE_PX` (1600), `TILE_OVERLAP` (160), `PER_PAGE` (24),
  `MAX_TILES_TOTAL` (320), `BATCH_TILES`/`BATCH_CONCURRENCY`. The effective budget is
  `min(MAX_TILES_TOTAL, nPages * PER_PAGE)`; tiles are emitted **row-major and truncated**, so a
  per-page cap below what the sheet needs silently discards its BOTTOM rows — a 36x48 or 30x42
  sheet at 150 DPI needs 4x5 = 20 tiles, and the old hardcoded 16 threw away 20% of every E-size
  drawing (`PER_PAGE` only became a real env knob in Phase 0; before that it was a literal 16).
  Trap: `rasterize.ts:60` still defaults `maxTilesPerPage = 16` independently — both extraction
  call sites pass it explicitly so behaviour is unaffected today, but a new caller that omits the
  option silently gets the old truncating cap. Every extraction records `facts.cost` (tokens/tiles/llmCalls/dpi;
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
  them. **A 4th was measured and rejected 2026-09-19**: a degenerate-block filter keyed on
  shape (label digits masked + identical non-label lines), which is a genuinely different
  signal from the rejected long-run filter — real `MH 100..109` runs differ in their
  elevations and so never group. It works exactly as designed (966 → 251 predicted
  structures at threshold 20) and still only bought **+0.3pp**, while costing 8 real
  structures and −7.8pp on Eric Smith Way. Output-side structure filtering is a dead end;
  the fabrication has to be stopped at the decoder. `provenance.ts` is the approach that works — verify the label against evidence —
  but see its header: it must be fed **only the located pages**. Fed the whole document it
  REGRESSES (F1 40.5%→38.7%, 13 real structures deleted on Ultimate Drive), because
  detail/spec sheets are often the only texty ones and their labels aren't this site's.
  Structure labels are in the text layer for just **1 of 12** golden projects (Bradford),
  so this only ever fires there. **`EXTRACTION_MODE=transcribe` is NOT the general fix
  (disproved 2026-09-19).** The grammar can indeed only emit labels present in a transcript —
  but the transcript now fabricates them itself (Bradford tile 2: `EX CBMH1036 → 668`, all
  with identical elevations). The guarantee holds and buys nothing. The real fix is upstream,
  at the decoder — see "Repetition loops are the #1 systemic defect".
- **Watermain** (`transcript-takeoff.ts`): **FIXED 2026-09-19, +4.6pp golden mean.** The
  assembler emitted a main only `if (!wm.existing && wm.lengthM != null)`, and `lengthM` comes
  from an inline `NN m` that real watermain callouts essentially never carry — length is
  scaled off the linework. 20 of 27 proposed mains died on that gate holding a perfectly good
  diameter and material. `text-takeoff.ts` already had the fix and the comment explaining it;
  the two assemblers had simply drifted. Corpus watermain went R4.5→**R20.9**, and precision
  went UP 60.0→**73.7** (`reconcileTakeoff::aggregateWatermainByDiameter` collapses the extra
  rows per size, so nothing inflates). 7 projects up, 0 regressions.
  **Still recall-limited:** 88 of 151 watermain transcript lines never parse at all —
  `parseWatermainCallout` requires a diameter, so `EX FIRE HYDRANT` and
  `CONNECT TO EX. 150mmØ WM WITH TEE` fall out. That is the next watermain lever, also $0.
  **When changing either assembler, change both** — they share `callout-parser.ts` and must
  agree on emission policy.
- **Pricing**: `costing-rules.ts::DEFAULT_COSTING`. This is the ONLY place dollars live.
  Do NOT put pricing back into the extraction path.
- **Template cells**: row ranges per template live in `constants.ts::TEMPLATE_LAYOUT`
  (SHORT/LONG) and are asserted against the real `.xlsx` files in `spreadsheet.test.ts`
  ("TEMPLATE_LAYOUT matches the real templates") — a template edit fails that test instead
  of silently mis-totalling. Data blocks: manholes 11–46, sewer runs 14–54 (SHORT: 14–51,
  rows 52–54 are its own VIDEO/LAYOUT/AS BUILT fee rows, which we fill instead of appending
  a second set), watermain runs from 13 (SHORT) / 14 (LONG), valves are matched by size into
  the fixed 50–300mm table (only P/R/S/T are written). `determineTemplateType` picks SHORT
  only when sewers, structures and watermain all fit; anything that overflows even LONG is a
  warning, never a silent drop. `INPUT_CELLS` is the older cell map — keep in sync.
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
- `evaluate-vector.ts` (`npm run evaluate:vector`) — $0 validation of the vector-native CAD
  extraction path directly against golden drawing PDFs (zero LLM calls).
- `calibrate-conventions.ts` (`npm run calibrate:conventions`) — calibrates and evaluates
  declarative estimator convention rules across held-out splits.
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

- `.github/workflows/deploy.yml` — a `verify` job (tsc, vitest incl. the end-to-end route
  test, `next build`) runs on every PR and push; pushes to `master`/`main` deploy to Cloud
  Run only if it passes.
- **Takeoffs are background jobs** (`lib/jobs.ts`): POST /api/process returns at once and
  the browser polls. Doing the extraction inside the request 504'd in production (a real
  drawing set takes 4–35 min). The job store is in-memory, so the deploy pins
  `--max-instances 1 --no-cpu-throttling` (polls must hit the instance running the job, and
  it needs CPU after the POST returns), `--memory 2Gi` (full-sheet rasters are ~155 MB each),
  and `MAX_CONCURRENT_JOBS=1`. To scale out, back `JobStore` with GCS/Firestore first.
- **Production runs `TILE_DPI=200 BATCH_TILES=4`** (set in `deploy.yml`, NOT the code
  defaults, which stay 150/16 for the golden eval). Evidence, 460 Bayly St E (2026-10-02, two
  runs each): at 150/16 one 12-tile call hit MAX_TOKENS, a tile was discarded for a repetition
  loop and 13 of 28 structures were never transcribed; at 200/4 structures 23/28 and rim/invert
  96%/96% on both runs, ~44k tokens vs 58k. 150 DPI also misread "BED AREA 3200" as 2000.
  This is one project — validate on the golden set (`TILE_DPI=200 BATCH_TILES=4
  GOLDEN_REPEATS=3`) before changing the code defaults. 200 DPI rasters are ~1.8x the memory
  of 150 (a 36x48 sheet ~276 MB); fine at 2Gi with one job, revisit before raising concurrency.
- **Production also runs `THINKING_BUDGET=1024`** (deploy.yml; code default stays 8192). Same
  project, 200 DPI / batch 4, 8 runs: budget 8192 -> ~48k tokens, 23/28 structures, rim/invert
  96%; budget 1024 -> 27k tokens (both runs), 24-25/28, 96%; budget 0 -> 22k when clean but a
  repetition loop on the same tile in 2 of 4 runs (55k tokens), and 92% fields. Some thinking
  stabilises transcription; 8192 is mostly waste. `THINKING_BUDGET=0` only works since
  `envNumber` (it used to fall back to 8192). One project again — confirm on the golden set.
- The old `/api/scoreboard` (legacy cell accuracy, public, leaked fs paths) and the dead
  `/api/download/[id]` were removed.
- The scheduled flywheel optimization workflow has been removed (see "Scripts" above).

## Working agreement for changes here

1. Keep each change shippable; the app must still run; `npm test` and `tsc --noEmit` stay green.
2. Add a test with any change to a pure function or to costing/eval logic.
3. When you touch architecture, update this file and `REDESIGN.md`.
4. Pricing belongs in `costing-rules.ts` — never in the extraction path.
</content>
