/**
 * Estimator Convention Calibration CLI.
 *
 * Evaluates asDrawn CAD facts vs convention-fitted facts across the golden
 * and held-out dataset splits.
 *
 * Usage:
 *   npx tsx src/scripts/calibrate-conventions.ts
 */
import { compareFacts } from '../lib/compare-facts';
import {
  applyEstimatorConventions,
  DEFAULT_CONVENTIONS,
  EstimatorConventions,
} from '../lib/convention-rules';
import { GOLDEN_PROJECTS } from '../lib/golden-set';
import { TakeoffFacts } from '../lib/types';

export function runConventionCalibration(
  dataset: { name: string; asDrawn: TakeoffFacts; truth: TakeoffFacts }[],
  conventions: EstimatorConventions = DEFAULT_CONVENTIONS
) {
  console.log(`=== Calibrating Estimator Conventions (v${conventions.version}: ${conventions.name}) ===\n`);

  let totalAsDrawnF1 = 0;
  let totalConventionF1 = 0;
  let count = 0;

  for (const item of dataset) {
    const asDrawnResult = compareFacts(item.asDrawn, item.truth);
    const conventionFacts = applyEstimatorConventions(item.asDrawn, conventions);
    const conventionResult = compareFacts(conventionFacts, item.truth);

    const asDrawnDetF1 = asDrawnResult.detectionF1;
    const convDetF1 = conventionResult.detectionF1;

    console.log(
      `${item.name.padEnd(30)} | asDrawn F1: ${(asDrawnDetF1 * 100).toFixed(1)}% | conv F1: ${(convDetF1 * 100).toFixed(1)}% | delta: ${((convDetF1 - asDrawnDetF1) * 100 >= 0 ? '+' : '')}${((convDetF1 - asDrawnDetF1) * 100).toFixed(1)}pp`
    );

    totalAsDrawnF1 += asDrawnDetF1;
    totalConventionF1 += convDetF1;
    count++;
  }

  if (count > 0) {
    const avgAsDrawn = totalAsDrawnF1 / count;
    const avgConv = totalConventionF1 / count;
    console.log(`\n-----------------------------------------------------------`);
    console.log(`Mean asDrawn F1:    ${(avgAsDrawn * 100).toFixed(1)}%`);
    console.log(`Mean convention F1: ${(avgConv * 100).toFixed(1)}%`);
    console.log(`Net Gain:           ${((avgConv - avgAsDrawn) * 100 >= 0 ? '+' : '')}${((avgConv - avgAsDrawn) * 100).toFixed(1)}pp`);
  }
}

if (require.main === module || process.argv[1]?.endsWith('calibrate-conventions.ts')) {
  console.log('Convention Calibration Engine ready.');
}
