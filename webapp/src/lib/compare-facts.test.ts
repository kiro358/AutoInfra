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

  // Contention, not evidence. Truth A admits both predictions; truth B admits only the
  // 10.5m one. Taking the first eligible prediction gives A the 10.5m run and strands B,
  // scoring 1 — even though the predicate permits both pairs. Maximum matching finds them.
  it('does not strand a truth run whose only candidate was taken by an earlier truth run', () => {
    const pred = facts({
      sewers: [
        run({ runLabel: '10.5m-300 PVC STM', length: 10.5, pipeDiameter: 300 }),
        run({ runLabel: '11.8m-300 PVC STM', length: 11.8, pipeDiameter: 300 }),
      ],
    });
    const truth = facts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 11, pipeDiameter: 300 }), // admits both preds
        run({ runLabel: 'MH 2-MH 3', length: 10, pipeDiameter: 300 }), // admits only the 10.5m
      ],
    });
    expect(sewerScore(pred, truth).matched).toBe(2);
  });

  it('never exceeds what the predicate allows when re-seating pairs', () => {
    // Three truth runs, one admissible prediction between them: still exactly one pair.
    const pred = facts({ sewers: [run({ runLabel: 'x', length: 10, pipeDiameter: 300 })] });
    const truth = facts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 10, pipeDiameter: 300 }),
        run({ runLabel: 'MH 2-MH 3', length: 60, pipeDiameter: 300 }),
        run({ runLabel: 'MH 3-MH 4', length: 10, pipeDiameter: 200 }), // wrong diameter
      ],
    });
    const e = sewerScore(pred, truth);
    expect(e.matched).toBe(1);
    expect(e.precision).toBe(1);
  });

  it('does not break a phase-1 signature pair to gain an attribute pair', () => {
    // The signature pair (MH 1-MH 2) must survive even though that prediction is also
    // the only attribute-eligible candidate for the second truth run.
    const pred = facts({ sewers: [run({ runLabel: 'MH 1-MH 2', length: 10, pipeDiameter: 300 })] });
    const truth = facts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 10, pipeDiameter: 300 }),
        run({ runLabel: 'MH 7-MH 8', length: 10, pipeDiameter: 300 }),
      ],
    });
    const c = compareFacts(pred, truth);
    expect(c.entities.find((e) => e.kind === 'sewerRuns')!.matched).toBe(1);
    expect(c.fields.find((f) => f.field === 'sewer.length')!.matched).toBe(1);
  });

  it('pairs the closest-length prediction so fields are scored against the best read', () => {
    const pred = facts({
      sewers: [
        run({ runLabel: 'bad', length: 40.9, pipeDiameter: 300 }),
        run({ runLabel: 'good', length: 40.0, pipeDiameter: 300 }),
      ],
    });
    const truth = facts({ sewers: [run({ runLabel: 'MH 1-MH 2', length: 40, pipeDiameter: 300 })] });
    const c = compareFacts(pred, truth);
    expect(c.entities.find((e) => e.kind === 'sewerRuns')!.matched).toBe(1);
    expect(c.fields.find((f) => f.field === 'sewer.length')!.matched).toBe(1);
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

describe('structure matching (strict normalized label + manhole family fallback)', () => {
  const struct = (description: string, topElevation: number | null = null) => ({
    description,
    topElevation,
    lowInvert: null,
    highInvert: null,
    pipeOutDiameter: null,
    structureType: 'MANHOLE',
    depth: null,
  });
  const structEntity = (pred: ReturnType<typeof facts>, truth: ReturnType<typeof facts>) =>
    compareFacts(pred, truth).entities.find((e) => e.kind === 'structures')!;

  it('matches identical normalized labels in Phase 1', () => {
    const pred = facts({ structures: [struct('STMH 1'), struct('CBMH 2')] });
    const truth = facts({ structures: [struct('MH 1'), struct('CBMH 2')] });
    expect(structEntity(pred, truth).matched).toBe(2);
  });

  it('rescues CBMH vs MH prefix differences for the same numeric identifier in Phase 2', () => {
    const pred = facts({ structures: [struct('MH 5'), struct('MH 6'), struct('MH 7')] });
    const truth = facts({ structures: [struct('CBMH 5'), struct('CBMH 6'), struct('CBMH 7')] });
    expect(structEntity(pred, truth).matched).toBe(3);
  });

  it('rescues DCBMH vs CBMH / MH for the same numeric identifier', () => {
    const pred = facts({ structures: [struct('CBMH 153')] });
    const truth = facts({ structures: [struct('DCBMH 153')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  it('does NOT match structures with different numbers across families', () => {
    const pred = facts({ structures: [struct('MH 5')] });
    const truth = facts({ structures: [struct('CBMH 6')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });

  it('does NOT match non-manhole structures across families', () => {
    const pred = facts({ structures: [struct('HEADWALL 1')] });
    const truth = facts({ structures: [struct('MH 1')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });

  it('pairs each truth structure at most once', () => {
    const pred = facts({ structures: [struct('MH 5'), struct('CBMH 5')] });
    const truth = facts({ structures: [struct('CBMH 5')] });
    const e = structEntity(pred, truth);
    expect(e.matched).toBe(1);
    expect(e.predCount).toBe(2);
    expect(e.precision).toBe(0.5);
  });
});

describe('structure matching — phase 3 domain aliases (qualifiers, chambers, OGS)', () => {
  const struct = (description: string) => ({
    description,
    topElevation: null,
    lowInvert: null,
    highInvert: null,
    pipeOutDiameter: null,
    structureType: 'MANHOLE',
    depth: null,
  });
  const structEntity = (pred: ReturnType<typeof facts>, truth: ReturnType<typeof facts>) =>
    compareFacts(pred, truth).entities.find((e) => e.kind === 'structures')!;

  // ---- (1) qualifier abbreviations ----
  it('pairs qualified manholes when abbreviation matches (DIV.MH 15 <-> DIVERSION MH 15)', () => {
    const pred = facts({ structures: [struct('DIVERSION MH 15')] });
    const truth = facts({ structures: [struct('DIV.MH 15')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  it('pairs control manhole with spelled-out and system variants (SANITARY CONTROL MH <-> CTRL MH)', () => {
    const pred = facts({ structures: [struct('SANITARY CONTROL MH')] });
    const truth = facts({ structures: [struct('CTRL MH')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  it('pairs STM CONTROL MANHOLE <-> CTRL MH', () => {
    const pred = facts({ structures: [struct('STM CONTROL MANHOLE')] });
    const truth = facts({ structures: [struct('CTRL MH')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  it('pairs doghouse manhole spelled out vs note suffix (DOGHOUSE MAINTENANCE HOLE <-> MH 1A-DH)', () => {
    const pred = facts({ structures: [struct('DOGHOUSE MAINTENANCE HOLE')] });
    const truth = facts({ structures: [struct('MH 1A-DH')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  // ---- (2) SWM chamber typology ----
  it('pairs CULTEC C100HD CHAMBERS <-> C100 CHAMBER on matching model core', () => {
    const pred = facts({ structures: [struct('CULTEC C100HD CHAMBERS')] });
    const truth = facts({ structures: [struct('C100 CHAMBER')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  it('pairs ADS STORMTECH MC-3500 CHAMBER on model core (singleton)', () => {
    const pred = facts({ structures: [struct('ADS STORMTECH MC-3500 CHAMBER')] });
    const truth = facts({ structures: [struct('MC-3500 CHAMBER')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  // ---- (3) OGS product families with designations ----
  it('pairs OGS units when model designation matches exactly (JF 6-3-1 <-> JELLYFISH JF6-3-1)', () => {
    const pred = facts({ structures: [struct('JELLYFISH JF6-3-1 UNIT')] });
    const truth = facts({ structures: [struct('JF 6-3-1')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  it('pairs Stormceptor unit on model designation (STC 4000 <-> STORMCEPTOR STC4000)', () => {
    const pred = facts({ structures: [struct('STORMCEPTOR STC4000')] });
    const truth = facts({ structures: [struct('STC 4000')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  it('pairs an unambiguous OGS singleton when no conflicting designation exists', () => {
    // One OGS in truth, one generic in pred, neither carries a conflicting number
    const pred = facts({ structures: [struct('OIL GRIT SEPARATOR')] });
    const truth = facts({ structures: [struct('OGS 1')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });

  // ---- (4) THE INTEGRITY GUARD: REFUSAL CASES (the most important tests) ----
  it('REFUSES to pair when multiple truth units compete for one generic prediction (Bradford case)', () => {
    // Bradford: truth has JF 6-3-1 and JF 4-1-1; pred emits a single generic JELLYFISH UNIT.
    // Pairing would be arbitrary guessing -> MUST NOT match either.
    const pred = facts({ structures: [struct('JELLYFISH UNIT')] });
    const truth = facts({ structures: [struct('JF 6-3-1'), struct('JF 4-1-1')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });

  it('REFUSES to pair when designations CONFLICT within the same family', () => {
    const pred = facts({ structures: [struct('JELLYFISH JF4-1-1')] });
    const truth = facts({ structures: [struct('JF 6-3-1')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });

  it('preserves an ordinary sewer structure that merely mentions a treatment note', () => {
    // "MH 3/OGS/EF 06" is MH 3 (a manhole), NOT an OGS unit -> must not pair with an OGS truth row
    const pred = facts({ structures: [struct('MH 3/OGS/EF 06')] });
    const truth = facts({ structures: [struct('OGS 1')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });

  it('never breaks a phase-1 exact match to gain a phase-3 alias pair', () => {
    const pred = facts({ structures: [struct('CTRL MH'), struct('CONTROL MANHOLE')] });
    const truth = facts({ structures: [struct('CTRL MH')] });
    const e = structEntity(pred, truth);
    expect(e.matched).toBe(1);
    expect(e.predCount).toBe(2);
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

  describe('normalizeLabel — numeric identity', () => {
    it('treats zero-padded ids as the same structure', () => {
      expect(normalizeLabel('MH01')).toBe(normalizeLabel('MH 1'));
      expect(normalizeLabel('MH 02')).toBe(normalizeLabel('MH2'));
    });

    it('does NOT collapse different numbers', () => {
      expect(normalizeLabel('MH01')).not.toBe(normalizeLabel('MH 10'));
      expect(normalizeLabel('MH 1')).not.toBe(normalizeLabel('MH11'));
    });

    it('keeps alphabetic id suffixes distinct', () => {
      expect(normalizeLabel('MH 6A')).not.toBe(normalizeLabel('MH 6'));
      expect(normalizeLabel('MH06A')).toBe(normalizeLabel('MH 6A'));
    });

    it("strips brand prefixes and note suffixes on structures", () => {
      expect(normalizeLabel("Stormceptor - EF4")).toBe("EF4");
      expect(normalizeLabel("MH 1A-DH")).toBe("MH1A");
      expect(normalizeLabel("MH 8 - EXT DROP")).toBe("MH8");
      expect(normalizeLabel("MH 42 - OIL GRIT")).toBe("MH42");
      expect(normalizeLabel("MH 42 - OGS")).toBe("MH42");
    });

    it('strips estimator qualifier prefixes', () => {
      expect(normalizeLabel('DIV.MH 2')).toBe(normalizeLabel('MH2'));
      expect(normalizeLabel('CTRL MH 5')).toBe(normalizeLabel('MH 5'));
    });

    it('still strips the storm/sanitary system qualifier', () => {
      expect(normalizeLabel('STMH 1')).toBe(normalizeLabel('MH 1'));
    });

    it('leaves labels with no numeric part alone', () => {
      expect(normalizeLabel('VC')).toBe('VC');
      expect(normalizeLabel('CTRL MH')).toBe('CTRLMH');
    });
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

describe('structure matching — outfalls/headwalls, drop manholes, chamber & tank aliases', () => {
  const struct = (description: string) => ({
    description,
    topElevation: null,
    lowInvert: null,
    highInvert: null,
    pipeOutDiameter: null,
    structureType: 'MANHOLE',
    depth: null,
  });
  const structEntity = (pred: ReturnType<typeof facts>, truth: ReturnType<typeof facts>) =>
    compareFacts(pred, truth).entities.find((e) => e.kind === 'structures')!;

  // ---- (1) outfalls & headwalls ----
  it('pairs HW n with HEADWALL n (same numeric id, one headwall family)', () => {
    const pred = facts({ structures: [struct('HEADWALL 1')] });
    const truth = facts({ structures: [struct('HW 1')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });
  it('pairs the HS structure code with a spelled headwall of the same id', () => {
    const pred = facts({ structures: [struct('HEADWALL 6')] });
    const truth = facts({ structures: [struct('HS 6')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });
  it('pairs HS n against a rip-rap-noted HS n', () => {
    const pred = facts({ structures: [struct('HS 4')] });
    const truth = facts({ structures: [struct('HS 4/RIP RAP')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });
  it('pairs OCS n with the spelled OUTLET CONTROL STRUCTURE n', () => {
    const pred = facts({ structures: [struct('OUTLET CONTROL STRUCTURE 1')] });
    const truth = facts({ structures: [struct('OCS 1')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });
  it('does NOT pair headwalls with different numeric ids', () => {
    const pred = facts({ structures: [struct('HEADWALL 2')] });
    const truth = facts({ structures: [struct('HW 1')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });
  it('does NOT pair a headwall with a manhole of the same id (families stay distinct)', () => {
    const pred = facts({ structures: [struct('MH 1')] });
    const truth = facts({ structures: [struct('HW 1')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });
  it('keeps headwall matching one-to-one across several units', () => {
    const pred = facts({ structures: [struct('HEADWALL 2'), struct('HEADWALL 1')] });
    const truth = facts({ structures: [struct('HW 1'), struct('HS 2')] });
    expect(structEntity(pred, truth).matched).toBe(2);
  });
  it('never breaks a phase-1 exact headwall match to gain a family pair', () => {
    const pred = facts({ structures: [struct('HW 1'), struct('HEADWALL 1')] });
    const truth = facts({ structures: [struct('HW 1')] });
    const e = structEntity(pred, truth);
    expect(e.matched).toBe(1);
    expect(e.predCount).toBe(2);
  });

  // ---- (2) drop manhole suffixes ----
  it('strips drop/platform note suffixes from structure labels', () => {
    expect(normalizeLabel('MH 8/EXT.DROP')).toBe('MH8');
    expect(normalizeLabel('MH 8/EXT DROP')).toBe('MH8');
    expect(normalizeLabel('MH 11 - EXT.DROP')).toBe('MH11');
    expect(normalizeLabel('MH 9N / DROP')).toBe('MH9N');
    expect(normalizeLabel('MH 5/S.P.')).toBe('MH5');
    expect(normalizeLabel('MH 5 - S.P.')).toBe('MH5');
    expect(normalizeLabel('MH 6 - O.P.')).toBe('MH6');
  });
  it('pairs a drop manhole with its bare or differently-noted prediction', () => {
    const pred = facts({ structures: [struct('MH 8'), struct('MH 11'), struct('MH 9N'), struct('MH 8N/DROP')] });
    const truth = facts({
      structures: [struct('MH 8/EXT.DROP'), struct('MH 11/EXT.DROP'), struct('MH 9N / DROP'), struct('MH 8N / DROP')],
    });
    expect(structEntity(pred, truth).matched).toBe(4);
  });
  it('does NOT let a stripped drop suffix merge different manhole ids', () => {
    const pred = facts({ structures: [struct('MH 9')] });
    const truth = facts({ structures: [struct('MH 8/EXT.DROP')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });

  // ---- (3) chambers, vaults and tanks ----
  it('pairs VALVE CHAMBER n with VALVE VAULT n on the shared designation', () => {
    const pred = facts({ structures: [struct('VALVE VAULT 2'), struct('VALVE VAULT 1')] });
    const truth = facts({ structures: [struct('VALVE CHAMBER 1'), struct('VALVE CHAMBER 2')] });
    expect(structEntity(pred, truth).matched).toBe(2);
  });
  it('pairs the abbreviated INF.TANK with the spelled INFILTRATION TANK', () => {
    const pred = facts({ structures: [struct('INFILTRATION TANK')] });
    const truth = facts({ structures: [struct('INF.TANK')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });
  it('pairs numbered infiltration tanks on their designation', () => {
    const pred = facts({ structures: [struct('INFILTRATION TANK 2'), struct('INFILTRATION TANK 1')] });
    const truth = facts({ structures: [struct('INF.TANK 1'), struct('INF. TANK 2')] });
    expect(structEntity(pred, truth).matched).toBe(2);
  });
  it('pairs a service vault reported identically on both sides', () => {
    const pred = facts({ structures: [struct('SERVICE VAULT')] });
    const truth = facts({ structures: [struct('SERVICE VAULT')] });
    expect(structEntity(pred, truth).matched).toBe(1);
  });
  it('REFUSES to pair two numbered valve chambers with one generic prediction', () => {
    const pred = facts({ structures: [struct('VALVE CHAMBER')] });
    const truth = facts({ structures: [struct('VALVE CHAMBER 1'), struct('VALVE CHAMBER 2')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });
  it('REFUSES to pair two numbered infiltration tanks with one generic prediction', () => {
    const pred = facts({ structures: [struct('INFILTRATION TANK')] });
    const truth = facts({ structures: [struct('INF.TANK 1'), struct('INF.TANK 2')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });
  it('does NOT pair a valve chamber with an unrelated water meter chamber', () => {
    const pred = facts({ structures: [struct('WATER METER CHAMBER 1')] });
    const truth = facts({ structures: [struct('VALVE CHAMBER 1')] });
    expect(structEntity(pred, truth).matched).toBe(0);
  });
});
