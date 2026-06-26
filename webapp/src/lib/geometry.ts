/**
 * Pure geometric/normalization helpers shared by the extraction and costing
 * stages. No side effects, no network — safe to import anywhere and unit-test.
 */
import { PIPE_DIAMETERS } from './constants';

/** Snap an arbitrary diameter (mm) to the nearest standard pipe size. */
export function snapToPipeDiameter(value: number): number {
  if (value <= 0) return 0;
  let closest = PIPE_DIAMETERS[0];
  let minDiff = Math.abs(value - closest);
  for (const d of PIPE_DIAMETERS) {
    const diff = Math.abs(value - d);
    if (diff < minDiff) {
      minDiff = diff;
      closest = d;
    }
  }
  return closest;
}

/** Pick a standard manhole barrel diameter (mm) from the largest outlet pipe. */
export function snapToMHSize(pipeOutDia: number | null): number {
  if (pipeOutDia === null || pipeOutDia <= 0) return 1200;
  if (pipeOutDia <= 450) return 1200;
  if (pipeOutDia <= 600) return 1500;
  if (pipeOutDia <= 825) return 1800;
  if (pipeOutDia <= 1050) return 2400;
  if (pipeOutDia <= 1500) return 3000;
  return 3600;
}

/**
 * Normalize slope values — drawings sometimes use ‰ (per-mille) instead of %.
 * Heuristic: a slope > 10 is almost certainly per-mille, so divide by 10.
 */
export function normalizeSlope(slope: number): number {
  if (slope > 10) return slope / 10;
  return slope;
}
