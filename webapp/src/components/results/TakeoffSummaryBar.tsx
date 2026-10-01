'use client';

import React from 'react';
import { DollarIcon, LayersIcon, ManholeIcon, PipeIcon } from '@/components/ui/Icons';
import { formatCurrency, formatMeters, formatNumber } from '@/lib/formatters';

export interface TakeoffSummaryBarProps {
  totalCost: number;
  totalPipeLength: number;
  structureCount: number;
  valveCount: number;
}

export const TakeoffSummaryBar: React.FC<TakeoffSummaryBarProps> = ({
  totalCost,
  totalPipeLength,
  structureCount,
  valveCount,
}) => {
  const tiles = [
    {
      tone: 'is-accent',
      label: 'Total estimate',
      value: formatCurrency(totalCost),
      sub: 'All trades combined',
      icon: <DollarIcon size={16} />,
    },
    {
      tone: 'is-storm',
      label: 'Linear pipework',
      value: formatMeters(totalPipeLength),
      sub: 'Storm, sanitary & watermain',
      icon: <PipeIcon size={16} />,
    },
    {
      tone: 'is-structures',
      label: 'Structures',
      value: formatNumber(structureCount, 0),
      sub: 'Maintenance holes & catchbasins',
      icon: <ManholeIcon size={16} />,
    },
    {
      tone: 'is-water',
      label: 'Appurtenances',
      value: formatNumber(valveCount, 0),
      sub: 'Valves, hydrants & specials',
      icon: <LayersIcon size={16} />,
    },
  ];

  return (
    <div className="studio-kpi-grid" aria-label="Takeoff Key Metrics">
      {tiles.map((t) => (
        <div key={t.label} className={`kpi-card ${t.tone}`}>
          <div className="kpi-head">
            <span className="kpi-label">{t.label}</span>
            <span className="kpi-icon">{t.icon}</span>
          </div>
          <div className="kpi-value">{t.value}</div>
          <div className="kpi-sub">{t.sub}</div>
        </div>
      ))}
    </div>
  );
};

export default TakeoffSummaryBar;
