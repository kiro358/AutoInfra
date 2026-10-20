/**
 * Pipeline diagnostics (PR18) — pure builders for the per-run diagnostics
 * record (ExtractionDiagnostics in types.ts) and for the facts warnings that
 * surface silent tile loss.
 *
 * Why: the silent-cap audit found the transcription path's losses were
 * console-only (class 6c: tiles missing after the single retry, tiles
 * discarded as degenerate — logged, never on the facts, so a user saw a
 * clean partial takeoff) and the tile caps truncated with no signal at all
 * (class 6a). This module turns the counts the pipeline already computes
 * into (a) a persisted record that attributes loss stage by stage and
 * (b) warnings on the facts, mirroring how the single-pass branch already
 * surfaces its degenerate batches.
 *
 * Everything here is pure and post-hoc: diagnostics read the finished
 * pipeline state and never influence extraction.
 */
import type {
  EntityCounts,
  ExtractionDiagnostics,
  PageDiagnostics,
  TakeoffFacts,
  TileDiagnostics,
} from './types';

/** Entity counts by kind, for the assembly section of the record. */
export function entityCountsByKind(facts: TakeoffFacts): EntityCounts {
  return {
    structures: facts.structures?.length ?? 0,
    sewers: facts.sewers?.length ?? 0,
    watermain: facts.watermain?.length ?? 0,
    catchbasins: facts.catchbasins?.length ?? 0,
  };
}

/**
 * Derive per-page rendered tile counts from render order and the caps.
 *
 * The renderer (rasterize.ts) reports only a flat tile list, but it renders
 * pages in the order given, emits min(planned, per-page cap) tiles per page
 * (row-major), and the flat list is truncated at the total cap — so the
 * per-page split is fully determined by the planned counts and the caps.
 * The derivation is only trusted when it reconciles with the ACTUAL
 * rendered total; on any mismatch (a page rendered fewer tiles than its
 * geometry implies, an out-of-range page, …) every page reports null and
 * the caller keeps totals only.
 */
export function deriveRenderedPerPage(
  plannedPages: { page: number; planned: number }[],
  perPageCap: number,
  totalCap: number,
  actualRendered: number,
): (number | null)[] {
  let remaining = totalCap;
  const out: number[] = [];
  for (const p of plannedPages) {
    const want = Math.min(p.planned, perPageCap);
    const got = Math.min(want, Math.max(0, remaining));
    remaining -= got;
    out.push(got);
  }
  const sum = out.reduce((a, b) => a + b, 0);
  return sum === actualRendered ? out : plannedPages.map(() => null);
}

export interface ExtractionDiagnosticsInput {
  mode: string;
  durationMs: number;
  locator: ExtractionDiagnostics['locator'];
  pages: PageDiagnostics[];
  tiles: TileDiagnostics;
  sources: ExtractionDiagnostics['assembly']['sources'];
  finalFacts: TakeoffFacts;
  /** PR34: fallback trips recorded during the run (see model-config.ts).
   *  PR40: trips may carry source: 'probe' (job-start probe trip). */
  modelFallback?: { role: string; from: string; to: string; source?: string }[];
}

/** Assemble the record. Final assembly counts are read from the finished
 *  facts, so the record always describes the takeoff actually returned. */
export function buildExtractionDiagnostics(input: ExtractionDiagnosticsInput): ExtractionDiagnostics {
  return {
    version: 1,
    mode: input.mode,
    durationMs: input.durationMs,
    locator: input.locator,
    pages: input.pages,
    tiles: input.tiles,
    ...(input.modelFallback && input.modelFallback.length > 0 ? { modelFallback: input.modelFallback } : {}),
    assembly: {
      sources: input.sources,
      final: entityCountsByKind(input.finalFacts),
    },
  };
}

/**
 * The warnings that surface silent tile loss on the facts (audit classes
 * 6c/6a) — the ONLY user-visible behaviour change in PR18. Wording avoids
 * the 'Coverage:' prefix and the 'AI call(s) failed' pattern, so the
 * confidence assessment (confidence.ts isCoverageWarning) is untouched;
 * callers also append these after the confidence assessment, mirroring
 * the physics warnings.
 */
export function tileDiagnosticsWarnings(tiles: TileDiagnostics): string[] {
  const warnings: string[] = [];

  const missing = tiles.missingAfterRetry ?? 0;
  const degenerate = tiles.degenerateDiscarded ?? 0;
  if (missing > 0 || degenerate > 0) {
    const parts: string[] = [];
    if (missing > 0) parts.push(`${missing} tile(s) never returned after all recovery attempts`);
    if (degenerate > 0) parts.push(`${degenerate} tile(s) discarded as degenerate repetition (a decode loop, not a read of the drawing)`);
    const rendered = tiles.rendered != null ? ` of ${tiles.rendered} rendered` : '';
    // Recovery credit: the loss counts above are FINAL (post-ladder), so
    // when the ladder also saved tiles, say so — the saved tiles are in
    // the transcript and are not part of the loss.
    const savedParts: string[] = [];
    const savedRetry = tiles.recoveredAfterRetry ?? 0;
    const savedSingle = tiles.recoveredAsSingle ?? 0;
    const savedDegenerate = tiles.degenerateRecovered ?? 0;
    if (savedRetry > 0) savedParts.push(`${savedRetry} after the batch retry`);
    if (savedSingle > 0) savedParts.push(`${savedSingle} as single-tile calls`);
    if (savedDegenerate > 0) savedParts.push(`${savedDegenerate} after a degenerate re-issue`);
    const savedTotal = savedRetry + savedSingle + savedDegenerate;
    const recovery = savedTotal > 0
      ? ` Recovery saved ${savedTotal} tile(s) (${savedParts.join(', ')}).`
      : '';
    warnings.push(
      `Transcription lost ${missing + degenerate} tile(s)${rendered}: ${parts.join('; ')}.${recovery} ` +
      `That sheet area was not transcribed, so this takeoff may be incomplete.`
    );
  }

  // Cap truncation — but not when rendering itself failed: a render failure
  // is a different loss (surfaced via the call-failure path), and calling it
  // truncation would misattribute it.
  if (!tiles.renderFailed && tiles.planned != null && tiles.rendered != null && tiles.rendered < tiles.planned) {
    warnings.push(
      `Tile rendering truncated: ${tiles.planned} tile(s) are needed to cover the vision pages ` +
      `but only ${tiles.rendered} were rendered (per-page / total tile cap). ` +
      `The un-rendered sheet area was never read, so this takeoff may be incomplete.`
    );
  }

  return warnings;
}
