import { describe, it, expect } from 'vitest';
import type { EntityAggregate, PerformanceSummary, ProjectSummary } from '@/lib/perf-summary';
import {
  ENTITY_METER_META,
  clampBarPct,
  entityMeterMeta,
  meterCountsLabel,
  meterErrorLabel,
  meterMetrics,
} from './EntityMeters';
import {
  FAIR_THRESHOLD,
  STRONG_THRESHOLD,
  classifyScore,
  entityCounts,
  isFailedRun,
  scoreTierMeta,
  varianceLabel,
} from './ProjectScoreCard';
import { filterProjects, headlineFigures } from './BenchmarkDashboard';

function entity(over: Partial<EntityAggregate> = {}): EntityAggregate {
  return {
    kind: 'sewerRuns',
    label: 'Sewer runs',
    matched: 12,
    truth: 30,
    pred: 18,
    recall: 0.4,
    precision: 0.6667,
    f1: 0.5,
    spurious: 6,
    missed: 18,
    ...over,
  };
}

function project(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    folder: '2024-114-white-oak',
    label: '24-114 White Oak',
    name: 'White Oak',
    jobCode: '24-114',
    detF1: 0.62,
    detF1Lo: null,
    detF1Hi: null,
    fieldAcc: 0.81,
    status: 'ok',
    truthSize: 44,
    structM: 8,
    structT: 14,
    runM: 10,
    runT: 20,
    repeats: 1,
    ...over,
  };
}

function summary(over: Partial<PerformanceSummary> = {}): PerformanceSummary {
  return {
    meanDetF1: 0.52,
    meanDetF1WithFailures: 0.39,
    meanFieldAcc: 0.77,
    projectsTotal: 8,
    projectsScored: 6,
    projectsFailed: 2,
    entities: [entity()],
    projects: [project()],
    scaleSplit: null,
    ...over,
  };
}

describe('entityMeterMeta', () => {
  it('gives each takeoff entity class a distinct label and accent', () => {
    const kinds = ['sewerRuns', 'structures', 'catchbasins', 'watermainRuns'];
    const tones = kinds.map((k) => entityMeterMeta(k).tone);
    expect(new Set(tones).size).toBe(kinds.length);
    expect(entityMeterMeta('structures').label).toBe('Manholes');
    expect(entityMeterMeta('watermainRuns').tone).toBe('water');
    expect(Object.keys(ENTITY_METER_META)).toEqual(kinds);
  });

  it('falls back to the aggregate label, then the raw kind, for unknown classes', () => {
    expect(entityMeterMeta('hydrants', 'Hydrants')).toEqual({ label: 'Hydrants', tone: 'muted' });
    expect(entityMeterMeta('hydrants')).toEqual({ label: 'hydrants', tone: 'muted' });
  });
});

describe('clampBarPct', () => {
  it('scales a 0..1 ratio into a 0..100 bar width', () => {
    expect(clampBarPct(0.4)).toBeCloseTo(40);
    expect(clampBarPct(0)).toBe(0);
    expect(clampBarPct(1)).toBe(100);
  });

  it('clamps out-of-range and non-numeric input instead of overflowing the track', () => {
    expect(clampBarPct(1.4)).toBe(100);
    expect(clampBarPct(-0.2)).toBe(0);
    expect(clampBarPct(null)).toBe(0);
    expect(clampBarPct(undefined)).toBe(0);
    expect(clampBarPct(Number.NaN)).toBe(0);
  });
});

describe('meterMetrics', () => {
  it('keeps recall and precision separate from the blended detF1', () => {
    const metrics = meterMetrics(entity());
    expect(metrics.map((m) => m.key)).toEqual(['recall', 'precision', 'f1']);
    expect(metrics.map((m) => m.label)).toEqual(['Recall', 'Precision', 'detF1']);
    expect(metrics[0].value).toBe(0.4);
    expect(metrics[2].value).toBe(0.5);
  });
});

describe('meterCountsLabel', () => {
  it('reports matched over truth plus the predicted count as integers', () => {
    expect(meterCountsLabel(entity())).toBe('12 / 30 found · 18 predicted');
  });
});

describe('meterErrorLabel', () => {
  it('lists only the non-zero halves of the error budget', () => {
    expect(meterErrorLabel(entity())).toBe('18 missed · 6 spurious');
    expect(meterErrorLabel(entity({ spurious: 0 }))).toBe('18 missed');
    expect(meterErrorLabel(entity({ missed: 0 }))).toBe('6 spurious');
  });

  it('returns null for a clean read so no empty footer renders', () => {
    expect(meterErrorLabel(entity({ missed: 0, spurious: 0 }))).toBeNull();
  });
});

describe('classifyScore', () => {
  it('splits Strong / Fair / Alarm at the 50% and 30% thresholds', () => {
    expect(STRONG_THRESHOLD).toBe(0.5);
    expect(FAIR_THRESHOLD).toBe(0.3);
    expect(classifyScore(0.82)).toBe('strong');
    expect(classifyScore(0.5)).toBe('strong');
    expect(classifyScore(0.49)).toBe('fair');
    expect(classifyScore(0.3)).toBe('fair');
    expect(classifyScore(0.29)).toBe('alarm');
    expect(classifyScore(0)).toBe('alarm');
  });

  it('treats an empty or missing run as an alarm regardless of the number', () => {
    expect(classifyScore(0.9, 'empty')).toBe('alarm');
    expect(classifyScore(0.9, 'missing')).toBe('alarm');
    expect(classifyScore(Number.NaN)).toBe('alarm');
  });
});

describe('scoreTierMeta', () => {
  it('maps each tier to its badge label and variant', () => {
    expect(scoreTierMeta('strong')).toEqual({ label: 'Strong', variant: 'success' });
    expect(scoreTierMeta('fair')).toEqual({ label: 'Fair', variant: 'warning' });
    expect(scoreTierMeta('alarm')).toEqual({ label: 'Alarm', variant: 'alarm' });
  });
});

describe('isFailedRun', () => {
  it('flags runs that returned nothing — a transport failure, not a bad read', () => {
    expect(isFailedRun(project({ status: 'ok' }))).toBe(false);
    expect(isFailedRun(project({ status: 'empty' }))).toBe(true);
    expect(isFailedRun(project({ status: 'missing' }))).toBe(true);
  });
});

describe('entityCounts', () => {
  it('returns matched/total chips for sewer runs and structures', () => {
    const counts = entityCounts(project());
    expect(counts.map((c) => c.key)).toEqual(['runs', 'structures']);
    expect(counts[0]).toMatchObject({ found: 10, total: 20, variant: 'storm' });
    expect(counts[1]).toMatchObject({ found: 8, total: 14, variant: 'structures' });
  });

  it('drops entity classes the truth set does not contain', () => {
    expect(entityCounts(project({ structT: 0 })).map((c) => c.key)).toEqual(['runs']);
    expect(entityCounts(project({ runT: 0, structT: 0 }))).toEqual([]);
  });
});

describe('varianceLabel', () => {
  it('is null for a single run with no confidence band', () => {
    expect(varianceLabel(project())).toBeNull();
  });

  it('reports the repeat count and the detF1 band when present', () => {
    expect(varianceLabel(project({ repeats: 3, detF1Lo: 0.401, detF1Hi: 0.523 }))).toBe(
      'mean of 3 runs · 40.1%–52.3%'
    );
    expect(varianceLabel(project({ repeats: 3 }))).toBe('mean of 3 runs');
    expect(varianceLabel(project({ detF1Lo: 0.4, detF1Hi: 0.6 }))).toBe('40.0%–60.0%');
  });
});

describe('filterProjects', () => {
  const projects = [
    project({ folder: 'a', name: 'White Oak', jobCode: '24-114', label: '24-114 White Oak' }),
    project({ folder: 'b', name: 'Woodbine', jobCode: '23-051', label: '23-051 Woodbine' }),
  ];

  it('returns everything for an empty or whitespace query', () => {
    expect(filterProjects(projects, '')).toHaveLength(2);
    expect(filterProjects(projects, '   ')).toHaveLength(2);
  });

  it('matches case-insensitively on name, job code and folder', () => {
    expect(filterProjects(projects, 'white').map((p) => p.folder)).toEqual(['a']);
    expect(filterProjects(projects, '23-051').map((p) => p.folder)).toEqual(['b']);
    expect(filterProjects(projects, 'WOODBINE').map((p) => p.folder)).toEqual(['b']);
    expect(filterProjects(projects, 'b').map((p) => p.folder)).toEqual(['b']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterProjects(projects, 'nonexistent')).toEqual([]);
  });
});

describe('headlineFigures', () => {
  it('surfaces the pessimistic detF1 alongside pass and failure counts', () => {
    const figures = headlineFigures(summary());
    expect(figures.map((f) => f.key)).toEqual(['withFailures', 'fieldAcc', 'scored', 'failed']);
    expect(figures[0].value).toBe('39.0%');
    expect(figures[1].value).toBe('77.0%');
    expect(figures[2].value).toBe('6 / 8');
    expect(figures[3].value).toBe('2');
  });

  it('raises an alarm tone only while runs are still failing', () => {
    expect(headlineFigures(summary({ projectsFailed: 2 }))[3].tone).toBe('alarm');
    expect(headlineFigures(summary({ projectsFailed: 0 }))[3].tone).toBe('strong');
  });
});
