import { describe, it, expect, vi } from 'vitest';
import { normalizeSlope, snapToPipeDiameter, snapToMHSize } from './geometry';
import {
  repairTruncatedJson,
  tryParseJSONWithRepair,
  deduplicateManholes,
  deduplicateSewers,
  mergeCatchbasinGroups,
  deduplicateWatermain,
  deduplicateSpecials,
  deduplicateValves,
  parseFacts,
  isNonMainlineSewer,
  isNonStructure,
  tilesNeededPerPage,
  findDegenerateRepetition,
  stripDegenerateKeys,
  parseWatermainFacts,
  applySecondPassWatermain,
  runSecondPassWatermain,
  sanitizeTranscriptTiles,
  contiguousRuns,
} from './extraction';

describe('parseFacts structure/catchbasin categorization', () => {
  it('reclassifies plain catchbasins out of structures into CB group counts by type', () => {
    const f = parseFacts({
      manholes: [
        { description: 'MH 1' }, { description: 'CBMH 2' },   // real structures (kept)
        { description: 'CB 1' }, { description: 'CB 2' },      // plain CB -> SINGLE_CB x2
        { description: 'DICB 1' },                             // -> DITCH_INLET_CB x1
        { description: 'PROP. BIKE RACKS' },                   // junk (dropped)
      ],
      catchbasins: { groups: [] },
    }, 'test');
    expect(f.structures.map((s) => s.description).sort()).toEqual(['CBMH 2', 'MH 1']);
    const cb = Object.fromEntries(f.catchbasins.map((c) => [c.type, c.quantity]));
    expect(cb['SINGLE_CB']).toBe(2);
    expect(cb['DITCH_INLET_CB']).toBe(1);
  });

  it('drops sub-drainage / detail callouts from sewer runs but keeps mainline + tank runs', () => {
    // isNonMainlineSewer flags sub-drainage / detail pipes only.
    expect(isNonMainlineSewer('Infiltration Gallery #1 - PERFORATED 200mm HDPE PIPE')).toBe(true);
    expect(isNonMainlineSewer('PICP Detail - 150mm HDPE SUBDRAIN')).toBe(true);
    expect(isNonMainlineSewer('MH 5-MH 4')).toBe(false);
    expect(isNonMainlineSewer('MH 10-INF.TANK')).toBe(false); // pipe to a tank IS a mainline run
    const f = parseFacts({
      manholes: [],
      sewers: [
        { runLabel: 'MH 5-MH 4', isLineItem: false, length: 45, pipeDiameter: 250 },
        { runLabel: 'PICP Detail - 150mm HDPE SUBDRAIN', isLineItem: false, length: 20, pipeDiameter: 150 },
        { runLabel: 'Infiltration Gallery #2 - PERFORATED 200mm HDPE PIPE', isLineItem: false, length: 30, pipeDiameter: 200 },
        { runLabel: 'MH 10-INF.TANK', isLineItem: false, length: 12, pipeDiameter: 300 },
      ],
      catchbasins: { groups: [] },
    }, 'test');
    expect(f.sewers.map((s) => s.runLabel).sort()).toEqual(['MH 10-INF.TANK', 'MH 5-MH 4']);
  });

  it('drops non-structure callouts (inspection ports, wye connections, infiltration galleries, bare SANITARY) from structures', () => {
    const f = parseFacts({
      manholes: [
        { description: 'MH 101' }, { description: 'STMH 5' },            // real → kept
        { description: 'INFILTRATION GALLERY #1' },
        { description: '150mm WYE CONNECTION AND VERTICAL INSPECTION PORT' },
        { description: 'CAP INSPECTION PORT' },
        { description: 'SANITARY' },
      ],
      catchbasins: { groups: [] },
    }, 'test');
    expect(f.structures.map((s) => s.description).sort()).toEqual(['MH 101', 'STMH 5']);
  });

  it('prefers an explicit CB group count over reclassified individuals (no double-count)', () => {
    const f = parseFacts({
      manholes: [{ description: 'CB 1' }, { description: 'CB 2' }],
      catchbasins: { groups: [{ type: 'SINGLE_CB', quantity: 5 }] },
    }, 'test');
    expect(f.catchbasins.find((c) => c.type === 'SINGLE_CB')!.quantity).toBe(5); // max(5,2)
    expect(f.structures.length).toBe(0);
  });
});

describe('normalizeSlope', () => {
  it('passes through plausible percent slopes (<= 10)', () => {
    expect(normalizeSlope(1.1)).toBe(1.1);
    expect(normalizeSlope(10)).toBe(10);
  });
  it('converts per-mille (> 10) to percent by dividing by 10', () => {
    expect(normalizeSlope(11)).toBeCloseTo(1.1);
    expect(normalizeSlope(100)).toBe(10);
  });
});

describe('snapToPipeDiameter', () => {
  it('returns 0 for non-positive values', () => {
    expect(snapToPipeDiameter(0)).toBe(0);
    expect(snapToPipeDiameter(-5)).toBe(0);
  });
  it('snaps to the nearest standard diameter', () => {
    expect(snapToPipeDiameter(305)).toBe(300);
    expect(snapToPipeDiameter(200)).toBe(200);
    expect(snapToPipeDiameter(130)).toBe(150); // closer to 150 than 100
  });
});

describe('snapToMHSize', () => {
  it('defaults to 1200 for null/zero/small outlets', () => {
    expect(snapToMHSize(null)).toBe(1200);
    expect(snapToMHSize(0)).toBe(1200);
    expect(snapToMHSize(450)).toBe(1200);
  });
  it('steps up MH diameter as the outlet pipe grows', () => {
    expect(snapToMHSize(600)).toBe(1500);
    expect(snapToMHSize(825)).toBe(1800);
    expect(snapToMHSize(1050)).toBe(2400);
    expect(snapToMHSize(1500)).toBe(3000);
    expect(snapToMHSize(2000)).toBe(3600);
  });
});

describe('repairTruncatedJson', () => {
  it('closes brackets left open by truncation', () => {
    const repaired = repairTruncatedJson('{"a":[{"b":1}');
    expect(repaired).toBe('{"a":[{"b":1}]}');
    expect(JSON.parse(repaired)).toEqual({ a: [{ b: 1 }] });
  });
  it('leaves already-valid JSON untouched', () => {
    expect(repairTruncatedJson('{"a":1}')).toBe('{"a":1}');
  });
  it('salvages complete elements when truncated mid-string inside an array', () => {
    // A dense response truncated mid-string in a big array (the White Oak failure):
    // keep the complete strings, drop the partial one, and close the containers.
    const repaired = repairTruncatedJson('{"pipeScan":["aa","bb","cc');
    expect(JSON.parse(repaired)).toEqual({ pipeScan: ['aa', 'bb'] });
  });
  it('salvages complete objects when truncated mid-object in an array', () => {
    const repaired = repairTruncatedJson('{"sewers":[{"len":5},{"len":6},{"len');
    expect(JSON.parse(repaired)).toEqual({ sewers: [{ len: 5 }, { len: 6 }] });
  });
  it('drops a trailing incomplete key/value pair inside an object', () => {
    expect(JSON.parse(repairTruncatedJson('{"a":1,"b":2,"c'))).toEqual({ a: 1, b: 2 });
  });
});

describe('findDegenerateRepetition', () => {
  // gemini-2.5-flash at temperature 0 can fall into a decode loop on a dense sheet:
  // it emitted "300mm PVC SOW-30 STM @ 1.00%" 1160 times in a row into pipeScan,
  // burned the whole maxOutputTokens budget inside the FIRST key, and so never
  // emitted sewers/manholes at all. repairTruncatedJson then "succeeds" into a
  // valid object holding only that key, which scores as a silent 0% extraction.
  it('flags a long run of an identical repeated string', () => {
    const looped = { pipeScan: Array(400).fill('300mm PVC SOW-30 STM @ 1.00%') };
    const found = findDegenerateRepetition(looped);
    expect(found).not.toBeNull();
    expect(found!.key).toBe('pipeScan');
    expect(found!.runLength).toBe(400);
  });

  it('flags an incrementing fabricated label sequence', () => {
    // The other observed shape: unique-but-arithmetic labels (SMH 30..SMH 277).
    // Every label differs, so dedupe cannot collapse it — but 248 structures on a
    // sheet whose truth is 31 is a runaway counter, not a read.
    const fabricated = { manholes: Array.from({ length: 260 }, (_, i) => ({ description: `SMH ${i + 30}` })) };
    const found = findDegenerateRepetition(fabricated);
    expect(found).not.toBeNull();
    expect(found!.key).toBe('manholes');
  });

  it('flags a runaway nested groups array (e.g. catchbasins.groups)', () => {
    const runawayCb = {
      catchbasins: {
        groups: Array.from({ length: 200 }, (_, i) => ({ type: 'SINGLE_CB', quantity: 1, depth: 1.8 + (i % 5) })),
      },
    };
    const found = findDegenerateRepetition(runawayCb);
    expect(found).not.toBeNull();
    expect(found!.key).toBe('catchbasins');
  });

  it('does NOT flag a normal dense response', () => {
    // A real dense sheet: many rows, varied labels, short repeat runs.
    const healthy = {
      sewers: Array.from({ length: 58 }, (_, i) => ({ runLabel: `MH ${i}-MH ${i + 1}`, length: 10 + (i % 7) })),
      manholes: Array.from({ length: 31 }, (_, i) => ({ description: `CBMH ${i}` })),
      pipeScan: ['17.3m-825mm CONC STM @0.5%', '12.9m-250mm PVC STM @1.0%', '8.2m-300mm PVC STM @0.7%'],
    };
    expect(findDegenerateRepetition(healthy)).toBeNull();
  });

  it('tolerates a short legitimate repeat run', () => {
    // Identical pipe callouts DO recur legitimately on a drawing (same spec, many
    // segments). Only a pathological run should trip the detector.
    const legit = { pipeScan: [...Array(12).fill('300mm PVC STM @ 1.00%'), 'MH 4-MH 5', '250mm PVC SAN'] };
    expect(findDegenerateRepetition(legit)).toBeNull();
  });

  it('ignores non-array and empty values', () => {
    expect(findDegenerateRepetition({ confidence: 0.9, warnings: [] })).toBeNull();
    expect(findDegenerateRepetition({})).toBeNull();
  });
});

describe('stripDegenerateKeys', () => {
  // Whole-batch discard was too blunt. Measured on Bradford (2026-09-12): discarding
  // 3 of 4 looped batches killed 54 fabricated structures (good) but ALSO destroyed
  // 2 real structures and 3 real runs — sewerRuns F1 fell 54%->48%. The loop is
  // usually confined to ONE key (pipeScan, which is scratch and never consumed
  // downstream), so drop only the degenerate keys and keep the healthy ones.
  it('drops only the looped key and keeps healthy entity arrays', () => {
    const batch = {
      pipeScan: Array(400).fill('300mm PVC SOW-30 STM @ 1.00%'),
      sewers: [{ runLabel: 'MH 1-MH 2', length: 40 }, { runLabel: 'MH 2-MH 3', length: 31 }],
      manholes: [{ description: 'MH 1' }, { description: 'MH 2' }],
    };
    const { cleaned, dropped } = stripDegenerateKeys(batch);
    expect(dropped.map((d) => d.key)).toEqual(['pipeScan']);
    expect(cleaned.pipeScan).toBeUndefined();
    expect(cleaned.sewers).toHaveLength(2);
    expect(cleaned.manholes).toHaveLength(2);
  });

  it('drops a fabricated entity array while keeping a healthy sibling', () => {
    const batch = {
      manholes: Array.from({ length: 260 }, (_, i) => ({ description: `SMH ${i + 30}` })),
      sewers: [{ runLabel: 'MH 1-MH 2', length: 40 }],
    };
    const { cleaned, dropped } = stripDegenerateKeys(batch);
    expect(dropped.map((d) => d.key)).toEqual(['manholes']);
    expect(cleaned.manholes).toBeUndefined();
    expect(cleaned.sewers).toHaveLength(1);
  });

  it('leaves a healthy batch completely untouched', () => {
    const batch = {
      sewers: Array.from({ length: 58 }, (_, i) => ({ runLabel: `MH ${i}-MH ${i + 1}` })),
      manholes: Array.from({ length: 31 }, (_, i) => ({ description: `CBMH ${i}` })),
    };
    const { cleaned, dropped } = stripDegenerateKeys(batch);
    expect(dropped).toEqual([]);
    expect(cleaned).toEqual(batch);
  });

  it('reports every degenerate key when more than one loops', () => {
    const batch = {
      pipeScan: Array(400).fill('x'),
      manholes: Array.from({ length: 260 }, (_, i) => ({ description: `SMH ${i}` })),
      sewers: [{ runLabel: 'MH 1-MH 2' }],
    };
    const { cleaned, dropped } = stripDegenerateKeys(batch);
    expect(dropped.map((d) => d.key).sort()).toEqual(['manholes', 'pipeScan']);
    expect(cleaned.sewers).toHaveLength(1);
  });
});

describe('tryParseJSONWithRepair', () => {
  it('parses valid JSON directly', () => {
    expect(tryParseJSONWithRepair('{"a":1}')).toEqual({ a: 1 });
  });
  it('repairs and parses truncated JSON', () => {
    expect(tryParseJSONWithRepair('{"runs":[{"len":5}')).toEqual({ runs: [{ len: 5 }] });
  });
  it('throws on irreparable input', () => {
    expect(() => tryParseJSONWithRepair('not json at all')).toThrow();
  });
});

describe('deduplicateManholes', () => {
  it('merges duplicate descriptions and fills complementary fields', () => {
    const out = deduplicateManholes([
      { description: 'MH 1', depth: 2 },
      { description: 'mh 1', topElevation: 100 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].depth).toBe(2);
    expect(out[0].topElevation).toBe(100);
  });
  it('drops entries with empty descriptions', () => {
    expect(deduplicateManholes([{ description: '' }])).toHaveLength(0);
  });
  it('collapses label variants (spacing/case/note-suffix) so structures are not over-counted', () => {
    const out = deduplicateManholes([
      { description: 'CBMH 15' }, { description: 'CBMH15' }, { description: 'CBMH 15/O.P.' },
    ]);
    expect(out).toHaveLength(1); // all normalize to CBMH15
  });
});

describe('deduplicateSewers', () => {
  it('collapses duplicate run labels', () => {
    const out = deduplicateSewers([
      { runLabel: 'ST 1', length: 50 },
      { runLabel: 'st 1', pipeDiameter: 300 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(50);
    expect(out[0].pipeDiameter).toBe(300);
  });
  it('collapses reversed endpoints into one run (order-insensitive signature)', () => {
    const out = deduplicateSewers([
      { runLabel: 'MH 5-MH 4', length: 45 },
      { runLabel: 'MH 4-MH 5', pipeDiameter: 250 },
      { runLabel: 'MH 5-MH 4/INS.' }, // note-suffix variant → same signature
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(45);
    expect(out[0].pipeDiameter).toBe(250);
  });
  it('keeps genuinely different runs', () => {
    expect(deduplicateSewers([{ runLabel: 'MH 5-MH 4' }, { runLabel: 'MH 6-MH 7' }])).toHaveLength(2);
  });
  it('keys line-items by exact label (no endpoints to signature)', () => {
    const out = deduplicateSewers([
      { runLabel: 'VIDEO', isLineItem: true }, { runLabel: 'LAYOUT', isLineItem: true },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('mergeCatchbasinGroups', () => {
  it('takes the MAX quantity per type across overlapping batches, not the sum', () => {
    const out = mergeCatchbasinGroups([
      { type: 'SINGLE_CB', quantity: 10 }, // batch 1 (whole page)
      { type: 'SINGLE_CB', quantity: 9 },  // batch 2 (overlapping tiles) — same CBs
      { type: 'DOUBLE_CB', quantity: 2 },
    ]);
    const byType = Object.fromEntries(out.map((g) => [g.type, g.quantity]));
    expect(byType['SINGLE_CB']).toBe(10); // max(10,9), NOT 19
    expect(byType['DOUBLE_CB']).toBe(2);
  });
});

describe('deduplicateWatermain', () => {
  it('sums lengths for the same size/type', () => {
    const out = deduplicateWatermain([
      { sizeAndType: '200mm C900', length: 10 },
      { sizeAndType: '200mm c900', length: 5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(15);
  });
});

describe('deduplicateSpecials / deduplicateValves', () => {
  it('sums quantities by name', () => {
    expect(
      deduplicateSpecials([
        { specialName: 'Bend', quantity: 2 },
        { specialName: 'bend', quantity: 3 },
      ])
    ).toEqual([{ specialName: 'Bend', quantity: 5 }]);
    expect(
      deduplicateValves([
        { valveSize: '200mm GV', quantity: 1 },
        { valveSize: '200mm gv', quantity: 1 },
      ])
    ).toEqual([{ valveSize: '200mm GV', quantity: 2 }]);
  });
});

describe('isNonStructure — demolition/sitework callouts listed as structures', () => {
  // On a removals sheet the model lists demolition scope as structures. It is real
  // scope, but the estimator's takeoff never carries it as a structure row.
  it.each([
    'TREE REMOVAL (TYP.)',
    'TOPSOIL & SOD REMOVAL (TYP.)',
    'ASPHALT SURFACE REMOVAL',
    'CONCRETE SIDEWALK REMOVAL',
    'GRAVEL PATH REMOVAL',
    'INTERLOCKING REMOVAL',
    'MONUMENT RELOCATION',
    'UTILITY RELOCATION COORDINATION',
    'WATER SERVICE ABANDONMENT',
    'RELOCATED WILKINSON CISTERN',
  ])('drops %s', (desc) => {
    expect(isNonStructure(desc)).toBe(true);
  });

  // The structure-code guard is what keeps this safe: a real structure is never
  // dropped just because its note happens to mention removal or relocation.
  it.each([
    'MH 1',
    'CBMH 14',
    'DCBMH 5',
    'MH 8/EXT.DROP',
    'MH 2A',
    'MH 3 (TO BE RELOCATED)',
    'CBMH 7 - ASPHALT PATCH',
    'DCVC-200',
    'OGS CHAMBER 1',
  ])('keeps %s', (desc) => {
    expect(isNonStructure(desc)).toBe(false);
  });

  it('still drops the callouts the original filter targeted', () => {
    expect(isNonStructure('PROP. BIKE RACKS')).toBe(true);
    expect(isNonStructure('SEWER CROSSING (STM)')).toBe(true);
    expect(isNonStructure('SANITARY')).toBe(true);
  });
});

describe('tilesNeededPerPage — per-page tile budget from sheet geometry', () => {
  // Pure arithmetic: no PDF, no dataset, no rasterizing. This pins the helper to the
  // real geometry in rasterize.ts::renderPdfPagesToTiles, which the helper mirrors.
  // At the defaults (TILE_DPI=150, TILE_PX=1600, TILE_OVERLAP=160 → step=1440).
  const IN = 72; // PDF points per inch

  it('needs 20 tiles for a 36x48in E-size sheet (the old cap of 16 dropped the bottom row)', () => {
    // W = ceil(36*150) = 5400 → cols = ceil((5400-160)/1440) = 4
    // H = ceil(48*150) = 7200 → rows = ceil((7200-160)/1440) = 5
    expect(tilesNeededPerPage(36 * IN, 48 * IN)).toBe(20);
  });

  it('needs only 12 tiles for a 36x24in sheet — the sizes the old cap never truncated', () => {
    // rows = ceil((3600-160)/1440) = 3, cols = 4
    expect(tilesNeededPerPage(36 * IN, 24 * IN)).toBe(12);
  });

  it('returns at least 1 tile for a degenerate/tiny page, never 0', () => {
    // (W - overlap) goes negative here; the Math.max(1, ...) floors match rasterize.ts.
    expect(tilesNeededPerPage(1, 1)).toBe(1);
    expect(tilesNeededPerPage(0, 0)).toBe(1);
  });

  it('matches rasterize on a letter-size sheet: 1 col, but 2 (overlapping) rows', () => {
    // H = ceil(11*150) = 1650 > tilePx 1600, so rasterize does emit a second row
    // (sy clamped to H - tilePx = 50). The helper must agree, not round down to 1.
    expect(tilesNeededPerPage(8.5 * IN, 11 * IN)).toBe(2);
  });

  it('stays at or under the 24 per-page cap for every sheet size in this corpus', () => {
    const sheets: [number, number][] = [
      [36, 48], [30, 42], [36, 24], [24, 36], [34, 22], [42, 30], [48, 36],
    ];
    for (const [w, h] of sheets) {
      expect(tilesNeededPerPage(w * IN, h * IN)).toBeLessThanOrEqual(24);
    }
  });
});

describe('parseWatermainFacts', () => {
  it('parses valid watermain items, specials, and valves', () => {
    const raw = {
      watermain: [
        { sizeAndType: '200mm PVC WM', length: 145.5, pipeDiameter: 200, ocSc: 1.2, avgCover: 2.1 },
        { sizeAndType: '150mm DI WM', length: '50m', pipeDiameter: 150 },
        { sizeAndType: '100mm PVC', length: 0 }, // 0-length dropped
      ],
      watermainSpecials: [
        { specialName: 'Hydrant Assembly', quantity: 2 },
        { specialName: 'Tapping Sleeve', quantity: '1' },
      ],
      watermainValves: [
        { valveSize: '200mm Gate Valve', quantity: 3 },
      ],
      warnings: ['Check connection to existing main'],
    };

    const parsed = parseWatermainFacts(raw);
    expect(parsed.watermain).toHaveLength(2);
    expect(parsed.watermain[0]).toEqual({
      sizeAndType: '200mm PVC WM',
      length: 145.5,
      pipeDiameter: 200,
      ocSc: 1.2,
      avgCover: 2.1,
    });
    expect(parsed.watermain[1]).toEqual({
      sizeAndType: '150mm DI WM',
      length: 50,
      pipeDiameter: 150,
      ocSc: 1.1,
      avgCover: 1.8,
    });
    expect(parsed.watermainSpecials).toEqual([
      { specialName: 'Hydrant Assembly', quantity: 2 },
      { specialName: 'Tapping Sleeve', quantity: 1 },
    ]);
    expect(parsed.watermainValves).toEqual([
      { valveSize: '200mm Gate Valve', quantity: 3 },
    ]);
    expect(parsed.warnings).toEqual(['Check connection to existing main']);
  });

  it('infers diameter from sizeAndType if pipeDiameter is omitted or 0', () => {
    const parsed = parseWatermainFacts({
      watermain: [
        { sizeAndType: '300mm PVC DR-18', length: 80 },
      ],
    });
    expect(parsed.watermain).toHaveLength(1);
    expect(parsed.watermain[0].pipeDiameter).toBe(300);
  });

  it('sums lengths for duplicate pipe sizes in the second pass response', () => {
    const parsed = parseWatermainFacts({
      watermain: [
        { sizeAndType: '200mm WM', length: 60, pipeDiameter: 200 },
        { sizeAndType: '200mm wm', length: 40, pipeDiameter: 200 },
      ],
    });
    expect(parsed.watermain).toHaveLength(1);
    expect(parsed.watermain[0].length).toBe(100);
  });
});

describe('two-pass watermain extraction', () => {
  it('triggers two-pass watermain when initial watermain is empty and merges facts', () => {
    const facts = parseFacts({
      manholes: [{ description: 'MH 1' }],
      sewers: [{ runLabel: 'MH 1-MH 2', length: 50, pipeDiameter: 250 }],
      watermain: [], // empty initial watermain
      watermainSpecials: [],
      watermainValves: [],
    }, 'Test Project');

    expect(facts.watermain).toHaveLength(0);

    const secondPassRaw = {
      watermain: [
        { sizeAndType: '200mm PVC WM', length: 180, pipeDiameter: 200, ocSc: 1.1, avgCover: 1.8 },
      ],
      watermainSpecials: [
        { specialName: 'Hydrant Lead', quantity: 1 },
      ],
      watermainValves: [
        { valveSize: '200mm Gate Valve', quantity: 2 },
      ],
      warnings: ['Watermain second pass note'],
    };

    const triggered = applySecondPassWatermain(facts, secondPassRaw);
    expect(triggered).toBe(true);
    expect(facts.watermain).toHaveLength(1);
    expect(facts.watermain[0]).toEqual({
      sizeAndType: '200mm PVC WM',
      length: 180,
      pipeDiameter: 200,
      ocSc: 1.1,
      avgCover: 1.8,
    });
    expect(facts.watermainSpecials).toEqual([
      { specialName: 'Hydrant Lead', quantity: 1 },
    ]);
    expect(facts.watermainValves).toEqual([
      { valveSize: '200mm Gate Valve', quantity: 2 },
    ]);
    expect(facts.warnings).toContain('Watermain second pass note');
  });

  it('does NOT trigger second pass if initial watermain was already found', () => {
    const facts = parseFacts({
      manholes: [{ description: 'MH 1' }],
      sewers: [{ runLabel: 'MH 1-MH 2', length: 50, pipeDiameter: 250 }],
      watermain: [
        { sizeAndType: '150mm PVC', length: 100, pipeDiameter: 150 },
      ],
      watermainSpecials: [{ specialName: 'Existing Special', quantity: 1 }],
      watermainValves: [{ valveSize: '150mm GV', quantity: 1 }],
    }, 'Test Project');

    expect(facts.watermain).toHaveLength(1);

    const secondPassRaw = {
      watermain: [
        { sizeAndType: '300mm PVC WM', length: 500, pipeDiameter: 300 },
      ],
      watermainSpecials: [
        { specialName: 'New Special', quantity: 5 },
      ],
      watermainValves: [
        { valveSize: '300mm GV', quantity: 5 },
      ],
    };

    const triggered = applySecondPassWatermain(facts, secondPassRaw);
    expect(triggered).toBe(false);
    expect(facts.watermain).toHaveLength(1);
    expect(facts.watermain[0].sizeAndType).toBe('150mm PVC');
    expect(facts.watermain[0].length).toBe(100);
    expect(facts.watermainSpecials).toEqual([{ specialName: 'Existing Special', quantity: 1 }]);
    expect(facts.watermainValves).toEqual([{ valveSize: '150mm GV', quantity: 1 }]);
  });

  it('returns false and keeps facts empty if second pass finds no watermain', () => {
    const facts = parseFacts({
      manholes: [],
      sewers: [],
      watermain: [],
    }, 'Test Project');

    const secondPassRaw = {
      watermain: [],
      watermainSpecials: [],
      watermainValves: [],
    };

    const triggered = applySecondPassWatermain(facts, secondPassRaw);
    expect(triggered).toBe(false);
    expect(facts.watermain).toHaveLength(0);
  });

  it('runSecondPassWatermain does not call LLM if watermain is already present', async () => {
    const facts = parseFacts({
      watermain: [{ sizeAndType: '200mm', length: 50, pipeDiameter: 200 }],
    }, 'Test Project');

    const generateFn = vi.fn();
    const preparePdfPart = vi.fn();

    const cost = { promptTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0, tiles: 0, dpi: 150 };
    const res = await runSecondPassWatermain(facts, {
      projectName: 'Test Project',
      sourceHash: 'test-hash-123',
      tileBatches: [[{ inlineData: {} }]],
      pdfBuffer: Buffer.from('mock pdf'),
      preparePdfPart,
      ai: { models: { generateContentStream: generateFn } },
      cost,
    });

    expect(res).toBe(false);
    expect(generateFn).not.toHaveBeenCalled();
    expect(preparePdfPart).not.toHaveBeenCalled();
  });

  it('runSecondPassWatermain calls LLM and merges results when watermain is initially empty', async () => {
    const facts = parseFacts({
      watermain: [],
    }, 'Test Project');

    const cost = { promptTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0, tiles: 0, dpi: 150 };
    const mockStream = (async function* () {
      yield {
        text: JSON.stringify({
          watermain: [{ sizeAndType: '250mm PVC WM', length: 120, pipeDiameter: 250 }],
          watermainSpecials: [{ specialName: 'Hydrant Tee', quantity: 2 }],
          watermainValves: [{ valveSize: '250mm Gate Valve', quantity: 1 }],
        }),
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
        candidates: [{ finishReason: 'STOP' }],
      };
    })();

    const generateFn = vi.fn().mockResolvedValue(mockStream);
    const preparePdfPart = vi.fn().mockResolvedValue({ inlineData: { mimeType: 'application/pdf', data: 'abc' } });

    // Temporarily disable eval cache for direct mock call
    const origCache = process.env.ENABLE_EVAL_CACHE;
    process.env.ENABLE_EVAL_CACHE = 'false';

    try {
      const res = await runSecondPassWatermain(facts, {
        projectName: 'Test Project',
        sourceHash: 'test-hash-empty-wm',
        tileBatches: [[]],
        pdfBuffer: Buffer.from('mock pdf'),
        preparePdfPart,
        ai: { models: { generateContentStream: generateFn } },
        cost,
      });

      expect(res).toBe(true);
      expect(generateFn).toHaveBeenCalled();
      expect(facts.watermain).toHaveLength(1);
      expect(facts.watermain[0].sizeAndType).toBe('250mm PVC WM');
      expect(facts.watermain[0].length).toBe(120);
      expect(facts.watermainSpecials).toEqual([{ specialName: 'Hydrant Tee', quantity: 2 }]);
      expect(facts.watermainValves).toEqual([{ valveSize: '250mm Gate Valve', quantity: 1 }]);
    } finally {
      process.env.ENABLE_EVAL_CACHE = origCache;
    }
  });
});


describe('contiguousRuns', () => {
  it('groups ascending indices into contiguous runs', () => {
    expect(contiguousRuns([3, 4, 5, 9, 10])).toEqual([[3, 4, 5], [9, 10]]);
  });
  it('sorts, dedupes, and handles the empty case', () => {
    expect(contiguousRuns([])).toEqual([]);
    expect(contiguousRuns([7, 5, 6, 5])).toEqual([[5, 6, 7]]);
  });
});

describe('sanitizeTranscriptTiles', () => {
  const tile = (n: number, blocks: string[][]) => ({ tile: n, blocks });

  it('keeps an ordinary tile untouched', () => {
    const raw = [tile(1, [['STMH 4', 'T/G=224.95'], ['30.0m-250mmØ STM @ 0.5%']])];
    const out = sanitizeTranscriptTiles(raw, 0, 1);
    expect(out.tiles).toEqual(raw);
    expect(out.degenerate).toEqual([]);
    expect(out.missing).toEqual([]);
  });

  // Bradford tile 18: the SAME block emitted 639 times in a row.
  it('empties a tile caught by the identical-run rule', () => {
    const blocks = Array.from({ length: 200 }, () => ['D/T 0.1', '224.09', '223.86']);
    const out = sanitizeTranscriptTiles([tile(18, blocks)], 17, 1);
    expect(out.degenerate).toEqual([18]);
    expect(out.tiles[0].blocks).toEqual([]);
    expect(out.missing).toEqual([]); // it came back, it was just useless
  });

  // Bradford tile 2: EX CBMH1036 -> 668, every block textually DISTINCT, identical
  // elevations. Dedup cannot touch this; only the array-length rule catches it.
  it('empties a counter loop whose blocks are all distinct', () => {
    const blocks = Array.from({ length: 369 }, (_, i) => [
      `EX CBMH${1036 - i} (1200Ø)`, 'T/G=223.43', 'N INV=222.680', 'S INV=222.680',
    ]);
    const out = sanitizeTranscriptTiles([tile(2, blocks)], 0, 2);
    expect(out.degenerate).toEqual([2]);
    expect(out.tiles.find((t) => t.tile === 2)!.blocks).toEqual([]);
  });

  // Ecole batch 1: tiles 1-16 requested, only 1,2,3 came back before the token
  // budget ran out. The other 13 are the RECALL loss worth recovering.
  it('reports tiles that were requested but never returned', () => {
    const raw = [tile(1, [['A']]), tile(2, [['B']]), tile(3, [['C']])];
    const out = sanitizeTranscriptTiles(raw, 0, 16);
    expect(out.missing).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(contiguousRuns(out.missing)).toEqual([[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]]);
  });

  it('honours the tile offset when deciding what is missing', () => {
    const out = sanitizeTranscriptTiles([tile(17, [['A']])], 16, 16);
    expect(out.missing[0]).toBe(18);
    expect(out.missing[out.missing.length - 1]).toBe(32);
  });

  it('drops non-array blocks and coerces lines to strings (pre-refactor contract)', () => {
    const raw = [{ tile: 1, blocks: [['MH 1', 224.95], 'not-a-block', null, [300]] }];
    const out = sanitizeTranscriptTiles(raw as any, 0, 1);
    expect(out.tiles[0].blocks).toEqual([['MH 1', '224.95'], ['300']]);
  });

  it('ignores malformed tile entries rather than throwing', () => {
    const out = sanitizeTranscriptTiles([null, { tile: 'x' }, { tile: 2 }] as any, 0, 2);
    expect(out.tiles.map((t) => t.tile)).toEqual([2]);
    expect(out.missing).toEqual([1]);
  });
});
