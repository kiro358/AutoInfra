'use client';

import React from 'react';
import { Button } from '@/components/ui/Button';
import { CheckIcon, FileSpreadsheetIcon, FileTextIcon, RefreshIcon } from '@/components/ui/Icons';

export interface TakeoffHeaderProps {
  projectId: string;
  projectName?: string;
  extractionDate?: string;
  processedAt?: string;
  onDownloadXlsx: () => void;
  onDownloadQuote: () => void;
  onReset: () => void;
  isDownloadingXlsx?: boolean;
  isDownloadingQuote?: boolean;
}

export const TakeoffHeader: React.FC<TakeoffHeaderProps> = ({
  projectId,
  projectName,
  extractionDate,
  processedAt,
  onDownloadXlsx,
  onDownloadQuote,
  onReset,
  isDownloadingXlsx,
  isDownloadingQuote,
}) => {
  const processed = processedAt ? new Date(processedAt) : null;
  const formattedProcessed =
    processed && !Number.isNaN(processed.getTime())
      ? processed.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })
      : null;
  // The drawing date is free text read off the title block (e.g. "APR.19th,2026"),
  // so show it verbatim rather than risk "Invalid Date" or a UTC day shift.
  const drawingDate = extractionDate?.trim() || null;

  return (
    <header className="results-header" aria-label="Takeoff Header">
      <div className="results-header-info">
        <span className="results-eyebrow">
          <CheckIcon size={14} strokeWidth={2.5} />
          Takeoff complete
        </span>
        <h1 className="results-title">{projectName || 'Site Servicing Takeoff'}</h1>
        <div className="results-meta">
          {formattedProcessed && (
            <>
              <span>Processed {formattedProcessed}</span>
              <span className="dot-sep" />
            </>
          )}
          {drawingDate && (
            <>
              <span>Drawing date {drawingDate}</span>
              <span className="dot-sep" />
            </>
          )}
          <span className="font-mono text-[12px]" title={projectId}>
            {projectId.slice(0, 10)}
          </span>
          <span className="dot-sep" />
          <span>OPSS / OPSD rates</span>
        </div>
      </div>

      <div className="results-actions">
        <Button variant="ghost" icon={<RefreshIcon size={15} />} onClick={onReset}>
          New takeoff
        </Button>
        <Button
          variant="secondary"
          icon={<FileTextIcon size={16} />}
          onClick={onDownloadQuote}
          loading={isDownloadingQuote}
        >
          Quote PDF
        </Button>
        <Button
          variant="primary"
          icon={<FileSpreadsheetIcon size={16} />}
          onClick={onDownloadXlsx}
          loading={isDownloadingXlsx}
        >
          Download Excel
        </Button>
      </div>
    </header>
  );
};

export default TakeoffHeader;
