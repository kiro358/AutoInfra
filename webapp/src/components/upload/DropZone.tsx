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
    <div className={`space-y-4 ${className}`.trim()}>
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

      {/* Error Alert Banner */}
      {activeError && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 p-3.5 rounded-[var(--radius-md)] border border-[var(--alarm-border)] bg-[var(--alarm-bg)] text-[var(--alarm)] transition-all animate-fadeIn"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertIcon size={16} className="shrink-0 mt-0.5" />
            <div className="text-xs font-medium leading-relaxed">
              {activeError}
            </div>
          </div>
          {localError && (
            <button
              type="button"
              onClick={() => setLocalError(null)}
              className="text-[var(--alarm)] hover:opacity-80 p-0.5 rounded transition-opacity"
              aria-label="Dismiss error"
            >
              <CloseIcon size={14} />
            </button>
          )}
        </div>
      )}

      {/* Main Drag-and-Drop Area */}
      {!selectedFile ? (
        <div
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => !disabled && !isUploading && fileInputRef.current?.click()}
          className={`
            relative flex flex-col items-center justify-center p-8 sm:p-12 rounded-[var(--radius-lg)] border-2 border-dashed text-center transition-all duration-200 cursor-pointer select-none group
            ${
              disabled || isUploading
                ? 'opacity-50 cursor-not-allowed pointer-events-none border-[var(--border-subtle)] bg-[var(--bg-surface)]'
                : isDragging
                ? 'border-[var(--water)] bg-[var(--water-bg)] shadow-[0_0_24px_rgba(0,180,216,0.15)] ring-2 ring-[var(--water)]/30 scale-[1.005]'
                : 'border-[var(--border-active)] bg-[var(--bg-surface)] hover:border-[var(--water)] hover:bg-[var(--bg-elevated)] hover:shadow-md'
            }
          `.trim()}
        >
          {/* CAD Hairline Crosshair Corner Accents */}
          <div className="absolute top-2 left-2 w-2 h-2 border-t border-l border-[var(--border-strong)] pointer-events-none opacity-40 group-hover:opacity-100 transition-opacity" />
          <div className="absolute top-2 right-2 w-2 h-2 border-t border-r border-[var(--border-strong)] pointer-events-none opacity-40 group-hover:opacity-100 transition-opacity" />
          <div className="absolute bottom-2 left-2 w-2 h-2 border-b border-l border-[var(--border-strong)] pointer-events-none opacity-40 group-hover:opacity-100 transition-opacity" />
          <div className="absolute bottom-2 right-2 w-2 h-2 border-b border-r border-[var(--border-strong)] pointer-events-none opacity-40 group-hover:opacity-100 transition-opacity" />

          {/* Upload Icon Container */}
          <div
            className={`
              w-14 h-14 rounded-[var(--radius-md)] flex items-center justify-center mb-4 border transition-transform duration-200
              ${
                isDragging
                  ? 'border-[var(--water)] bg-[var(--water-bg)] text-[var(--water)] scale-110'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] group-hover:border-[var(--water-border)] group-hover:text-[var(--water)] group-hover:-translate-y-0.5'
              }
            `.trim()}
          >
            <UploadIcon size={24} />
          </div>

          {/* Instruction Text */}
          <div className="space-y-1 max-w-sm">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] tracking-tight">
              {isDragging ? 'Drop engineering drawing PDF here' : 'Upload Civil Engineering Drawing Set'}
            </h3>
            <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
              Drag and drop your municipal servicing plan (PDF), or click to browse local files.
            </p>
          </div>

          {/* Badges / Supported Specs */}
          <div className="flex items-center gap-2 mt-4 flex-wrap justify-center">
            <Badge variant="storm" size="sm">
              Storm Sewer
            </Badge>
            <Badge variant="sanitary" size="sm">
              Sanitary Sewer
            </Badge>
            <Badge variant="water" size="sm">
              Watermain
            </Badge>
            <Badge variant="muted" size="sm">
              PDF Vector / Raster
            </Badge>
          </div>
        </div>
      ) : (
        /* Selected File Preview Card */
        <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-sm space-y-4 animate-fadeIn">
          <div className="flex items-center justify-between gap-3 p-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 border border-[var(--storm-border)] bg-[var(--storm-bg)] text-[var(--storm)]">
                <FileTextIcon size={20} />
              </div>
              <div className="min-w-0 space-y-0.5">
                <div className="text-xs font-semibold text-[var(--text-primary)] truncate font-mono">
                  {selectedFile.name}
                </div>
                <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)] font-mono">
                  <span>{formatFileSize(selectedFile.size)}</span>
                  <span>•</span>
                  <span className="text-[var(--storm)] font-sans">Ready for analysis</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRemoveFile}
                disabled={isUploading || disabled}
                className="text-[var(--text-muted)] hover:text-[var(--alarm)] hover:bg-[var(--alarm-bg)]"
                aria-label="Remove selected drawing file"
              >
                <TrashIcon size={14} className="mr-1" />
                Remove
              </Button>
            </div>
          </div>

          {/* Active Mode Summary Chip */}
          <div className="flex items-center justify-between px-1 text-xs">
            <span className="text-[var(--text-secondary)]">Pipeline Configuration:</span>
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-[var(--text-primary)]">{activeModeDetails.name}</span>
              <Badge variant={activeModeDetails.badgeVariant} size="sm">
                {activeModeDetails.badge}
              </Badge>
            </div>
          </div>

          {/* Action Trigger Button */}
          <Button
            variant="storm"
            size="lg"
            onClick={handleProcess}
            loading={isUploading}
            disabled={disabled}
            className="w-full font-semibold tracking-wide shadow-md"
          >
            {!isUploading && <SparklesIcon size={18} className="mr-2" />}
            {isUploading ? 'Extracting Linework & Quantities…' : 'Process Drawing Set'}
          </Button>
        </div>
      )}

      {/* Collapsible Advanced Configuration Drawer */}
      <div className="border border-[var(--border-subtle)] rounded-[var(--radius-md)] bg-[var(--bg-surface)] overflow-hidden">
        <button
          type="button"
          onClick={() => setShowConfig((prev) => !prev)}
          disabled={disabled || isUploading}
          aria-expanded={showConfig}
          className="w-full flex items-center justify-between px-3.5 py-2.5 text-left text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors select-none"
        >
          <div className="flex items-center gap-2">
            <SettingsIcon size={14} className="text-[var(--text-muted)]" />
            <span>Advanced Pipeline Settings</span>
            <Badge variant="muted" size="sm">
              {activeModeDetails.badge}
            </Badge>
          </div>
          {showConfig ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
        </button>

        {showConfig && (
          <div className="p-3.5 border-t border-[var(--border-subtle)] bg-[var(--bg-canvas)] animate-fadeIn">
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
  );
};
