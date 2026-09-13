'use client';

import React from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FileSpreadsheetIcon, FileTextIcon, RefreshIcon } from '@/components/ui/Icons';

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
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="results-title">
            {projectName || 'Site Servicing Takeoff'}
          </h1>
          <Badge variant="storm" size="sm" className="font-mono">
            ID: {projectId.slice(0, 10)}
          </Badge>
        </div>
        <div className="results-meta">
          <span>Processed {formattedDate}</span>
          <span className="dot-sep">•</span>
          <span>Ontario Provincial Standards (OPS)</span>
        </div>
      </div>

      <div className="results-actions">
        <Button
          variant="primary"
          icon={<FileSpreadsheetIcon size={16} />}
          onClick={onDownloadXlsx}
          loading={isDownloadingXlsx}
        >
          Download Excel (.xlsx)
        </Button>
        <Button
          variant="secondary"
          icon={<FileTextIcon size={16} />}
          onClick={onDownloadQuote}
          loading={isDownloadingQuote}
        >
          Export Quote (.pdf)
        </Button>
        <Button
          variant="outline"
          icon={<RefreshIcon size={15} />}
          onClick={onReset}
        >
          New Takeoff
        </Button>
      </div>
    </header>
  );
};

export default TakeoffHeader;
