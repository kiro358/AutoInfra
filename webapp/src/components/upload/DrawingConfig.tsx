'use client';

import React from 'react';
import { Badge, BadgeVariant } from '@/components/ui/Badge';
import { CpuIcon, EyeIcon, LayersIcon, RulerIcon, SparklesIcon, CheckIcon } from '@/components/ui/Icons';

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
      className={`space-y-2.5 ${className}`.trim()}
      role="radiogroup"
      aria-label="Extraction Engine Pipeline Configuration"
    >
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)]">
          Extraction Engine Pipeline
        </span>
        <span className="text-[11px] font-mono text-[var(--text-muted)]">
          {EXTRACTION_MODES.length} Modes Available
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
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
                group relative flex flex-col justify-between p-3.5 rounded-[var(--radius-md)] border text-left transition-all duration-150 cursor-pointer select-none outline-none
                ${
                  disabled
                    ? 'opacity-50 cursor-not-allowed pointer-events-none border-[var(--border-subtle)] bg-[var(--bg-surface)]'
                    : isSelected
                    ? 'border-[var(--water)] bg-[var(--bg-elevated)] ring-1 ring-[var(--water)]/40 shadow-sm'
                    : 'border-[var(--border-subtle)] bg-[var(--bg-surface)] hover:border-[var(--border-active)] hover:bg-[var(--bg-hover)]'
                }
              `.trim()}
            >
              <div className="flex items-start justify-between gap-2.5 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className={`
                      w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 border transition-colors
                      ${
                        isSelected
                          ? 'border-[var(--water-border)] bg-[var(--water-bg)]'
                          : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)] group-hover:border-[var(--border-active)]'
                      }
                    `.trim()}
                  >
                    {option.icon}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-semibold text-[var(--text-primary)] font-sans leading-tight">
                        {option.name}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge variant={option.badgeVariant} size="sm">
                    {option.badge}
                  </Badge>
                  {option.recommended && (
                    <Badge variant="storm" size="sm" dot>
                      Recommended
                    </Badge>
                  )}
                  {/* Radio Indicator */}
                  <div
                    className={`
                      w-4 h-4 rounded-full border flex items-center justify-center ml-1 transition-colors
                      ${
                        isSelected
                          ? 'border-[var(--water)] bg-[var(--water)]'
                          : 'border-[var(--border-active)] bg-transparent group-hover:border-[var(--border-strong)]'
                      }
                    `.trim()}
                    aria-hidden="true"
                  >
                    {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </div>
                </div>
              </div>

              <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed font-sans pl-9">
                {option.description}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
