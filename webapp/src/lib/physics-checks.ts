/**
 * Physics surfacing: the cad-invariants checks that assembled facts can
 * actually feed, run on the default (transcript / text / hybrid) paths.
 *
 * The five physical invariants live in cad-invariants.ts, but they evaluate
 * a BoundSiteNetwork — drawn geometry (polylines, centroids, drawn lengths)
 * that only the vector path builds — so on the paths prod actually runs
 * they have never fired. This module is the facts-native counterpart: it
 * reads the same physics off TakeoffFacts and reports violations as
 * warnings (the channel every consumer already reads), exactly like
 * coverage-checks.ts. It NEVER alters a fact, a quantity or a score.
 *
 * What each cad invariant becomes at facts level (input audit, 2026-10-13,
 * golden 26 — see pr10_evidence.md for the census behind every line):
 *
 *  - DEPTH_VALIDITY → WIRED. Structures carry rim (topElevation) and
 *    inverts, so rim − lowInvert is checkable today: non-positive depth,
 *    an invert above the rim, and the cad module's own 0.8–12.0 m typical
 *    range. One facts-level refinement: headwalls (HW) and flared end
 *    sections (FES) are exempt from the SHALLOW bound only — a headwall's
 *    top is the top of a concrete apron, and 0.55–0.72 m over the outlet
 *    invert is ordinary there (the corpus's only two shallow firings of
 *    that kind); they remain subject to every other check. The plan's
 *    stated-depth cross-check (depth ≈ rim − invert) is wired too — it
 *    fires wherever a path emits a stated depth.
 *  - HYDRAULIC_DROP → WIRED as the slope-consistency check. Directed
 *    edges don't exist in facts, but a run that names both endpoints
 *    (the single-pass label shape, "MH 5-MH 4") carries slope + length,
 *    and the endpoint structures carry inverts: the stated drop
 *    (slope × length) must fit inside the fall the inverts allow.
 *  - CAPACITY_CONTINUITY → WIRED in its stated-outlet form: a connected
 *    pipe larger than the structure's stated outgoing diameter
 *    (pipeOutDiameter). The graph form (which pipe is "outgoing") is not
 *    decidable from facts — run labels carry no direction.
 *  - ENDPOINT_COMPLETENESS → NOT duplicated here: coverage-checks.ts
 *    (PR #34) already reports dangling run endpoints on these paths.
 *    Unresolved endpoints simply limit the run checks above.
 *  - LENGTH_CONSERVATION → NOT wired: it compares stated length against
 *    DRAWN length, and facts carry no drawn length. It stays vector-only
 *    until a path records one (plan 4.3).
 *
 * Corpus reality, stated plainly: on the golden 26 the transcript/text
 * assemblers label runs by their dimension callout ("17.34m-825mm STM"),
 * not by endpoints — 0 of 860 corpus runs name an endpoint pair, and
 * pipeOutDiameter is populated on 0 of 853 corpus structures — so the
 * run-level checks are standing guards on this corpus (they fire on
 * endpoint-labelled facts, the shape the single-pass prompt mandates),
 * while the structure-level checks fire today. Every check is
 * conservative: ambiguous identity (a label matching two structures)
 * resolves to "cannot check", never to a guessed pairing.
 */
import { StructureFact, TakeoffFacts } from './types';
import { normalizeLabel } from './compare-facts';
import { getEndpointSignature } from './reconcile';

/** Inverts/rods are stated to 2–3 dp; below this, readings are "equal". */
const ELEV_TOL = 0.02;
/** cad-invariants DEPTH_VALIDITY typical range, verbatim. */
const DEPTH_MIN = 0.8;
const DEPTH_MAX = 12.0;
/** Stated depth vs rim − invert agreement band (plan 4.1 cross-check). */
const DEPTH_MATCH_TOL = 0.3;
/**
 * Slope-consistency slack: the stated drop must land within this distance
 * of the invert fall window. The floor absorbs invert readings taken from
 * different sheets of the same set; the proportional part absorbs slope
 * rounding on long runs (a slope stated to 2 dp over 100 m is ±0.05 m of
 * drop by itself, before any reading error).
 */
const SLOPE_TOL_FLOOR = 0.25;
const SLOPE_TOL_FRAC = 0.2;

const f2 = (v: number) => v.toFixed(2);

/** Structures by normalised label; a label with 2+ structures is ambiguous. */
function structureIndex(facts: TakeoffFacts): Map<string, StructureFact | null> {
  const index = new Map<string, StructureFact | null>();
  for (const s of facts.structures ?? []) {
    const key = normalizeLabel(s.description);
    if (!key) continue;
    index.set(key, index.has(key) ? null : s);
  }
  return index;
}

/** Terminal outlet structures whose "rim" is an apron top, not a grade. */
const TERMINAL_KINDS = new Set(['HW', 'FES']);

function structureWarnings(s: StructureFact): string[] {
  const warnings: string[] = [];
  const name = `"${s.description}"`;
  const { topElevation: rim, lowInvert: low, highInvert: high } = s;
  const kind = /^([A-Z]+)\d/.exec(normalizeLabel(s.description))?.[1];
  const isTerminal = kind != null && TERMINAL_KINDS.has(kind);

  // Drop validity: the highest invert entering a structure cannot sit
  // below the lowest invert leaving it — the two readings contradict
  // each other (cad's HYDRAULIC_DROP, at the structure itself).
  if (high != null && low != null && high < low - ELEV_TOL) {
    warnings.push(
      `Physics: structure ${name} has a high invert (${f2(high)}) below its low invert (${f2(low)}) — ` +
        `the invert readings contradict each other; verify them against the profile.`
    );
  }

  if (rim != null && low != null) {
    const depth = rim - low;
    // DEPTH_VALIDITY (cad): rim at or below the low invert is impossible.
    if (depth <= 0) {
      warnings.push(
        `Physics: structure ${name} has rim ${f2(rim)} at or below its low invert ${f2(low)} ` +
          `(depth ${f2(depth)}m) — one of the elevations was misread.`
      );
    } else if (depth > DEPTH_MAX || (depth < DEPTH_MIN && !isTerminal)) {
      // DEPTH_VALIDITY (cad): outside the typical civil range. Terminal
      // structures are exempt from the shallow bound only (see header).
      warnings.push(
        `Physics: structure ${name} depth (rim − low invert) is ${f2(depth)}m, ` +
          `outside the typical ${DEPTH_MIN}–${DEPTH_MAX}m range — verify the rim and invert readings.`
      );
    }
    // Stated-depth cross-check (plan 4.1): where a path recorded a depth
    // of its own, it must agree with the elevations it recorded.
    if (s.depth != null && depth > 0 && Math.abs(s.depth - depth) > DEPTH_MATCH_TOL) {
      warnings.push(
        `Physics: structure ${name} stated depth ${f2(s.depth)}m disagrees with rim − low invert ` +
          `(${f2(depth)}m) by ${f2(Math.abs(s.depth - depth))}m — verify which reading is right.`
      );
    }
  }

  // An invert above the rim is a pipe entering above ground level. (The
  // low-invert case is the depth check above; this catches a high invert
  // poking above the rim while the low invert stays below it.)
  if (rim != null && high != null && high > rim + ELEV_TOL) {
    warnings.push(
      `Physics: structure ${name} has a high invert (${f2(high)}) above its rim (${f2(rim)}) — ` +
        `a pipe cannot enter above ground level; verify the elevations.`
    );
  }
  return warnings;
}

interface ResolvedRun {
  label: string;
  length: number;
  slope: number | null;
  diameter: number | null;
  a: StructureFact;
  b: StructureFact;
}

/**
 * Warnings for physics violations visible in the assembled facts.
 * Pure and deterministic; ordering is structures first (in takeoff
 * order), then runs (in takeoff order), so re-running over the same
 * facts yields the identical list (the appender relies on this).
 */
export function physicsWarnings(facts: TakeoffFacts): string[] {
  const warnings: string[] = [];
  for (const s of facts.structures ?? []) warnings.push(...structureWarnings(s));

  const index = structureIndex(facts);

  // Resolve endpoint-labelled runs to their two structures, and record
  // each structure's connected pipe diameters for the capacity check.
  const resolved: ResolvedRun[] = [];
  const connectedDiameters = new Map<StructureFact, number[]>();
  for (const run of facts.sewers ?? []) {
    if (run.isLineItem) continue;
    const sig = getEndpointSignature(run.runLabel);
    if (!sig) continue;
    const tokens = sig.split('|');
    if (tokens.length !== 2 || tokens.includes('CONN')) continue;
    const a = index.get(tokens[0]);
    const b = index.get(tokens[1]);
    if (!a || !b || a === b) continue;
    if (run.pipeDiameter != null) {
      for (const s of [a, b]) {
        (connectedDiameters.get(s) ?? connectedDiameters.set(s, []).get(s)!).push(run.pipeDiameter);
      }
    }
    if (run.length != null && run.length > 0) {
      resolved.push({ label: run.runLabel, length: run.length, slope: run.slope, diameter: run.pipeDiameter, a, b });
    }
  }

  // Slope ≈ invert drop ÷ length (cad HYDRAULIC_DROP, facts form). The
  // downstream structure's pipe invert lies between its low invert (the
  // outlet) and its high invert (the highest inlet), so the stated drop
  // must fit the window [fall − downstream drop, fall] around the
  // outlet-to-outlet fall. Direction-free: "upstream" is whichever end
  // sits higher.
  for (const run of resolved) {
    if (run.slope == null || run.slope <= 0 || run.slope > 10) continue; // range validation owns those
    const { a, b } = run;
    if (a.lowInvert == null || b.lowInvert == null) continue;
    const up = a.lowInvert >= b.lowInvert ? a : b;
    const down = up === a ? b : a;
    const fall = up.lowInvert! - down.lowInvert!;
    const downDrop =
      down.highInvert != null ? Math.max(0, down.highInvert - down.lowInvert!) : 0;
    const lo = Math.min(fall, fall - downDrop);
    const hi = fall;
    const implied = (run.slope * run.length) / 100;
    const tol = Math.max(SLOPE_TOL_FLOOR, SLOPE_TOL_FRAC * implied);
    if (implied < lo - tol || implied > hi + tol) {
      warnings.push(
        `Physics: run "${run.label}" states ${f2(run.slope)}% over ${run.length.toFixed(1)}m ` +
          `(a ${f2(implied)}m drop), but its endpoint inverts allow only ${f2(lo)}–${f2(hi)}m of fall — ` +
          `the slope, the length or an invert was misread.`
      );
    }
  }

  // Capacity continuity (cad), stated-outlet form: no connected pipe may
  // exceed the diameter the structure states for its outgoing pipe.
  for (const s of facts.structures ?? []) {
    if (s.pipeOutDiameter == null) continue;
    const diameters = connectedDiameters.get(s) ?? [];
    const oversize = diameters.filter((d) => d > s.pipeOutDiameter!);
    if (oversize.length > 0) {
      warnings.push(
        `Physics: structure "${s.description}" has a connected ${Math.max(...oversize)}mm pipe larger than ` +
          `its stated ${s.pipeOutDiameter}mm outgoing pipe — capacity cannot grow downstream; verify the diameters.`
      );
    }
  }
  return warnings;
}

/**
 * Append the physics warnings to a takeoff's warnings, skipping any
 * already present verbatim (the checks are pure, so re-running them over
 * re-reconciled or merged facts must not duplicate a note). Mirrors
 * appendCoverageWarnings; call it AFTER the final confidence assessment
 * — physics notes are not confidence signals.
 */
export function appendPhysicsWarnings(facts: TakeoffFacts): TakeoffFacts {
  const existing = new Set(facts.warnings ?? []);
  const fresh = physicsWarnings(facts).filter((w) => !existing.has(w));
  if (fresh.length === 0) return facts;
  return { ...facts, warnings: [...(facts.warnings ?? []), ...fresh] };
}
