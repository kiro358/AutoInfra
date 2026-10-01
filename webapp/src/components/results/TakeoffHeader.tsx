'use client';

import React from 'react';
import { Button } from '@/components/ui/Button';
import { CheckIcon, FileSpreadsheetIcon, FileTextIcon, RefreshIcon } from '@/components/ui/Icons';

export interface TakeoffHeaderProps {
  projectId: string;
  projectName?: string;
  extractionDate?: string;
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
  onDownloadXlsx,
  onDownloadQuote,
  onReset,
  isDownloadingXlsx,
  isDownloadingQuote,
}) => {
  const formattedDate = extractionDate
    ? new Date(extractionDate).toLocaleString('en-CA', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : new Date().toLocaleString('en-CA', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });

  return (
    <header className="results-header" aria-label="Takeoff Header">
      <div className="results-header-info">
        <span className="results-eyebrow">
          <CheckIcon size={14} strokeWidth={2.5} />
          Takeoff complete
        </span>
        <h1 className="results-title">{projectName || 'Site Servicing Takeoff'}</h1>
        <div className="results-meta">
          <span>Processed {formattedDate}</span>
          <span className="dot-sep" />
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
