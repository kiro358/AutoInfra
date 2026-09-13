import React from 'react';
import type { EntityAggregate } from '@/lib/perf-summary';
import { formatNumber, formatPercent } from '@/lib/formatters';

/**
 * EntityMeters — per-entity-class accuracy bars for the facts metric.
 *
 * Recall, precision and detF1 are shown as three SEPARATE bars on purpose: a
 * single blended percentage hides which half is failing, and "found 40% of the
 * manholes" vs "40% of the manholes we emitted were real" are different bugs
 * with different fixes. See perf-summary.ts / CLAUDE.md.
 */

/** Which domain accent a takeoff entity class draws in. */
export type MeterTone = 'storm' | 'sanitary' | 'water' | 'structures' | 'muted';

export interface EntityMeterMeta {
  /** Human label for the entity class. */
  label: string;
  tone: MeterTone;
}

/**
 * Entity class -> display metadata. Keys match `perf-summary.ts`'s entity kinds.
 * Catchbasins draw sanitary-amber rather than the structures-violet they share
 * with manholes on a drawing, so the four meters stay visually separable.
 */
export const ENTITY_METER_META: Record<string, EntityMeterMeta> = {
  sewerRuns: { label: 'Sewer runs', tone: 'storm' },
  structures: { label: 'Manholes', tone: 'structures' },
  catchbasins: { label: 'Catchbasins', tone: 'sanitary' },
  watermainRuns: { label: 'Watermain', tone: 'water' },
};

/** Metadata for a kind, falling back to the aggregate's own label. */
export function entityMeterMeta(kind: string, fallbackLabel?: string): EntityMeterMeta {
  const known = ENTITY_METER_META[kind];
  if (known) return known;
  return { label: fallbackLabel || kind, tone: 'muted' };
}

/** Clamp a 0..1 ratio to a 0..100 bar width, tolerating null/NaN/out-of-range. */
export function clampBarPct(ratio: number | null | undefined): number {
  if (ratio == null || Number.isNaN(ratio)) return 0;
  if (ratio <= 0) return 0;
  if (ratio >= 1) return 100;
  return ratio * 100;
}

export type MeterMetricKey = 'recall' | 'precision' | 'f1';

export interface MeterMetric {
  key: MeterMetricKey;
  label: string;
  value: number;
}

/** The three bars drawn for one entity class, in reading order. */
export function meterMetrics(entity: EntityAggregate): MeterMetric[] {
  return [
    { key: 'recall', label: 'Recall', value: entity.recall },
    { key: 'precision', label: 'Precision', value: entity.precision },
    { key: 'f1', label: 'detF1', value: entity.f1 },
  ];
}

/** "12 / 30 found · 18 predicted" — the raw counts under a meter. */
export function meterCountsLabel(entity: EntityAggregate): string {
  const n = (v: number) => formatNumber(v, 0);
  return `${n(entity.matched)} / ${n(entity.truth)} found · ${n(entity.pred)} predicted`;
}

/** "6 missed · 4 spurious" — the error budget, omitted when clean. */
export function meterErrorLabel(entity: EntityAggregate): string | null {
  const parts: string[] = [];
  if (entity.missed > 0) parts.push(`${formatNumber(entity.missed, 0)} missed`);
  if (entity.spurious > 0) parts.push(`${formatNumber(entity.spurious, 0)} spurious`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export interface EntityMetersProps {
  entities: EntityAggregate[];
  className?: string;
}

export const EntityMeters: React.FC<EntityMetersProps> = ({ entities, className = '' }) => {
  if (entities.length === 0) {
    return (
      <p className={`bench-empty ${className}`.trim()}>
        No per-entity breakdown in this result set.
      </p>
    );
  }

  return (
    <div className={`meter-list ${className}`.trim()}>
      {entities.map((entity) => {
        const meta = entityMeterMeta(entity.kind, entity.label);
        const errors = meterErrorLabel(entity);

        return (
          <div key={entity.kind} className="meter" data-tone={meta.tone}>
            <div className="meter-head">
              <span className="meter-swatch" aria-hidden="true" />
              <span className="meter-name">{meta.label}</span>
              <span className="meter-counts font-mono">{meterCountsLabel(entity)}</span>
            </div>

            <div className="meter-lines">
              {meterMetrics(entity).map((metric) => (
                <div key={metric.key} className="meter-line">
                  <span className="meter-key">{metric.label}</span>
                  <div
                    className="meter-track"
                    role="progressbar"
                    aria-label={`${meta.label} ${metric.label}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(clampBarPct(metric.value))}
                  >
                    <div
                      className={`meter-fill is-${metric.key}`}
                      style={{ width: `${clampBarPct(metric.value)}%` }}
                    />
                  </div>
                  <span className="meter-val font-mono">{formatPercent(metric.value, 1)}</span>
                </div>
              ))}
            </div>

            {errors && <div className="meter-foot font-mono">{errors}</div>}
          </div>
        );
      })}
    </div>
  );
};

export default EntityMeters;
