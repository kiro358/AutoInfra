import { describe, it, expect } from 'vitest';
import { physicsWarnings, appendPhysicsWarnings } from './physics-checks';
import { TakeoffFacts, StructureFact, SewerFact } from './types';

const facts = (over: Partial<TakeoffFacts>): TakeoffFacts => ({
  projectName: 'T', jobNumber: '', date: '',
  structures: [], catchbasins: [], sewers: [], watermain: [],
  watermainSpecials: [], watermainValves: [], confidence: 1, warnings: [],
  ...over,
});
const struct = (description: string, over: Partial<StructureFact> = {}): StructureFact => ({
  description, topElevation: null, lowInvert: null, highInvert: null,
  pipeOutDiameter: null, structureType: null, depth: null, ...over,
});
const run = (runLabel: string, over: Partial<SewerFact> = {}): SewerFact => ({
  runLabel, isLineItem: false, length: 30, pipeDiameter: 300,
  typeClass: null, slope: 1, depth: null, ...over,
});

describe('physicsWarnings — consistent geometry stays silent', () => {
  it('is silent on a fully consistent takeoff', () => {
    const w = physicsWarnings(facts({
      structures: [
        struct('MH 1', { topElevation: 100, lowInvert: 97.4, highInvert: 97.55 }),
        struct('MH 2', { topElevation: 99.8, lowInvert: 97.1, highInvert: 97.25 }),
      ],
      // 1.0% over 30 m = 0.30 m drop; outlet fall is 97.4 − 97.1 = 0.30. Fits.
      sewers: [run('MH 1 - MH 2', { slope: 1, length: 30 })],
    }));
    expect(w).toEqual([]);
  });

  it('is silent on facts with no elevations at all (nothing is checkable)', () => {
    const w = physicsWarnings(facts({
      structures: [struct('MH 1'), struct('MH 2')],
      sewers: [run('MH 1 - MH 2')],
    }));
    expect(w).toEqual([]);
  });
});

describe('physicsWarnings — structure depth validity (cad DEPTH_VALIDITY)', () => {
  it('fires once when the rim is at or below the low invert', () => {
    const w = physicsWarnings(facts({
      structures: [struct('MH 1', { topElevation: 97.0, lowInvert: 97.4 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('Physics:');
    expect(w[0]).toContain('at or below its low invert');
  });

  it('fires when the derived depth is implausibly shallow', () => {
    const w = physicsWarnings(facts({
      structures: [struct('MH 1', { topElevation: 100, lowInvert: 99.7 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('outside the typical');
  });

  it('fires when the derived depth is implausibly deep', () => {
    const w = physicsWarnings(facts({
      structures: [struct('MH 1', { topElevation: 112, lowInvert: 99 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('outside the typical');
  });

  it('exempts headwalls from the shallow bound only (apron top, not grade)', () => {
    expect(physicsWarnings(facts({
      structures: [struct('HW 1', { topElevation: 100, lowInvert: 99.45 })],
    }))).toEqual([]);
    const w = physicsWarnings(facts({
      structures: [struct('HW 1', { topElevation: 99.0, lowInvert: 99.45 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('at or below its low invert');
  });

  it('fires when a high invert pokes above the rim while the low invert is sane', () => {
    const w = physicsWarnings(facts({
      structures: [struct('MH 1', { topElevation: 100, lowInvert: 97.5, highInvert: 100.4 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('above its rim');
  });

  it('cross-checks a stated depth against rim − low invert', () => {
    const w = physicsWarnings(facts({
      structures: [struct('MH 1', { topElevation: 100, lowInvert: 97, depth: 2.2 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('stated depth');
    // Within the 0.3 m band: silent.
    expect(physicsWarnings(facts({
      structures: [struct('MH 1', { topElevation: 100, lowInvert: 97, depth: 3.2 })],
    }))).toEqual([]);
  });
});

describe('physicsWarnings — drop validity (cad HYDRAULIC_DROP, at the structure)', () => {
  it('fires once when the high invert is below the low invert', () => {
    const w = physicsWarnings(facts({
      structures: [struct('MH 1', { topElevation: 102, lowInvert: 98.5, highInvert: 98.1 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('below its low invert');
  });

  it('tolerates rounding-level invert differences', () => {
    const w = physicsWarnings(facts({
      structures: [struct('MH 1', { topElevation: 102, lowInvert: 98.5, highInvert: 98.49 })],
    }));
    expect(w).toEqual([]);
  });
});

describe('physicsWarnings — slope vs invert drop ÷ length (cad HYDRAULIC_DROP, facts form)', () => {
  const mh1 = struct('MH 1', { topElevation: 100, lowInvert: 97.4, highInvert: 97.5 });
  const mh2 = struct('MH 2', { topElevation: 99.8, lowInvert: 97.1, highInvert: 97.3 });
  // A pair with a 1.50 m outlet fall (window 1.30–1.50) for the firing cases.
  const hi1 = struct('MH 1', { topElevation: 101, lowInvert: 98.5, highInvert: 98.6 });
  const hi2 = struct('MH 2', { topElevation: 99.8, lowInvert: 97.0, highInvert: 97.2 });

  it('fires when the stated slope demands far more drop than the inverts allow', () => {
    // 8% over 30 m = 2.40 m drop; the inverts allow only 1.30–1.50 m of fall.
    const w = physicsWarnings(facts({
      structures: [hi1, hi2],
      sewers: [run('MH 1 - MH 2', { slope: 8, length: 30 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('endpoint inverts allow');
  });

  it('fires when the stated slope is far too flat for the invert fall', () => {
    // 0.33% over 30 m = 0.10 m drop; the inverts fall 1.30–1.50 m.
    const w = physicsWarnings(facts({
      structures: [hi1, hi2],
      sewers: [run('MH 1 - MH 2', { slope: 0.33, length: 30 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('endpoint inverts allow');
  });

  it('credits the downstream structure’s own drop (window, not outlet fall alone)', () => {
    // Downstream MH 2 has inverts 96.6 (in) / 96.3 (out): the pipe can land
    // anywhere in between, so a 0.80 m stated drop fits (window 0.80–1.10)
    // even though the outlet-to-outlet fall is 1.10 m.
    const w = physicsWarnings(facts({
      structures: [
        struct('MH 1', { topElevation: 100, lowInvert: 97.4, highInvert: 97.5 }),
        struct('MH 2', { topElevation: 99.8, lowInvert: 96.3, highInvert: 96.6 }),
      ],
      sewers: [run('MH 1 - MH 2', { slope: 2.67, length: 30 })], // 0.80 m drop
    }));
    expect(w).toEqual([]);
  });

  it('skips runs whose endpoints, slope or inverts are missing', () => {
    const w = physicsWarnings(facts({
      structures: [mh1],
      sewers: [
        run('MH 1 - MH 9', { slope: 5 }),                    // endpoint absent
        run('17.34m-825mm STM', { slope: 5 }),               // dimension callout: no endpoints
        run('MH 1 - CONN.', { slope: 5 }),                   // connection sentinel
        run('MH 1 - MH 1', { slope: 5 }),                    // self-pair collapses to one token
      ],
    }));
    expect(w).toEqual([]);
  });

  it('skips ambiguous endpoints (two structures share the normalised label)', () => {
    // System prefixes are stripped by the normaliser, so a sanitary and a
    // storm "MH 1" collide — the endpoint is ambiguous and unresolvable.
    const w = physicsWarnings(facts({
      structures: [
        struct('SAN MH 1', { topElevation: 100, lowInvert: 97.4 }),
        struct('STMH 1', { topElevation: 100, lowInvert: 90.0 }),
        struct('MH 2', { topElevation: 99.8, lowInvert: 97.1 }),
      ],
      sewers: [run('MH 1 - MH 2', { slope: 5 })],
    }));
    expect(w).toEqual([]);
  });

  it('leaves out-of-range slopes to range validation (suspected per-mille)', () => {
    const w = physicsWarnings(facts({
      structures: [mh1, mh2],
      sewers: [run('MH 1 - MH 2', { slope: 50, length: 30 })],
    }));
    expect(w).toEqual([]);
  });
});

describe('physicsWarnings — capacity continuity (cad CAPACITY_CONTINUITY, stated-outlet form)', () => {
  it('fires when a connected pipe exceeds the stated outgoing diameter', () => {
    const w = physicsWarnings(facts({
      structures: [
        struct('MH 1', { topElevation: 100, lowInvert: 97.4, pipeOutDiameter: 300 }),
        struct('MH 2', { topElevation: 99.8, lowInvert: 97.1 }),
      ],
      sewers: [run('MH 1 - MH 2', { pipeDiameter: 375, slope: 1, length: 30 })],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('outgoing pipe');
  });

  it('is silent when connected pipes fit the stated outlet, or no outlet is stated', () => {
    expect(physicsWarnings(facts({
      structures: [
        struct('MH 1', { topElevation: 100, lowInvert: 97.4, pipeOutDiameter: 375 }),
        struct('MH 2', { topElevation: 99.8, lowInvert: 97.1 }),
      ],
      sewers: [run('MH 1 - MH 2', { pipeDiameter: 300, slope: 1, length: 30 })],
    }))).toEqual([]);
    expect(physicsWarnings(facts({
      structures: [
        struct('MH 1', { topElevation: 100, lowInvert: 97.4 }),
        struct('MH 2', { topElevation: 99.8, lowInvert: 97.1 }),
      ],
      sewers: [run('MH 1 - MH 2', { pipeDiameter: 900, slope: 1, length: 30 })],
    }))).toEqual([]);
  });
});

describe('appendPhysicsWarnings — appender contract (mirrors appendCoverageWarnings)', () => {
  const violating = () => facts({
    structures: [struct('MH 1', { topElevation: 97.0, lowInvert: 97.4 })],
    warnings: ['pre-existing note'],
  });

  it('appends without mutating the input and keeps existing warnings', () => {
    const f = violating();
    const out = appendPhysicsWarnings(f);
    expect(f.warnings).toEqual(['pre-existing note']);
    expect(out.warnings).toHaveLength(2);
    expect(out.warnings[0]).toBe('pre-existing note');
    expect(out.warnings[1]).toContain('Physics:');
    expect(out.structures).toBe(f.structures); // facts carried through untouched
  });

  it('is idempotent — a second pass adds nothing', () => {
    const once = appendPhysicsWarnings(violating());
    const twice = appendPhysicsWarnings(once);
    expect(twice).toBe(once);
  });

  it('returns the input unchanged when nothing violates', () => {
    const f = facts({ structures: [struct('MH 1', { topElevation: 100, lowInvert: 97.5 })] });
    expect(appendPhysicsWarnings(f)).toBe(f);
  });

  it('is deterministic — same facts, same list', () => {
    const f = violating();
    expect(physicsWarnings(f)).toEqual(physicsWarnings(f));
  });
});

describe('physicsWarnings — PR27: stated-depth cross-check uses the fact-layer depth rule', () => {
  it('does not flag a CB-family stated depth that includes the catchbasin sump', () => {
    // rim − low invert = 3.0; with the 0.3m sump the recorded depth is 3.3.
    // Against the plain difference that is exactly at the old band edge;
    // against the shared derivedStructureDepth rule it agrees exactly.
    const w = physicsWarnings(facts({
      structures: [struct('CBMH 1', { topElevation: 100, lowInvert: 97, depth: 3.3 })],
    }));
    expect(w.filter((x) => x.includes('stated depth'))).toEqual([]);
  });

  it('still flags a CB-family stated depth that disagrees with the sump-inclusive expectation', () => {
    const w = physicsWarnings(facts({
      structures: [struct('CBMH 1', { topElevation: 100, lowInvert: 97, depth: 4.1 })],
    }));
    expect(w.some((x) => x.includes('stated depth'))).toBe(true);
  });
});
