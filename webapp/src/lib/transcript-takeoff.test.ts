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
    // No PARSE warnings — but the assembly is empty from a non-empty
    // transcript, which the coverage check must say out loud (see the
    // coverage describe block below).
    expect(facts.warnings.filter((w) => !w.startsWith('Coverage:'))).toHaveLength(0);
    expect(facts.warnings.some((w) => w.startsWith('Coverage:') && w.includes('nothing could be assembled'))).toBe(true);
  });

  it('warns (not guesses) on unparseable schedule rows', () => {
    const facts = assembleTranscriptTakeoff([{ tile: 1, blocks: [['ST11 | 42.3 | 300 | 1.0%']] }], 'T');
    expect(facts.sewers).toHaveLength(0);
    expect(facts.warnings.length).toBeGreaterThan(0);
  });

  it('harvests run-schedule rows as runs under their schedule ids', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [[
        'ST1 | 29.6 m | 250 mm dia. | PVC DR35 | 1.0%',
        'ST4A | 41.6 m | 300 mm dia. | PVC DR35 | 0.4%',
        'SA1 | 10.0 m | 150 mm dia. | PVC DR28 | 2.0%',
      ]]},
    ], 'T');
    expect(facts.sewers).toHaveLength(3);
    expect(facts.sewers.find((s) => s.runLabel === 'ST1'))
      .toMatchObject({ length: 29.6, pipeDiameter: 250, slope: 1.0 });
    expect(facts.sewers.find((s) => s.runLabel === 'ST4A'))
      .toMatchObject({ length: 41.6, pipeDiameter: 300, slope: 0.4 });
    expect(facts.sewers.find((s) => s.runLabel === 'SA1'))
      .toMatchObject({ length: 10.0, pipeDiameter: 150, slope: 2.0 });
    expect(facts.warnings.filter((w) => w.includes('Unparseable schedule row'))).toHaveLength(0);
  });

  it('keeps attribute-identical schedule rows distinct, and dedupes a re-read schedule', () => {
    // Ultimate Drive's schedule lists pairs with identical attributes
    // (ST1/ST2 are both 29.6m/250mm/1.0%) and is transcribed by two tiles.
    // The ids are the identity: pairs survive, the duplicate tile collapses.
    const rows = [
      'ST1 | 29.6 m | 250 mm dia. | PVC DR35 | 1.0%',
      'ST2 | 29.6 m | 250 mm dia. | PVC DR35 | 1.0%',
      'ST16 | 37.6 m | 250 mm dia. | PVC DR35 | 0.5%',
      'ST16A | 37.6 m | 250 mm dia. | PVC DR35 | 0.5%',
    ];
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [rows] },
      { tile: 2, blocks: [rows] },
    ], 'T');
    expect(facts.sewers.map((s) => s.runLabel).sort()).toEqual(['ST1', 'ST16', 'ST16A', 'ST2']);
  });

  it('does not harvest the non-schedule pipe tables a transcript carries', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [[
        '03 | JAN 27/26 | MC | ADDED SANITARY SERVICE',                    // revision table
        'MH1 | 1200 | 701.010 | 401.010',                                   // structure schedule
        'Woodbine Ave | CBMH7 | CBMH10 | 0.11 | 0.90',                     // drainage areas
      ]]},
    ], 'T');
    expect(facts.sewers).toHaveLength(0);
  });

  it('admits "#" dialect headers from callout blocks but not from schedule rows', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        // Plan/profile callout block in the "#" dialect (Wigmore): admitted.
        ['NEW STM MH#1 (1200mmØ)', 'RIM = 140.55', 'S INV. 138.80', 'N INV. 138.77'],
        // Structure-schedule row (Ultimate Drive): the "#" header cell is not
        // admitted — schedule numbering runs past the takeoff's scope, and
        // harvesting it is the schedule-table work's decision.
        ['STMH #15 | DPSG 701.010, 400 Ø Frame and Cover (Closed) and 600 mm Sump | Top = 214.60 m | N Inv = 212.80 m (200 mm)'],
        ['CB #7 | DPSG 701.010, 400 Ø Frame and Cover and 600 mm Sump | Parkway 1 | Top = 214.60 m'],
      ]},
    ], 'T');
    expect(facts.structures).toHaveLength(1);
    expect(facts.structures[0]).toMatchObject({ description: 'MH1', topElevation: 140.55, lowInvert: 138.77 });
    expect(facts.catchbasins).toHaveLength(0);
    expect(facts.warnings.some((w) => w.includes('Unparseable schedule row'))).toBe(true);
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
  it('reads a size the drafter wrapped onto its own line', () => {
    const f = assembleTranscriptTakeoff([{ tile: 1, blocks: [['PROP STM MH 15', '(1800 mmØ)', 'RIM ELEV 89.69', 'W INV EL 84.85']] }], 'Bayly');
    expect(f.structures[0]).toMatchObject({ description: 'MH 15', diameter: 1800, topElevation: 89.69, lowInvert: 84.85 });
    expect(f.warnings.filter((w) => w.startsWith('Unrecognized'))).toEqual([]);
  });
  it('stops at a second rim — the next structure\'s callout merged into this block', () => {
    const f = assembleTranscriptTakeoff([{ tile: 1, blocks: [[
      'PROP STMH 9', '(2400 mmØ)', 'RIM ELEV 88.09', 'W INV EL 85.24', 'PROP INV EL 200', 'RIM ELEV 86.78', 'W INV EL 85.02',
    ]] }], 'Bayly');
    expect(f.structures[0]).toMatchObject({ topElevation: 88.09, lowInvert: 85.24, diameter: 2400 });
    expect(f.warnings.some((w) => w.includes('second rim'))).toBe(true);
  });
  it('drops existing structures', () => {
    expect(facts.structures.some((s) => s.description === 'MH 3')).toBe(false);
  });
  it('lists a chamber system and warns that it needs manual pricing', () => {
    expect(by('902 HD')).toMatchObject({ structureType: 'CHAMBER' });
    expect(facts.warnings.some((w) => w.includes('902 HD') && w.includes('3200'))).toBe(true);
  });
});

describe('assembleTranscriptTakeoff — coverage surfacing (PR 7)', () => {
  const coverage = (warnings: string[]) => warnings.filter((w) => w.startsWith('Coverage:'));

  it('is silent on a complete assembly', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['STMH 4', 'T/G=224.95', 'N INV=223.350'],
        ['CB 2', 'T/G=224.50'],
        ['83.7m-375mmØ SAN @ 0.02%'],
      ]},
    ], 'T');
    expect(facts.structures).toHaveLength(1);
    expect(facts.catchbasins).toEqual([
      { type: 'SINGLE_CB', quantity: 1, wallThickness: null, depth: null,
        source: { method: 'transcript', tile: 1, evidence: 'CB 2' } },
    ]);
    expect(coverage(facts.warnings)).toEqual([]);
  });

  it('names a structure whose header was swallowed by another block', () => {
    // The vision step merged MH 6's header into MH 4's block: the assembler
    // can only take the first header, so MH 6 used to vanish silently (it
    // surfaced only as an "unrecognized line"). The coverage check names it.
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['STMH 4', 'T/G=224.95', 'MH 6', 'INV=220.00'],
      ]},
    ], 'T');
    expect(facts.structures).toHaveLength(1);
    const w = coverage(facts.warnings);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('MH 6');
    expect(w[0]).toContain('not in this takeoff');
  });

  it('names schedule-carried structures and CBs the takeoff does not harvest', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['STMH #15 | DPSG 701.010, 400 Ø Frame and Cover (Closed) and 600 mm Sump | Top = 214.60 m | N Inv = 212.80 m (200 mm)'],
        ['CB #7 | DPSG 701.010, 400 Ø Frame and Cover and 600 mm Sump | Parkway 1 | Top = 214.60 m'],
      ]},
    ], 'T');
    expect(facts.structures).toHaveLength(0);
    expect(facts.catchbasins).toHaveLength(0);
    const w = coverage(facts.warnings).join('\n');
    expect(w).toContain('STMH 15');
    expect(w).toContain('CB 7');
  });

  it('does not re-report labels that reconcile deliberately collapsed (phase-suffix echoes)', () => {
    // Milton shape: a field-bearing MH61 plus its field-empty MH61E echo. The
    // echo WAS assembled (it is in the sink), then reconcile collapsed it
    // with its own warning — coverage must stay silent about it.
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH61', 'T/G=200.00', 'INV=198.50'],
        ['MH61E'],
      ]},
    ], 'T');
    expect(facts.structures).toHaveLength(1);
    expect(coverage(facts.warnings)).toEqual([]);
  });

  it('does not report existing structures as missing', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['EX SAN MH 02', 'T/G = 311.85', 'SW INV = 310.56'],
        ['STMH 4', 'T/G=224.95'],
      ]},
    ], 'T');
    expect(coverage(facts.warnings)).toEqual([]);
  });

  it('flags a transcription that assembled to nothing as missing, not empty', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [] },
      { tile: 2, blocks: [] },
      { tile: 3, blocks: [] },
    ], 'T');
    const w = coverage(facts.warnings);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('3 tile(s) / 0 block(s)');
    expect(w[0]).toContain('treat this takeoff as missing');
  });
});

describe('assembleTranscriptTakeoff — provenance & withheld (PR 8)', () => {
  it('attaches transcript source (tile + evidence) to structures, runs and watermain', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 7, blocks: [
        ['STMH 4', 'T/G=224.95', 'N INV=223.350', 'S INV=223.250'],
        ['83.7m-375mmØ SAN @ 0.02%'],
        ['200mmØ PVC WATERMAIN 120.0m'],
      ]},
    ], 'T');
    expect(facts.structures[0].source).toEqual({ method: 'transcript', tile: 7, evidence: 'STMH 4' });
    expect(facts.sewers[0].source).toEqual({ method: 'transcript', tile: 7, evidence: '83.7m-375mmØ SAN @ 0.02%' });
    expect(facts.watermain[0].source).toEqual({ method: 'transcript', tile: 7, evidence: '200mmØ PVC WATERMAIN 120.0m' });
  });

  it('marks schedule-harvested runs with method schedule', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 3, blocks: [[
        'ST1 | 29.6 m | 250 mm dia. | PVC DR35 | 1.0%',
        'ST4A | 41.6 m | 300 mm dia. | PVC DR35 | 0.4%',
      ]]},
    ], 'T');
    const run = facts.sewers.find((s) => s.runLabel === 'ST1');
    expect(run).toBeDefined();
    expect(run!.source?.method).toBe('schedule');
    expect(run!.source?.tile).toBe(3);
    expect(run!.source?.evidence).toContain('ST1');
  });

  it('leaves watermain ocSc/avgCover unstated (null) and withholds an unmeasured length', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [['200mmØ PVC WATERMAIN']] },
    ], 'T');
    expect(facts.watermain).toHaveLength(1);
    expect(facts.watermain[0].ocSc).toBeNull();
    expect(facts.watermain[0].avgCover).toBeNull();
    expect(facts.withheld ?? []).toEqual([
      expect.objectContaining({ entity: '200mm PVC', field: 'length', kind: 'withheld', defaultApplied: null }),
    ]);
  });

  it('gives catchbasin groups the source of their first label', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 5, blocks: [['CB 1'], ['CB 2']] },
    ], 'T');
    const group = facts.catchbasins.find((g) => g.type === 'SINGLE_CB');
    expect(group).toBeDefined();
    expect(group!.source).toEqual({ method: 'transcript', tile: 5, evidence: 'CB 1' });
  });
});

describe('assembleTranscriptTakeoff — PR23 enumeration scope guards', () => {
  const cbBlocks = (kind: string, from: number, to: number, hyphen = false) =>
    Array.from({ length: to - from + 1 }, (_, i) => {
      const n = from + i;
      return [`${kind}${hyphen ? '-' : ''}${n}`, 'TOP=100.00'];
    });
  const cbmhBlocks = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => [`CBMH${from + i}(1200Ø)`, 'TOP=100.00']);

  it('does not count a hyphenated site-wide CB enumeration; plan-evidenced labels still count', () => {
    // Panattoni shape: tile 49 carries CB-1..CB-805 (hyphenated enumeration)
    // alongside plain plan reads. Scaled down: 45 hyphenated labels form the
    // enumeration; CB1/CB2 have plain plan occurrences too and must count.
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: cbBlocks('CB', 1, 45, true) },
      { tile: 2, blocks: [['CB1', 'TOP=99.10'], ['CB2', 'TOP=99.20'], ['CB46', 'TOP=99.30'], ['DCB100', 'TOP=99.40']] },
    ], 'T');
    const single = facts.catchbasins.find((g) => g.type === 'SINGLE_CB');
    expect(single).toBeDefined();
    expect(single!.quantity).toBe(3); // CB1, CB2 (plan reads of enumerated labels) + CB46
    expect(facts.catchbasins.find((g) => g.type === 'DOUBLE_CB')!.quantity).toBe(1);
    const scope = facts.warnings.find((w) => w.startsWith('Scope:') && w.includes('SINGLE_CB'));
    expect(scope).toBeDefined();
    expect(scope).toContain('43 SINGLE_CB'); // 45 enumerated − CB1/CB2, which plan reads rescued
  });

  it('an enumeration-only CB set produces no group, but says so', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: cbBlocks('CB', 1, 45, true) },
    ], 'T');
    expect(facts.catchbasins).toEqual([]);
    expect(facts.warnings.some((w) => w.startsWith('Scope:') && w.includes('45 SINGLE_CB'))).toBe(true);
  });

  it('counts a small hyphenated CB set (a plan that numbers CB-101 style)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [...cbBlocks('CB', 100, 103, true), ['CB 1', 'TOP=99.00']] },
    ], 'T');
    const single = facts.catchbasins.find((g) => g.type === 'SINGLE_CB');
    expect(single!.quantity).toBe(5);
    expect(facts.warnings.some((w) => w.startsWith('Scope:'))).toBe(false);
  });

  it('counts a long CONTIGUOUS plain-form CB set in full — contiguity alone is not an enumeration', () => {
    // 45 plain CB labels on one tile + enough network that the reconcile
    // ceiling does not bite: the hyphen dialect is a required part of the
    // enumeration signature.
    const structures = Array.from({ length: 30 }, (_, i) => [`MH ${300 + i}`, 'T/G=100.00']);
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [...cbBlocks('CB', 1, 45), ...structures] },
    ], 'T');
    const single = facts.catchbasins.find((g) => g.type === 'SINGLE_CB');
    expect(single!.quantity).toBe(45);
    expect(facts.warnings.some((w) => w.startsWith('Scope:'))).toBe(false);
  });

  it('excludes structures read only inside a complete enumeration; plan-corroborated labels survive', () => {
    // Panattoni shape: one tile enumerates CBMH1..CBMH45 (two such tiles in
    // the real set, one per vintage); plan tiles read the servicing subset.
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: cbmhBlocks(1, 45) },
      { tile: 2, blocks: [['CBMH7(1200Ø)', 'TOP=101.00'], ['CBMH100(1200Ø)', 'TOP=101.00'], ['CBMH101(1200Ø)', 'TOP=101.00']] },
    ], 'T');
    const labels = facts.structures.map((s) => s.description).sort();
    expect(labels).toEqual(['CBMH100', 'CBMH101', 'CBMH7']);
    const scope = facts.warnings.find((w) => w.startsWith('Scope:') && w.includes('structure'));
    expect(scope).toBeDefined();
    expect(scope).toContain('44 structure(s)');
  });

  it('keeps a dense but sub-threshold single-tile cluster (a real plan area)', () => {
    // Ultimate shape: 15 same-kind labels on one tile, contiguous — a plan
    // area, not an enumeration table. The bar is 40. (Elevations vary per
    // block so the tile repetition filter does not eat the fixture.)
    const blocks = Array.from({ length: 15 }, (_, i) => [
      `MH${i + 1}`, `T/G=${(100 + i * 0.37).toFixed(2)}`, `INV=${(98 + i * 0.37).toFixed(2)}`,
    ]);
    const facts = assembleTranscriptTakeoff([{ tile: 1, blocks }], 'T');
    expect(facts.structures).toHaveLength(15);
    expect(facts.warnings.some((w) => w.startsWith('Scope:'))).toBe(false);
  });

  it('keeps a large single-tile cluster whose numbers are not a complete sequence', () => {
    // 45 same-kind labels but spanning 1..90 at 50% density — scattered plan
    // reads across a big sheet, not an enumeration.
    const blocks = Array.from({ length: 45 }, (_, i) => [`CBMH${(i + 1) * 2}(1200Ø)`, 'TOP=100.00']);
    const facts = assembleTranscriptTakeoff([{ tile: 1, blocks }], 'T');
    expect(facts.structures).toHaveLength(45);
    expect(facts.warnings.some((w) => w.startsWith('Scope:'))).toBe(false);
  });
});
