import { describe, it, expect } from 'vitest';
import { diffEntities } from './score-manual-facts';
import { TakeoffFacts, StructureFact, SewerFact } from '../lib/types';

function facts(overrides: Partial<TakeoffFacts> = {}): TakeoffFacts {
  return {
    projectName: 'T', jobNumber: '', date: '',
    structures: [], catchbasins: [], sewers: [], watermain: [],
    watermainSpecials: [], watermainValves: [],
    confidence: 1, warnings: [],
    ...overrides,
  };
}

const run = (o: Partial<SewerFact>): SewerFact => ({
  runLabel: '', isLineItem: false, length: null, pipeDiameter: null,
  typeClass: null, slope: null, depth: null, ...o,
});

const structure = (o: Partial<StructureFact>): StructureFact => ({
  description: '', topElevation: null, lowInvert: null, highInvert: null,
  pipeOutDiameter: null, structureType: null, depth: null, ...o,
});

describe('diffEntities', () => {
  it('lists a truth structure missing from pred as MISSED and a pred-only run as EXTRA, leaving the matched run out of both', () => {
    const truth = facts({
      structures: [structure({ description: 'MH 1' })],
      sewers: [run({ runLabel: 'MH 1-MH 2', length: 20, pipeDiameter: 250 })],
    });
    const pred = facts({
      structures: [],
      sewers: [
        run({ runLabel: 'MH 1-MH 2', length: 20, pipeDiameter: 250 }),
        run({ runLabel: 'ST9', length: 5, pipeDiameter: 200 }),
      ],
    });

    const { missed, extra } = diffEntities(pred, truth);

    expect(missed).toEqual(expect.arrayContaining([expect.stringContaining('structure MH 1')]));
    expect(extra).toEqual(expect.arrayContaining([expect.stringContaining('run ST9')]));
    // The run that matched (same endpoints + attributes) must not appear in either list.
    expect(missed.some((m) => m.includes('MH 1-MH 2'))).toBe(false);
    expect(extra.some((e) => e.includes('MH 1-MH 2'))).toBe(false);
  });
});
