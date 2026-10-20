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
    // PR27: stated lengths are recorded in whole metres, rounding up
    // (the estimator's convention) — 8.4m is recorded as 9, 15.5m as 16.
    expect(byLength.get(9)).toMatchObject({ pipeDiameter: 300, slope: 1.0 });
    expect(byLength.get(16)).toMatchObject({ pipeDiameter: 450, slope: 0.3 });
    expect(facts.warnings).toHaveLength(0);
  });

  it('stops a greedy join at the next callout instead of swallowing it', () => {
    // Two wrapped callouts stacked in one block: the second slope belongs to the second
    // pipe, and adds no field the first tail did not already supply.
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [['8.4m - 300mm', 'PVC STM @ 1.00%', '@ 0.50%']] },
    ], 'T');
    expect(facts.sewers).toHaveLength(1);
    // Length 8.4m is recorded whole-metre-up as 9 (PR27).
    expect(facts.sewers[0]).toMatchObject({ length: 9, pipeDiameter: 300, slope: 1.0 });
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
    // PR27: schedule lengths are recorded whole-metre-up (29.6 → 30, 41.6 → 42).
    expect(facts.sewers.find((s) => s.runLabel === 'ST1'))
      .toMatchObject({ length: 30, pipeDiameter: 250, slope: 1.0 });
    expect(facts.sewers.find((s) => s.runLabel === 'ST4A'))
      .toMatchObject({ length: 42, pipeDiameter: 300, slope: 0.4 });
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

describe('assembleTranscriptTakeoff — PR25 grammar extensions', () => {
  it('emits the EF component named in an OGS parenthetical alongside its host', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH33 (OGS3-EF04)', 'T/G=210.49', 'S INV=208.61'],
        ['MH25 (OGS2-EF08)', '(2400mmØ)', 'T/G=209.45'],
      ]},
    ], 'CRIMSON');
    const descriptions = facts.structures.map((s) => s.description).sort();
    expect(descriptions).toEqual(['CBMH33', 'EF 04', 'EF 08', 'MH25']);
    // The component carries no elevations of its own — the block's are the host's.
    const ef = facts.structures.find((s) => s.description === 'EF 04')!;
    expect(ef.topElevation).toBeNull();
    expect(ef.lowInvert).toBeNull();
  });

  it('assembles MHTEE blocks and the MODEL: Stormceptor, not its JF component', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MHTEE112 (1200Ø)', 'T/G = 100.50', 'INV = 98.25'],
        ['MODEL: STC 4000 (JF6-3-1)'],
      ]},
    ], 'TEST');
    const descriptions = facts.structures.map((s) => s.description).sort();
    expect(descriptions).toEqual(['MHTEE112', 'STC 4000']);
  });
});

describe('assembleTranscriptTakeoff — detached elevation dialects (PR39)', () => {
  it('reads a value-first block (rim "277.09 T/G", bare inverts) as field-bearing', () => {
    // The 3.x-era Uxbridge shape that cost MH 1A: label bare, geometry
    // value-first. Before PR39 every geometry line orphaned and the
    // structure assembled field-empty.
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH1A', '277.09 T/G', '275.64', '275.61'],
      ]},
    ], 'UXBRIDGE');
    expect(facts.structures).toHaveLength(1);
    expect(facts.structures[0]).toMatchObject({
      description: 'MH1A', topElevation: 277.09, lowInvert: 275.61, highInvert: 275.64,
    });
    expect(facts.warnings.some((w) => w.startsWith('Unrecognized line in structure block'))).toBe(false);
  });

  it('keeps a value-first suffixed structure out of the phase-suffix collapse', () => {
    // MH1 read keyword-first (field-bearing) + MH1A read value-first: the
    // collapse may only fold a suffixed form that is FIELD-EMPTY, so a
    // value-first MH1A with real readings must survive beside MH1. Before
    // PR39 this collapsed ("MH1A → MH1") and the structure was lost.
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH1', 'T/G = 276.36', 'INV = 274.63'],
        ['MH1A', '277.09 T/G', '275.64', '275.61'],
      ]},
    ], 'UXBRIDGE');
    const descriptions = facts.structures.map((s) => s.description).sort();
    expect(descriptions).toEqual(['MH1', 'MH1A']);
    expect(facts.warnings.some((w) => w.startsWith('Collapsed'))).toBe(false);
  });

  it('still collapses a genuinely field-empty phase-suffix echo', () => {
    // The Milton shape the collapse exists for: a bare suffixed re-read with
    // no geometry lines at all stays field-empty and still folds.
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH61', 'T/G = 276.75', 'INV = 275.72'],
        ['MH61E'],
      ]},
    ], 'MILTON');
    expect(facts.structures.map((s) => s.description)).toEqual(['MH61']);
    expect(facts.warnings.some((w) => w.startsWith('Collapsed'))).toBe(true);
  });

  it('adopts a value-first rim alongside keyword inverts (depth becomes derivable)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH2', '(1200mmØ)', '276.36 T/G', 'N INV. 275.64', 'S INV. 275.61'],
      ]},
    ], 'UXBRIDGE');
    expect(facts.structures[0]).toMatchObject({
      description: 'MH2', topElevation: 276.36, lowInvert: 275.61, highInvert: 275.64, diameter: 1200,
    });
  });

  it('reads a parenthesised bare value as the rim', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH9', '(277.13)', '275.90'],
      ]},
    ], 'UXBRIDGE');
    expect(facts.structures[0]).toMatchObject({ topElevation: 277.13, lowInvert: 275.90 });
  });

  it('does not adopt OPSD drawing numbers or small dimensions as elevations', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH5', 'LID 276.75', '701.010', '21.00', 'INV. 275.72'],
      ]},
    ], 'PANATTONI');
    expect(facts.structures[0]).toMatchObject({ topElevation: 276.75, lowInvert: 275.72, highInvert: null });
    expect(facts.warnings.some((w) => w.includes('"701.010"'))).toBe(true);
    expect(facts.warnings.some((w) => w.includes('"21.00"'))).toBe(true);
  });
});

describe('PR42 elevation recovery', () => {
  const byLabel = (facts: ReturnType<typeof assembleTranscriptTakeoff>, want: string) =>
    facts.structures.find((x) => x.description.replace(/\s/g, '') === want);

  it('reads a bare directional line in a structure block as its invert (L1a own-block)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['DCBMH 2', 'NE 258.30'],
        ['DCBMH 2', 'T/G 260.00'],
      ]},
    ], 'GEORGIAN');
    const s = byLabel(facts, 'DCBMH2')!;
    expect(s.topElevation).toBe(260);
    expect(s.lowInvert).toBe(258.3);
    expect(s.depth).toBe(2); // 260 − 258.30 + 0.30 CB sump
  });

  it('refuses bare directional lines that are OPSD numbers or small values (L1a guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH5', 'LID 276.75', 'NE 701.010', 'SW 21.00', 'INV. 275.72'],
      ]},
    ], 'T');
    expect(facts.structures[0]).toMatchObject({ topElevation: 276.75, lowInvert: 275.72, highInvert: null });
  });

  it('fills a geometry-free read from a hyphenated system-prefix block; hyphenated-only structures are not emitted (L1a dialect)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH4'],
        ['STM-MH 4', 'T/G 284.49', 'E INV 282.54', 'N INV 282.54'],
        ['STM-MH 122', 'T/G 285.62'],
      ]},
    ], 'ORILLIA');
    expect(byLabel(facts, 'MH4')).toMatchObject({ topElevation: 284.49, lowInvert: 282.54, depth: 1.95 });
    expect(byLabel(facts, 'MH122')).toBeUndefined();
  });

  it('never lets a hyphenated read override an established read (L1a dialect guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['STM-MH 3', 'T/G 284.64', 'S INV 282.21'],
        ['STM MH3', 'T/G 285.12', 'S INV 283.38'],
      ]},
    ], 'ORILLIA');
    expect(byLabel(facts, 'MH3')).toMatchObject({ topElevation: 285.12, lowInvert: 283.38 });
  });

  it('recovers geometry from a one-character garbled label block, fill-only (L1a rescue)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH2', 'T/G 129.10'],
        ['CRMH2', 'T/G 129.10', 'N.INV 125.91', 'W.INV 125.88'],
      ]},
    ], 'KING FOREST');
    expect(byLabel(facts, 'CBMH2')).toMatchObject({ topElevation: 129.1, lowInvert: 125.88, highInvert: 125.91 });
    expect(facts.warnings.some((w) => w.includes('mis-transcribed label block') && w.includes('CRMH2'))).toBe(true);
  });

  it('uses the block rim to separate two one-edit candidates (L1a rescue corroboration)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['DCBMH 144', 'TOP 171.25'],
        ['CBMH 144', 'TOP 169.00'],
        ['DBMH144 (1500Ø)', 'TOP=171.25', 'N INV=168.93', 'S INV=168.78'],
      ]},
    ], 'PANATTONI');
    expect(byLabel(facts, 'DCBMH144')).toMatchObject({ lowInvert: 168.78, highInvert: 168.93 });
    expect(byLabel(facts, 'CBMH144')).toMatchObject({ lowInvert: null });
  });

  it('adopts nothing when rim corroboration cannot separate two one-edit candidates (L1a rescue guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['DCBMH 144', 'TOP 171.25'],
        ['CBMH 144', 'TOP 169.00'],
        ['DBMH144 (1500Ø)', 'TOP=170.00', 'N INV=168.93', 'S INV=168.78'],
      ]},
    ], 'PANATTONI');
    expect(byLabel(facts, 'DCBMH144')).toMatchObject({ lowInvert: null });
    expect(byLabel(facts, 'CBMH144')).toMatchObject({ lowInvert: null });
    expect(facts.warnings.some((w) => w.includes('mis-transcribed label block'))).toBe(false);
  });

  it('does not rescue into a group that already carries both components (L1a rescue guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH2', 'T/G 129.10', 'N.INV 125.91'],
        ['CRMH2', 'T/G 129.10', 'N.INV 125.91', 'W.INV 125.88'],
      ]},
    ], 'KING FOREST');
    expect(byLabel(facts, 'CBMH2')).toMatchObject({ lowInvert: 125.91, highInvert: null });
    expect(facts.warnings.some((w) => w.includes('mis-transcribed label block'))).toBe(false);
  });

  it('adopts a lone orphan invert from a catchbasin-group block into the only invertless rimmed structure on the tile (L1a adoption)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH8', 'T/G 287.50'],
        ['DICB301', 'INV=284.61'],
      ]},
    ], 'WOODBINE');
    expect(byLabel(facts, 'CBMH8')).toMatchObject({ lowInvert: 284.61 });
    expect(facts.warnings.some((w) => w.includes('Adopted invert 284.61'))).toBe(true);
  });

  it('adopts nothing when two invertless structures share the tile (L1a adoption guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH8', 'T/G 287.50'],
        ['CBMH7', 'T/G 287.61'],
        ['DICB301', 'INV=284.61'],
      ]},
    ], 'WOODBINE');
    expect(byLabel(facts, 'CBMH8')).toMatchObject({ lowInvert: null });
    expect(byLabel(facts, 'CBMH7')).toMatchObject({ lowInvert: null });
  });

  it('adopts nothing when the orphan value sits at or above the candidate rim (L1a adoption guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['MH47', 'T/G 243.87'],
        ['DICB301', 'INV=244.15'],
      ]},
    ], 'ECOLE');
    expect(byLabel(facts, 'MH47')).toMatchObject({ lowInvert: null });
  });

  it('adopts nothing when two orphan values compete on the tile (L1a adoption guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH8', 'T/G 287.50'],
        ['DICB301', 'INV=284.61'],
        ['DCB302', 'INV=284.99'],
      ]},
    ], 'WOODBINE');
    expect(byLabel(facts, 'CBMH8')).toMatchObject({ lowInvert: null });
  });

  it('prefers the corroborated operative rim over a shared family rim; inverts stay first-wins (L1b)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH1', 'TOP=171.25', 'N INV=166.00'],
        ['CBMH2', 'TOP=171.25', 'N INV=166.00'],
        ['CBMH3', 'TOP=171.25', 'N INV=166.00'],
      ]},
      { tile: 2, blocks: [
        ['CBMH1', 'TOP=168.86'],
        ['CBMH1', 'TOP=168.86'],
      ]},
    ], 'PANATTONI');
    expect(byLabel(facts, 'CBMH1')).toMatchObject({ topElevation: 168.86, lowInvert: 166 });
    expect(byLabel(facts, 'CBMH2')).toMatchObject({ topElevation: 171.25 });
  });

  it('keeps the first rim when the operative value is stated only once (L1b guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH1', 'TOP=171.25', 'N INV=166.00'],
        ['CBMH2', 'TOP=171.25', 'N INV=166.00'],
        ['CBMH3', 'TOP=171.25', 'N INV=166.00'],
      ]},
      { tile: 2, blocks: [['CBMH1', 'TOP=168.86']] },
    ], 'PANATTONI');
    expect(byLabel(facts, 'CBMH1')).toMatchObject({ topElevation: 171.25 });
  });

  it('keeps the first rim when the split is under 0.8 m of transcription noise (L1b guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH1', 'TOP=171.25', 'N INV=166.00'],
        ['CBMH2', 'TOP=171.25', 'N INV=166.00'],
        ['CBMH3', 'TOP=171.25', 'N INV=166.00'],
      ]},
      { tile: 2, blocks: [
        ['CBMH1', 'TOP=170.90'],
        ['CBMH1', 'TOP=170.90'],
      ]},
    ], 'PANATTONI');
    expect(byLabel(facts, 'CBMH1')).toMatchObject({ topElevation: 171.25 });
  });

  it('keeps a structure-specific first rim even against a corroborated late rim (L1b guard)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [['MH1', 'T/G 200.00', 'INV 197.00']] },
      { tile: 2, blocks: [
        ['MH1', 'T/G 198.00'],
        ['MH1', 'T/G 198.00'],
      ]},
    ], 'T');
    expect(byLabel(facts, 'MH1')).toMatchObject({ topElevation: 200 });
  });

  it('keeps the PR52 derivation — CB depths carry the 0.30 sump, MH depths do not (L2 dropped: no convention switch)', () => {
    const facts = assembleTranscriptTakeoff([
      { tile: 1, blocks: [
        ['CBMH1', 'T/G 100.00', 'INV 97.00'],
        ['MH1', 'T/G 100.00', 'INV 97.00'],
      ]},
    ], 'T');
    expect(byLabel(facts, 'CBMH1')).toMatchObject({ depth: 3.3 });
    expect(byLabel(facts, 'MH1')).toMatchObject({ depth: 3 });
  });
});
