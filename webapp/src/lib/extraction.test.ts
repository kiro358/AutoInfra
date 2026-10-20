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
  recoverTranscriptTiles,
  contiguousRuns,
  assembleHybridTakeoff,
  countEntities,
  unionLocatedPages,
  selectImageOnlyCandidates,
  applyImageOnlyRecheck,
  MAX_IMAGE_ONLY_ADMISSIONS,
  ROLE_LOCATIONS,
  ROLE_MODELS,
  ROLE_THINKING,
  FALLBACK_MODEL,
  getGenAI,
  type CostAcc,
} from './extraction';
import { ThinkingLevel } from '@google/genai';
import { createModelFallbackState } from './model-config';
import { assembleTextTakeoff } from './text-takeoff';
import { isTextyPage, hasAnnotationForm, PageText } from './pdf-text';
import { TileTranscript } from './types';

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

    const cost: CostAcc = { promptTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0, tiles: 0, dpi: 150 };
    const mockStream = (async function* () {
      yield {
        text: JSON.stringify({
          watermain: [{ sizeAndType: '250mm PVC WM', length: 120, pipeDiameter: 250 }],
          watermainSpecials: [{ specialName: 'Hydrant Tee', quantity: 2 }],
          watermainValves: [{ valveSize: '250mm Gate Valve', quantity: 1 }],
        }),
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 25, totalTokenCount: 175 },
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
      // PR30: usage is bucketed under the watermain role's resolved model and
      // thoughts tokens are accumulated (billed at the output rate downstream).
      // PR36: the watermain role's resolved model is now gemini-3.5-flash-lite.
      expect(cost.thoughtsTokens).toBe(25);
      expect(cost.byModel).toEqual({
        'gemini-3.5-flash-lite': {
          model: 'gemini-3.5-flash-lite',
          promptTokens: 100,
          outputTokens: 50,
          thoughtsTokens: 25,
          totalTokens: 175,
          llmCalls: 1,
        },
      });
    } finally {
      process.env.ENABLE_EVAL_CACHE = origCache;
    }
  });
});


describe('PR34 model fallback — runSecondPassWatermain end-to-end', () => {
  const err404 = () => Object.assign(
    new Error('Publisher model `projects/x/locations/us/publishers/google/models/gemini-3.5-flash-lite` was not found or your project does not have access to it'),
    { status: 404 },
  );
  const wmStream = () => (async function* () {
    yield {
      text: JSON.stringify({
        watermain: [{ sizeAndType: '250mm PVC WM', length: 120, pipeDiameter: 250 }],
        watermainSpecials: [],
        watermainValves: [],
      }),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 25, totalTokenCount: 175 },
      candidates: [{ finishReason: 'STOP' }],
    };
  })();
  const freshCost = (): CostAcc => ({ promptTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0, tiles: 0, dpi: 150 });

  async function withCacheOff<T>(fn: () => Promise<T>): Promise<T> {
    const orig = process.env.ENABLE_EVAL_CACHE;
    process.env.ENABLE_EVAL_CACHE = 'false';
    try { return await fn(); } finally { process.env.ENABLE_EVAL_CACHE = orig; }
  }

  it('trips on a 404: retries once on the fallback, records the trip, buckets usage under the fallback, and sticks for the job', async () => {
    await withCacheOff(async () => {
      const facts = parseFacts({ watermain: [] }, 'Test Project');
      const cost = freshCost();
      const state = createModelFallbackState('gemini-3.1-flash-lite');
      const seenModels: string[] = [];
      const generateFn = vi.fn(async (args: any) => {
        seenModels.push(args.model);
        if (args.model === 'gemini-3.5-flash-lite') throw err404();
        return wmStream();
      });
      const preparePdfPart = vi.fn().mockResolvedValue({ inlineData: { mimeType: 'application/pdf', data: 'abc' } });
      const opts = (f: any, c: CostAcc, h: string) => ({
        projectName: 'Test Project', sourceHash: h, tileBatches: [[]],
        pdfBuffer: Buffer.from('mock pdf'), preparePdfPart,
        ai: { models: { generateContentStream: generateFn } }, cost: c, modelFallback: state,
      });

      const res = await runSecondPassWatermain(facts, opts(facts, cost, 'test-hash-wm-fallback'));
      expect(res).toBe(true);
      // Exactly one retry: configured model first, fallback second.
      expect(seenModels).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
      expect(state.trips).toEqual([{ role: 'watermain', from: 'gemini-3.5-flash-lite', to: 'gemini-3.1-flash-lite' }]);
      // Telemetry follows the EFFECTIVE model: nothing is bucketed under the configured model.
      expect(Object.keys(cost.byModel ?? {})).toEqual(['gemini-3.1-flash-lite']);
      expect(cost.byModel!['gemini-3.1-flash-lite'].llmCalls).toBe(1);
      expect(facts.watermain).toHaveLength(1);

      // Sticks for the job: a later run sharing the state calls the
      // fallback directly — the unavailable model is never retried.
      const facts2 = parseFacts({ watermain: [] }, 'Test Project');
      seenModels.length = 0;
      const res2 = await runSecondPassWatermain(facts2, opts(facts2, freshCost(), 'test-hash-wm-fallback-2'));
      expect(res2).toBe(true);
      expect(seenModels).toEqual(['gemini-3.1-flash-lite']);
      expect(state.trips).toHaveLength(1);
    });
  });

  it('does NOT trip on a non-availability error: no fallback call, no trip, batch contributes nothing', async () => {
    await withCacheOff(async () => {
      const facts = parseFacts({ watermain: [] }, 'Test Project');
      const state = createModelFallbackState('gemini-3.1-flash-lite');
      const generateFn = vi.fn(async () => {
        throw Object.assign(new Error('INVALID_ARGUMENT: bad request'), { status: 400 });
      });
      const res = await runSecondPassWatermain(facts, {
        projectName: 'Test Project',
        sourceHash: 'test-hash-wm-no-trip',
        tileBatches: [[]],
        pdfBuffer: Buffer.from('mock pdf'),
        preparePdfPart: vi.fn().mockResolvedValue({ inlineData: { mimeType: 'application/pdf', data: 'abc' } }),
        ai: { models: { generateContentStream: generateFn } },
        cost: freshCost(),
        modelFallback: state,
      });
      expect(res).toBe(false);
      expect(generateFn).toHaveBeenCalledTimes(1);
      expect(state.trips).toEqual([]);
      expect(facts.watermain).toHaveLength(0);
    });
  });

  it('when the fallback also 404s the trip is still recorded, but the batch fails cleanly after exactly one retry', async () => {
    await withCacheOff(async () => {
      const facts = parseFacts({ watermain: [] }, 'Test Project');
      const state = createModelFallbackState('gemini-3.1-flash-lite');
      const generateFn = vi.fn(async () => { throw err404(); });
      const res = await runSecondPassWatermain(facts, {
        projectName: 'Test Project',
        sourceHash: 'test-hash-wm-double-404',
        tileBatches: [[]],
        pdfBuffer: Buffer.from('mock pdf'),
        preparePdfPart: vi.fn().mockResolvedValue({ inlineData: { mimeType: 'application/pdf', data: 'abc' } }),
        ai: { models: { generateContentStream: generateFn } },
        cost: freshCost(),
        modelFallback: state,
      });
      expect(res).toBe(false);
      expect(generateFn).toHaveBeenCalledTimes(2);
      expect(state.trips).toEqual([{ role: 'watermain', from: 'gemini-3.5-flash-lite', to: 'gemini-3.1-flash-lite' }]);
      expect(facts.watermain).toHaveLength(0);
    });
  });
});

describe('PR30 role-based model assignment — module wiring (clean env)', () => {
  // resolution LOGIC under env variations is pinned in model-config.test.ts;
  // this pins that extraction.ts actually resolved the defaults and
  // per-role thinking configs at module load (no env set in the test runner).
  it('resolves the role defaults per role (PR36: every role on gemini-3.5-flash-lite)', () => {
    expect(ROLE_MODELS).toEqual({
      locator: 'gemini-3.5-flash-lite',
      recheck: 'gemini-3.5-flash-lite',
      verify: 'gemini-3.5-flash-lite',
      transcription: 'gemini-3.5-flash-lite',
      single: 'gemini-3.5-flash-lite',
      watermain: 'gemini-3.5-flash-lite',
    });
  });

  it('pins thinking levels for the 3.x defaults: MINIMAL for the verdict roles, MEDIUM at the code-default budget (PR34)', () => {
    // 3.5-flash-lite is a 3.x model → thinkingLevel, never a numeric budget.
    // Locator/recheck/verify pin thinking OFF → MINIMAL on 3.x;
    // transcription/single/watermain at the code-default budget 8192 → MEDIUM.
    expect(ROLE_THINKING.locator).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(ROLE_THINKING.recheck).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(ROLE_THINKING.verify).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(ROLE_THINKING.transcription).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
    expect(ROLE_THINKING.single).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
    expect(ROLE_THINKING.watermain).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
  });

  it('resolves every role location to us and the fallback model to gemini-3.1-flash-lite (PR34 locations, PR36 fallback)', () => {
    expect(ROLE_LOCATIONS).toEqual({
      locator: 'us',
      recheck: 'us',
      verify: 'us',
      transcription: 'us',
      single: 'us',
      watermain: 'us',
    });
    expect(FALLBACK_MODEL).toBe('gemini-3.1-flash-lite');
  });
});

describe('PR34 getGenAI — per-location client cache', () => {
  // The SDK validates eagerly, and the test env carries no GCP project, so
  // construct through the API-key branch (getGenAI reads the key at call
  // time). Location is ignored by that branch — the cache semantics under
  // test are the factory's own Map, identical on both branches.
  function withApiKeyEnv(fn: () => void) {
    const origKey = process.env.GEMINI_API_KEY;
    const origVertex = process.env.USE_VERTEX_AI;
    process.env.GEMINI_API_KEY = 'test-key-not-real';
    delete process.env.USE_VERTEX_AI;
    try { fn(); } finally {
      if (origKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = origKey;
      if (origVertex === undefined) delete process.env.USE_VERTEX_AI; else process.env.USE_VERTEX_AI = origVertex;
    }
  }

  it('returns the SAME instance for the same location and distinct instances per location', () => {
    withApiKeyEnv(() => {
      expect(getGenAI('us')).toBe(getGenAI('us'));
      expect(getGenAI('global')).toBe(getGenAI('global'));
      expect(getGenAI('us')).not.toBe(getGenAI('global'));
      expect(getGenAI('us')).not.toBe(getGenAI('eu'));
    });
  });

  it('the no-arg call is the GCP_LOCATION default client (us-central1 in a clean env)', () => {
    withApiKeyEnv(() => {
      expect(getGenAI()).toBe(getGenAI('us-central1'));
      expect(getGenAI()).not.toBe(getGenAI('us'));
    });
  });
});

describe('assembleHybridTakeoff — zero-yield fallback routing', () => {
  const ptPage = (page: number, items: { text: string; x: number; y: number }[]): PageText => ({
    page, width: 2592, height: 1728,
    items: items.map((i) => ({ ...i, width: 120, height: 12 })),
  });

  // A genuine texty servicing page: labels + elevations + run callouts.
  const yieldingPage = ptPage(1, [
    { text: 'STMH 1', x: 100, y: 900 },
    { text: 'T/G=224.95', x: 105, y: 885 },
    { text: 'N INV=223.35', x: 105, y: 870 },
    { text: '45.0m - 250mmØ PVC STM @ 0.50%', x: 400, y: 900 },
    { text: '60.0m - 300mmØ PVC STM @ 0.35%', x: 400, y: 800 },
    { text: '30.0m - 200mmØ PVC SAN @ 1.00%', x: 400, y: 700 },
  ]);

  // Texty by both classifier gates (10 mm hits = keyword density + annotation
  // forms) but NOTHING on it assembles: a sizes/spec list, no callout grammar.
  // This is the production fallback shape (Ultimate Drive p5, Stevenson p6).
  const zeroYieldPage = ptPage(2, [
    { text: 'PIPE SIZES SHOWN ARE NOMINAL', x: 100, y: 900 },
    { text: '250mm 300mm 375mm 450mm 525mm 600mm 750mm 900mm 1050mm 1200mm', x: 100, y: 850 },
  ]);

  // No callout content at all — routed to vision by the classifier already.
  const rasterPage = ptPage(3, [
    { text: 'GENERAL NOTES AND INDEX', x: 100, y: 900 },
    { text: 'SHEET LIST', x: 100, y: 850 },
  ]);

  const fallbackTiles: TileTranscript[] = [
    { tile: 1, blocks: [['MH 7', 'RIM: 90.50', 'INV: 88.10'], ['22.0m - 200mmØ PVC @ 1.00%']] },
  ];
  const rasterTiles: TileTranscript[] = [
    { tile: 13, blocks: [['CB 3', 'RIM: 91.00']] },
  ];

  it('fixtures have the routing properties the tests rely on', () => {
    expect(isTextyPage(yieldingPage)).toBe(true);
    expect(isTextyPage(zeroYieldPage)).toBe(true);
    expect(isTextyPage(rasterPage)).toBe(false);
    expect(countEntities(assembleTextTakeoff([yieldingPage], 'T'))).toBeGreaterThan(0);
    expect(countEntities(assembleTextTakeoff([zeroYieldPage], 'T'))).toBe(0);
  });

  it('re-routes a zero-yield texty page to vision transcription and merges its facts', async () => {
    const transcribe = vi.fn(async (_pages: number[]) => fallbackTiles);
    const out = await assembleHybridTakeoff([yieldingPage, zeroYieldPage], [1, 2], 'T', transcribe);

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith([2]);
    expect(out.fallbackPageNums).toEqual([2]);
    expect(out.textyPageNums).toEqual([1, 2]);
    expect(out.rasterPageNums).toEqual([2]);
    // Text facts survive (primary) AND the fallback page's vision facts land.
    const labels = out.facts.structures.map((s) => s.description);
    expect(labels).toContain('STMH 1');
    expect(labels).toContain('MH 7');
    expect(out.facts.sewers.some((s) => s.pipeDiameter === 200 && s.length === 22.0)).toBe(true);
    expect(out.transcript).toEqual(fallbackTiles);
  });

  it('does NOT transcribe a texty page that yields entities (no fallback, no vision cost)', async () => {
    const transcribe = vi.fn(async (_pages: number[]) => fallbackTiles);
    const out = await assembleHybridTakeoff([yieldingPage], [1], 'T', transcribe);

    expect(transcribe).not.toHaveBeenCalled();
    expect(out.fallbackPageNums).toEqual([]);
    expect(out.rasterPageNums).toEqual([]);
    expect(out.transcript).toEqual([]);
    expect(out.facts.structures.map((s) => s.description)).toContain('STMH 1');
    expect(out.facts.sewers.length).toBeGreaterThanOrEqual(3);
  });

  it('mixed routing: zero-yield texty and non-texty pages are transcribed together, yielding page stays text-only', async () => {
    const transcribe = vi.fn(async (pages: number[]) => [
      ...(pages.includes(2) ? fallbackTiles : []),
      ...(pages.includes(3) ? rasterTiles : []),
    ]);
    const out = await assembleHybridTakeoff(
      [yieldingPage, zeroYieldPage, rasterPage], [1, 2, 3], 'T', transcribe,
    );

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith([2, 3]);
    expect(out.fallbackPageNums).toEqual([2]);
    expect(out.rasterPageNums).toEqual([2, 3]);
    expect(out.facts.structures.map((s) => s.description)).toContain('STMH 1');
    expect(out.facts.structures.map((s) => s.description)).toContain('MH 7');
    expect(out.facts.catchbasins.reduce((a, c) => a + c.quantity, 0)).toBeGreaterThanOrEqual(1);
  });
});

describe('assembleHybridTakeoff — zero-RUN-yield fallback routing (PR24)', () => {
  const ptPage = (page: number, items: { text: string; x: number; y: number }[]): PageText => ({
    page, width: 2592, height: 1728,
    items: items.map((i) => ({ ...i, width: 120, height: 12 })),
  });

  // The Eric Smith shape: a servicing strip repeated on every sheet yields
  // structures + catchbasins from the text layer, but every pipe run on the
  // sheet is drawn as strokes — the text grammar reads ZERO runs. Texty by
  // both classifier gates (T/G + INV density + annotation forms).
  const stripPage = ptPage(5, [
    { text: 'MH1', x: 100, y: 900 }, { text: 'T/G=224.95', x: 105, y: 885 }, { text: 'N INV=223.35', x: 105, y: 870 }, { text: 'S INV=223.50', x: 105, y: 855 },
    { text: 'MH2', x: 300, y: 900 }, { text: 'T/G=225.10', x: 305, y: 885 }, { text: 'N INV=223.60', x: 305, y: 870 }, { text: 'S INV=223.75', x: 305, y: 855 },
    { text: 'MH3', x: 500, y: 900 }, { text: 'T/G=225.40', x: 505, y: 885 }, { text: 'N INV=224.00', x: 505, y: 870 }, { text: 'S INV=224.15', x: 505, y: 855 },
    { text: 'MH4', x: 700, y: 800 }, { text: 'T/G=225.60', x: 705, y: 785 }, { text: 'N INV=224.20', x: 705, y: 770 }, { text: 'S INV=224.35', x: 705, y: 755 },
    { text: 'CB1', x: 900, y: 900 }, { text: 'CB2', x: 950, y: 900 }, { text: 'CB3', x: 1000, y: 900 },
  ]);

  // A lone structure parsed out of a sizes/spec list: total yield 1. The
  // yield-1 fragment class (a manufacturer's detail sheet is the census's
  // real example) must NOT trigger a vision pass.
  const fragmentPage = ptPage(6, [
    { text: 'STMH 1', x: 100, y: 900 }, { text: 'T/G=224.95', x: 105, y: 885 }, { text: 'N INV=223.35', x: 105, y: 870 },
    { text: '250mm 300mm 375mm 450mm 525mm 600mm 750mm 900mm 1050mm 1200mm', x: 100, y: 700 },
  ]);

  // Structures + a WATERMAIN run, zero sewers: pipe-run yield is 1, so the
  // page is not run-blind and must stay text-only.
  const wmPage = ptPage(7, [
    { text: 'MH1', x: 100, y: 900 }, { text: 'T/G=224.95', x: 105, y: 885 }, { text: 'N INV=223.35', x: 105, y: 870 },
    { text: 'MH2', x: 300, y: 900 }, { text: 'T/G=225.10', x: 305, y: 885 }, { text: 'N INV=223.60', x: 305, y: 870 },
    { text: '120.0m - 150mmØ PVC WATERMAIN', x: 400, y: 800 },
    { text: '250mmØ PVC', x: 600, y: 800 }, { text: '300mmØ PVC', x: 600, y: 750 },
  ]);

  // Vision's read of the strip page: it re-reads two of the strip
  // structures (MH1 with a CONFLICTING rim — text must win), finds one
  // structure the strip did not name, and reads the stroke-only run.
  const stripTiles: TileTranscript[] = [
    { tile: 1, blocks: [
      ['MH1', 'RIM: 999.99', 'INV: 223.35'],
      ['MH2', 'RIM: 225.10', 'INV: 223.60'],
      ['MH 9', 'RIM: 226.00', 'INV: 224.50'],
      ['45.0m - 250mmØ PVC STM @ 0.50%'],
    ] },
  ];

  it('fixtures have the routing properties the tests rely on', () => {
    expect(isTextyPage(stripPage)).toBe(true);
    expect(isTextyPage(fragmentPage)).toBe(true);
    expect(isTextyPage(wmPage)).toBe(true);
    const strip = assembleTextTakeoff([stripPage], 'T');
    expect(strip.structures).toHaveLength(4);
    expect(strip.sewers).toHaveLength(0);
    expect(strip.watermain).toHaveLength(0);
    expect(countEntities(assembleTextTakeoff([fragmentPage], 'T'))).toBe(1);
    const wm = assembleTextTakeoff([wmPage], 'T');
    expect(wm.sewers).toHaveLength(0);
    expect(wm.watermain).toHaveLength(1);
  });

  it('fires on a structures-but-zero-runs page and merges vision as ADDITIVE (no double-count, text wins)', async () => {
    const transcribe = vi.fn(async (_pages: number[]) => stripTiles);
    const out = await assembleHybridTakeoff([stripPage], [5], 'T', transcribe);

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith([5]);
    expect(out.runFallbackPageNums).toEqual([5]);
    expect(out.fallbackPageNums).toEqual([]);
    expect(out.rasterPageNums).toEqual([5]);
    expect(out.textyPageRunYields[5]).toBe(0);
    expect(out.textyPageYields[5]).toBe(5);

    // Structures: the four text structures + vision's one new structure —
    // the two re-read structures are NOT duplicated.
    const labels = out.facts.structures.map((s) => s.description.replace(/\s+/g, ''));
    expect(labels.sort()).toEqual(['MH1', 'MH2', 'MH3', 'MH4', 'MH9']);
    // Text wins the field both paths read: MH1's rim stays the text layer's
    // 224.95, not vision's conflicting 999.99.
    const mh1 = out.facts.structures.find((s) => s.description.replace(/\s+/g, '') === 'MH1')!;
    expect(mh1.topElevation).toBe(224.95);
    expect(mh1.lowInvert).toBe(223.35);
    // The stroke-only run lands exactly once; the catchbasin group is the
    // text layer's, unchanged.
    expect(out.facts.sewers).toHaveLength(1);
    expect(out.facts.sewers[0].length).toBe(45);
    expect(out.facts.sewers[0].pipeDiameter).toBe(250);
    expect(out.facts.catchbasins).toEqual([
      expect.objectContaining({ type: 'SINGLE_CB', quantity: 3 }),
    ]);
  });

  it('does NOT fire on a page that yields sewer runs', async () => {
    const yielding = ptPage(1, [
      { text: 'STMH 1', x: 100, y: 900 },
      { text: 'T/G=224.95', x: 105, y: 885 },
      { text: 'N INV=223.35', x: 105, y: 870 },
      { text: '45.0m - 250mmØ PVC STM @ 0.50%', x: 400, y: 900 },
      { text: '60.0m - 300mmØ PVC STM @ 0.35%', x: 400, y: 800 },
      { text: '30.0m - 200mmØ PVC SAN @ 1.00%', x: 400, y: 700 },
    ]);
    const transcribe = vi.fn(async (_pages: number[]) => stripTiles);
    const out = await assembleHybridTakeoff([yielding], [1], 'T', transcribe);
    expect(transcribe).not.toHaveBeenCalled();
    expect(out.runFallbackPageNums).toEqual([]);
    expect(out.textyPageRunYields[1]).toBeGreaterThanOrEqual(1);
  });

  it('does NOT fire on a page whose only pipe yield is watermain', async () => {
    const transcribe = vi.fn(async (_pages: number[]) => stripTiles);
    const out = await assembleHybridTakeoff([wmPage], [7], 'T', transcribe);
    expect(transcribe).not.toHaveBeenCalled();
    expect(out.runFallbackPageNums).toEqual([]);
    expect(out.textyPageRunYields[7]).toBe(1);
    expect(out.facts.watermain).toHaveLength(1);
  });

  it('does NOT fire on a yield-1 fragment page (lone entity is not a bearing plan page)', async () => {
    const transcribe = vi.fn(async (_pages: number[]) => stripTiles);
    const out = await assembleHybridTakeoff([fragmentPage], [6], 'T', transcribe);
    expect(transcribe).not.toHaveBeenCalled();
    expect(out.runFallbackPageNums).toEqual([]);
    expect(out.fallbackPageNums).toEqual([]);
    expect(out.rasterPageNums).toEqual([]);
  });

  it('keeps the two fallbacks disjoint: zero-yield pages stay zero-yield, strip pages are run-fallbacks', async () => {
    const zeroYield = ptPage(2, [
      { text: 'PIPE SIZES SHOWN ARE NOMINAL', x: 100, y: 900 },
      { text: '250mm 300mm 375mm 450mm 525mm 600mm 750mm 900mm 1050mm 1200mm', x: 100, y: 850 },
    ]);
    const transcribe = vi.fn(async (_pages: number[]) => stripTiles);
    const out = await assembleHybridTakeoff([zeroYield, stripPage], [2, 5], 'T', transcribe);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith([2, 5]);
    expect(out.fallbackPageNums).toEqual([2]);
    expect(out.runFallbackPageNums).toEqual([5]);
    expect(out.rasterPageNums).toEqual([2, 5]);
  });
});

describe('unionLocatedPages — locator union with text-layer-bearing pages', () => {
  const ptPage = (page: number, texts: string[]): PageText => ({
    page, width: 2592, height: 1728,
    items: texts.map((text, i) => ({ text, x: 100, y: 900 - i * 20, width: 120, height: 12 })),
  });

  // Bearing by annotation form with ZERO yield: callout shapes in the text
  // layer that the grammar cannot assemble into entities (the SHX shape).
  const annPage = ptPage(2, ['250mmØ PVC STM', '375mmØ PVC STM', 'PVC PIPE ALONG ALIGNMENT']);
  // Bearing by yield only: named structures with no digit anywhere — the
  // annotation-form regex cannot see them, but the text assembler reads two.
  const yieldPage = ptPage(3, ['HEADWALL', 'FLARED END SECTION']);
  // Prose only: servicing keywords throughout, no callout shapes, no yield.
  const prosePage = ptPage(4, [
    'GENERAL NOTES',
    'STORM SEWER AND SANITARY SEWER NOTES',
    'WATERMAIN PVC PIPE',
    'INV AND T/G ELEVATIONS PER DETAIL',
    'CB AND MH STRUCTURES',
  ]);
  // The Loretto key-plan shape: annotation forms present, but the page's
  // entire yield is ONE lone run fragment — not proof of a bearing page.
  const fragmentPage = ptPage(5, ['45.0m - 250mmØ PVC STM @ 0.50%']);
  const locatedPage = ptPage(1, ['TITLE BLOCK']);

  it('fixtures have the evidence properties the tests rely on', () => {
    expect(hasAnnotationForm(annPage)).toBe(true);
    expect(countEntities(assembleTextTakeoff([annPage], 'T'))).toBe(0);
    expect(hasAnnotationForm(yieldPage)).toBe(false);
    expect(countEntities(assembleTextTakeoff([yieldPage], 'T'))).toBe(2);
    expect(hasAnnotationForm(prosePage)).toBe(false);
    expect(countEntities(assembleTextTakeoff([prosePage], 'T'))).toBe(0);
    expect(hasAnnotationForm(fragmentPage)).toBe(true);
    expect(countEntities(assembleTextTakeoff([fragmentPage], 'T'))).toBe(1);
  });

  it('adds an unlocated zero-yield page with annotation-form evidence', () => {
    const out = unionLocatedPages([1], [locatedPage, annPage], 'T');
    expect(out.pages).toEqual([1, 2]);
    expect(out.added).toEqual([{ page: 2, reason: 'annotation-form' }]);
  });

  it('adds an unlocated page the text assembler reads repeatedly (text-yield)', () => {
    const out = unionLocatedPages([1], [locatedPage, yieldPage], 'T');
    expect(out.pages).toEqual([1, 3]);
    expect(out.added).toEqual([{ page: 3, reason: 'text-yield' }]);
  });

  it('does NOT add a page whose entire yield is a single fragment', () => {
    const out = unionLocatedPages([1], [locatedPage, fragmentPage], 'T');
    expect(out.pages).toEqual([1]);
    expect(out.added).toEqual([]);
  });

  it('does NOT add a prose-only page (legend/notes)', () => {
    const out = unionLocatedPages([1], [locatedPage, prosePage], 'T');
    expect(out.pages).toEqual([1]);
    expect(out.added).toEqual([]);
  });

  it('empty locator set: returns exactly the proven-bearing pages, sorted', () => {
    const out = unionLocatedPages([], [prosePage, yieldPage, annPage], 'T');
    expect(out.pages).toEqual([2, 3]);
    expect(out.added.map((a) => a.page)).toEqual([2, 3]);
  });

  it('never duplicates a located page and never removes one', () => {
    const dup = unionLocatedPages([2], [annPage, prosePage], 'T');
    expect(dup.pages).toEqual([2]);
    expect(dup.added).toEqual([]);
    // A located page stays located even when it carries no evidence itself.
    const kept = unionLocatedPages([4], [prosePage, annPage], 'T');
    expect(kept.pages).toEqual([2, 4]);
  });
});

describe('image-only locator pass — selectImageOnlyCandidates / applyImageOnlyRecheck', () => {
  const ptPage = (page: number, texts: string[]): PageText => ({
    page, width: 2592, height: 1728,
    items: texts.map((text, i) => ({ text, x: 100, y: 900 - i * 20, width: 120, height: 12 })),
  });
  const drawn = (entries: [number, { pathOps: number; imageOps: number }][]) => new Map(entries);

  // Pure scan: literally no text layer, one painted image (the Gerrard
  // plan & profile shape — its located siblings have the same signature).
  const scanPage = ptPage(2, []);
  // Dense vector CAD whose text layer is fragmented prose: no annotation
  // form, zero yield (the Panattoni C101 shape).
  const vectorPage = ptPage(3, ['CIVIL DRAWING', 'SCALE 1:500', 'SHEET C-101']);
  // Prose document page: text present, almost no drawn content (the
  // appendix/tender class the drawn gate exists to refuse).
  const prosePage = ptPage(4, ['GENERAL NOTES', 'THE CONTRACTOR SHALL VERIFY ALL DIMENSIONS']);
  // Blank separator: no text, no drawing, no image.
  const blankPage = ptPage(5, []);
  // Annotation-form page: the union's class, not this pass's — even drawn.
  const annPage = ptPage(6, ['250mmØ PVC STM', '375mmØ PVC STM', 'PVC PIPE ALONG ALIGNMENT']);
  // Yield-1 page with no annotation form: a lone fragment is not proof
  // of a bearing page (PR17's lesson), however dense the drawing is.
  const fragmentPage = ptPage(7, ['HEADWALL']);
  // Genuinely texty page: many callouts — the text path's class.
  const textyPage = ptPage(8, Array.from({ length: 6 }, () => '250mmØ PVC STM'));
  const locatedPage = ptPage(1, ['TITLE BLOCK']);

  const stats = drawn([
    [1, { pathOps: 10, imageOps: 0 }],
    [2, { pathOps: 1, imageOps: 1 }],
    [3, { pathOps: 50000, imageOps: 2 }],
    [4, { pathOps: 200, imageOps: 2 }],
    [5, { pathOps: 0, imageOps: 0 }],
    [6, { pathOps: 9000, imageOps: 0 }],
    [7, { pathOps: 9000, imageOps: 0 }],
    [8, { pathOps: 9000, imageOps: 0 }],
  ]);
  const allPages = [locatedPage, scanPage, vectorPage, prosePage, blankPage, annPage, fragmentPage, textyPage];

  it('fixtures have the evidence properties the tests rely on', () => {
    for (const p of [scanPage, vectorPage, prosePage, blankPage]) {
      expect(hasAnnotationForm(p)).toBe(false);
      expect(countEntities(assembleTextTakeoff([p], 'T'))).toBe(0);
    }
    expect(isTextyPage(scanPage)).toBe(false);
    expect(isTextyPage(vectorPage)).toBe(false);
    expect(hasAnnotationForm(annPage)).toBe(true);
    expect(countEntities(assembleTextTakeoff([fragmentPage], 'T'))).toBe(1);
    expect(hasAnnotationForm(fragmentPage)).toBe(false);
    expect(isTextyPage(textyPage)).toBe(true);
  });

  it('shortlists the pure scan and the dense vector sheet, strongest evidence first', () => {
    const out = selectImageOnlyCandidates(allPages, [1], stats, 'T');
    expect(out).toEqual([3, 2]);
  });

  it('refuses prose, blank, annotation-form, yield-1, texty, and located pages', () => {
    const out = selectImageOnlyCandidates(allPages, [1], stats, 'T');
    for (const refused of [1, 4, 5, 6, 7, 8]) expect(out).not.toContain(refused);
  });

  it('refuses a page with no drawn-content measurement', () => {
    const out = selectImageOnlyCandidates([vectorPage], [], new Map(), 'T');
    expect(out).toEqual([]);
  });

  it('caps the re-check shortlist at 8, keeping the densest pages', () => {
    const pages = Array.from({ length: 10 }, (_, i) => ptPage(10 + i, ['CIVIL DRAWING']));
    const many = drawn(pages.map((p, i) => [p.page, { pathOps: 2000 * (i + 1), imageOps: 0 }] as [number, { pathOps: number; imageOps: number }]));
    const out = selectImageOnlyCandidates(pages, [], many, 'T');
    expect(out.length).toBe(8);
    expect(out[0]).toBe(19); // 20000 path ops — densest first
    expect(out).not.toContain(10);
    expect(out).not.toContain(11);
  });

  it('admits only re-check picks inside the shortlist, with the image-only reason', () => {
    const out = applyImageOnlyRecheck([1], [3, 2], new Set([2]));
    expect(out.pages).toEqual([1, 2]);
    expect(out.added).toEqual([{ page: 2, reason: 'image-only-locator' }]);
    // A pick outside the shortlist is ignored; located pages are kept.
    const stray = applyImageOnlyRecheck([1], [3, 2], new Set([9]));
    expect(stray.pages).toEqual([1]);
    expect(stray.added).toEqual([]);
  });

  it('caps admissions per job at MAX_IMAGE_ONLY_ADMISSIONS, strongest first', () => {
    const candidates = [10, 11, 12, 13, 14, 15];
    const out = applyImageOnlyRecheck([1], candidates, new Set(candidates));
    expect(out.added.length).toBe(MAX_IMAGE_ONLY_ADMISSIONS);
    expect(out.added.map((a) => a.page)).toEqual([10, 11, 12, 13]);
    expect(out.pages).toEqual([1, 10, 11, 12, 13]);
  });

  it('no re-check picks → located set unchanged', () => {
    const out = applyImageOnlyRecheck([1, 3], [2], new Set());
    expect(out.pages).toEqual([1, 3]);
    expect(out.added).toEqual([]);
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

describe('recoverTranscriptTiles — tile-loss recovery ladder (PR19)', () => {
  const tile = (n: number, blocks: string[][]) => ({ tile: n, blocks });
  // The Bradford loop shape: the same block emitted hundreds of times.
  const loopBlocks = Array.from({ length: 200 }, () => ['D/T 0.1', '224.09', '223.86']);
  const empty = (tiles: number[]) => sanitizeTranscriptTiles([], tiles[0] - 1, tiles.length);

  it('credits the batch re-issue rung when it saves a missing tile (rung 1 unchanged)', async () => {
    const first = sanitizeTranscriptTiles([tile(1, [['A']])], 0, 2); // tile 2 missing
    const callTiles = vi.fn(async (tiles: number[], phase: string) => {
      expect(phase).toBe('batch-retry');
      return sanitizeTranscriptTiles([tile(2, [['MH 2']])], tiles[0] - 1, tiles.length);
    });
    const out = await recoverTranscriptTiles(first, { callTiles: callTiles as any });
    expect(out.recoveredAfterRetry).toBe(1);
    expect(out.recoveredAsSingle).toBe(0);
    expect(out.missing).toEqual([]);
    expect(out.tiles.map((t) => t.tile)).toEqual([1, 2]);
    expect(callTiles).toHaveBeenCalledTimes(1); // no single-tile calls needed
  });

  it('recovers a still-missing tile with a single-tile call and lands it in the transcript', async () => {
    const first = sanitizeTranscriptTiles([tile(1, [['A']])], 0, 2); // tile 2 missing
    const phases: string[] = [];
    const callTiles = vi.fn(async (tiles: number[], phase: string, attempt: number) => {
      phases.push(`${phase}:${attempt}`);
      if (phase === 'batch-retry') return empty(tiles); // the re-issue drops it again
      return sanitizeTranscriptTiles([tile(2, [['MH 2', 'RIM 1.0']])], 1, 1);
    });
    const out = await recoverTranscriptTiles(first, { callTiles: callTiles as any });
    expect(phases).toEqual(['batch-retry:1', 'single-missing:1']);
    expect(out.recoveredAsSingle).toBe(1);
    expect(out.missing).toEqual([]);
    expect(out.tiles.find((t) => t.tile === 2)!.blocks).toEqual([['MH 2', 'RIM 1.0']]);
  });

  it('gives a stubborn tile up to two single-tile attempts before counting it lost', async () => {
    const first = sanitizeTranscriptTiles([], 0, 1); // tile 1 missing
    let singles = 0;
    const callTiles = vi.fn(async (tiles: number[], phase: string) => {
      if (phase === 'batch-retry') return empty(tiles);
      singles++;
      return singles < 2 ? empty(tiles) : sanitizeTranscriptTiles([tile(1, [['OK']])], 0, 1);
    });
    const out = await recoverTranscriptTiles(first, { callTiles: callTiles as any });
    expect(singles).toBe(2);
    expect(out.recoveredAsSingle).toBe(1);
    expect(out.missing).toEqual([]);
  });

  it('keeps a degenerate tile whose single-tile re-issue reads cleanly', async () => {
    const first = sanitizeTranscriptTiles([tile(1, loopBlocks)], 0, 1);
    expect(first.degenerate).toEqual([1]);
    const callTiles = vi.fn(async (tiles: number[], phase: string) => {
      expect(phase).toBe('single-degenerate');
      expect(tiles).toEqual([1]);
      return sanitizeTranscriptTiles([tile(1, [['MH 1']])], 0, 1);
    });
    const out = await recoverTranscriptTiles(first, { callTiles: callTiles as any });
    expect(out.degenerateRecovered).toBe(1);
    expect(out.degenerate).toEqual([]);
    expect(out.tiles[0].blocks).toEqual([['MH 1']]);
  });

  it('discards a degenerate tile whose re-issue loops again — final loss, counted once', async () => {
    const first = sanitizeTranscriptTiles([tile(1, loopBlocks)], 0, 1);
    const callTiles = vi.fn(async () => sanitizeTranscriptTiles([tile(1, loopBlocks)], 0, 1));
    const out = await recoverTranscriptTiles(first, { callTiles: callTiles as any });
    expect(callTiles).toHaveBeenCalledTimes(1); // exactly one re-issue, no more
    expect(out.degenerateRecovered).toBe(0);
    expect(out.degenerate).toEqual([1]);
    expect(out.tiles).toEqual([{ tile: 1, blocks: [] }]); // the pre-ladder placeholder shape
  });

  it('caps bind: a batch where everything fails terminates with bounded calls and final-loss counts', async () => {
    const first = sanitizeTranscriptTiles([], 0, 16); // all 16 tiles missing
    const budget = { maxTotalCalls: 5, usedCalls: 0 };
    const callTiles = vi.fn(async (tiles: number[]) => empty(tiles));
    const out = await recoverTranscriptTiles(first, {
      callTiles: callTiles as any, budget, maxCallsPerBatch: 5, concurrency: 1,
    });
    expect(out.singleRecoveryCalls).toBe(5);
    expect(out.recoveryCapReached).toBe(true);
    expect(budget.usedCalls).toBe(5);
    // 1 batch re-issue (the missing tiles form one contiguous run) + 5 capped singles.
    expect(callTiles).toHaveBeenCalledTimes(6);
    expect(out.missing).toHaveLength(16);
    expect(out.recoveredAsSingle).toBe(0);
    expect(out.degenerate).toEqual([]);
  });

  it('a shared budget starves a later batch instead of overshooting the run total', async () => {
    const budget = { maxTotalCalls: 3, usedCalls: 0 };
    const callTiles = vi.fn(async (tiles: number[]) => empty(tiles));
    const outA = await recoverTranscriptTiles(sanitizeTranscriptTiles([], 0, 4), {
      callTiles: callTiles as any, budget, concurrency: 1,
    });
    expect(outA.singleRecoveryCalls).toBe(3);
    const outB = await recoverTranscriptTiles(sanitizeTranscriptTiles([], 16, 4), {
      callTiles: callTiles as any, budget, concurrency: 1,
    });
    expect(outB.singleRecoveryCalls).toBe(0);
    expect(outB.recoveryCapReached).toBe(true);
    expect(outB.missing).toHaveLength(4);
    expect(budget.usedCalls).toBe(3);
  });
});

describe('parseFacts — untrusted LLM JSON', () => {
  it('turns non-numeric values into null, never NaN', async () => {
    const { parseFacts, num } = await import('./extraction');
    expect(num('n/a')).toBeNull();
    expect(num('1,234.5')).toBe(1234.5);
    expect(num(Infinity)).toBeNull();
    const facts = parseFacts(
      {
        manholes: [{ description: 'MH 1', topElevation: 'n/a', lowInvert: '177.2' }],
        sewers: [{ runLabel: 'MH 1 - MH 2', length: 'unknown', slope: 'TBD', pipeDiameter: '300' }],
        warnings: ['ok', 42],
      },
      'P'
    );
    expect(facts.structures[0].topElevation).toBeNull();
    expect(facts.structures[0].lowInvert).toBe(177.2);
    expect(facts.sewers[0].length).toBeNull();
    expect(facts.sewers[0].slope).toBeNull();
    expect(facts.sewers[0].pipeDiameter).toBe(300);
    expect(facts.warnings).toEqual(['ok']);
  });

  it('tolerates wrong container types instead of crashing', async () => {
    const { parseFacts } = await import('./extraction');
    const facts = parseFacts({ manholes: 'none', sewers: {}, watermain: null }, 'P');
    expect(facts.structures).toEqual([]);
    expect(facts.sewers).toEqual([]);
    expect(facts.watermain).toEqual([]);
    expect(parseFacts(null, 'P').projectName).toBe('P');
  });
});

describe('envNumber', () => {
  it('honours an explicit 0 (THINKING_BUDGET=0 turns thinking off)', async () => {
    const { envNumber } = await import('./extraction');
    expect(envNumber('0', 8192)).toBe(0);
    expect(envNumber('512', 8192)).toBe(512);
    expect(envNumber(undefined, 8192)).toBe(8192);
    expect(envNumber('', 8192)).toBe(8192);
    expect(envNumber('abc', 8192)).toBe(8192);
    expect(envNumber('-1', 160)).toBe(160);
  });
});
