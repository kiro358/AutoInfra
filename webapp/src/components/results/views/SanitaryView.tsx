'use client';

import React from 'react';
import type { SewerRunRow } from './rows';
import { SewerRunTable } from './SewerRunTable';

export interface SanitaryViewProps {
  sanitaryRuns: SewerRunRow[];
  totalSanitaryCost: number;
  totalSanitaryLength: number;
}

/**
 * Sanitary sewer tab — same takeoff geometry as storm, amber accent, priced off
 * the sanitary rate table upstream. See `SewerRunTable` for the columns.
 */
export const SanitaryView: React.FC<SanitaryViewProps> = ({
  sanitaryRuns,
  totalSanitaryCost,
  totalSanitaryLength,
}) => (
  <SewerRunTable
    accent="sanitary"
    rows={sanitaryRuns}
    totalCost={totalSanitaryCost}
    totalLength={totalSanitaryLength}
    emptyMessage="No sanitary sewer runs were found in this drawing."
  />
);

export default SanitaryView;
