# Vector-Native Takeoff — Design Spec

> Status: approved design, not yet implemented.
> Predecessor: `docs/superpowers/plans/2026-07-21-deterministic-extraction-dag.md` (shipped
> `pdf-text.ts`, `callout-parser.ts`, `reconcile.ts`, `text-takeoff.ts`, `transcript-takeoff.ts`).
> Companions: `REDESIGN.md` (facts/pricing split), `EVAL_METHODOLOGY.md` (how to measure),
> `CLAUDE.md` (operational map).

**Goal:** near-100% takeoff accuracy at near-zero marginal cost, by treating the servicing
drawing as the CAD file it is rather than as a picture, and by making the estimator's
personal conventions an explicit, fitted, inspectable layer instead of something the model
is expected to intuit.

---

## 1. Findings this design is built on

All measured against the local dataset on 2026-08-21. Numbers, not intuitions.

### 1.1 Current state

From `golden-results-offline.json` (16 golden projects, cached predictions):

| | matched | truth | pred | recall | precision | F1 |
|---|---|---|---|---|---|---|
| structures    | 104 | 299 | 276 | 34.8% | 37.7% | 36.2% |
| sewerRuns     | 149 | 442 | 242 | 33.7% | 61.6% | 43.6% |
| catchbasins   |  76 | 196 | 106 | 38.8% | 71.7% | 50.3% |
| watermainRuns |   4 |  40 |   4 | 10.0% | 100%  | 18.2% |

Mean detF1 **48.0%** over the 12 runs that returned a takeoff; **36.0%** counting the 4
empty runs as zero. The 4 empties are transport/harness failures, not 0%-accurate reads,
and must stay classified separately (`perf-summary.ts` already does this).

### 1.2 The input is small, and it is vector CAD

Golden-set drawing sets are **1–13 pages** (median ≈ 4), 0.1–43 MB. Probing the PDF
internals of 10 golden projects:

- 8 of 10 are **vector** plots — hundreds of thousands of path ops, negligible raster area.
  Ecole 964k path ops / 0 fonts; Orillia 789k / 0; Milton 230k / 0; Georgian 138k / 0.
- Exactly **one** (`2026-060 Proposed Commercial`) is a genuine scan: ~10 path ops and a
  single 1976×701 image for a 36×24 sheet (≈55 DPI). It is also one of the two worst scores.
- One (`2026-009 Eric Smith Way`) is not a drawing at all — see §1.4.
- ~40% of probed projects preserve **AutoCAD layer names** as optional content groups
  (`3-SANITARY`, `B.O. - San Prop Text`, `-PRO-Trench`) — a useful bonus signal, not a
  reliable primary one.

On Ontario Tech page 1 (25 structures, 36 runs, one sheet), `getOperatorList()` yields:

- **93,688** paths, each with coordinates, bbox, stroke colour and line width
- **58,865** (63%) glyph-sized — the SHX text, drawn as strokes
- **2,341** multi-point polylines > 20pt — pipe/linework candidates
- **47** `showText` ops — the title block only; the drawing carries no usable text layer

There is no schedule table on that sheet: all 61 entities are plan callouts. Sheets do,
however, carry a **legend** that names every symbol used (proposed storm, CB, CBMH,
sanitary, watermain, hydrant, valve).

### 1.3 Reading is not the bottleneck — the ceiling is convention

`npm run evaluate:text` reads callouts **exactly** from the text layer where one exists.
6 of 16 projects produce output that way, and it matches or beats the LLM path:

| project | text-layer F1 | cached LLM F1 |
|---|---|---|
| Oakville Fire Hall | **68.3%** | 45.9% |
| Bradford Civic | **60.7%** | 53.7% |
| Matthews Hangar | 60.1% | 62.2% |
| Ultimate Drive | 44.1% | 59.1% |

A *perfect* read scores 60–68%. Dumping the residual on those projects shows why — and
none of it is misread text:

| class | evidence | nature |
|---|---|---|
| Label normalization | Matthews: truth `MH 1…MH 5`, pred `MH01…MH05` → **6 of 6 structures lost**. Bradford: truth `DIV.MH 2`, pred `MH2` | pure code |
| Grammar gaps | Oakville `C100 CHAMBER`, `CTRL MH`; Bradford `JF 6-3-1`, `JF 4-1-1`; Ultimate `EF 04`, `VC`; Oakville `SUBDRAIN` run | pure code |
| No schedule-table reader | Ultimate Drive: 7 texty pages, truth is `ST 1…ST 25`/`SA 1…SA 2`, text path emits **0 runs** | pure code |
| Segment → run aggregation | Matthews: drawing `17.5m + 32m` at 300mm; truth `MH 1-MH 2 = 50m` | needs topology |
| Estimator rounding | Oakville: drawing `10.5m`/`18.6m`, truth `12m`/`20m` — consistent centre-to-centre offset | convention |
| Duplicate emission | Bradford: 10 extra runs — same pipes already matched via schedule, re-emitted from callouts | dedup |
| Watermain | 0 predicted on Oakville (2 truth), Bradford (2), Ultimate (3) | pure code — `text-takeoff.ts:99` drops every watermain callout with no stated length (`wm.lengthM != null`), and most read `200mmØ PVC WATERMAIN` with the length implied by the drawn line. Aggregation (`aggregateWatermainByDiameter`) already exists and is fine. |

**Conclusion: this is a CAD-parsing and convention-reconciliation problem that has been
built as a computer-vision problem.** That is why it is simultaneously expensive and
stuck near 48%.

### 1.4 At least one "zero" is a sheet-selection failure, not an extraction failure

`2026-009 Eric Smith Way` scores 0.0% — 11 structures, 14 runs, 31 catchbasins in truth,
nothing predicted. The cause is that the manifest fed it the wrong file:

- **Selected:** `Topsite bid leveling 2026-04-15.pdf` — a 9×11, 0.1 MB *bid-comparison
  sheet*. Not a drawing at all. 281 path ops.
- **Present in the same folder, never used:** `55EricTSmithWay-A01SS-SPA-Nov15-24.pdf`
  (`SS` = Site Servicing), 1.7 MB.

Feeding the correct file to the existing text-layer path, with no code changes at all,
immediately yields **8 structures** (`MH1 … MH8`), 3 catchbasins, 1 texty page. It also
reproduces two Phase 0 residuals exactly: the labels come out `MH1` where truth says
`MH 1` (§1.3 row 1), and runs come out **0** because they are in a schedule (§1.3 row 3).

A folder-wide scan of the golden set shows this is currently isolated to this project —
but it is total where it occurs, and it means **Stage 0 (sheet selection) is a first-class
correctness surface**, not plumbing. A takeoff can only be as good as the sheet it was
given.

**Root cause (confirmed 2026-08-22): the selection logic is already correct; the artifact
is stale.** `chooseDrawingPdfs()` today picks `55EricTSmithWay-A01SS-SPA-Nov15-24.pdf`
correctly — `PDF_HARD_EXCLUDE` has contained `'bid leveling'` since commit `7994e8d`
(2026-07-04), whose message is literally *"fix(dataset): word-boundary civil hints +
path-level junk excludes (Eric Smith)"*. But `dataset-manifest.json` was generated
**2026-07-03 11:18**, one day earlier, and has never been regenerated. It therefore
predates six subsequent fixes:

| commit | date | what the stale manifest predates |
|---|---|---|
| `7994e8d` | Jul 4 | word-boundary civil hints + junk path excludes (Eric Smith) |
| `f48f7bb` | Jul 7 | stop reading the `V/‖` factor column as sewer slope |
| `0f0320e` | Jul 9 | **read watermain runs (were being dropped entirely)** |
| `021e4ce` | Jul 11 | manifest-driven truth selection (never score against empty decoys) |
| `3d7790b` | Jul 13 | White Oak truth aligned to drawn scope |

This also explains §1.1's `watermain: 0` for every usable project: those counts were
computed by a `readTruthFacts` that dropped watermain rows. **It is one stale derived
artifact, not two independent bugs** — and `dataset-manifest.json` has no staleness guard
despite being consumed by `evaluate-text.ts`, `analyze-eval.ts` and `evaluate-golden.ts`.
Regenerating it is the single highest-leverage action in Phase 0 and costs one command.

### 1.5 Supervised material available

`dataset-manifest.json`: 53 projects, **37 usable** (drawing PDF + standard-template
workbook), totalling **456 structures**, **724 runs**, 815 pages. Enough to *fit* explicit
convention rules with a held-out split; not enough to train a model, which is not the plan.

---

## 2. Target

**Decision (2026-08-21): match this estimator's workbook autonomously.** The workbook is
ground truth including its conventions; a fitted reconciliation layer reproduces them.

**Accepted risk, recorded deliberately:** accuracy is capped by how self-consistent this
estimator was, and by convention drift over time. Adding a second estimator, or this one
changing habits, requires re-fitting. The design therefore keeps the convention layer
**isolated and swappable** so that is a re-fit, not a rewrite. Held-out reporting (§6.2)
is what will make drift visible rather than silent.

---

## 3. Architecture

One new stage boundary, in the same spirit as the facts/pricing split that already worked:
separate **what the drawing says** from **how this estimator writes it down**.

```
project folder  (messy: quotes, geo reports, SWM reports, backups, drawings)
   │
   ▼ [0] SHEET SELECTION                        deterministic, $0
   │     classify every PDF page: servicing plan / profile / schedule / detail / noise
   │     signals: page dimensions, vector path density, callout-keyword density,
   │              title-block text, OCG layer names
   │
   ▼ [1] PAGE DECODE                            →  PageContent
   │     1a  text layer          exact strings + coords, free            (~1/3 of pages)
   │     1b  SHX stroke decode   cluster → oriented word crops → decode locally
   │     1c  raster fallback     OCR / VLM — true scans only             (1 project in 16)
   │     every path retained with colour, line width, dash pattern, layer
   │
   ▼ [2] DRAWING MODEL                          →  SiteNetwork        ← new capability
   │     nodes  = structures    (symbol match + bound label callout)
   │     edges  = pipe segments (polylines between nodes)
   │     annots = callouts bound to owner by leader line, else proximity
   │     invariants: 2 endpoints per edge · elevations fall downstream ·
   │                 Σ segment length ≈ callout length · diameter non-decreasing downstream
   │
   ▼ [3] RECONCILE                              →  TakeoffFacts (as-drawn)
   │     one entity per physical thing; merges plan callout + schedule row + profile
   │
   ▼ [4] CONVENTION                             →  EstimatorTakeoff   ← new capability
   │     fitted rules: segment→run aggregation · length rounding / centre-to-centre ·
   │                   CB-lead grouping · label style · scope inclusion
   │
   ▼ [5] COSTING     unchanged — deterministic `priceTakeoff()`
   ▼ [6] TEMPLATE    unchanged — `.xlsx` + quote
```

Stages [5] and [6] are untouched. **Pricing stays out of the extraction path.**

### 3.1 Provenance on every value

```ts
interface Provenance {
  source: 'text-layer' | 'shx' | 'ocr' | 'vlm' | 'schedule' | 'derived';
  page: number;
  bbox: [number, number, number, number];
  raw: string;         // exact glyphs read, before parsing
  confidence: number;  // 1.0 for text-layer — it is not a guess
}
interface Valued<T> { value: T; prov: Provenance }
```

Three consequences, all load-bearing:

1. **Source conflicts resolve by rule** (text-layer > schedule > shx > ocr > vlm) rather
   than by whichever path ran last.
2. **The verifier can be targeted.** Phase 4 sends only low-confidence values to a model.
   This is what collapses the cost.
3. **`provenance.ts`'s lesson becomes structural.** That module regressed F1 40.5%→38.7%
   when fed the whole document, because detail/spec sheets are often the only texty ones
   and their labels are not this site's. With per-value page provenance, "verify only
   against located pages" is enforced by construction rather than by memory.

---

## 4. The metric splits with the architecture

`compare-facts.ts` currently produces one `detectionF1` that conflates two failures.
Replace with two, plus the existing composition:

- **`asDrawnF1`** — did we read the drawing? Scored against a hand-verified **as-drawn
  truth** on a small set of sheets (§6.3). Ceiling is genuinely 100%; fully under our control.
- **`conventionF1`** — given a correct read, did we produce this estimator's rows? Scored
  on held-out projects only (§6.2).
- **`detF1`** — unchanged in definition, reported as today, so history stays comparable.

This extends REDESIGN §3.4's "measure the two stages apart" one level up. When the number
moves, we will know which half moved.

---

## 5. Phases

Sequenced so the free, offline, measurable work lands first and de-risks the rest.

### Phase 0 — free wins ($0, offline, no LLM calls)

Every item below is a measured residual from §1.3, not a guess.

0. **Regenerate `dataset-manifest.json` and guard it against staleness.** It predates six
   truth/selection fixes (§1.4), which is the single cause of both the Eric Smith
   wrong-file failure and the `watermain: 0` counts. Per EVAL_METHODOLOGY, a ruler bug
   outranks every other fix — and this one is `npm run dataset:manifest`. Add a staleness
   check so a manifest older than the modules that produce it is loud, not silent.
1. **Numeric label identity.** Normalize labels to `(kind, number, suffix)` — `MH01` →
   `(MH, 1)` — *not* by stripping characters, which would collapse `MH 1` and `MH 10`.
   Handle qualifier prefixes (`DIV.`, `CTRL`). Applies to both `callout-parser.ts` and
   `compare-facts.ts::normalizeLabel`. Because this changes the ruler, validate offline
   and confirm it creates no false matches before accepting any score change.
2. **Grammar coverage** — `CHAMBER`, `CTRL MH`, `JF`, `EF`, `VC`, `SUBDRAIN`, and
   material-suffixed run labels (`ST 6-HDPE`) into the structure/run grammar.
3. **Schedule-table reader.** Reconstruct tables from positioned text by clustering into
   rows/columns on coordinates, then map columns to fields by header. Generic; worth 0→29
   runs on Ultimate Drive alone.
4. **Cross-source dedup** in `reconcile.ts` — a pipe present in both the schedule and a
   plan callout is one pipe (Bradford: 10 phantom runs).
5. **Coverage budget.** Replace the flat `MAX_TILES_TOTAL` cap with a per-project budget
   scaled by located page count. The cap truncates precisely the two largest documents
   (Panattoni 13 pages / 15%, Proposed Commercial 6 pages / 26%).
6. **Watermain** — stop discarding length-less callouts (`text-takeoff.ts:99`). Emit the
   pipe with `length: null` so it is *detected*, and let the length arrive from the
   schedule, or from the drawn polyline in Phase 1. Detection and measurement are separate
   failures and `matchWatermain` phase 3 already scores them separately by design.
7. **Sheet selection (§1.4).** The selection *logic* is already correct — task 0 fixes the
   artifact. What is missing is a **regression test** pinning `selectDrawingPdfs` on the
   Eric Smith filename set (a pure-function test needing no dataset), plus a preference
   for servicing sheet-codes (`SS`) over grading/erosion/detail codes (`SG`, `EC`, `D1`,
   `D2`, `T`) when several civil sheets qualify, so the servicing plan is decoded first
   under a page budget.
8. **Triage the remaining empty runs** as transport failures, separately from accuracy.

**Acceptance:** items 0–4, 6 and 7 are validated by `npm run score:offline` +
`npm run analyze:eval` at zero cost. Items 5 and 8 need one focused LLM run.
Report the aggregate against the existing noise band (`GOLDEN_REPEATS=3`), not a point.

**Decomposition:** each phase gets its own implementation plan. This spec is the shared
design; Phase 0 is the next plan to write, and is independently shippable.

### Phase 1 — topology from vector geometry

New pure module (`cad-geometry.ts` → `site-network.ts`) building `SiteNetwork`:

- Extract paths via `getOperatorList()` with colour, line width, dash, and OCG layer.
  Verified working: `constructPath` args carry `[opcodes, coordinate runs, bbox]`.
- **Bootstrap the symbol dictionary from the drawing's own legend** where one exists —
  the sheet declares its symbol vocabulary. Fall back to clustering repeated geometry.
- Edges: polylines of consistent colour/linetype joining two symbol centroids.
- Leaders: short polylines binding a text cluster to its owning node or edge.
- Assert the invariants listed in §3. **Violations are the confidence signal** for
  Phase 4 — they are free to compute and they mark exactly what to double-check.

### Phase 2 — SHX text recovery

- Cluster glyph-sized strokes into **oriented** text runs (principal axis — CAD text
  rotates to follow pipe alignment; axis-aligned clustering will not do).
- Decode in order: (a) geometric glyph matching against a codebook built once by
  rendering the reference stroke-font glyph set; (b) fallback — render the de-rotated
  crop at high DPI and run local OCR.
- **Grammar-constrained correction.** Callouts are rigidly formulaic
  (`83.7m-375mmØ SAN @ 0.02%`), so decodings that do not fit the grammar are repaired or
  rejected. This is where the last few percent come from.
- Emit per-token confidence.

Prototype evidence: 58,865 strokes cluster to 2,362 groups, 613 word/line-like, on a sheet
with 61 entities plus notes and legend — the right order of magnitude. This proves
**segmentation**, not decoding; see §8.

### Phase 3 — convention layer, fitted

Do not ask a model what the conventions are. **Measure them** from aligned pairs:

1. Run Phases 0–2 over the 37 usable projects to get as-drawn facts.
2. Align to each workbook with the existing permissive 3-phase matcher.
3. From aligned pairs, fit each rule and record its residual:

| convention | fitted from | evidence seen |
|---|---|---|
| segment → run aggregation | is a truth row's length ≈ Σ of a connected chain in the graph? | Matthews `17.5 + 32` → `MH 1-MH 2 = 50` |
| length rounding | distribution of (truth − as-drawn) | Oakville `10.5→12`, `18.6→20` |
| CB-lead grouping | drawing CBs per truth CB row | CB counts already track well |
| label style | template induced from aligned examples | `MH01` vs `MH 1` |

Each rule lands in a **versioned table** alongside `DEFAULT_COSTING` — a fitted parameter
plus a residual, inspectable, diffable, unit-tested. Not English prose. Not auto-committed.

> `dynamic-rules.json` is the cautionary tale: a machine writing English rules against a
> noisy metric produced something nobody could audit. REDESIGN §3.5 froze it. Do not
> reintroduce that shape here.

### Phase 4 — LLM demoted to verifier

The model sees only low-confidence values and invariant violations, as targeted questions
with the relevant crop attached. Most projects should complete with **zero** LLM calls.

---

## 6. Testing and evaluation

### 6.1 The gap to close first

The dataset is gitignored, so today **none of the extraction path is testable from a clean
clone**. Commit **tiny synthetic CAD PDFs** — a generated 3-structure / 2-pipe site with
known geometry, callouts, a legend, and a schedule table — so the whole chain runs in CI.
`pdf-lib` is already a dependency and already used for fixture PDFs.

### 6.2 Held-out discipline (non-negotiable for Phase 3)

37 pairs is thin. Fit convention rules on ~25, report `conventionF1` on ~12 held out.
Fitting and reporting on the same 37 produces a number that means nothing. A rule enters
the table only if it improves held-out aggregate beyond the noise band.

### 6.3 As-drawn truth

Hand-verify 3–5 sheets spanning the three decode paths (one texty, one SHX, one scan) to
give `asDrawnF1` a real ruler. This is the same exercise as `score:manual`, but scoring
the *drawing's* content rather than the estimator's sheet.

### 6.4 Unchanged discipline

Pure functions, `vitest`, a test with every change to costing or eval logic,
`npx tsc --noEmit` green, `GOLDEN_REPEATS=3` bands rather than points, full regression on
the Vertex VM rather than the laptop. Batch fixes, then one regression run.

---

## 7. Cost

Today: 16–48 JPEG tiles at 150 DPI plus ~31k thinking tokens per call (Vertex), for a
document whose semantic content is a few KB of text. After Phase 4 the model sees only
low-confidence word crops — tens of small images, usually none. Expected order:
**~100× reduction**, with most projects free.

Keep recording `facts.cost` (tokens/tiles/llmCalls/dpi) so this is measured, not asserted.

---

## 8. Risks

1. **SHX decoding is the one genuinely novel build.** The probe proves segmentation is
   tractable, *not* that decoding is solved. Mitigation: local OCR on de-rotated crops is
   the fallback, and that is approach B from the design conversation — bounded downside.
2. **No legend on some sheets** → symbol dictionary bootstrapping fails. Mitigation:
   cluster repeated geometry instead.
3. **Conventions may not be stationary** across time or estimators (§2). Mitigation:
   held-out reporting makes drift visible; the layer stays swappable.
4. **Phase 0 may deliver more than expected** and change the calculus for Phases 1–2.
   That is a good outcome and the reason Phase 0 is sequenced first.

---

## 9. Explicitly out of scope

- **Do not retry the three rejected structure filters** — long-contiguous-run,
  missing-data, and sewer-endpoint corroboration were each measured and rejected
  (see `CLAUDE.md`). Phase 1's topology + Phase 2's transcript-grounded labels are the
  approach that replaces them.
- **Do not reintroduce prompt-rule auto-commit** (REDESIGN §3.5).
- **Do not put pricing in the extraction path** — `costing-rules.ts` remains the only
  place dollars live.
- Quote generation, template cell mapping, and costing are untouched by this design.
