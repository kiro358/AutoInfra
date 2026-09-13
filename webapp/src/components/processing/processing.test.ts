import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STAGES,
  TOTAL_STAGES,
  clampStage,
  formatElapsed,
  getProgressRatio,
  getStageStatus,
  resolveExtractionModeMeta,
} from './ProcessingStages';

describe('PIPELINE_STAGES', () => {
  it('defines the 4 AutoInfra takeoff pipeline stages in execution order', () => {
    expect(PIPELINE_STAGES).toHaveLength(4);
    expect(TOTAL_STAGES).toBe(4);
    expect(PIPELINE_STAGES.map((s) => s.id)).toEqual([1, 2, 3, 4]);
    expect(PIPELINE_STAGES.map((s) => s.name)).toEqual([
      'Page Location & Sheet Filtering',
      'Physical Fact Extraction',
      'Municipal Cost Rules & Snapping',
      'Spreadsheet & Quote Generation',
    ]);
  });

  it('assigns a distinct Ontario linework accent and icon to each stage', () => {
    const accents = PIPELINE_STAGES.map((s) => s.accent);
    expect(accents).toEqual(['storm', 'sanitary', 'water', 'structures']);
    expect(new Set(accents).size).toBe(PIPELINE_STAGES.length);
    for (const stage of PIPELINE_STAGES) {
      expect(stage.icon).toBeDefined();
      expect(stage.description.length).toBeGreaterThan(0);
    }
  });

  it('keeps physical extraction (stage 2) strictly ahead of costing (stage 3)', () => {
    const extraction = PIPELINE_STAGES.find((s) => s.name === 'Physical Fact Extraction');
    const costing = PIPELINE_STAGES.find((s) => s.name === 'Municipal Cost Rules & Snapping');
    expect(extraction!.id).toBeLessThan(costing!.id);
  });
});

describe('formatElapsed', () => {
  it('renders the MM:SSs technical counter', () => {
    expect(formatElapsed(0)).toBe('00:00s');
    expect(formatElapsed(14)).toBe('00:14s');
    expect(formatElapsed(59)).toBe('00:59s');
    expect(formatElapsed(60)).toBe('01:00s');
    expect(formatElapsed(75)).toBe('01:15s');
  });

  it('rolls hours up into the minutes field', () => {
    expect(formatElapsed(3600)).toBe('60:00s');
    expect(formatElapsed(3725)).toBe('62:05s');
  });

  it('truncates fractional seconds rather than rounding up', () => {
    expect(formatElapsed(14.9)).toBe('00:14s');
  });

  it('falls back to zero for negative or non-finite input', () => {
    expect(formatElapsed(-5)).toBe('00:00s');
    expect(formatElapsed(NaN)).toBe('00:00s');
    expect(formatElapsed(Infinity)).toBe('00:00s');
  });
});

describe('getStageStatus', () => {
  it('marks earlier stages complete, the current stage active, later stages pending', () => {
    expect(getStageStatus(1, 2)).toBe('complete');
    expect(getStageStatus(2, 2)).toBe('active');
    expect(getStageStatus(3, 2)).toBe('pending');
  });

  it('marks every stage complete once the pipeline runs past the last stage', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(getStageStatus(stage.id, TOTAL_STAGES + 1)).toBe('complete');
    }
  });

  it('produces exactly one active stage while running', () => {
    for (let current = 1; current <= TOTAL_STAGES; current++) {
      const active = PIPELINE_STAGES.filter((s) => getStageStatus(s.id, current) === 'active');
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(current);
    }
  });
});

describe('clampStage', () => {
  it('clamps below the first stage and above the terminal stage', () => {
    expect(clampStage(0)).toBe(1);
    expect(clampStage(-3)).toBe(1);
    expect(clampStage(99)).toBe(TOTAL_STAGES + 1);
  });

  it('passes valid stages through and rounds fractional values', () => {
    expect(clampStage(3)).toBe(3);
    expect(clampStage(2.4)).toBe(2);
    expect(clampStage(NaN)).toBe(1);
  });
});

describe('getProgressRatio', () => {
  it('reports zero progress on the first stage and full progress when finished', () => {
    expect(getProgressRatio(1)).toBe(0);
    expect(getProgressRatio(TOTAL_STAGES + 1)).toBe(1);
  });

  it('advances by one quarter per completed stage', () => {
    expect(getProgressRatio(2)).toBeCloseTo(0.25);
    expect(getProgressRatio(3)).toBeCloseTo(0.5);
    expect(getProgressRatio(4)).toBeCloseTo(0.75);
  });

  it('never exceeds 1 for out-of-range stages', () => {
    expect(getProgressRatio(100)).toBe(1);
    expect(getProgressRatio(-10)).toBe(0);
  });
});

describe('resolveExtractionModeMeta', () => {
  it('maps each known extraction engine to its linework badge variant', () => {
    expect(resolveExtractionModeMeta('default').badgeVariant).toBe('storm');
    expect(resolveExtractionModeMeta('transcribe').badgeVariant).toBe('sanitary');
    expect(resolveExtractionModeMeta('hybrid').badgeVariant).toBe('water');
    expect(resolveExtractionModeMeta('vector').badgeVariant).toBe('structures');
  });

  it('defaults to the multimodal storm chip when no mode is supplied', () => {
    expect(resolveExtractionModeMeta(undefined).label).toBe('Multimodal');
    expect(resolveExtractionModeMeta(null).badgeVariant).toBe('storm');
    expect(resolveExtractionModeMeta('').badgeVariant).toBe('storm');
  });

  it('renders an unknown backend mode as a muted chip rather than blanking out', () => {
    const meta = resolveExtractionModeMeta('experimental-x');
    expect(meta.label).toBe('experimental-x');
    expect(meta.badgeVariant).toBe('muted');
  });

  it('provides a non-empty label for every known mode', () => {
    for (const mode of ['default', 'transcribe', 'hybrid', 'vector']) {
      expect(resolveExtractionModeMeta(mode).label.length).toBeGreaterThan(0);
    }
  });
});
