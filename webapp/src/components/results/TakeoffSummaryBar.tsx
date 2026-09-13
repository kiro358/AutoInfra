'use client';

import React from 'react';
import { Card } from '@/components/ui/Card';
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
  return (
    <div className="studio-kpi-grid" aria-label="Takeoff Key Metrics">
      <Card variant="interactive" className="kpi-card is-storm">
        <div className="flex items-center justify-between mb-2">
          <span className="kpi-label">Total Estimate</span>
          <span className="p-1.5 rounded bg-storm/10 text-storm">
            <DollarIcon size={18} />
          </span>
        </div>
        <div className="kpi-val text-storm font-mono">
          {formatCurrency(totalCost)}
        </div>
        <div className="kpi-sub font-mono">
          Grand total across all trades
        </div>
      </Card>

      <Card variant="interactive" className="kpi-card is-sanitary">
        <div className="flex items-center justify-between mb-2">
          <span className="kpi-label">Linear Pipework</span>
          <span className="p-1.5 rounded bg-sanitary/10 text-sanitary">
            <PipeIcon size={18} />
          </span>
        </div>
        <div className="kpi-val text-sanitary font-mono">
          {formatMeters(totalPipeLength)}
        </div>
        <div className="kpi-sub font-mono">
          Storm, sanitary &amp; watermain mains
        </div>
      </Card>

      <Card variant="interactive" className="kpi-card is-structures">
        <div className="flex items-center justify-between mb-2">
          <span className="kpi-label">Structures &amp; Inlets</span>
          <span className="p-1.5 rounded bg-structures/10 text-structures">
            <ManholeIcon size={18} />
          </span>
        </div>
        <div className="kpi-val text-structures font-mono">
          {formatNumber(structureCount, 0)}
        </div>
        <div className="kpi-sub font-mono">
          Maintenance holes, CBs &amp; inlets
        </div>
      </Card>

      <Card variant="interactive" className="kpi-card is-water">
        <div className="flex items-center justify-between mb-2">
          <span className="kpi-label">Appurtenances</span>
          <span className="p-1.5 rounded bg-water/10 text-water">
            <LayersIcon size={18} />
          </span>
        </div>
        <div className="kpi-val text-water font-mono">
          {formatNumber(valveCount, 0)}
        </div>
        <div className="kpi-sub font-mono">
          Valves, hydrants &amp; special fittings
        </div>
      </Card>
    </div>
  );
};

export default TakeoffSummaryBar;
