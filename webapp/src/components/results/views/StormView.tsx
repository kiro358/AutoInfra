'use client';

import React from 'react';
import type { SewerRunRow } from './rows';
import { SewerRunTable } from './SewerRunTable';

export interface StormViewProps {
  stormRuns: SewerRunRow[];
  totalStormCost: number;
  totalStormLength: number;
}

/**
 * Storm sewer tab — run-by-run pipe takeoff with a linear-metre and cost footer.
 *
 * Storm and sanitary share `SewerRunTable`; this component exists so the tab
 * wiring names a domain rather than a generic table with an accent prop.
 */
export const StormView: React.FC<StormViewProps> = ({
  stormRuns,
  totalStormCost,
  totalStormLength,
}) => (
  <SewerRunTable
    accent="storm"
    rows={stormRuns}
    totalCost={totalStormCost}
    totalLength={totalStormLength}
    emptyMessage="No storm sewer runs were found in this drawing."
  />
);

export default StormView;
