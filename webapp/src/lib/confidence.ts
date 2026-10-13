/**
 * Signal-based confidence: an honest replacement for the hardcoded scores the
 * takeoff paths used to report (`confidence: 1` on the text/transcript paths,
 * `0.9` on single-pass — constants that said "trust this" regardless of what
 * the assembly actually did).
 *
 * The score starts at 1.0 — "every signal this module can see came back
 * clean" — and each signal that fires applies a NAMED multiplicative
 * deduction. The returned breakdown (`confidenceFactors`) names every
 * deduction, its count and its multiplier, so the number explains itself
 * wherever it is surfaced. It is a review prioritizer, never a verification:
 * it can only see signals the pipeline emits, and entities that were never
 * transcribed leave no signal at all (Future Park measures detF1 14% on
 * runs its transcripts never mentioned, while its read fields are accurate —
 * its score is mid-pack, and that blind spot is inherent, not a bug).
 *
 * The scorer reads ONLY engine-emitted signals — provenance (PR #35),
 * withheld items (PR #35), coverage warnings (PR #34) — never the measured
 * values themselves.
 *
 * Calibration (2026-10-13, golden 26, transcript/text assemblies rescored
 * against truth; full data in pr9_evidence.md):
 *  - Defaulted-values rate (priced WithheldItem 'defaulted' per fact) is the
 *    strongest single predictor of measured field accuracy (Pearson
 *    r = −0.72): a default is applied exactly where a fact is missing a
 *    value, so the rate proxies fact sparsity. Max deduction 0.65 sits in
 *    the grid-search plateau (0.6–0.7) that best rank-matches measured
 *    quality (Spearman ρ = +0.62 vs convention-excluded field accuracy,
 *    +0.46 vs a detF1/field-accuracy blend).
 *  - Withheld-question rate (unmeasured callouts per fact) is directionally
 *    right but weak (ρ ≈ 0 alone); max deduction 0.45 from the same plateau.
 *  - Coverage warnings: 0.15 per warning. The rank optimizer prefers ~0
 *    (Ultimate Drive carries two dangling-endpoint warnings on a genuinely
 *    good takeoff), but a takeoff that itself reports a missing network
 *    must not score as clean — kept at the plateau's low end on semantics.
 *  - Derived values are REPORTED but NOT deducted (factor 1.0): across the
 *    golden 26, the derived rate correlates POSITIVELY with measured
 *    field accuracy (r = +0.60, ρ = +0.66) — derivations computed from read
 *    values (a manhole diameter snapped from its connected pipes, a drop
 *    from two read inverts) are reliable, and deducting them would punish
 *    the pipeline for doing arithmetic the estimator asked for.
 *  - Unprovenanced / unverifiable (single-pass) facts have zero variance in
 *    the assembled calibration corpus — every assembled fact now carries a
 *    source — so their weights cannot be fitted. They are set equal to the
 *    defaulted weight (0.65) on a documented judgement: a value that cannot
 *    be traced to a checkable read is at least as risky as one that was
 *    defaulted at pricing. This is the deduction that fires on legacy
 *    cached facts and on the single-pass LLM path.
 */
import { TakeoffFacts, ConfidenceFactor } from './types';

export interface ConfidenceAssessment {
  score: number;
  factors: ConfidenceFactor[];
}

/** An assembly that produced nothing is not a low-confidence takeoff, it is
 *  an absent one — the score craters to this floor. */
export const EMPTY_ASSEMBLY_SCORE = 0.02;

const MAX_DEDUCTION_DEFAULTED = 0.65;
const MAX_DEDUCTION_WITHHELD = 0.45;
const MAX_DEDUCTION_UNPROVENANCED = 0.65;
const MAX_DEDUCTION_UNVERIFIABLE = 0.65;
const COVERAGE_WARNING_FACTOR = 0.85;

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** Warnings that report incompleteness (coverage-checks.ts + failed calls). */
const isCoverageWarning = (w: string): boolean =>
  w.startsWith('Coverage:') || /AI call\(s\) failed/.test(w);

/**
 * Assess a takeoff's confidence from its own signals. Pure: reads facts,
 * withheld items and warnings; changes nothing. At pricing time the caller
 * passes the facts with the priced (defaulted/derived-extended) withheld
 * list, which is when the defaulted-values deduction can fire.
 */
export function assessConfidence(facts: TakeoffFacts): ConfidenceAssessment {
  // The provenance-bearing fact pool. Watermain specials/valves carry no
  // source field in the schema, so they are not part of the pool.
  const pool = [
    ...(facts.structures ?? []),
    ...(facts.catchbasins ?? []),
    ...(facts.sewers ?? []),
    ...(facts.watermain ?? []),
  ];
  const n = pool.length;

  if (n === 0) {
    return {
      score: EMPTY_ASSEMBLY_SCORE,
      factors: [{
        signal: 'empty-assembly',
        label: 'The assembly produced no facts at all — there is nothing here to rely on.',
        count: 0,
        total: 0,
        factor: EMPTY_ASSEMBLY_SCORE,
      }],
    };
  }

  const factors: ConfidenceFactor[] = [];
  let score = 1;
  const deduct = (signal: string, label: string, count: number, total: number, factor: number) => {
    if (count <= 0) return;
    factors.push({ signal, label, count, total, factor: round4(factor) });
    score *= factor;
  };

  const unprovenanced = pool.filter((f) => !f.source).length;
  deduct(
    'unprovenanced-facts',
    `${unprovenanced} of ${n} facts carry no provenance — their origin was not recorded and cannot be checked.`,
    unprovenanced, n, 1 - MAX_DEDUCTION_UNPROVENANCED * (unprovenanced / n)
  );

  const unverifiable = pool.filter((f) => f.source?.method === 'single-pass').length;
  deduct(
    'unverifiable-method',
    `${unverifiable} of ${n} facts come from the single-pass model read, which no deterministic path corroborates.`,
    unverifiable, n, 1 - MAX_DEDUCTION_UNVERIFIABLE * (unverifiable / n)
  );

  const withheld = facts.withheld ?? [];
  const withheldCount = withheld.filter((w) => w.kind === 'withheld').length;
  deduct(
    'withheld-questions',
    `${withheldCount} value(s) were mentioned on the drawings but not measured — open questions on the AUDIT sheet.`,
    withheldCount, n, 1 - MAX_DEDUCTION_WITHHELD * Math.min(1, withheldCount / n)
  );

  const defaultedCount = withheld.filter((w) => w.kind === 'defaulted').length;
  deduct(
    'defaulted-values',
    `${defaultedCount} value(s) were not read off the drawings and had a convention default applied at pricing — see the AUDIT sheet.`,
    defaultedCount, n, 1 - MAX_DEDUCTION_DEFAULTED * Math.min(1, defaultedCount / n)
  );

  const coverageCount = (facts.warnings ?? []).filter(isCoverageWarning).length;
  deduct(
    'coverage-warnings',
    `${coverageCount} coverage warning(s): part of the work appears to be missing from this takeoff.`,
    coverageCount, (facts.warnings ?? []).length, Math.pow(COVERAGE_WARNING_FACTOR, coverageCount)
  );

  // Derived values: reported for transparency, never deducted (see header —
  // measured as reliable across the golden corpus).
  const derivedCount =
    pool.filter((f) => f.source?.method === 'derived' || f.source?.method === 'convention-default').length +
    withheld.filter((w) => w.kind === 'derived').length;
  if (derivedCount > 0) {
    factors.push({
      signal: 'derived-values',
      label: `${derivedCount} value(s) were derived from read values at pricing (no deduction — derivations measured as reliable).`,
      count: derivedCount,
      total: n,
      factor: 1,
    });
  }

  return { score: round4(Math.min(1, Math.max(EMPTY_ASSEMBLY_SCORE, score))), factors };
}

/** Return the facts with `confidence` / `confidenceFactors` replaced by the
 *  signal-based assessment. Every other field is carried through untouched. */
export function withConfidence<T extends TakeoffFacts>(facts: T): T {
  const { score, factors } = assessConfidence(facts);
  return { ...facts, confidence: score, confidenceFactors: factors };
}
