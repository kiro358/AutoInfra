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

const run = (o: Partial<TakeoffFacts['sewers'][number]>) => ({
  runLabel: '', isLineItem: false, length: null, pipeDiameter: null,
  typeClass: null, slope: null, depth: null, ...o,
});

describe('sewer run matching (endpoint label + physical-attribute fallback)', () => {
  const sewerScore = (pred: TakeoffFacts, truth: TakeoffFacts) =>
    compareFacts(pred, truth).entities.find((e) => e.kind === 'sewerRuns')!;

  it('matches a dimension-labeled pred run to an endpoint-labeled truth run by attributes', () => {
    const pred = facts({ sewers: [run({ runLabel: '45.0m-250mm PVC STM @0.5%', length: 45, pipeDiameter: 250, slope: 0.5 })] });
    const truth = facts({ sewers: [run({ runLabel: 'MH 5-MH 4', length: 45, pipeDiameter: 250, slope: 0.5 })] });
    expect(sewerScore(pred, truth).matched).toBe(1);
  });

  it('does not attr-match runs of different diameter or far-off length', () => {
    const truth = facts({ sewers: [run({ runLabel: 'MH 5-MH 4', length: 45, pipeDiameter: 250, slope: 0.5 })] });
    expect(sewerScore(facts({ sewers: [run({ runLabel: 'x', length: 45, pipeDiameter: 300, slope: 0.5 })] }), truth).matched).toBe(0);
    expect(sewerScore(facts({ sewers: [run({ runLabel: 'x', length: 80, pipeDiameter: 250, slope: 0.5 })] }), truth).matched).toBe(0);
  });

  it('still prefers exact endpoint-label matches', () => {
    const pred = facts({ sewers: [run({ runLabel: 'MH2-MH1', length: 45, pipeDiameter: 250 })] });
    const truth = facts({ sewers: [run({ runLabel: 'MH 1-MH 2', length: 45, pipeDiameter: 250 })] });
    expect(sewerScore(pred, truth).matched).toBe(1);
  });

  it('matches a shared endpoint when truth abstracts the far end (CONN) and length is close', () => {
    // truth "MH 2-CONN." (far end abstracted) vs pred "MH 2-MH 1" (far end named), same dia, ~length
    const pred = facts({ sewers: [run({ runLabel: 'MH 2-MH 1', length: 98.7, pipeDiameter: 450 })] });
    const truth = facts({ sewers: [run({ runLabel: 'MH 2-CONN.', length: 104, pipeDiameter: 450 })] });
    expect(sewerScore(pred, truth).matched).toBe(1);
  });

  it('does NOT shared-endpoint-match a different pipe out of the same structure (far length)', () => {
    const pred = facts({ sewers: [run({ runLabel: 'MH 2-MH 9', length: 8, pipeDiameter: 450 })] });
    const truth = facts({ sewers: [run({ runLabel: 'MH 2-CONN.', length: 104, pipeDiameter: 450 })] });
    expect(sewerScore(pred, truth).matched).toBe(0);
  });
});

describe('watermain matching (blank truth labels → attribute match)', () => {
  const wm = (sizeAndType: string, length: number, pipeDiameter: number) =>
    ({ sizeAndType, length, pipeDiameter, ocSc: 1.1, avgCover: 1.8 });
  const wmEntity = (pred: ReturnType<typeof facts>, truth: ReturnType<typeof facts>) =>
    compareFacts(pred, truth).entities.find((e) => e.kind === 'watermainRuns')!;
  const wmField = (pred: ReturnType<typeof facts>, truth: ReturnType<typeof facts>, field: string) =>
    compareFacts(pred, truth).fields.find((f) => f.field === field)!;

  it('matches watermain by diameter + close length when the truth size/type label is blank', () => {
    const pred = facts({ watermain: [wm('200mm FIRE PROTECTION WATERMAIN', 90, 200)] });
    const truth = facts({ watermain: [wm('200mm', 92, 200)] });
    expect(wmEntity(pred, truth).matched).toBe(1);
  });

  // A pipe read off the drawing but not measured is a FOUND pipe with a bad length.
  // Requiring length agreement to detect it scored it as missing and then dropped it
  // from field accuracy too, hiding the defect in both numbers.
  it('detects a run whose diameter is right but whose length is missing', () => {
    const pred = facts({ watermain: [wm('200mm WATER SERVICE', 0, 200)] });
    const truth = facts({ watermain: [wm('200mm', 61, 200)] });
    expect(wmEntity(pred, truth).matched).toBe(1);
  });

  it('still scores the missing length as a failed field, not a free pass', () => {
    const pred = facts({ watermain: [wm('200mm WATER SERVICE', 0, 200)] });
    const truth = facts({ watermain: [wm('200mm', 61, 200)] });
    const f = wmField(pred, truth, 'watermain.length');
    expect(f.total).toBe(1);
    expect(f.matched).toBe(0);
  });

  it('does not match across different diameters', () => {
    const pred = facts({ watermain: [wm('150mm', 61, 150)] });
    const truth = facts({ watermain: [wm('200mm', 61, 200)] });
    expect(wmEntity(pred, truth).matched).toBe(0);
  });

  it('pairs each truth row at most once when predictions share a diameter', () => {
    const pred = facts({ watermain: [wm('200mm A', 0, 200), wm('200mm B', 0, 200), wm('200mm C', 0, 200)] });
    const truth = facts({ watermain: [wm('200mm', 61, 200)] });
    const e = wmEntity(pred, truth);
    expect(e.matched).toBe(1);
    expect(e.precision).toBeCloseTo(1 / 3); // the two extra rows are over-extraction
  });

  // Phase ordering matters: the correctly-measured row must be the one that gets
  // paired, or field accuracy would be scored against an arbitrary sibling.
  it('prefers the correctly-measured row when several share a diameter', () => {
    const pred = facts({ watermain: [wm('200mm BAD', 0, 200), wm('200mm GOOD', 61, 200)] });
    const truth = facts({ watermain: [wm('200mm', 61, 200)] });
    expect(wmField(pred, truth, 'watermain.length').matched).toBe(1);
  });

  it('handles duplicate diameters in truth by pairing them one-for-one', () => {
    const pred = facts({ watermain: [wm('250mm', 110, 250), wm('250mm', 0, 250)] });
    const truth = facts({ watermain: [wm('250mm', 110, 250), wm('250mm', 88, 250)] });
    expect(wmEntity(pred, truth).matched).toBe(2);
  });
});

describe('normalizeLabel / runSignature', () => {
  it('normalizes structure labels ignoring case, spaces, punctuation, parens', () => {
    expect(normalizeLabel('CBMH 2')).toBe(normalizeLabel('cbmh-2'));
    expect(normalizeLabel('MH 1 (repl.)')).toBe('MH1');
  });
  it('treats pipe runs as endpoint sets (order-insensitive, ignores /INS & CONN)', () => {
    expect(runSignature('MH 1-MH 2')).toBe(runSignature('MH2-MH1'));
    expect(runSignature('MH 1-MH 2/INS')).toBe(runSignature('MH 1-MH 2'));
  });
  it('strips note suffixes from structure labels', () => {
    expect(normalizeLabel('MH 1/O.P.')).toBe('MH1');
    expect(normalizeLabel('MH 8/EXT.DROP')).toBe('MH8');
    expect(normalizeLabel('CBMH 1/RIP RAP')).toBe('CBMH1');
  });
  it('strips storm/sanitary system prefixes so STMH 1 matches MH 1', () => {
    expect(normalizeLabel('STMH 1')).toBe('MH1');
    expect(normalizeLabel('STMH 1')).toBe(normalizeLabel('MH 1'));
    expect(normalizeLabel('SAN MH 3')).toBe('MH3');
    expect(normalizeLabel('ST CBMH 2')).toBe('CBMH2');
    expect(normalizeLabel('STORM DICB 4')).toBe('DICB4');
  });
  it('does NOT strip storm/san from run/schedule IDs (no structure code)', () => {
    expect(normalizeLabel('ST 1')).toBe('ST1');   // storm run label, not a structure
    expect(normalizeLabel('SA 2')).toBe('SA2');   // sanitary run label
  });
  it('matches storm-prefixed run endpoints to bare ones', () => {
    expect(runSignature('STMH 5-STMH 4')).toBe(runSignature('MH 4-MH 5'));
    expect(runSignature('ST CBMH 7-STMH 3')).toBe(runSignature('CBMH 7-MH 3'));
  });
  it('handles /P.INS. and " / INS." run-note variants', () => {
    expect(runSignature('MH 3-MH 4/P.INS.')).toBe(runSignature('MH 3-MH 4'));
    expect(runSignature('MH 9-MH 10 / INS.')).toBe(runSignature('MH 9-MH 10'));
  });
  it('keeps the connection endpoint (CONN) instead of collapsing to one node', () => {
    // "MH 8-CONN." must NOT reduce to the same signature as bare "MH 8".
    expect(runSignature('MH 8-CONN.')).not.toBe(runSignature('MH 8'));
    expect(runSignature('MH 8-CONN.')).toBe(runSignature('MH8-CONN'));
    expect(runSignature('DICB 1-CONN.')).toBe(runSignature('DICB 1-PLUG'));
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

describe('compareFacts — detection F1 excludes vacuous entity kinds', () => {
  it('does not let an empty (0-truth, 0-pred) kind inflate the average', () => {
    // 1 of 2 structures matched (F1 0.5); no sewers, no watermain anywhere.
    const truth = facts({
      structures: [
        { description: 'MH 1', topElevation: null, lowInvert: null, highInvert: null, pipeOutDiameter: null, structureType: null, depth: null },
        { description: 'MH 2', topElevation: null, lowInvert: null, highInvert: null, pipeOutDiameter: null, structureType: null, depth: null },
      ],
    });
    const pred = facts({
      structures: [
        { description: 'MH 1', topElevation: null, lowInvert: null, highInvert: null, pipeOutDiameter: null, structureType: null, depth: null },
        { description: 'MH 9', topElevation: null, lowInvert: null, highInvert: null, pipeOutDiameter: null, structureType: null, depth: null },
      ],
    });
    const c = compareFacts(pred, truth);
    // Only structures are "active"; empty sewers/watermain are excluded, so the
    // score reflects structures alone (0.5), not (0.5 + 1 + 1)/3 = 0.83.
    expect(c.detectionF1).toBeCloseTo(0.5);
  });
});
