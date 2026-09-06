# How we improve AutoInfra accuracy (read this before optimizing)

This is the playbook for improving extraction accuracy **fast** without falling into the
two traps we kept hitting: (1) optimizing against a **broken ruler**, and (2) **per-project
prompt grinding** that trades one project's score for another's (a zero-sum loop).

## The one rule that matters most

**Measure the ruler before you optimize the model.** A metric/coverage bug is worth far
more than any prompt tweak. Concrete example from this repo: reading the truth sheet's
constant "V/‖" factor column as `slope` silently poisoned run matching — fixing that *one
bug* moved runs **20% → 37%** on the *same predictions*, with zero LLM cost. Weeks of prompt
nudging moved runs ~2 points. **Find the bugs first.**

## Priority order (highest ROI first)

1. **Ruler / measurement integrity** — is truth read correctly? are all entities scored? are
   tolerances/enums right? A bug here means every downstream number lies. (free, offline)
2. **Coverage** — is the model even *seeing* the data? (locator page selection, tile budget).
   Big projects failed because a 48-tile cap dropped half the plan — not a prompt problem. (cheap)
3. **Systematic extraction fixes** — one change that helps *all* projects (over-extraction of
   junk structures, emit-every-run forcing function). Measured by ONE regression run. (medium)
4. **Field values / matching robustness** — slope/depth/typeClass accuracy, label normalization.
   Only worth it once entities are matched. (low, do last)

Never spend an expensive eval on step 3/4 before steps 1/2 are clean.

## The loop

```
              ┌──────────────────────────────────────────────────────┐
              │  1. OFFLINE bug hunt (free, no LLM)                    │
              │     npm run analyze:eval        ← error decomposition │
              │     + targeted probes on predicted_facts.json         │
              │     Find ruler bugs, coverage gaps, over/under-extract │
              │     If predictions carry a `transcript` array         │
              │     (EXTRACTION_MODE=transcribe|hybrid), npm run       │
              │     assemble:transcripts re-runs the WHOLE assembly+   │
              │     reconcile stack offline on it. As of 2026-09-06 NO │
              │     cached prediction carries one (0 of 18), so this    │
              │     loop currently validates NOTHING — see below.       │
              └───────────────────────┬──────────────────────────────┘
                                      │  batch several fixes
              ┌───────────────────────▼──────────────────────────────┐
              │  2. FAST validation (cheap)                           │
              │     - offline re-score if the fix is metric/matching  │
              │     - else local focus run: GOLDEN_FILTER=… REPEATS=3 │
              │     Confirm the fix beats the noise band on 1-2 cases │
              └───────────────────────┬──────────────────────────────┘
                                      │  batch is ready
              ┌───────────────────────▼──────────────────────────────┐
              │  3. FULL regression gate (expensive — do rarely)      │
              │     GOLDEN_REPEATS=3 on the VM (Vertex), then         │
              │     analyze:eval on the EXPORTED fresh predictions    │
              │     Accept only if aggregate clears the band AND no    │
              │     project regresses beyond its band. New baseline.  │
              └──────────────────────────────────────────────────────┘
```

**Batch changes, then one regression run.** Don't run a full eval per change. Each full run
is dollars + ~20 min; each offline analysis is free + seconds.

## Anti-patterns (things that wasted us time)

- **Single-run comparisons.** Variance is huge (a project swung detF1 12→51 unchanged). Always
  `GOLDEN_REPEATS=3`; compare *bands*, not points. A gain inside the band is not a gain.
- **Per-project prompt tuning.** Fixing Ecole regressed Matthews. Prefer changes that help the
  aggregate; if a change is net-neutral on the band, drop it and move to the next lever.
- **Trusting the metric blindly.** We chased "17% runs" for a long time; ~half was a slope bug.
- **Running the eval on the laptop.** Sleep-kills + `UND_ERR_SOCKET`. Use the throwaway Vertex VM.

## Bug-class checklist (run through this each analysis)

- [ ] **Truth-reading**: dump a real sheet, confirm every column maps right (we found F≠slope).
      Confirm every project reads sensible counts (no sheet-name mismatch dropping data).
- [ ] **Unscored entities**: does the metric cover the whole takeoff? (catchbasins were absent.)
- [ ] **Enum/lookup gaps**: are all real values representable? (`PIPE_DIAMETERS` missed 825/975 → snapping corrupted them.)
- [ ] **Over-extraction**: pred/truth ratio ≫ 1 and low precision → model emits junk (bike racks as structures).
- [ ] **Under-extraction**: pred/truth ratio ≪ 1 → coverage (tiles/locator) or the model gives up.
- [ ] **Matching**: are correct entities missing only due to label variance? (attribute-match rescued dimension-labeled runs.)
- [ ] **Stuck-at-0 projects**: distinct failure mode (didn't emit? wrong labels? not tiled?). Diagnose one, don't tune all.
- [ ] **Stale derived artifacts**: is `dataset-manifest.json` older than `dataset.ts` /
      `truth-facts.ts` / `build-dataset-manifest.ts`? It silently encoded 2026-07-03 code
      for seven weeks — costing one golden project its entire score and hiding every
      watermain row. Run `npm run manifest:check`.

## What each $0 loop can and cannot prove

The four free loops are **not interchangeable**, and treating them as such has already
produced one wrong acceptance ruling. Only two of them execute `reconcileTakeoff`:

| loop | what it runs | reaches `reconcileTakeoff`? |
|---|---|---|
| `npm run score:offline` | `compareFacts` on cached `predicted_facts.json` | **no** |
| `npm run analyze:eval` | same cached predictions, error decomposition | **no** |
| `npm run evaluate:text` | `extractPageText` → `assembleTextTakeoff` → reconcile, on the real PDFs | **yes** |
| `npm run assemble:transcripts` | `assembleTranscriptTakeoff` → reconcile, on cached transcripts | **yes, but** |

- **The cached predictions are already-reconciled OUTPUT.** `score:offline` and `analyze:eval`
  re-score them, so they can only ever move for changes that execute at SCORING time (the
  metric, matching, truth resolution). A parser, assembler, reconcile, tiling or prompt change
  is **structurally invisible** to them — a flat offline number is not evidence that such a
  change did nothing. Never attribute an extraction-side gain to an offline delta.
- **`evaluate:text` is the right free loop for reconcile/parser changes**, but it covers a
  narrow slice: only **6 of 16** golden projects have texty pages, and only **3** of those
  produce any sewer runs at all (Matthews Hangar, Oakville Fire Hall, Bradford Civic). A
  "no change" result here is weak evidence of safety, not proof.
- **`evaluate:text` needs `VERBOSE=true` to be decision-grade.** The default row prints only
  `textF1`, which conflates precision and recall and cannot decide a recall veto. `VERBOSE=true`
  emits `formatFactsComparison` with the per-entity `P= R= F1= (matched/truth, pred)` line. Use
  `VERBOSE=true npm run evaluate:text` for any acceptance decision.
- **`assemble:transcripts` currently validates nothing.** It only replays transcripts cached by
  a prior `EXTRACTION_MODE=transcribe|hybrid` run, and as of 2026-09-06 there are zero of those
  in the corpus (0 of 18 `predicted_facts.json` files carry a `transcript` array). It becomes
  useful the moment one such run lands; until then a green result from it means "no input".

### Text-layer ceiling (2026-09-06, `VERBOSE=true npm run evaluate:text`)

Oakville Fire Hall **85.7%** · Matthews Hangar **80.9%** · Bradford Civic **67.4%** · Ultimate
Drive **45.0%** · Eric Smith Way 7.0% · Holiday Inn 0.0%. (2026-08-21: 68.3 / 60.1 / 60.7 /
44.1, with Eric Smith not scoring at all.) On the three strong projects the residual is now
dominated by **field** accuracy, not detection — `sewer.typeClass` 0%, `sewer.depth` 0%,
`sewer.length` 50–68%. Ultimate Drive emits 0 of 29 sewer runs while scoring 80% structure F1
and 100% catchbasins, so its gap is a run-assembly gap, not a reading gap.

### What only a LIVE run can confirm

- **Tile-budget / coverage changes** (`PER_PAGE` 16→24, `MAX_TILES_TOTAL` 192→320). Expected
  effect: `facts.cost.tiles` rises 16 → 20 per E-size page. No offline loop can see this.
- **Whether the 4 empty runs clear.** Eric Smith Way is a confirmed wrong-drawing failure that
  `chooseDrawingPdfs` now fixes; for Georgian Dr, White Oak Woodbine and Milton #13 the cache
  has no `cost` telemetry, so "never tiled" (coverage/transport) cannot be separated from
  "returned nothing" (accuracy) without re-extracting.
- **`isEndpointPair` on real drawings** — provably a no-op on the text-layer corpus (no
  CONN/OUTLET/PLUG terminator and no `EX` prefix among those labels), so its benefit is
  unmeasured outside unit tests.
- **`schedule-table.ts`** — DORMANT: it fires on zero golden projects, so its behaviour is
  proven only by unit tests.

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

## Infrastructure (what makes each eval teach us more)

- **`npm run analyze:eval`** — the error-decomposition tool. Reads each golden project's
  `generated_spreadsheets/predicted_facts.json` + truth, prints per-entity precision/recall/F1
  + pred/truth ratio, field accuracy, stuck projects, unmatched samples. Run after every eval.
  Point it at fresh predictions with `PREDICTIONS_DIR=…`.
- **`predicted_facts.json` is the unit of offline analysis.** Every extraction persists it, so
  metric/matching/costing changes are re-scored for FREE — no re-extraction. Guard this.
- **The eval VM exports predictions to GCS** (`predictions.tgz`) so we can `analyze:eval` on
  *fresh* Vertex output, not stale local runs. Pull + extract over the local training dir, then
  `npm run analyze:eval`. (Without this we were forever stuck on stale predictions.)
- **Variance bands are first-class** in the scoreboard (`GOLDEN_REPEATS` → mean + [lo–hi]).
- See `CLAUDE.md` "Run it" for the exact commands (focus/full/filter/repeats knobs).

## When to stop

Set a target per lever and a stop-criterion: if a change doesn't clear the aggregate noise
band, drop it. Don't keep tuning a project whose band already overlaps the target — that's the
infinite loop. Move to the next-biggest error mass (use `analyze:eval` to see where it is).
