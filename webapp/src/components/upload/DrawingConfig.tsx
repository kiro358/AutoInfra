'use client';

import React from 'react';
import { Badge, BadgeVariant } from '@/components/ui/Badge';
import { EyeIcon, LayersIcon, RulerIcon, SparklesIcon } from '@/components/ui/Icons';

export type ExtractionMode = 'default' | 'transcribe' | 'hybrid' | 'vector';

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
    name: 'Multimodal Fact Extraction',
    badge: 'Standard',
    badgeVariant: 'storm',
    description: 'End-to-end Gemini 2.5 multimodal fact extraction with direct reasoning over civil engineering drawings.',
    icon: <SparklesIcon size={16} className="text-[var(--storm)]" />,
    recommended: true,
  },
  {
    id: 'transcribe',
    name: 'Verbatim Vision + Grammar Parser',
    badge: 'Precision',
    badgeVariant: 'sanitary',
    description: 'High-precision OCR transcription paired with deterministic municipal grammar & schedule parser.',
    icon: <EyeIcon size={16} className="text-[var(--sanitary)]" />,
  },
  {
    id: 'hybrid',
    name: 'Direct PDF Text + Transcribe Fallback',
    badge: 'Fast',
    badgeVariant: 'water',
    description: 'Direct PDF text stream extraction for vector plans with automated vision model fallback.',
    icon: <LayersIcon size={16} className="text-[var(--water)]" />,
  },
  {
    id: 'vector',
    name: 'Zero-LLM CAD Vector Geometry',
    badge: 'Deterministic',
    badgeVariant: 'structures',
    description: 'Pure mathematical linework extraction, vector stroke tracing, and native symbol matching without LLM inference.',
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
