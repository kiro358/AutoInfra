'use client';

import React, { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  UploadIcon,
  FileTextIcon,
  TrashIcon,
  SettingsIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  SparklesIcon,
  AlertIcon,
  CloseIcon,
} from '@/components/ui/Icons';
import { DrawingConfig, ExtractionMode, EXTRACTION_MODES } from './DrawingConfig';
import { formatFileSize } from '@/lib/formatters';

export interface DropZoneProps {
  onProcess?: (file: File, mode: ExtractionMode) => void;
  onFileSelected?: (file: File, mode: ExtractionMode) => void;
  isUploading?: boolean;
  error?: string | null;
  className?: string;
  disabled?: boolean;
}

export const DropZone: React.FC<DropZoneProps> = ({
  onProcess,
  onFileSelected,
  isUploading = false,
  error: externalError = null,
  className = '',
  disabled = false,
}) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedMode, setSelectedMode] = useState<ExtractionMode>('default');
  const [isDragging, setIsDragging] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const activeError = externalError || localError;

  const validateAndSetFile = useCallback(
    (file: File) => {
      setLocalError(null);

      const isPdf =
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf');

      if (!isPdf) {
        setLocalError('Invalid file type. Please upload an Ontario civil engineering drawing set in PDF format.');
        return false;
      }

      setSelectedFile(file);
      if (onFileSelected) {
        onFileSelected(file, selectedMode);
      }
      return true;
    },
    [onFileSelected, selectedMode]
  );

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled || isUploading) return;
    dragCounter.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled || isUploading) return;
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled || isUploading) return;
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled || isUploading) return;
    dragCounter.current = 0;
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      validateAndSetFile(file);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      validateAndSetFile(file);
    }
  };

  const handleRemoveFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedFile(null);
    setLocalError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleProcess = () => {
    if (!selectedFile || isUploading || disabled) return;
    if (onProcess) {
      onProcess(selectedFile, selectedMode);
    }
  };

  const activeModeDetails = EXTRACTION_MODES.find((m) => m.id === selectedMode) || EXTRACTION_MODES[0];

  return (
    <div className={`space-y-3 ${className}`.trim()}>
      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="hidden"
        onChange={handleFileInputChange}
        disabled={disabled || isUploading}
        tabIndex={-1}
        aria-hidden="true"
      />

      {activeError && (
        <div role="alert" className="alert alert-error animate-fadeIn text-left">
          <AlertIcon size={18} className="alert-icon shrink-0 mt-px" />
          <div className="min-w-0 flex-1">
            <div className="alert-title">
              {localError ? 'That file can’t be used' : 'We couldn’t process that drawing set'}
            </div>
            <div className="alert-body mt-0.5">{activeError}</div>
          </div>
          {localError && (
            <button
              type="button"
              onClick={() => setLocalError(null)}
              className="btn btn-ghost btn-sm btn-icon -mr-1 -mt-1"
              aria-label="Dismiss error"
            >
              <CloseIcon size={14} />
            </button>
          )}
        </div>
      )}

      <div className="card card-elevated">
        {!selectedFile ? (
          <div
            role="button"
            tabIndex={disabled || isUploading ? -1 : 0}
            aria-label="Upload a drawing set PDF"
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={() => !disabled && !isUploading && fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !disabled && !isUploading) {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className="p-2.5 outline-none group"
          >
            <div
              className={`
                relative flex flex-col items-center justify-center text-center px-6 py-12 sm:py-14
                rounded-[var(--radius-md)] border-[1.5px] border-dashed cursor-pointer select-none
                transition-all duration-200
                ${
                  disabled || isUploading
                    ? 'opacity-50 cursor-not-allowed border-line'
                    : isDragging
                    ? 'border-[var(--accent)] bg-[var(--accent-bg)]'
                    : 'border-[var(--border-active)] bg-elevated group-hover:border-[var(--accent-border)] group-hover:bg-[var(--accent-bg)] group-focus-visible:border-[var(--accent)]'
                }
              `}
            >
              <div
                className={`
                  grid place-items-center size-12 mb-4 rounded-[12px] border bg-surface shadow-[var(--shadow-sm)]
                  transition-transform duration-200
                  ${
                    isDragging
                      ? 'border-[var(--accent-border)] text-[var(--accent)] -translate-y-0.5'
                      : 'border-line text-secondary group-hover:text-[var(--accent)] group-hover:-translate-y-0.5'
                  }
                `}
              >
                <UploadIcon size={22} />
              </div>

              <h3 className="text-[15px] font-semibold text-primary">
                {isDragging ? 'Drop to upload' : 'Drop your drawing set here'}
              </h3>
              <p className="mt-1 text-[13px] text-secondary">
                or <span className="font-medium text-[var(--accent)]">browse your files</span> — PDF, vector or scanned
              </p>

              <div className="flex items-center gap-1.5 mt-5 flex-wrap justify-center">
                <Badge variant="storm" size="sm">Storm</Badge>
                <Badge variant="sanitary" size="sm">Sanitary</Badge>
                <Badge variant="water" size="sm">Watermain</Badge>
                <Badge variant="structures" size="sm">Structures</Badge>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-4 animate-fadeIn">
            <div className="flex items-center justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-line bg-elevated">
              <div className="flex items-center gap-3 min-w-0">
                <div className="grid place-items-center size-10 shrink-0 rounded-[8px] bg-[var(--alarm-bg)] text-[var(--alarm)]">
                  <FileTextIcon size={20} />
                </div>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium text-primary truncate" title={selectedFile.name}>
                    {selectedFile.name}
                  </div>
                  <div className="flex items-center gap-2 text-[12px] text-muted">
                    <span className="font-mono">{formatFileSize(selectedFile.size)}</span>
                    <span className="dot-sep" />
                    <span className="text-[var(--success)]">Ready to process</span>
                  </div>
                </div>
              </div>

              <Button
                variant="ghost"
                size="sm"
                onClick={handleRemoveFile}
                disabled={isUploading || disabled}
                icon={<TrashIcon size={14} />}
                aria-label="Remove selected drawing file"
              >
                <span className="hidden sm:inline">Remove</span>
              </Button>
            </div>

            <Button
              variant="primary"
              size="lg"
              onClick={handleProcess}
              loading={isUploading}
              disabled={disabled}
              className="w-full"
              icon={<SparklesIcon size={17} />}
            >
              {isUploading ? 'Extracting quantities…' : 'Run takeoff'}
            </Button>
          </div>
        )}

        {/* Extraction engine disclosure */}
        <div className="border-t border-line">
          <button
            type="button"
            onClick={() => setShowConfig((prev) => !prev)}
            disabled={disabled || isUploading}
            aria-expanded={showConfig}
            className="w-full flex items-center justify-between gap-3 px-5 py-3 text-left text-[13px] text-secondary hover:text-primary hover:bg-hover transition-colors"
          >
            <span className="flex items-center gap-2 min-w-0">
              <SettingsIcon size={14} className="text-muted shrink-0" />
              <span className="shrink-0">Extraction engine</span>
              <span className="text-muted truncate hidden sm:inline">· {activeModeDetails.name}</span>
            </span>
            <span className="flex items-center gap-2 shrink-0">
              <Badge variant={activeModeDetails.badgeVariant} size="sm">
                {activeModeDetails.badge}
              </Badge>
              {showConfig ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
            </span>
          </button>

          {showConfig && (
            <div className="px-5 pb-5 pt-1 animate-fadeIn">
              <DrawingConfig
                selectedMode={selectedMode}
                onModeChange={(mode) => {
                  setSelectedMode(mode);
                  if (selectedFile && onFileSelected) {
                    onFileSelected(selectedFile, mode);
                  }
                }}
                disabled={disabled || isUploading}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
