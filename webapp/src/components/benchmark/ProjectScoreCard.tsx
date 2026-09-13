import React from 'react';
import type { ProjectSummary } from '@/lib/perf-summary';
import { Badge, BadgeVariant } from '@/components/ui/Badge';
import { AlertIcon } from '@/components/ui/Icons';
import { formatNumber, formatPercent } from '@/lib/formatters';
import { clampBarPct } from './EntityMeters';

/**
 * ProjectScoreCard — one golden-set project's facts-metric result.
 *
 * A project whose extraction returned NOTHING is called out separately rather
 * than shown as "0% accurate": that is a run/transport failure, not a bad read,
 * and averaging it in misattributes infrastructure to the model (perf-summary.ts).
 */

export type ScoreTier = 'strong' | 'fair' | 'alarm';

/** detF1 at or above this reads as a usable takeoff. */
export const STRONG_THRESHOLD = 0.5;
/** Below this the read is not worth an estimator's time. */
export const FAIR_THRESHOLD = 0.3;

/** Strong >= 50%, Fair 30-50%, Alarm < 30%. A failed run is always an alarm. */
export function classifyScore(detF1: number, status: ProjectSummary['status'] = 'ok'): ScoreTier {
  if (status !== 'ok') return 'alarm';
  if (!Number.isFinite(detF1)) return 'alarm';
  if (detF1 >= STRONG_THRESHOLD) return 'strong';
  if (detF1 >= FAIR_THRESHOLD) return 'fair';
  return 'alarm';
}

export interface ScoreTierMeta {
  label: string;
  variant: BadgeVariant;
}

export function scoreTierMeta(tier: ScoreTier): ScoreTierMeta {
  if (tier === 'strong') return { label: 'Strong', variant: 'success' };
  if (tier === 'fair') return { label: 'Fair', variant: 'warning' };
  return { label: 'Alarm', variant: 'alarm' };
}

/** True when the run produced no entities at all against a non-empty truth. */
export function isFailedRun(project: ProjectSummary): boolean {
  return project.status !== 'ok';
}

export interface EntityCount {
  key: string;
  label: string;
  found: number;
  total: number;
  variant: BadgeVariant;
}

/** The matched/total chips shown on a card, skipping entity classes truth lacks. */
export function entityCounts(project: ProjectSummary): EntityCount[] {
  const all: EntityCount[] = [
    { key: 'runs', label: 'Sewer runs', found: project.runM, total: project.runT, variant: 'storm' },
    {
      key: 'structures',
      label: 'Structures',
      found: project.structM,
      total: project.structT,
      variant: 'structures',
    },
  ];
  return all.filter((c) => c.total > 0);
}

/** "mean of 3 runs · 40.1%–52.3%" — only meaningful with a repeat band. */
export function varianceLabel(project: ProjectSummary): string | null {
  const hasBand = project.detF1Lo != null && project.detF1Hi != null;
  if (project.repeats <= 1 && !hasBand) return null;
  const runs = project.repeats > 1 ? `mean of ${formatNumber(project.repeats, 0)} runs` : null;
  const band = hasBand
    ? `${formatPercent(project.detF1Lo, 1)}–${formatPercent(project.detF1Hi, 1)}`
    : null;
  return [runs, band].filter(Boolean).join(' · ') || null;
}

export interface ProjectScoreCardProps {
  project: ProjectSummary;
  className?: string;
}

export const ProjectScoreCard: React.FC<ProjectScoreCardProps> = ({ project, className = '' }) => {
  const failed = isFailedRun(project);
  const tier = classifyScore(project.detF1, project.status);
  const tierMeta = scoreTierMeta(tier);
  const counts = entityCounts(project);
  const variance = varianceLabel(project);

  return (
    <div className={`pscore is-${tier} ${className}`.trim()}>
      <div className="pscore-head">
        <div className="pscore-ident">
          {project.jobCode && <span className="pscore-code font-mono">{project.jobCode}</span>}
          <span className="pscore-name" title={project.folder}>
            {project.name}
          </span>
        </div>
        <Badge variant={tierMeta.variant} size="sm">
          {failed ? 'No output' : `${formatPercent(project.detF1, 1)} ${tierMeta.label}`}
        </Badge>
      </div>

      <div
        className="pscore-rail"
        role="progressbar"
        aria-label={`${project.name} detection F1`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clampBarPct(project.detF1))}
      >
        <div className="pscore-fill" style={{ width: `${clampBarPct(project.detF1)}%` }} />
      </div>

      <div className="pscore-chips">
        {counts.map((c) => (
          <Badge key={c.key} variant={c.variant} size="sm" dot>
            <span className="font-mono">
              {formatNumber(c.found, 0)}/{formatNumber(c.total, 0)}
            </span>{' '}
            {c.label}
          </Badge>
        ))}
        <Badge variant="muted" size="sm">
          <span className="font-mono">{formatNumber(project.truthSize, 0)}</span> in truth
        </Badge>
        {project.fieldAcc != null && (
          <Badge variant="info" size="sm">
            <span className="font-mono">{formatPercent(project.fieldAcc, 1)}</span> fields
          </Badge>
        )}
      </div>

      {variance && <div className="pscore-note font-mono">{variance}</div>}

      {failed && (
        <div className="pscore-warn" role="note">
          <AlertIcon size={13} />
          <span>
            Extraction returned no entities — treat as a run failure, not a bad read.
          </span>
        </div>
      )}
    </div>
  );
};

export default ProjectScoreCard;
