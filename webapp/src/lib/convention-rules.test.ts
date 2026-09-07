import { describe, it, expect } from 'vitest';
import {
  aggregateWatermain,
  applyEstimatorConventions,
  DEFAULT_CONVENTIONS,
  normalizeStructureLabel,
} from './convention-rules';
import { TakeoffFacts } from './types';

describe('convention-rules helpers', () => {
  it('normalizes structure labels with leading zeros', () => {
    expect(normalizeStructureLabel('MH01')).toBe('MH 1');
    expect(normalizeStructureLabel('STMH 05')).toBe('STMH 5');
    expect(normalizeStructureLabel('SAN MH 003')).toBe('SAN MH 3');
    expect(normalizeStructureLabel('CB 104A')).toBe('CB 104A');
    expect(normalizeStructureLabel('DIV.MH 2')).toBe('DIV.MH 2');
  });

  it('aggregates watermain runs by diameter', () => {
    const rawWatermain = [
      { sizeAndType: '150mm PVC WATERMAIN', length: 20.0, pipeDiameter: 150, ocSc: 1.1, avgCover: 1.8 },
      { sizeAndType: '150mm PVC WATERMAIN', length: 35.5, pipeDiameter: 150, ocSc: 1.1, avgCover: 1.8 },
      { sizeAndType: '200mm PVC WATERMAIN', length: 50.0, pipeDiameter: 200, ocSc: 1.1, avgCover: 1.8 },
    ];

    const aggregated = aggregateWatermain(rawWatermain);
    expect(aggregated.length).toBe(2);

    const wm150 = aggregated.find((w) => w.pipeDiameter === 150);
    expect(wm150).toBeDefined();
    expect(wm150?.length).toBe(55.5);

    const wm200 = aggregated.find((w) => w.pipeDiameter === 200);
    expect(wm200).toBeDefined();
    expect(wm200?.length).toBe(50.0);
  });

  it('applies estimator conventions to TakeoffFacts cleanly without mutating original', () => {
    const asDrawn: TakeoffFacts = {
      projectName: 'Test Site',
      jobNumber: '123',
      date: '2026-09-01',
      structures: [
        { description: 'MH01', topElevation: 100, lowInvert: 97, highInvert: 97, pipeOutDiameter: 300, structureType: 'MH', depth: 3 },
        { description: 'STMH 02', topElevation: 100, lowInvert: 97, highInvert: 97, pipeOutDiameter: 300, structureType: 'MH', depth: 3 },
      ],
      catchbasins: [{ type: 'SINGLE_CB', quantity: 2, wallThickness: 150, depth: 1.8 }],
      sewers: [
        { runLabel: 'MH01-STMH 02', isLineItem: false, length: 45.2, pipeDiameter: 300, typeClass: null, slope: 0.5, depth: 2.5 },
      ],
      watermain: [
        { sizeAndType: '150mm PVC WATERMAIN', length: 15.0, pipeDiameter: 150, ocSc: 1.1, avgCover: 1.8 },
        { sizeAndType: '150mm PVC WATERMAIN', length: 25.0, pipeDiameter: 150, ocSc: 1.1, avgCover: 1.8 },
      ],
      watermainSpecials: [],
      watermainValves: [],
      confidence: 0.95,
      warnings: [],
    };

    const fitted = applyEstimatorConventions(asDrawn, DEFAULT_CONVENTIONS);

    // Verify original object is untouched
    expect(asDrawn.structures[0].description).toBe('MH01');
    expect(asDrawn.watermain.length).toBe(2);

    // Verify fitted output
    expect(fitted.structures[0].description).toBe('MH 1');
    expect(fitted.structures[1].description).toBe('STMH 2');
    expect(fitted.sewers[0].runLabel).toBe('MH 1-STMH 2');
    expect(fitted.watermain.length).toBe(1);
    expect(fitted.watermain[0].length).toBe(40.0);
  });
});
