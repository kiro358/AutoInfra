import { describe, it, expect } from 'vitest';
import {
  reconcileTakeoff,
  mergeTakeoffs,
  isSpecNoteDescription,
  isNonStructureFeature,
  dropNonStructureFeatures,
  dropImplausibleCatchbasinGroups,
} from './reconcile';
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

  it('is still idempotent once the junk filters have fired', () => {
    const facts = emptyFacts({
      structures: [struct({ description: 'MH 1' }), struct({ description: 'ADJUST MH BENCHING TO SUIT' })],
      catchbasins: [{ type: 'SINGLE_CB', quantity: 249, wallThickness: null, depth: null }],
    });
    expect(reconcileTakeoff(reconcileTakeoff(facts))).toEqual(reconcileTakeoff(facts));
  });
});

describe('isSpecNoteDescription — spec notes vs structure identifiers', () => {
  it('rejects instructions that open with an imperative verb', () => {
    expect(isSpecNoteDescription('INSTALL 200mm VALVE AND BOX INCLUDING PLUG')).toBe(true);
    expect(isSpecNoteDescription('ADJUST MH BENCHING TO SUIT')).toBe(true);
    expect(isSpecNoteDescription('CONNECT INTO EXISTING 1200mmØ MANHOLE')).toBe(true);
    expect(isSpecNoteDescription('CAP INSPECTION PORT INSIDE 300mm DIA. PLASTIC LANDSCAPING VALVE BOX')).toBe(true);
  });

  // An id inside the text does not redeem an instruction — this one names MH 38A and is
  // still a note, which is why the imperative test runs before the id check.
  it('rejects an instruction even when it quotes a real structure id', () => {
    expect(isSpecNoteDescription('CORE 150mmØ PVC SAN INTO EX. SAN. MH.38A-1200mm')).toBe(true);
  });

  it('rejects directive/spec phrases anywhere in the text', () => {
    expect(isSpecNoteDescription('HYDRO POLE TO BE RELOCATED')).toBe(true);
    expect(isSpecNoteDescription('PUBLIC RIGHT-OF-WAY TO BE RESTORED TO TOWN SATISFACTION')).toBe(true);
  });

  it('rejects long prose that names no structure', () => {
    expect(isSpecNoteDescription('WATERMAIN TO CROSS BELOW DUCT BANK WITH 0.5m CLEARANCE')).toBe(true);
  });

  it('keeps plain structure identifiers', () => {
    for (const d of ['MH 12', 'CBMH 4', 'DCBMH 1', 'MH 98 A', 'EF4', 'CTRL MH', 'JF 6-3-1']) {
      expect(isSpecNoteDescription(d)).toBe(false);
    }
  });

  // These look like prose but are equipment NAMES and appear in the estimators'
  // workbooks as real structures. The filter must not reach them — that is the whole
  // reason it tests grammar rather than length alone.
  it('keeps multi-word equipment names that are real structures', () => {
    for (const d of [
      'STORMTRAP DOUBLETRAP DETENTION SYSTEM OOS',
      'GREENSTORM SWM DETENTION TANK',
      'DOGHOUSE MAINTENANCE HOLE',
      'SANITARY CONTROL MH',
      'UNDERGROUND STORAGE CHAMBERS, EZSTORM B1',
      'RELOCATED WILKINSON CISTERN',
      'BIOSWALE INLET STRUCTURE (CB6)',
    ]) {
      expect(isSpecNoteDescription(d)).toBe(false);
    }
  });

  it('leaves an empty description to other checks', () => {
    expect(isSpecNoteDescription('')).toBe(false);
  });

  it('drops spec notes through reconcileTakeoff and warns', () => {
    const r = reconcileTakeoff(
      emptyFacts({
        structures: [
          struct({ description: 'MH 1' }),
          struct({ description: 'INSTALL RODENT GRATE AT PIPE END' }),
          struct({ description: 'GREENSTORM SWM DETENTION TANK' }),
        ],
      })
    );
    expect(r.structures.map((s) => s.description).sort()).toEqual(['GREENSTORM SWM DETENTION TANK', 'MH 1']);
    expect(r.warnings.join(' ')).toContain('spec note');
  });
});

describe('isNonStructureFeature — non-structure civil features vs structure identifiers', () => {
  it('identifies bare headings surrounded by optional punctuation/whitespace', () => {
    for (const d of [
      'SANITARY',
      'STORM',
      'WATER',
      'SEWER',
      'SEWER CONNECTION',
      'WATER METER',
      'WATER VAULT',
      'GAS',
      'HYDRO',
      'ELECTRICAL',
      '(SANITARY)',
      '[STORM]',
      'STORM:',
      '  SEWER CONNECTION  ',
      'PROP. SANITARY',
      'EX. WATER',
    ]) {
      expect(isNonStructureFeature(d)).toBe(true);
    }
  });

  it('identifies elevation equations', () => {
    for (const d of [
      'MH INV=246.48',
      'INV=223.10',
      'T/G=150.20',
      'TG=150.20',
      'T/G = 150.20',
      'EX. MH 1 INV = 100.5',
    ]) {
      expect(isNonStructureFeature(d)).toBe(true);
    }
  });

  it('identifies non-structure site keywords', () => {
    for (const d of [
      'PROP. MUD MAT',
      'PROP. RETAINING WALL',
      'PROP. DEPRESSED CURB',
      'SEWER CROSSING (STM)',
      'SEWER CROSSING (SAN)',
      'PROP. SNOW STORAGE',
      'PROP. BIKE RACKS',
      '6m X 5m TRANSFORMER',
      'LIGHT POLE',
      'HYDRO POLE',
      'TREE PROTECTION',
      'SILT FENCE',
      'HANDRAIL',
      'GUARDRAIL',
      'BOLLARD',
      'CROSSING C',
    ]) {
      expect(isNonStructureFeature(d)).toBe(true);
    }
  });

  it('preserves valid structures', () => {
    for (const d of [
      'MH 1',
      'CBMH 2',
      'JELLYFISH UNIT',
      'STORMTRAP DOUBLETRAP DETENTION SYSTEM OOS',
      'DOGHOUSE MAINTENANCE HOLE',
      'C100 CHAMBER',
      'SAN MH 1',
      'DICB 5',
      'DCBMH 10',
      'CB 3',
      'OCS 1',
      'HEADWALL 1',
    ]) {
      expect(isNonStructureFeature(d)).toBe(false);
    }
  });

  it('drops non-structure features through reconcileTakeoff and warns', () => {
    const r = reconcileTakeoff(
      emptyFacts({
        structures: [
          struct({ description: 'MH 1' }),
          struct({ description: 'PROP. MUD MAT' }),
          struct({ description: 'SANITARY' }),
          struct({ description: 'MH INV=246.48' }),
          struct({ description: 'CBMH 2' }),
        ],
      })
    );
    expect(r.structures.map((s) => s.description).sort()).toEqual(['CBMH 2', 'MH 1']);
    expect(r.warnings.join(' ')).toContain('civil site feature');
  });

  it('dropNonStructureFeatures returns kept and dropped lists', () => {
    const list = [
      struct({ description: 'MH 1' }),
      struct({ description: 'PROP. RETAINING WALL' }),
      struct({ description: 'SEWER CROSSING (STM)' }),
    ];
    const res = dropNonStructureFeatures(list);
    expect(res.structures.map((s) => s.description)).toEqual(['MH 1']);
    expect(res.dropped).toEqual(['PROP. RETAINING WALL', 'SEWER CROSSING (STM)']);
  });
});

describe('dropImplausibleCatchbasinGroups — misread quantities', () => {
  const grp = (type: any, quantity: number) => ({ type, quantity, wallThickness: null, depth: null });

  it('drops a quantity far beyond what the drainage network can carry', () => {
    // The real case: 249 single CBs on a site whose whole extracted network is 16 rows.
    const r = dropImplausibleCatchbasinGroups([grp('SINGLE_CB', 249), grp('DOUBLE_CB', 2)], 16);
    expect(r.catchbasins).toEqual([grp('DOUBLE_CB', 2)]);
    expect(r.dropped).toEqual([{ type: 'SINGLE_CB', quantity: 249 }]);
  });

  it('keeps the largest genuine counts in the golden set', () => {
    // Eric Smith Way: 27 single + 4 double against a 25-row network — the highest real
    // catchbasins-to-network ratio observed, and it must survive untouched.
    const groups = [grp('SINGLE_CB', 27), grp('DOUBLE_CB', 4)];
    expect(dropImplausibleCatchbasinGroups(groups, 25).dropped).toEqual([]);
    // Panattoni: 28 double-ditch-inlets on a large network.
    expect(dropImplausibleCatchbasinGroups([grp('DOUBLE_DITCH_INLET_CB', 28)], 174).dropped).toEqual([]);
  });

  it('does not squeeze a tiny drawing (floor of 10 network rows)', () => {
    expect(dropImplausibleCatchbasinGroups([grp('SINGLE_CB', 40)], 0).dropped).toEqual([]);
    expect(dropImplausibleCatchbasinGroups([grp('SINGLE_CB', 41)], 0).dropped).toHaveLength(1);
  });

  it('drops through reconcileTakeoff and warns, without inventing a replacement count', () => {
    const r = reconcileTakeoff(
      emptyFacts({
        structures: [struct({ description: 'MH 1' })],
        sewers: [run({ runLabel: 'MH 1-MH 2', length: 10, pipeDiameter: 300 })],
        catchbasins: [grp('SINGLE_CB', 249), grp('DOUBLE_CB', 2)],
      })
    );
    expect(r.catchbasins).toEqual([grp('DOUBLE_CB', 2)]);
    expect(r.warnings.join(' ')).toContain('misread');
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

  // Two decode paths see the same physical structure but read different fields:
  // the text layer gets the label + invert, the vector/topology path gets the rim.
  // Dropping the secondary row entirely threw away a value nothing else supplied.
  it('fills fields the primary is missing from the secondary structure', () => {
    const a = emptyFacts({ structures: [struct({ description: 'MH 1', lowInvert: 97.5 })] });
    const b = emptyFacts({ structures: [struct({ description: 'MH 1', topElevation: 100.5, depth: 3.0 })] });
    const m = mergeTakeoffs(a, b);
    expect(m.structures).toHaveLength(1);
    const mh1 = m.structures[0];
    expect(mh1.lowInvert).toBe(97.5);      // primary's own read survives
    expect(mh1.topElevation).toBe(100.5);  // secondary fills the gap
    expect(mh1.depth).toBe(3.0);
  });

  it('still lets the primary win when both paths read the same field', () => {
    const a = emptyFacts({ structures: [struct({ description: 'MH 1', topElevation: 100 })] });
    const b = emptyFacts({ structures: [struct({ description: 'MH 1', topElevation: 999 })] });
    expect(mergeTakeoffs(a, b).structures[0].topElevation).toBe(100);
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

describe('stitchSewerRuns — multi-tile deduplication', () => {
  it('merges runs with matching endpoints (order-insensitive) and same diameter', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 25.0, pipeDiameter: 300, slope: 0.01 }),
        run({ runLabel: 'MH 2-MH 1', length: 24.8, pipeDiameter: 300, depth: 2.0 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(1);
    expect(r.sewers[0].runLabel).toBe('MH 1-MH 2');
    expect(r.sewers[0].length).toBe(25.0); // max length
    expect(r.sewers[0].slope).toBe(0.01);
    expect(r.sewers[0].depth).toBe(2.0);
  });

  it('merges runs with matching endpoints and preserves /INS. suffix', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 25.0, pipeDiameter: 300 }),
        run({ runLabel: 'MH 2-MH 1/INS.', length: 24.8, pipeDiameter: 300 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(1);
    expect(r.sewers[0].runLabel).toContain('/INS');
  });

  it('deduplicates attribute-level duplicates with identical diameter and length', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'CBMH 103-CBMH 104', length: 29.3, pipeDiameter: 375, slope: 0.02 }),
        run({ runLabel: 'CBMH 103-CBMH 104', length: 29.1, pipeDiameter: 375, slope: 0.02 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(1);
    expect(r.sewers[0].length).toBe(29.3); // keeps max
  });

  it('preserves distinct valid runs with different endpoints', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 30.0, pipeDiameter: 300 }),
        run({ runLabel: 'MH 2-MH 3', length: 30.5, pipeDiameter: 300 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(2);
  });

  it('keeps pipes of same size but different lengths beyond tolerance', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 30.0, pipeDiameter: 300 }),
        run({ runLabel: '50.0m-300mm STM', length: 50.0, pipeDiameter: 300 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(2);
  });

  it('collapses tile overlap duplicates with length within 2% tolerance', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: '30.0m-300mm STM', length: 30.0, pipeDiameter: 300, slope: 1.0 }),
        run({ runLabel: '29.8m-300mm STM', length: 29.8, pipeDiameter: 300, slope: 1.0 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(1);
    expect(r.sewers[0].length).toBe(30.0);
  });

  it('collapses tile overlap duplicates with length within 0.5m absolute tolerance', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: '10.0m-250mm SAN', length: 10.0, pipeDiameter: 250, typeClass: 2.35 }),
        run({ runLabel: '10.4m-250mm SAN', length: 10.4, pipeDiameter: 250, typeClass: 2.35 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(1);
    expect(r.sewers[0].length).toBe(10.4);
  });

  it('keeps runs with matching diameter and length but different slopes', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: '30.0m-300mm STM', length: 30.0, pipeDiameter: 300, slope: 0.5 }),
        run({ runLabel: '30.0m-300mm STM', length: 30.0, pipeDiameter: 300, slope: 2.0 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(2);
  });

  it('merges complementary fields from multiple tile reads', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 42.0, pipeDiameter: 300 }),
        run({ runLabel: 'MH 2-MH 1', length: 41.8, pipeDiameter: 300, typeClass: 2.35, slope: 0.01, depth: 2.5 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(1);
    expect(r.sewers[0].length).toBe(42.0);
    expect(r.sewers[0].typeClass).toBe(2.35);
    expect(r.sewers[0].slope).toBe(0.01);
    expect(r.sewers[0].depth).toBe(2.5);
  });

  it('handles system prefix variations in endpoint matching', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'STMH 10-STMH 11', length: 42.0, pipeDiameter: 300 }),
        run({ runLabel: 'MH 11-MH 10', length: 41.5, pipeDiameter: 300 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(1);
    expect(r.sewers[0].length).toBe(42.0);
  });

  it('does not merge runs with different diameters even if endpoints match', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 30.0, pipeDiameter: 300 }),
        run({ runLabel: 'MH 2-MH 1', length: 30.0, pipeDiameter: 375 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(2);
  });

  it('handles CBMH structures in endpoint matching', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'CBMH 1-CBMH 2', length: 20.0, pipeDiameter: 250 }),
        run({ runLabel: 'CBMH 2-CBMH 1', length: 19.8, pipeDiameter: 250 }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(1);
  });

  it('preserves isLineItem and lineItemType fields during stitching', () => {
    const facts = emptyFacts({
      sewers: [
        run({ runLabel: 'VIDEO INSPECTION', isLineItem: true, lineItemType: 'VIDEO', length: null, pipeDiameter: null }),
        run({ runLabel: 'LAYOUT', isLineItem: true, lineItemType: 'LAYOUT', length: null, pipeDiameter: null }),
      ],
    });
    const r = reconcileTakeoff(facts);
    expect(r.sewers).toHaveLength(2);
    expect(r.sewers.every((s) => s.isLineItem)).toBe(true);
  });
});
