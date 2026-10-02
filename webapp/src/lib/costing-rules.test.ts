import { describe, it, expect } from 'vitest';
import { priceTakeoff, determineTemplateType, DEFAULT_COSTING } from './costing-rules';
import { TakeoffFacts } from './types';

function emptyFacts(overrides: Partial<TakeoffFacts> = {}): TakeoffFacts {
  return {
    projectName: 'Test',
    jobNumber: '2026-001',
    date: '2026-06-26',
    structures: [],
    catchbasins: [],
    sewers: [],
    watermain: [],
    watermainSpecials: [],
    watermainValves: [],
    confidence: 0.9,
    warnings: [],
    ...overrides,
  };
}

describe('determineTemplateType', () => {
  // SHORT capacities come from constants.ts::TEMPLATE_LAYOUT (asserted against the real
  // template in spreadsheet.test.ts): 38 run rows (14..51; 52-54 are its fee rows),
  // 36 structures (11..46), 6 watermain runs (13..18).
  it('selects LONG when sewer run rows exceed SHORT capacity (38)', () => {
    expect(determineTemplateType(38)).toBe('SHORT');
    expect(determineTemplateType(39)).toBe('LONG');
  });
  it('selects LONG when structures or watermain runs exceed SHORT capacity', () => {
    expect(determineTemplateType(5, 36, 6)).toBe('SHORT');
    expect(determineTemplateType(5, 37, 0)).toBe('LONG');
    expect(determineTemplateType(5, 0, 7)).toBe('LONG');
  });
  it('does not count the standard fee rows against SHORT run capacity', () => {
    const sewers = Array.from({ length: 38 }, (_, i) => ({
      runLabel: `MH${i}-MH${i + 1}`, isLineItem: false, length: 1, pipeDiameter: 300, typeClass: null, slope: null, depth: null,
    }));
    expect(priceTakeoff(emptyFacts({ sewers })).templateType).toBe('SHORT');
  });
});

describe('priceTakeoff — structures', () => {
  it('applies the CBMH / DCBMH material surcharges from the rule table', () => {
    const out = priceTakeoff(
      emptyFacts({
        structures: [
          { description: 'CBMH 1', topElevation: null, lowInvert: null, highInvert: null, pipeOutDiameter: null, structureType: null, depth: null },
          { description: 'DCBMH 2', topElevation: null, lowInvert: null, highInvert: null, pipeOutDiameter: null, structureType: null, depth: null },
        ],
      })
    );
    expect(out.manholes[0].addMaterials).toBe(900);
    expect(out.manholes[1].addMaterials).toBe(1800);
    // DCBMH gets a fixed 1500mm barrel; CBMH with no pipe defaults to 1200mm
    expect(out.manholes[1].diameter).toBe(1500);
    expect(out.manholes[0].diameter).toBe(1200);
  });

  it('charges drop structures material AND labor', () => {
    const out = priceTakeoff(
      emptyFacts({
        structures: [
          { description: 'MH 3 DROP', topElevation: null, lowInvert: null, highInvert: null, pipeOutDiameter: null, structureType: null, depth: null },
        ],
      })
    );
    expect(out.manholes[0].addMaterials).toBe(3000);
    expect(out.manholes[0].addLE).toBe(3000);
  });

  it('derives depth from top elevation minus lowest invert', () => {
    const out = priceTakeoff(
      emptyFacts({
        structures: [
          { description: 'MH 1', topElevation: 100, lowInvert: 97.5, highInvert: 98, pipeOutDiameter: null, structureType: null, depth: null },
        ],
      })
    );
    expect(out.manholes[0].depth).toBe(2.5);
  });

  it('sizes the manhole barrel from the largest connected sewer', () => {
    const out = priceTakeoff(
      emptyFacts({
        structures: [
          { description: 'MH 1', topElevation: null, lowInvert: null, highInvert: null, pipeOutDiameter: null, structureType: null, depth: null },
        ],
        sewers: [
          { runLabel: 'MH 1-MH 2', isLineItem: false, length: 50, pipeDiameter: 600, typeClass: 2.35, slope: 1.1, depth: 2 },
        ],
      })
    );
    expect(out.manholes[0].pipeOutDiameter).toBe(600);
    expect(out.manholes[0].diameter).toBe(1500); // snapToMHSize(600)
  });
});

describe('priceTakeoff — sewers', () => {
  it('prices insulation / connection / wye add-ons and appends standard fees', () => {
    const out = priceTakeoff(
      emptyFacts({
        sewers: [
          { runLabel: 'MH1-MH2/INS', isLineItem: false, length: 10, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 2 },
          { runLabel: 'MH2-MH3 CONN', isLineItem: false, length: 5, pipeDiameter: 300, typeClass: 2.35, slope: 1.1, depth: 2 },
          { runLabel: 'WYE 1', isLineItem: false, length: 3, pipeDiameter: 200, typeClass: 1.3, slope: 1.1, depth: 2 },
        ],
      })
    );
    expect(out.sewers[0]).toMatchObject({ addMaterials: 800, addLE: 400 }); // 10 * 80 / 40
    expect(out.sewers[1]).toMatchObject({ addMaterials: 500, addLE: 250 });
    expect(out.sewers[2]).toMatchObject({ addMaterials: 880, addLE: 0 });

    const fees = out.sewers.slice(3).map((s) => s.runLabel);
    expect(fees).toEqual(['VIDEO ($25/m)', 'LAYOUT', 'AS BUILT']);
    const video = out.sewers.find((s) => s.runLabel.includes('VIDEO'))!;
    expect(video.addMaterials).toBe(18 * 25); // total non-line-item length * $25/m
  });

  it('prices an extracted fee line item in place instead of duplicating it', () => {
    const out = priceTakeoff(
      emptyFacts({
        sewers: [
          { runLabel: 'MH1-MH2', isLineItem: false, length: 10, pipeDiameter: 300, typeClass: null, slope: null, depth: null },
          { runLabel: 'VIDEO', isLineItem: true, length: null, pipeDiameter: null, typeClass: null, slope: null, depth: null },
        ],
      })
    );
    expect(out.sewers.map((s) => s.runLabel)).toEqual(['MH1-MH2', 'VIDEO', 'LAYOUT', 'AS BUILT']);
    expect(out.sewers[1].addMaterials).toBe(10 * DEFAULT_COSTING.standardFees.videoPerM);
  });

  it('adds no fee rows when there are no sewers', () => {
    expect(priceTakeoff(emptyFacts()).sewers).toHaveLength(0);
  });
});

describe('priceTakeoff — catchbasins, watermain', () => {
  it('fills CB defaults, drops zero-quantity groups, and sets labor rates', () => {
    const out = priceTakeoff(
      emptyFacts({
        catchbasins: [
          { type: 'SINGLE_CB', quantity: 2, wallThickness: null, depth: null },
          { type: 'DOUBLE_CB', quantity: 0, wallThickness: null, depth: null },
        ],
      })
    );
    expect(out.catchbasins.groups).toHaveLength(1);
    expect(out.catchbasins.groups[0]).toMatchObject({
      type: 'SINGLE_CB',
      wallThickness: DEFAULT_COSTING.catchbasin.defaultWallThickness,
      depth: DEFAULT_COSTING.catchbasin.defaultDepth,
      addMaterials: 900,
    });
    expect(out.catchbasins.laborRates).toEqual(DEFAULT_COSTING.laborRates);
  });

  it('warns about a watermain run with no length, without mutating the input facts', () => {
    const input = emptyFacts({
      warnings: ['upstream'],
      watermain: [{ sizeAndType: '200mm PVC', length: 0, pipeDiameter: 200, ocSc: 1.1, avgCover: 1.8 }],
    });
    const out = priceTakeoff(input);
    expect(out.warnings[0]).toBe('upstream');
    expect(out.warnings.some((w) => /200mm PVC.*length not found.*TBD/.test(w))).toBe(true);
    expect(input.warnings).toEqual(['upstream']);
  });

  it('applies watermain special/valve cost defaults', () => {
    const out = priceTakeoff(
      emptyFacts({
        watermainSpecials: [{ specialName: '200mm Bend', quantity: 2 }],
        watermainValves: [{ valveSize: '200mm GV', quantity: 1 }],
      })
    );
    expect(out.watermainSpecials[0]).toMatchObject({ anodeCost: 100, costEach: 0 });
    expect(out.watermainValves[0]).toMatchObject({ boxCost: 285, anodeCost: 150, laborPerValve: 150 });
  });
});

describe('priceTakeoff — stated manhole size (460 Bayly St E)', () => {
  const base = { description: 'MH 10', topElevation: 89.45, lowInvert: 85.02, highInvert: null, pipeOutDiameter: null, structureType: null, depth: null };
  const facts = (diameter: number | null) => ({
    projectName: 'P', jobNumber: '', date: '', confidence: 1, warnings: [], catchbasins: [], sewers: [],
    watermain: [], watermainSpecials: [], watermainValves: [], structures: [{ ...base, diameter }],
  });
  it('uses a stated size that is a real manhole size', () => {
    expect(priceTakeoff(facts(2400)).manholes[0].diameter).toBe(2400);
  });
  it('rejects a misread size and warns', () => {
    const r = priceTakeoff(facts(180));
    expect(r.manholes[0].diameter).toBe(1200);
    expect(r.warnings.some((w) => w.includes('180mm'))).toBe(true);
  });
});
