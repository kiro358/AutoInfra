'use client';

import React from 'react';
import { Badge, BadgeVariant } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import {
  CheckIcon,
  DollarIcon,
  FileSpreadsheetIcon,
  LayersIcon,
  RulerIcon,
  SpinnerIcon,
} from '@/components/ui/Icons';
import { formatFileSize } from '@/lib/formatters';

/* ---------- Pipeline stage definitions ---------- */

export type StageStatus = 'complete' | 'active' | 'pending';

export interface PipelineStage {
  /** 1-based stage ordinal, matches the `currentStage` prop. */
  id: number;
  /** Short title-block label. */
  name: string;
  /** One-line technical description of the work performed. */
  description: string;
  /** Ontario servicing linework accent used for the stage rail & icon. */
  accent: BadgeVariant;
  icon: React.ReactNode;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    id: 1,
    name: 'Page Location & Sheet Filtering',
    description:
      'Scanning the drawing set for servicing plan sheets and segmenting each sheet into high-resolution tiles.',
    accent: 'storm',
    icon: <LayersIcon size={15} />,
  },
  {
    id: 2,
    name: 'Physical Fact Extraction',
    description:
      'Reading sewer linework, pipe callouts, slopes, inverts and rim elevations as physical facts only.',
    accent: 'sanitary',
    icon: <RulerIcon size={15} />,
  },
  {
    id: 3,
    name: 'Municipal Cost Rules & Snapping',
    description:
      'Applying Ontario OPS costing tables, trench depth bands and deterministic pipe-to-structure snapping.',
    accent: 'water',
    icon: <DollarIcon size={15} />,
  },
  {
    id: 4,
    name: 'Spreadsheet & Quote Generation',
    description:
      'Populating the .xlsx takeoff workbook and compiling the itemized quote PDF for review.',
    accent: 'structures',
    icon: <FileSpreadsheetIcon size={15} />,
  },
];

export const TOTAL_STAGES = PIPELINE_STAGES.length;

/* ---------- Extraction mode metadata ---------- */

export interface ExtractionModeMeta {
  id: string;
  label: string;
  badgeVariant: BadgeVariant;
}

const EXTRACTION_MODE_META: Record<string, ExtractionModeMeta> = {
  default: { id: 'default', label: 'Automatic', badgeVariant: 'storm' },
  transcribe: { id: 'transcribe', label: 'Transcribe', badgeVariant: 'sanitary' },
  'single-pass': { id: 'single-pass', label: 'Single-pass', badgeVariant: 'water' },
  hybrid: { id: 'hybrid', label: 'Hybrid', badgeVariant: 'storm' },
  vector: { id: 'vector', label: 'Vector', badgeVariant: 'structures' },
};

/**
 * Resolves an extraction mode id to its display label and Ontario linework badge
 * colour. Unknown or missing ids fall back to a muted "Custom" chip so an
 * unexpected backend value never blanks out the metadata row.
 */
export function resolveExtractionModeMeta(mode?: string | null): ExtractionModeMeta {
  if (!mode) return EXTRACTION_MODE_META.default;
  const known = EXTRACTION_MODE_META[mode];
  if (known) return known;
  return { id: mode, label: mode, badgeVariant: 'muted' };
}

/* ---------- Pure helpers (unit tested) ---------- */

/**
 * Formats an elapsed duration in seconds as a `MM:SSs` technical counter
 * (e.g. `00:14s`). Hours roll up into the minutes field so long runs stay
 * readable in a fixed-width monospace slot.
 */
export function formatElapsed(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00s';
  const whole = Math.floor(totalSeconds);
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}s`;
}

/**
 * Determines the visual state of a stage given the 1-based active stage.
 * A `currentStage` greater than the last stage marks every stage complete.
 */
export function getStageStatus(stageId: number, currentStage: number): StageStatus {
  if (stageId < currentStage) return 'complete';
  if (stageId === currentStage) return 'active';
  return 'pending';
}

/** Clamps an arbitrary stage number into the 1..TOTAL_STAGES+1 range. */
export function clampStage(stage: number): number {
  if (!Number.isFinite(stage)) return 1;
  return Math.min(Math.max(Math.round(stage), 1), TOTAL_STAGES + 1);
}

/**
 * Maps the server's coarse job stage onto the 1-based timeline. The server only
 * knows "extracting" as one long step, so while extracting the timeline may
 * self-advance between stages 1 and 2 (`simulated`) but never past them — it
 * can no longer claim work is done that the server has not finished.
 */
export function stageFromServer(serverStage: string | undefined, simulated: number): number {
  switch (serverStage) {
    case 'pricing':
      return 3;
    case 'documents':
      return 4;
    case 'done':
      return TOTAL_STAGES + 1;
    case 'queued':
      return 1;
    default:
      return Math.min(Math.max(simulated, 1), 2);
  }
}

/** Completion ratio (0..1) used by the progress rail. */
export function getProgressRatio(currentStage: number): number {
  const clamped = clampStage(currentStage);
  return Math.min((clamped - 1) / TOTAL_STAGES, 1);
}

/* ---------- Component ---------- */

export interface ProcessingStagesProps {
  /** Name of the drawing set currently being processed. */
  fileName: string;
  /** Size in bytes; rendered as a human readable chip when provided. */
  fileSize?: number;
  /** Extraction engine id (`default` | `transcribe` | `hybrid` | `vector`). */
  extractionMode?: string;
  /**
   * 1-based active stage. When omitted the component self-advances so it can be
   * used as a standalone indeterminate progress animation.
   */
  currentStage?: number;
  /** Real job stage from GET /api/jobs/[id]; takes precedence over simulation. */
  serverStage?: string;
  /** Milliseconds each simulated stage occupies when `currentStage` is omitted. */
  simulatedStageMs?: number;
  className?: string;
}

export const ProcessingStages: React.FC<ProcessingStagesProps> = ({
  fileName,
  fileSize,
  extractionMode,
  currentStage,
  serverStage,
  simulatedStageMs = 20000,
  className = '',
}) => {
  const isControlled = currentStage != null;

  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const [simulatedStage, setSimulatedStage] = React.useState(1);

  // Live elapsed counter. One interval drives the `MM:SSs` readout.
  React.useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Uncontrolled mode: walk forward through the pipeline and hold on the last
  // stage until the parent unmounts the component.
  React.useEffect(() => {
    if (isControlled) return;
    const timer = setInterval(() => {
      setSimulatedStage((prev) => (prev >= TOTAL_STAGES ? TOTAL_STAGES : prev + 1));
    }, simulatedStageMs);
    return () => clearInterval(timer);
  }, [isControlled, simulatedStageMs]);

  const activeStage = clampStage(
    isControlled
      ? (currentStage as number)
      : serverStage
      ? stageFromServer(serverStage, simulatedStage)
      : simulatedStage
  );
  const modeMeta = resolveExtractionModeMeta(extractionMode);
  const progressPct = Math.round(getProgressRatio(activeStage) * 100);
  const completedCount = Math.min(activeStage - 1, TOTAL_STAGES);
  const runningStage = PIPELINE_STAGES.find((s) => s.id === activeStage);

  return (
    <Card
      variant="elevated"
      className={`proc-card ${className}`.trim()}
      title="Running takeoff"
      headerBadge={
        <Badge variant="accent" size="sm" dot>
          In progress
        </Badge>
      }
      action={
        <span className="proc-elapsed font-mono" aria-label="Elapsed processing time">
          {formatElapsed(elapsedSeconds)}
        </span>
      }
    >
      {/* File metadata summary chip row */}
      <div className="proc-meta">
        <span className="proc-meta-file font-mono" title={fileName}>
          {fileName}
        </span>
        {fileSize != null && (
          <span className="proc-meta-sep font-mono">{formatFileSize(fileSize)}</span>
        )}
        <Badge variant={modeMeta.badgeVariant} size="sm">
          {modeMeta.label}
        </Badge>
        <span className="proc-meta-sep font-mono">
          {completedCount}/{TOTAL_STAGES} steps done
        </span>
      </div>

      <div className="proc-layout">
        {/* CAD radar / reticle scanning animation */}
        <div className="proc-radar cad-grid-dense" aria-hidden="true">
          <svg viewBox="0 0 120 120" className="proc-radar-svg">
            <defs>
              <linearGradient id="proc-sweep" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--water)" stopOpacity="0.55" />
                <stop offset="100%" stopColor="var(--water)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <circle className="proc-radar-ring" cx="60" cy="60" r="52" />
            <circle className="proc-radar-ring" cx="60" cy="60" r="34" />
            <circle className="proc-radar-ring" cx="60" cy="60" r="16" />
            <line className="proc-radar-cross" x1="60" y1="4" x2="60" y2="116" />
            <line className="proc-radar-cross" x1="4" y1="60" x2="116" y2="60" />
            <g className="proc-radar-sweep">
              <path d="M60 60 L112 60 A52 52 0 0 0 96 23 Z" fill="url(#proc-sweep)" />
              <line className="proc-radar-beam" x1="60" y1="60" x2="112" y2="60" />
            </g>
            <circle className="proc-radar-core" cx="60" cy="60" r="3.5" />
          </svg>
          <span className="proc-radar-caption font-mono">SCANNING</span>
        </div>

        {/* Animated stage timeline */}
        <ol className="proc-timeline" role="list">
          {PIPELINE_STAGES.map((stage) => {
            const status = getStageStatus(stage.id, activeStage);
            return (
              <li
                key={stage.id}
                className={`proc-stage is-${status} is-${stage.accent}`}
                aria-current={status === 'active' ? 'step' : undefined}
              >
                <div className="proc-stage-rail" aria-hidden="true">
                  <span className="proc-stage-node">
                    {status === 'complete' ? (
                      <CheckIcon size={13} strokeWidth={3} />
                    ) : status === 'active' ? (
                      <SpinnerIcon size={13} className="animate-spin" />
                    ) : (
                      <span className="proc-stage-dot" />
                    )}
                  </span>
                  {stage.id < TOTAL_STAGES && <span className="proc-stage-line" />}
                </div>

                <div className="proc-stage-body">
                  <div className="proc-stage-head">
                    <span className="proc-stage-icon" aria-hidden="true">
                      {stage.icon}
                    </span>
                    <span className="proc-stage-name font-condensed">{stage.name}</span>
                    {status === 'active' && (
                      <Badge variant="accent" size="sm" dot>
                        Working
                      </Badge>
                    )}
                  </div>
                  <p className="proc-stage-desc">{stage.description}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Determinate progress rail */}
      <div className="proc-progress">
        <div
          className="proc-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPct}
          aria-label="Takeoff pipeline progress"
        >
          <div className="proc-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="proc-progress-pct font-mono">{progressPct}%</span>
      </div>

      <p className="proc-status font-mono" role="status" aria-live="polite">
        {serverStage === 'queued'
          ? 'Waiting for a free worker — another takeoff is running…'
          : runningStage
          ? `Step ${activeStage} of ${TOTAL_STAGES} — ${runningStage.name}`
          : `Finishing up — ${TOTAL_STAGES}/${TOTAL_STAGES} steps complete`}
      </p>
    </Card>
  );
};

export default ProcessingStages;
