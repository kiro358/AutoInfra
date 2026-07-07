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
