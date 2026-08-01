import { describe, it, expect } from 'vitest';
import { summarizePerformance, classifyRow, splitFolder, GoldenRow } from './perf-summary';

const row = (over: Partial<GoldenRow> = {}): GoldenRow => ({
  folder: '2026-001 SOME PROJECT',
  label: 'Some Project (5/8)',
  detF1: 0.5,
  structM: 3, structT: 5,
  runM: 4, runT: 8,
  fieldM: 5, fieldT: 10,
  ...over,
});

describe('splitFolder', () => {
  it('splits the job code off the folder and strips the label count suffix', () => {
    expect(splitFolder('2026-025 INDUSTRIAL DEVELOPMENT-ULTIMATE DRIVE', 'Ultimate Drive (19/29)'))
      .toEqual({ jobCode: '2026-025', name: 'Ultimate Drive' });
  });

  it('falls back to the folder name when there is no job code', () => {
    expect(splitFolder('LOOSE FOLDER', '')).toEqual({ jobCode: '', name: 'LOOSE FOLDER' });
  });
});

describe('classifyRow', () => {
  it('marks a run that found nothing against non-empty truth as a failed extraction', () => {
    expect(classifyRow(row({ detF1: 0, structM: 0, runM: 0 }))).toBe('empty');
  });

  it('does not mark a genuinely-scored low result as failed', () => {
    expect(classifyRow(row({ detF1: 0.05, structM: 0, runM: 1 }))).toBe('ok');
  });

  it('respects an explicit status', () => {
    expect(classifyRow(row({ status: 'missing' }))).toBe('missing');
  });
});

describe('summarizePerformance', () => {
  it('separates the headline mean from the mean that counts failures as zero', () => {
    const s = summarizePerformance([
      row({ folder: '2026-001 A', detF1: 0.6 }),
      row({ folder: '2026-002 B', detF1: 0.4 }),
      row({ folder: '2026-003 C', detF1: 0, structM: 0, runM: 0 }), // failed run
    ]);
    expect(s.projectsScored).toBe(2);
    expect(s.projectsFailed).toBe(1);
    expect(s.meanDetF1).toBeCloseTo(0.5);
    expect(s.meanDetF1WithFailures).toBeCloseTo(1 / 3);
  });

  it('aggregates entity precision/recall and derives missed + spurious counts', () => {
    const s = summarizePerformance([
      row({
        folder: '2026-001 A',
        entities: [{ kind: 'sewerRuns', matched: 8, truthCount: 10, predCount: 12 }],
      }),
      row({
        folder: '2026-002 B',
        entities: [{ kind: 'sewerRuns', matched: 2, truthCount: 10, predCount: 4 }],
      }),
    ]);
    const sewer = s.entities.find((e) => e.kind === 'sewerRuns')!;
    expect(sewer.matched).toBe(10);
    expect(sewer.truth).toBe(20);
    expect(sewer.pred).toBe(16);
    expect(sewer.recall).toBeCloseTo(0.5);
    expect(sewer.precision).toBeCloseTo(10 / 16);
    expect(sewer.missed).toBe(10);
    expect(sewer.spurious).toBe(6);
    expect(sewer.label).toBe('Sewer runs');
  });

  it('excludes failed extractions from the entity aggregate', () => {
    const s = summarizePerformance([
      row({ folder: '2026-001 A', entities: [{ kind: 'sewerRuns', matched: 5, truthCount: 10, predCount: 5 }] }),
      row({
        folder: '2026-002 B', detF1: 0, structM: 0, runM: 0,
        entities: [{ kind: 'sewerRuns', matched: 0, truthCount: 40, predCount: 0 }],
      }),
    ]);
    expect(s.entities.find((e) => e.kind === 'sewerRuns')!.truth).toBe(10);
  });

  it('orders entities the way a takeoff reads, not alphabetically', () => {
    const s = summarizePerformance([
      row({
        entities: [
          { kind: 'watermainRuns', matched: 0, truthCount: 3, predCount: 0 },
          { kind: 'structures', matched: 1, truthCount: 2, predCount: 2 },
          { kind: 'sewerRuns', matched: 1, truthCount: 2, predCount: 2 },
        ],
      }),
    ]);
    expect(s.entities.map((e) => e.kind)).toEqual(['sewerRuns', 'structures', 'watermainRuns']);
  });

  it('splits accuracy by drawing size at the median', () => {
    const mk = (f: string, det: number, size: number) =>
      row({ folder: f, detF1: det, entities: [{ kind: 'sewerRuns', matched: 1, truthCount: size, predCount: 1 }] });
    const s = summarizePerformance([
      mk('2026-001 A', 0.6, 5), mk('2026-002 B', 0.5, 8),
      mk('2026-003 C', 0.2, 50), mk('2026-004 D', 0.1, 90),
    ]);
    expect(s.scaleSplit).not.toBeNull();
    expect(s.scaleSplit!.smallMean).toBeGreaterThan(s.scaleSplit!.largeMean);
  });

  it('returns a null scale split when there are too few projects to compare', () => {
    expect(summarizePerformance([row(), row({ folder: '2026-002 B' })]).scaleSplit).toBeNull();
  });

  it('handles an empty result set without dividing by zero', () => {
    const s = summarizePerformance([]);
    expect(s.meanDetF1).toBe(0);
    expect(s.projectsTotal).toBe(0);
    expect(s.entities).toEqual([]);
  });
});
