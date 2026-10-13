# Eval results & the regression gate

`baseline.json` in this folder is the frozen reference run for the automated
eval gate (`webapp/src/scripts/eval-gate.ts`). Each gate run also writes a
timestamped `<timestamp>.json` here, so score history is preserved.

## Running the gate

```bash
cd webapp
npm run eval:gate                      # compare current code vs baseline.json
npm run eval:gate -- --update-baseline # record the current run as the new baseline
```

Requires the golden dataset at the repo root (`existing_projects_training_data/`
+ `dataset-manifest.json`, both gitignored — the dataset is not in this repo).
Without them the gate exits with code 2 and explains what's missing.

## What it checks

The gate runs the deterministic $0 text-layer path (`extractPageText →
assembleTextTakeoff → compareFacts`, the same computation as
`npm run evaluate:text`) for every golden project, then compares against the
baseline:

- **FAIL (exit 1)** if aggregate detection F1 or field accuracy drops more than
  `GATE_AGG_BAND_PTS` (default 0.5 pts), or any single project's detection F1
  drops more than `GATE_PROJECT_BAND_PTS` (default 2 pts), or a project that
  scored in the baseline no longer scores.
- **PASS (exit 0)** otherwise.

This is the acceptance rule from `EVAL_METHODOLOGY.md` — aggregate clears its
band **and** no project regresses beyond its own — made executable, so a change
can't be accepted on the strength of the one project it was built for.

Cached LLM predictions (`generated_spreadsheets/predicted_facts.json`) are
reported for context but never gate: offline rescoring cannot see extraction
changes.

## Seeded baseline

`baseline.json` was seeded 2026-10-13 from dataset staged locally from the
project archive, on `main` @ f4a0bf4d:

- 11 of 26 golden projects have text-layer pages and score on this path
  (the rest are raster/SHX and are covered by the transcript/LLM layers).
- Aggregate: detection F1 **41.1%**, field accuracy **43.7%**.

## Updating the baseline

Only after a change has been accepted under the methodology loop (batch →
full gate → no per-project regression). Re-freezing the baseline is a
deliberate act: run with `--update-baseline` and say why in the commit message.
Ruler changes (`compare-facts.ts`, `truth-facts.ts`, tolerances, matching)
invalidate comparisons — they ship alone, with before/after numbers on
identical predictions, and the baseline is re-frozen in the same PR.
