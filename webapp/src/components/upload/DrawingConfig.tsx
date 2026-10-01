'use client';

import React from 'react';
import { Badge, BadgeVariant } from '@/components/ui/Badge';
import { EyeIcon, LayersIcon, RulerIcon, SparklesIcon } from '@/components/ui/Icons';

/** `default` sends no mode, so the server uses its configured default (hybrid). */
export type ExtractionMode = 'default' | 'transcribe' | 'single-pass' | 'vector';

export interface ExtractionModeOption {
  id: ExtractionMode;
  name: string;
  badge: string;
  badgeVariant: BadgeVariant;
  description: string;
  icon: React.ReactNode;
  recommended?: boolean;
}

export const EXTRACTION_MODES: ExtractionModeOption[] = [
  {
    id: 'default',
    name: 'Automatic (hybrid)',
    badge: 'Standard',
    badgeVariant: 'storm',
    description:
      'Reads callouts exactly from the PDF text layer where it exists, and uses AI transcription for scanned or CAD-font sheets.',
    icon: <LayersIcon size={16} className="text-[var(--storm)]" />,
    recommended: true,
  },
  {
    id: 'transcribe',
    name: 'AI transcription + parser',
    badge: 'Precision',
    badgeVariant: 'sanitary',
    description:
      'AI transcribes every callout verbatim; deterministic Ontario grammar rules turn the text into quantities.',
    icon: <EyeIcon size={16} className="text-[var(--sanitary)]" />,
  },
  {
    id: 'single-pass',
    name: 'Single-pass multimodal',
    badge: 'Legacy',
    badgeVariant: 'water',
    description:
      'The original path: Gemini reads the drawing tiles and returns quantities directly in one pass.',
    icon: <SparklesIcon size={16} className="text-[var(--water)]" />,
  },
  {
    id: 'vector',
    name: 'CAD vector geometry',
    badge: 'Deterministic',
    badgeVariant: 'structures',
    description:
      'No AI calls: traces vector linework and symbols directly. Only works on vector (non-scanned) CAD exports.',
    icon: <RulerIcon size={16} className="text-[var(--structures)]" />,
  },
];

export interface DrawingConfigProps {
  selectedMode: ExtractionMode;
  onModeChange: (mode: ExtractionMode) => void;
  className?: string;
  disabled?: boolean;
}

export const DrawingConfig: React.FC<DrawingConfigProps> = ({
  selectedMode,
  onModeChange,
  className = '',
  disabled = false,
}) => {
  const handleKeyDown = (e: React.KeyboardEvent, mode: ExtractionMode) => {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onModeChange(mode);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const currentIndex = EXTRACTION_MODES.findIndex((m) => m.id === selectedMode);
      const nextIndex = (currentIndex + 1) % EXTRACTION_MODES.length;
      onModeChange(EXTRACTION_MODES[nextIndex].id);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const currentIndex = EXTRACTION_MODES.findIndex((m) => m.id === selectedMode);
      const prevIndex = (currentIndex - 1 + EXTRACTION_MODES.length) % EXTRACTION_MODES.length;
      onModeChange(EXTRACTION_MODES[prevIndex].id);
    }
  };

  return (
    <div
      className={`grid grid-cols-1 md:grid-cols-2 gap-2.5 ${className}`.trim()}
      role="radiogroup"
      aria-label="Extraction engine"
    >
      {EXTRACTION_MODES.map((option) => {
        const isSelected = selectedMode === option.id;

        return (
          <div
            key={option.id}
            role="radio"
            aria-checked={isSelected}
            tabIndex={disabled ? -1 : isSelected ? 0 : -1}
            onClick={() => !disabled && onModeChange(option.id)}
            onKeyDown={(e) => handleKeyDown(e, option.id)}
            className={`
              group relative flex gap-3 p-3.5 rounded-[var(--radius-md)] border text-left cursor-pointer select-none outline-none
              transition-all duration-150 focus-visible:shadow-[var(--ring)]
              ${
                disabled
                  ? 'opacity-50 cursor-not-allowed pointer-events-none border-line bg-surface'
                  : isSelected
                  ? 'border-[var(--accent)] bg-[var(--accent-bg)] shadow-[0_0_0_1px_var(--accent)]'
                  : 'border-line bg-surface hover:border-[var(--border-active)] hover:bg-hover'
              }
            `}
          >
            <span className="grid place-items-center size-8 shrink-0 rounded-[8px] border border-line bg-surface">
              {option.icon}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-semibold text-primary leading-tight">
                  {option.name}
                </span>
                {option.recommended && (
                  <Badge variant="accent" size="sm">
                    Recommended
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-secondary">
                {option.description}
              </p>
            </div>

            <span
              className={`
                mt-0.5 grid place-items-center size-4 shrink-0 rounded-full border transition-colors
                ${isSelected ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--border-strong)]'}
              `}
              aria-hidden="true"
            >
              {isSelected && <span className="size-1.5 rounded-full bg-white" />}
            </span>
          </div>
        );
      })}
    </div>
  );
};
