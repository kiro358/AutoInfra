import { describe, it, expect } from 'vitest';
import { compareFacts, normalizeLabel, runSignature } from './compare-facts';
import { TakeoffFacts } from './types';

function facts(overrides: Partial<TakeoffFacts> = {}): TakeoffFacts {
  return {
    projectName: 'T', jobNumber: '', date: '',
    structures: [], catchbasins: [], sewers: [], watermain: [],
    watermainSpecials: [], watermainValves: [],
    confidence: 1, warnings: [],
    ...overrides,
  };
}

describe('normalizeLabel / runSignature', () => {
  it('normalizes structure labels ignoring case, spaces, punctuation, parens', () => {
    expect(normalizeLabel('CBMH 2')).toBe(normalizeLabel('cbmh-2'));
    expect(normalizeLabel('MH 1 (repl.)')).toBe('MH1');
  });
  it('treats pipe runs as endpoint sets (order-insensitive, ignores /INS & CONN)', () => {
    expect(runSignature('MH 1-MH 2')).toBe(runSignature('MH2-MH1'));
    expect(runSignature('MH 1-MH 2/INS')).toBe(runSignature('MH 1-MH 2'));
  });
});

describe('compareFacts — entity detection', () => {
  it('scores perfect detection as F1 = 1', () => {
    const truth = facts({
      structures: [{ description: 'MH 1', topElevation: 100, lowInvert: 97, highInvert: null, pipeOutDiameter: 300, structureType: '1', depth: 3 }],
      sewers: [{ runLabel: 'MH 1-MH 2', isLineItem: false, length: 50, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 3 }],
    });
    const c = compareFacts(truth, truth);
    expect(c.detectionF1).toBe(1);
    expect(c.fieldAccuracy).toBe(1);
  });

  it('penalizes missed and hallucinated entities via recall/precision', () => {
    const truth = facts({
      sewers: [
        { runLabel: 'MH 1-MH 2', isLineItem: false, length: 50, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 3 },
        { runLabel: 'MH 2-MH 3', isLineItem: false, length: 40, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 3 },
      ],
    });
    const pred = facts({
      sewers: [
        { runLabel: 'MH 2-MH 1', isLineItem: false, length: 50, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 3 }, // matches run 1 (order-insensitive)
        { runLabel: 'MH 9-MH 9', isLineItem: false, length: 10, pipeDiameter: 200, typeClass: 1.3, slope: 1.1, depth: 2 }, // hallucinated
      ],
    });
    const sewer = compareFacts(pred, truth).entities.find((e) => e.kind === 'sewerRuns')!;
    expect(sewer.matched).toBe(1);
    expect(sewer.recall).toBe(0.5); // found 1 of 2 truth runs
    expect(sewer.precision).toBe(0.5); // 1 of 2 predicted runs is real
  });

  it('ignores appended fee line-items when matching runs', () => {
    const truth = facts({ sewers: [{ runLabel: 'ST 1', isLineItem: false, length: 20, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 2 }] });
    const pred = facts({
      sewers: [
        { runLabel: 'ST 1', isLineItem: false, length: 20, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 2 },
        { runLabel: 'VIDEO ($25/m)', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null },
      ],
    });
    const sewer = compareFacts(pred, truth).entities.find((e) => e.kind === 'sewerRuns')!;
    expect(sewer.precision).toBe(1); // fee row excluded, so no false positive
    expect(sewer.recall).toBe(1);
  });
});

describe('compareFacts — field accuracy', () => {
  it('uses exact match for diameters and tolerance for lengths', () => {
    const truth = facts({ sewers: [{ runLabel: 'ST 1', isLineItem: false, length: 100, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 3 }] });
    const pred = facts({ sewers: [{ runLabel: 'ST 1', isLineItem: false, length: 103, pipeDiameter: 375, typeClass: 2.35, slope: 1.1, depth: 3 }] });
    const c = compareFacts(pred, truth);
    const len = c.fields.find((f) => f.field === 'sewer.length')!;
    const dia = c.fields.find((f) => f.field === 'sewer.pipeDiameter')!;
    expect(len.accuracy).toBe(1); // 103 within 5% of 100
    expect(dia.accuracy).toBe(0); // 375 != 300 exactly
  });
});
