import { describe, it, expect } from 'vitest';
import { reconcileTakeoff, mergeTakeoffs } from './reconcile';
import { TakeoffFacts, SewerFact, StructureFact, WatermainFact } from './types';

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

describe('watermain aggregation by diameter', () => {
  const wm = (pipeDiameter: number | null, length: number, over: Partial<WatermainFact> = {}): WatermainFact => ({
    sizeAndType: pipeDiameter ? `${pipeDiameter}mm` : '', length,
    pipeDiameter: pipeDiameter as number, ocSc: 1.1, avgCover: 1.8, ...over,
  });

  // Truth carries one row per SIZE with the total metres of that size, so separate
  // segments of the same pipe have to be summed or a correct read scores as noise.
  it('sums separate segments of the same size into one row', () => {
    const out = reconcileTakeoff(emptyFacts({ watermain: [wm(150, 20), wm(150, 30), wm(150, 40)] }));
    expect(out.watermain).toHaveLength(1);
    expect(out.watermain[0].pipeDiameter).toBe(150);
    expect(out.watermain[0].length).toBe(90);
  });

  it('keeps different sizes as separate rows, largest first', () => {
    const out = reconcileTakeoff(emptyFacts({ watermain: [wm(150, 104), wm(200, 195)] }));
    expect(out.watermain.map((w) => [w.pipeDiameter, w.length])).toEqual([[200, 195], [150, 104]]);
  });

  it('normalizes sizeAndType to the bare size', () => {
    const out = reconcileTakeoff(emptyFacts({
      watermain: [wm(200, 60, { sizeAndType: '200mmØ PVC DR-18 FIRELINE' })],
    }));
    expect(out.watermain[0].sizeAndType).toBe('200mm');
  });

  // The exact-duplicate dedupe must run BEFORE the sum, or one callout read from two
  // overlapping tiles doubles the metres instead of being dropped.
  it('drops an exact duplicate rather than adding it twice', () => {
    const out = reconcileTakeoff(emptyFacts({ watermain: [wm(200, 61), wm(200, 61)] }));
    expect(out.watermain).toHaveLength(1);
    expect(out.watermain[0].length).toBe(61);
  });

  it('still sums distinct lengths at the same size after that dedupe', () => {
    const out = reconcileTakeoff(emptyFacts({ watermain: [wm(200, 61), wm(200, 61), wm(200, 12)] }));
    expect(out.watermain[0].length).toBe(73);
  });

  it('passes rows without a diameter through instead of merging or dropping them', () => {
    const out = reconcileTakeoff(emptyFacts({ watermain: [wm(200, 61), wm(null, 15)] }));
    expect(out.watermain).toHaveLength(2);
    expect(out.watermain.find((w) => w.pipeDiameter == null)?.length).toBe(15);
  });

  it('carries ocSc/avgCover forward from the first row that states one', () => {
    const out = reconcileTakeoff(emptyFacts({
      watermain: [wm(200, 61, { ocSc: null as never, avgCover: null as never }), wm(200, 12)],
    }));
    expect(out.watermain[0].ocSc).toBe(1.1);
    expect(out.watermain[0].avgCover).toBe(1.8);
  });

  it('leaves an empty watermain list empty', () => {
    expect(reconcileTakeoff(emptyFacts({ watermain: [] })).watermain).toEqual([]);
  });
});

describe('cross-source dedup (schedule row vs plan callout)', () => {
  it('drops the dimension-labelled duplicate of an endpoint-labelled run', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 83.7, pipeDiameter: 375, slope: 0.02 }),
        run({ runLabel: '83.7m-375mm SAN', length: 83.7, pipeDiameter: 375, slope: 0.02 }),
        run({ runLabel: '44.8m-375mm SAN', length: 44.8, pipeDiameter: 375, slope: 0.16 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(2);
    expect(r.sewers.map((s) => s.runLabel)).toContain('MH 1-MH 2');
    expect(r.sewers.map((s) => s.runLabel)).toContain('44.8m-375mm SAN');
  });

  it('keeps two same-size pipes of genuinely different lengths', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 30.0, pipeDiameter: 300 }),
        run({ runLabel: '47.5m-300mm STM', length: 47.5, pipeDiameter: 300 }),
      ],
    });
    expect(reconcileTakeoff(facts).sewers).toHaveLength(2);
  });

  it('treats a CONN/OUTLET endpoint as an endpoint pair and kills its dimension duplicate', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 8-CONN.', length: 52.0, pipeDiameter: 250, slope: 0.01 }),
        run({ runLabel: '52.0m-250mm STM', length: 52.0, pipeDiameter: 250, slope: 0.01 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(1);
    expect(r.sewers[0].runLabel).toBe('MH 8-CONN.');
  });

  it('never dedups two dimension labels against each other at equal size and length', () => {
    // Neither is endpoint-labelled, so the kill loop must not fire. This is the
    // case that catches a LOOSENED predicate: if a dimension callout were
    // promoted to "endpoint pair" it would start killing its neighbours.
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: '47.5m-300mm STM', length: 47.5, pipeDiameter: 300 }),
        run({ runLabel: '47.5m-300mm SAN', length: 47.5, pipeDiameter: 300 }),
      ],
    });
    expect(reconcileTakeoff(facts).sewers).toHaveLength(2);
  });
});
