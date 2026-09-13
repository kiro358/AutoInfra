'use client';

import React from 'react';

/**
 * The summary strip that sits under every domain table. Shared so the storm,
 * sanitary, structures and watermain footers stay visually identical — an
 * estimator reads these five numbers across tabs and any drift between them
 * reads as a data difference rather than a styling one.
 */

export type SummaryTone = 'storm' | 'sanitary' | 'water' | 'structures' | 'neutral';

export type SummaryFigure = {
  key: string;
  label: string;
  value: string;
  sub?: string;
  tone?: SummaryTone;
};

/** `.kpi-card` accents are opt-in; 'neutral' intentionally adds no modifier. */
export function toneClass(tone: SummaryTone | undefined): string {
  return !tone || tone === 'neutral' ? '' : `is-${tone}`;
}

export interface ViewSummaryProps {
  figures: SummaryFigure[];
  className?: string;
  /** Accessible name for the region, e.g. "Storm sewer totals". */
  label?: string;
}

export const ViewSummary: React.FC<ViewSummaryProps> = ({ figures, className = '', label }) => {
  if (figures.length === 0) return null;
  return (
    <div
      className={`studio-kpi-grid ${className}`.trim()}
      role="group"
      aria-label={label ?? 'Totals'}
    >
      {figures.map((figure) => (
        <div key={figure.key} className={`kpi-card ${toneClass(figure.tone)}`.trim()}>
          <div className="kpi-label">{figure.label}</div>
          <div className="kpi-value font-mono">{figure.value}</div>
          {figure.sub && <div className="kpi-sub">{figure.sub}</div>}
        </div>
      ))}
    </div>
  );
};

export default ViewSummary;
