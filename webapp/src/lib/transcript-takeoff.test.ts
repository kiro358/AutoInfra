import { describe, it, expect } from 'vitest';
import { assembleTranscriptTakeoff } from './transcript-takeoff';

describe('assembleTranscriptTakeoff', () => {
  it('assembles structure blocks with elevations and run blocks', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['EX SAN MH 02', 'T/G = 311.85', 'SW INV = 310.56'],   // existing — excluded
        ['STMH 4', 'T/G=224.95', 'N INV=223.350', 'S INV=223.250'],
        ['83.7m-375mmØ SAN @ 0.02%'],
      ]},
      { tile: 2, blocks: [
        ['STMH 4', 'T/G=224.95'],                     // same structure re-seen in overlap tile
        ['EX SAN 87.4m - 250mmØ', 'DR 35 @ 0.05%'],   // split callout + existing — excluded
        ['45.0m - 250mmØ', 'PVC STM @ 0.50%'],        // split callout, proposed — kept
      ]},
    ], 'T');
    expect(facts.structures).toHaveLength(1);
    expect(facts.structures[0]).toMatchObject({ description: 'STMH 4', topElevation: 224.95, lowInvert: 223.25 });
    expect(facts.sewers).toHaveLength(2);
    expect(facts.sewers.find((s) => s.pipeDiameter === 250)!.slope).toBe(0.5);
  });

  it('joins callouts the drafter wrapped over two or three visual lines', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['300mm PVC STM', '@ 1.00% (25.0m)'],                 // diameter-first head + slope/length tail
        ['250mmØ PVC SAN', '@ 0.50% - 45.0m'],                // same, dash-length tail
        ['8.4m - 300mm', 'PVC STM @ 1.00%', 'INSULATED'],     // three lines, qualifier last
        ['15.5m - 450mm', 'PVC STM', '@ 0.30%'],              // three lines, slope last
      ]},
    ], 'T');
    expect(facts.sewers).toHaveLength(4);
    const byLength = new Map(facts.sewers.map((s) => [s.length, s]));
    expect(byLength.get(25.0)).toMatchObject({ pipeDiameter: 300, slope: 1.0 });
    expect(byLength.get(45.0)).toMatchObject({ pipeDiameter: 250, slope: 0.5 });
    expect(byLength.get(8.4)).toMatchObject({ pipeDiameter: 300, slope: 1.0 });
    expect(byLength.get(15.5)).toMatchObject({ pipeDiameter: 450, slope: 0.3 });
    expect(facts.warnings).toHaveLength(0);
  });

  it('stops a greedy join at the next callout instead of swallowing it', () => {
    // Two wrapped callouts stacked in one block: the second slope belongs to the second
    // pipe, and adds no field the first tail did not already supply.
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [['8.4m - 300mm', 'PVC STM @ 1.00%', '@ 0.50%']] },
    ], 'T');
    expect(facts.sewers).toHaveLength(1);
    expect(facts.sewers[0]).toMatchObject({ length: 8.4, pipeDiameter: 300, slope: 1.0 });
  });

  it('leaves a head untouched when no continuation completes it', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [['300mm PVC STM', 'DRAWN BY: ML']] },
    ], 'T');
    expect(facts.sewers).toHaveLength(0);
    expect(facts.warnings).toHaveLength(0);
  });

  it('warns (not guesses) on unparseable schedule rows', () => {
    const facts = assembleTranscriptTakeoff([{ tile: 1, blocks: [['ST11 | 42.3 | 300 | 1.0%']] }], 'T');
    expect(facts.sewers).toHaveLength(0);
    expect(facts.warnings.length).toBeGreaterThan(0);
  });

  it('warns (not guesses) on an unconsumed non-elevation line in a structure block', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['STMH 4', 'T/G=224.95', '83.7m-375mmØ SAN @ 0.02%'],
      ]},
    ], 'T');
    expect(facts.structures).toHaveLength(1);
    expect(facts.structures[0]).toMatchObject({ description: 'STMH 4', topElevation: 224.95 });
    expect(facts.sewers).toHaveLength(0);
    expect(facts.warnings.some((w) => w.includes('83.7m-375mmØ SAN @ 0.02%'))).toBe(true);
  });

  describe('watermain detection without a stated length', () => {
    it('emits a proposed main whose callout carries no length', () => {
      const facts = assembleTranscriptTakeoff([
        { tile: 1, blocks: [
          ['200mmØ PVC WATERMAIN'],
          ['EX. 300 mmØ PVC WATERMAIN'], // existing — excluded
        ]},
      ], 'T');
      expect(facts.watermain).toHaveLength(1);
      expect(facts.watermain[0].pipeDiameter).toBe(200);
      expect(facts.watermain[0].length).toBe(0);
    });

    it('prefers a stated length over an unmeasured duplicate of the same size', () => {
      const facts = assembleTranscriptTakeoff([
        { tile: 1, blocks: [
          ['150mmØ PVC WATERMAIN'],
          ['124.0m - 150mmØ PVC WM'],
        ]},
      ], 'T');
      expect(facts.watermain).toHaveLength(1);
      expect(facts.watermain[0].length).toBe(124);
    });
  });

});

describe('assembleTranscriptTakeoff — 460 Bayly St E blocks', () => {
  const facts = assembleTranscriptTakeoff([{ tile: 1, blocks: [
    ['PROP STMH MH 100 (2400mmØ)', 'RIM ELEV 89.70', 'SW INV EL 84.84', 'W INV EL 85.59'],
    ['PROP STMH MH 1 (1200 mmØ)', 'RIM ELEV 90.93', 'E INV EL 88.68'],
    ['PROP SAN MH 1', 'RIM EL 87.75', 'S INV EL 79.92'],
    ['EX STMH MH 3', 'RIM EL 90.12', 'TO BE REMOVED', 'E INV EL 84.73'],
    ['PROP. CULTEC OR APPROVED', 'RECHARGER 902HD', 'BED AREA 3200 SQ.M.'],
  ] }], 'Bayly');
  const by = (d: string) => facts.structures.find((s) => s.description === d);

  it('attaches rim, low invert and stated diameter', () => {
    expect(by('MH 100')).toMatchObject({ topElevation: 89.7, lowInvert: 84.84, diameter: 2400 });
  });
  it('keeps sanitary MH 1 separate from storm MH 1', () => {
    expect(by('MH 1')).toMatchObject({ topElevation: 90.93, lowInvert: 88.68 });
    expect(by('SAN MH 1')).toMatchObject({ topElevation: 87.75, lowInvert: 79.92 });
  });
  it('drops existing structures', () => {
    expect(facts.structures.some((s) => s.description === 'MH 3')).toBe(false);
  });
  it('lists a chamber system and warns that it needs manual pricing', () => {
    expect(by('902 HD')).toMatchObject({ structureType: 'CHAMBER' });
    expect(facts.warnings.some((w) => w.includes('902 HD') && w.includes('3200'))).toBe(true);
  });
});
