'use client';

import React, { useState, useMemo, useCallback } from 'react';
import type { ProcessResponse, SewerRun } from '@/lib/types';
import { TakeoffHeader } from './TakeoffHeader';
import { TakeoffSummaryBar } from './TakeoffSummaryBar';
import { TakeoffTabs, TakeoffTab } from './TakeoffTabs';
import {
  CostLedgerView,
  SanitaryView,
  StormView,
  StructuresView,
  TelemetryView,
  WatermainView,
  sewerTrade,
  takeoffHeadline,
  toManholeRows,
  toSewerRunRows,
  toWatermainPipeRows,
  toWatermainValveRows,
} from './views';

export interface TakeoffStudioProps {
  result: ProcessResponse;
  onReset: () => void;
}

/**
 * Downloads a base64 string safely by creating an ephemeral link.
 */
export function downloadBase64File(base64: string, filename: string, mimeType: string): void {
  if (typeof window === 'undefined' || !base64) return;
  try {
    const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    const byteCharacters = atob(cleanBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoking synchronously can cancel the download in Safari/Firefox.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error('Failed to trigger file download:', err);
  }
}

export const TakeoffStudio: React.FC<TakeoffStudioProps> = ({ result, onReset }) => {
  const [activeTab, setActiveTab] = useState<TakeoffTab>('summary');
  const [isDownloadingXlsx, setIsDownloadingXlsx] = useState(false);
  const [isDownloadingQuote, setIsDownloadingQuote] = useState(false);

  const extraction = result.extraction;

  // Same storm/sanitary rule as the Cost Ledger (rows.ts::sewerTrade)
  const stormRunsRaw = useMemo(() => {
    return (extraction.sewers ?? []).filter((r: SewerRun) => sewerTrade(r.runLabel) === 'storm');
  }, [extraction.sewers]);

  const sanitaryRunsRaw = useMemo(() => {
    return (extraction.sewers ?? []).filter((r: SewerRun) => sewerTrade(r.runLabel) === 'sanitary');
  }, [extraction.sewers]);

  // Transformed table rows
  const stormRows = useMemo(() => toSewerRunRows(stormRunsRaw), [stormRunsRaw]);
  const sanitaryRows = useMemo(() => toSewerRunRows(sanitaryRunsRaw), [sanitaryRunsRaw]);
  const structureRows = useMemo(() => toManholeRows(extraction.manholes), [extraction.manholes]);
  const watermainPipeRows = useMemo(
    () => toWatermainPipeRows(extraction.watermain),
    [extraction.watermain]
  );
  const watermainValveRows = useMemo(
    () => toWatermainValveRows(extraction.watermainValves, extraction.watermainSpecials),
    [extraction.watermainValves, extraction.watermainSpecials]
  );

  // Computed lengths and totals
  const totalStormLength = useMemo(
    () => stormRows.reduce((sum, r) => sum + (r.length ?? 0), 0),
    [stormRows]
  );
  const totalStormCost = useMemo(
    () => stormRows.reduce((sum, r) => sum + (r.totalCost ?? 0), 0),
    [stormRows]
  );

  const totalSanitaryLength = useMemo(
    () => sanitaryRows.reduce((sum, r) => sum + (r.length ?? 0), 0),
    [sanitaryRows]
  );
  const totalSanitaryCost = useMemo(
    () => sanitaryRows.reduce((sum, r) => sum + (r.totalCost ?? 0), 0),
    [sanitaryRows]
  );

  const totalStructuresCost = useMemo(
    () => structureRows.reduce((sum, r) => sum + (r.totalCost ?? 0), 0),
    [structureRows]
  );

  const totalWatermainLength = useMemo(
    () => watermainPipeRows.reduce((sum, r) => sum + (r.length ?? 0), 0),
    [watermainPipeRows]
  );
  const totalWatermainCost = useMemo(() => {
    const pipeCost = watermainPipeRows.reduce((sum, r) => sum + (r.totalCost ?? 0), 0);
    const valveCost = watermainValveRows.reduce((sum, r) => sum + (r.totalCost ?? 0), 0);
    return pipeCost + valveCost;
  }, [watermainPipeRows, watermainValveRows]);

  const headline = useMemo(() => takeoffHeadline(extraction), [extraction]);
  const grandTotalPipeLength = totalStormLength + totalSanitaryLength + totalWatermainLength;

  const counts = useMemo(
    () => ({
      stormRuns: stormRows.length,
      sanitaryRuns: sanitaryRows.length,
      structures: structureRows.length,
      watermainRuns: watermainPipeRows.length,
      valves: watermainValveRows.length,
    }),
    [stormRows, sanitaryRows, structureRows, watermainPipeRows, watermainValveRows]
  );

  const handleDownloadXlsx = useCallback(() => {
    if (!result.xlsxBase64) return;
    setIsDownloadingXlsx(true);
    try {
      downloadBase64File(
        result.xlsxBase64,
        `takeoff_${result.projectId || 'project'}.xlsx`,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
    } finally {
      setIsDownloadingXlsx(false);
    }
  }, [result.xlsxBase64, result.projectId]);

  const handleDownloadQuote = useCallback(() => {
    if (!result.quoteBase64) return;
    setIsDownloadingQuote(true);
    try {
      downloadBase64File(
        result.quoteBase64,
        `quote_${result.projectId || 'project'}.pdf`,
        'application/pdf'
      );
    } finally {
      setIsDownloadingQuote(false);
    }
  }, [result.quoteBase64, result.projectId]);

  return (
    <div className="takeoff-studio animate-in" aria-label="Takeoff Studio Workspace">
      <TakeoffHeader
        projectId={result.projectId}
        projectName={extraction.projectName}
        extractionDate={extraction.date}
        processedAt={result.processedAt}
        onDownloadXlsx={handleDownloadXlsx}
        onDownloadQuote={handleDownloadQuote}
        onReset={onReset}
        isDownloadingXlsx={isDownloadingXlsx}
        isDownloadingQuote={isDownloadingQuote}
      />

      <TakeoffSummaryBar
        totalCost={headline.totalCost}
        totalPipeLength={grandTotalPipeLength}
        structureCount={headline.structureCount}
        valveCount={headline.appurtenanceCount}
      />

      <TakeoffTabs
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        counts={counts}
      />

      <div className="studio-view-container" role="region" aria-label="Takeoff details">
        {activeTab === 'summary' && (
          <CostLedgerView extraction={extraction} />
        )}
        {activeTab === 'storm' && (
          <StormView
            stormRuns={stormRows}
            totalStormCost={totalStormCost}
            totalStormLength={totalStormLength}
          />
        )}
        {activeTab === 'sanitary' && (
          <SanitaryView
            sanitaryRuns={sanitaryRows}
            totalSanitaryCost={totalSanitaryCost}
            totalSanitaryLength={totalSanitaryLength}
          />
        )}
        {activeTab === 'structures' && (
          <StructuresView
            manholes={structureRows}
            totalStructuresCost={totalStructuresCost}
          />
        )}
        {activeTab === 'watermain' && (
          <WatermainView
            watermainPipes={watermainPipeRows}
            watermainValves={watermainValveRows}
            totalWatermainCost={totalWatermainCost}
            totalWatermainLength={totalWatermainLength}
          />
        )}
        {activeTab === 'telemetry' && (
          <TelemetryView extraction={extraction} factsCost={result.cost ?? undefined} />
        )}
      </div>
    </div>
  );
};

export default TakeoffStudio;
