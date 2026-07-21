import { describe, it, expect } from 'vitest';
import { reconcileTakeoff, mergeTakeoffs } from './reconcile';
import { TakeoffFacts, SewerFact, StructureFact } from './types';

const emptyFacts = (over: Partial<TakeoffFacts> = {}): TakeoffFacts => ({
  projectName: 'T', jobNumber: '', date: '',
  structures: [], catchbasins: [], sewers: [], watermain: [],
  watermainSpecials: [], watermainValves: [], confidence: 1, warnings: [], ...over,
});
const run = (over: Partial<SewerFact>): SewerFact => ({
  runLabel: '', isLineItem: false, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null, ...over,
});
const struct = (over: Partial<StructureFact>): StructureFact => ({
  description: '', topElevation: null, lowInvert: null, highInvert: null,
  pipeOutDiameter: null, structureType: null, depth: null, ...over,
});

describe('reconcileTakeoff', () => {
  it('kills the dual-label duplicate, keeping the endpoint-labeled run', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'STMH 10-STMH 11', length: 42.0, pipeDiameter: 300, slope: 1.0 }),
        run({ runLabel: 'ST11', length: 42.3, pipeDiameter: 300 }), // same physical pipe, schedule id
        run({ runLabel: 'ST12', length: 18.0, pipeDiameter: 250 }), // different pipe — must survive
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(2);
    expect(r.sewers.map((s) => s.runLabel)).toContain('STMH 10-STMH 11');
    expect(r.sewers.map((s) => s.runLabel)).toContain('ST12');
  });

  it('merges duplicate structures across fragments, keeping the most complete data', () => {
    const facts = emptyFacts({
      structures: [
        struct({ description: 'STMH 1', topElevation: 224.95 }),
        struct({ description: 'MH 1', lowInvert: 221.4 }),   // same structure: STMH 1 == MH 1 after normalizeLabel
        struct({ description: 'CBMH 2', topElevation: 225.1 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.structures).toHaveLength(2);
    const mh1 = r.structures.find((s) => s.description.includes('1'))!;
    expect(mh1.topElevation).toBe(224.95);
    expect(mh1.lowInvert).toBe(221.4);
  });

  it('is idempotent', () => {
    const facts = emptyFacts({ sewers: [run({ runLabel: 'MH 1-MH 2', length: 10, pipeDiameter: 200 })] });
    expect(reconcileTakeoff(reconcileTakeoff(facts))).toEqual(reconcileTakeoff(facts));
  });
});

describe('mergeTakeoffs', () => {
  it('primary wins on structure-label conflicts; union otherwise', () => {
    const a = emptyFacts({ structures: [struct({ description: 'MH 1', topElevation: 100 })] });
    const b = emptyFacts({
      structures: [struct({ description: 'MH 1', topElevation: 999 }), struct({ description: 'MH 2' })],
      sewers: [run({ runLabel: 'MH 1-MH 2', length: 20, pipeDiameter: 250 })],
    });
    const m = mergeTakeoffs(a, b);
    expect(m.structures).toHaveLength(2);
    expect(m.structures.find((s) => s.description === 'MH 1')!.topElevation).toBe(100);
    expect(m.sewers).toHaveLength(1);
  });
});
