/**
 * Conformance suite (fix plan Phase 7).
 *
 * The golden projects measure field performance on noisy real drawings;
 * nothing about them says what the engine SHOULD produce. This suite does:
 * every sheet here is generated from analytic inputs (the generator options
 * ARE the ground truth), run through the real extraction paths, and scored
 * for exactness against those inputs — never against captured engine output.
 *
 * Tolerances appear only where the engine legitimately derives a value:
 *  - drawn lengths are reported rounded to 0.1 m, so a scale-converted
 *    length is asserted within ±0.1 m of the analytic value;
 *  - depths are rim − invert in floating point, asserted to 6 dp;
 *  - calibration residuals are asserted < 0.01 on sheets whose geometry was
 *    generated at exactly the stated ratio (float pipeline noise only).
 * Everything stated on a sheet — labels, diameters, stated lengths, slopes,
 * elevations — is asserted EXACTLY.
 *
 * Known engine gaps are NOT hidden: they live in `it.fails` cases below,
 * each naming the analytic expectation and the actual behaviour. An
 * `it.fails` case turns red the day the engine is fixed, which is the
 * signal to promote it to a regular case. See pr15_evidence.md.
 */
import { describe, it, expect } from 'vitest';
import {
  createSyntheticCadPdf,
  SyntheticCadPdfOptions,
  SyntheticStructureDef,
  SyntheticPipeDef,
} from './test-fixtures/synthetic-cad-pdf';
import { extractVectorTakeoff } from './vector-takeoff';
import { assembleTranscriptTakeoff } from './transcript-takeoff';
import {
  parseStructureLabel,
  parseRunCallout,
  parseScheduleRunRow,
  parseWatermainCallout,
  parseElevation,
  structureDescription,
} from './callout-parser';
import { TakeoffFacts } from './types';

/** pt per metre for a "SCALE 1:denom" note: (1000mm/denom) at 72pt per 25.4mm. */
const ptPerM = (denom: number) => (1000 / denom) * (72 / 25.4);

const MH = (
  id: string, x: number, y: number, rim: number, inv: number,
): SyntheticStructureDef => ({
  id, type: 'MH', x, y, size: 14,
  rimElevation: rim, invertElevation: inv, labelOffset: { x: 10, y: 15 },
});
const CB = (
  id: string, x: number, y: number, rim: number, inv: number,
): SyntheticStructureDef => ({
  id, type: 'CB', x, y, size: 12,
  rimElevation: rim, invertElevation: inv, labelOffset: { x: 15, y: 0 },
});

// Extraction is ~1s per sheet; share each generated sheet across its cases.
const factsCache = new Map<string, Promise<TakeoffFacts>>();
function factsFor(name: string, options: SyntheticCadPdfOptions): Promise<TakeoffFacts> {
  let p = factsCache.get(name);
  if (!p) {
    p = (async () => {
      const pdf = await createSyntheticCadPdf(options);
      return extractVectorTakeoff(Buffer.from(pdf), [1], name);
    })();
    factsCache.set(name, p);
  }
  return p;
}

function expectStructure(
  facts: TakeoffFacts, description: string, rim: number, inv: number,
) {
  const s = facts.structures.find((x) => x.description === description);
  expect(s, `structure ${description}`).toBeDefined();
  expect(s!.topElevation).toBe(rim);
  expect(s!.lowInvert).toBe(inv);
  return s!;
}

function expectRun(
  facts: TakeoffFacts, runLabel: string,
  expected: { length: number | null; diameter: number | null; slope: number | null },
) {
  const r = facts.sewers.find((x) => x.runLabel === runLabel);
  expect(r, `run ${runLabel}`).toBeDefined();
  expect(r!.length).toBe(expected.length);
  expect(r!.pipeDiameter).toBe(expected.diameter);
  expect(r!.slope).toBe(expected.slope);
  return r!;
}

// ---------------------------------------------------------------------------
// (a) Parameterized vector sheets
// ---------------------------------------------------------------------------

// Sheet 1: storm trunk drawn TRUE to its 1:200 note — MH spacing generated
// at exactly ptPerM(200) per metre, so stated and drawn lengths agree.
const STEP200 = 20 * ptPerM(200); // 283.4646pt per 20.0m at 1:200
const SHEET_200_STRUCTURES = [
  MH('STMH 1', 120, 400, 100.5, 97.5),
  MH('STMH 2', 120 + STEP200, 400, 100.3, 97.3),
  MH('STMH 3', 120 + 2 * STEP200, 400, 100.1, 97.1),
  CB('CB 1', 120 + STEP200, 500, 100.2, 98.6),
];
const SHEET_200: SyntheticCadPdfOptions = {
  legend: false, schedule: false,
  structures: SHEET_200_STRUCTURES,
  pipes: [
    { id: 'STM-1', fromStructureId: 'STMH 1', toStructureId: 'STMH 2', system: 'STORM', diameterMm: 300, material: 'PVC', slopePercent: 0.5, lengthMeters: 20.0, calloutText: '20.0m - 300mmØ PVC STORM @ 0.50%', calloutPosition: { x: 200, y: 420 }, leaderLine: true },
    { id: 'STM-2', fromStructureId: 'STMH 2', toStructureId: 'STMH 3', system: 'STORM', diameterMm: 375, material: 'PVC', slopePercent: 0.4, lengthMeters: 20.0, calloutText: '20.0m - 375mmØ PVC STORM @ 0.40%', calloutPosition: { x: 480, y: 420 }, leaderLine: true },
    // No callout: the sheet states neither this lead's length nor its size.
    { id: 'CB-LEAD-1', fromStructureId: 'CB 1', toStructureId: 'STMH 2', system: 'STORM', diameterMm: 200, material: 'PVC', leaderLine: false },
  ],
};

// Sheet 2: same discipline at 1:500 (note text AND geometry both change).
const STEP500 = 25 * ptPerM(500); // 141.7323pt per 25.0m at 1:500
const SHEET_500: SyntheticCadPdfOptions = {
  legend: false, schedule: false, scaleNote: 'SCALE 1:500',
  structures: [
    MH('STMH 1', 150, 400, 100.5, 97.5),
    MH('STMH 2', 150 + STEP500, 400, 100.3, 97.3),
    MH('STMH 3', 150 + 2 * STEP500, 400, 100.1, 97.1),
  ],
  pipes: [
    { id: 'STM-1', fromStructureId: 'STMH 1', toStructureId: 'STMH 2', system: 'STORM', diameterMm: 300, material: 'PVC', slopePercent: 0.5, lengthMeters: 25.0, calloutText: '25.0m - 300mmØ PVC STORM @ 0.50%', calloutPosition: { x: 180, y: 420 }, leaderLine: true },
    { id: 'STM-2', fromStructureId: 'STMH 2', toStructureId: 'STMH 3', system: 'STORM', diameterMm: 300, material: 'PVC', slopePercent: 0.5, lengthMeters: 25.0, calloutText: '25.0m - 300mmØ PVC STORM @ 0.50%', calloutPosition: { x: 320, y: 420 }, leaderLine: true },
  ],
};

// Sheet 3: storm variant in ordinary drafting geometry (structures 200pt
// apart, lengths stated only in callouts), 4 MH + 2 CB, five runs with
// distinct diameters and slopes.
const SHEET_VARIANT_STRUCTURES = [
  MH('STMH 1', 150, 450, 102.0, 99.0),
  MH('STMH 2', 350, 450, 101.8, 98.8),
  MH('STMH 3', 550, 450, 101.6, 98.62),
  MH('STMH 4', 550, 250, 101.4, 98.44),
  CB('CB 1', 350, 520, 101.9, 100.3),
  CB('CB 2', 620, 250, 101.5, 100.1),
];
const SHEET_VARIANT_PIPES: SyntheticPipeDef[] = [
  { id: 'STM-1', fromStructureId: 'STMH 1', toStructureId: 'STMH 2', system: 'STORM', diameterMm: 300, material: 'PVC', slopePercent: 0.5, lengthMeters: 40.0, calloutText: '40.0m - 300mmØ PVC STORM @ 0.50%', calloutPosition: { x: 200, y: 470 }, leaderLine: true },
  { id: 'STM-2', fromStructureId: 'STMH 2', toStructureId: 'STMH 3', system: 'STORM', diameterMm: 450, material: 'PVC', slopePercent: 0.45, lengthMeters: 40.0, calloutText: '40.0m - 450mmØ PVC STORM @ 0.45%', calloutPosition: { x: 400, y: 470 }, leaderLine: true },
  { id: 'STM-3', fromStructureId: 'STMH 3', toStructureId: 'STMH 4', system: 'STORM', diameterMm: 525, material: 'PVC', slopePercent: 0.45, lengthMeters: 40.0, calloutText: '40.0m - 525mmØ PVC STORM @ 0.45%', calloutPosition: { x: 570, y: 350 }, leaderLine: true },
  { id: 'CB-L1', fromStructureId: 'CB 1', toStructureId: 'STMH 2', system: 'STORM', diameterMm: 200, material: 'PVC', slopePercent: 2.0, lengthMeters: 14.0, calloutText: '14.0m - 200mmØ PVC CB LEAD @ 2.00%', calloutPosition: { x: 370, y: 490 }, leaderLine: true },
  { id: 'CB-L2', fromStructureId: 'CB 2', toStructureId: 'STMH 4', system: 'STORM', diameterMm: 200, material: 'PVC', slopePercent: 2.0, lengthMeters: 14.0, calloutText: '14.0m - 200mmØ PVC CB LEAD @ 2.00%', calloutPosition: { x: 600, y: 270 }, leaderLine: true },
];
const SHEET_VARIANT: SyntheticCadPdfOptions = {
  legend: false, schedule: false,
  structures: SHEET_VARIANT_STRUCTURES,
  pipes: SHEET_VARIANT_PIPES,
};

const SHEET_SAN: SyntheticCadPdfOptions = {
  legend: false, schedule: false,
  structures: [
    { id: 'SAN MH 1', type: 'MH', x: 150, y: 300, size: 14, rimElevation: 101.0, invertElevation: 97.2, labelOffset: { x: -10, y: 15 } },
    { id: 'SAN MH 2', type: 'MH', x: 350, y: 300, size: 14, rimElevation: 100.8, invertElevation: 97.04, labelOffset: { x: 10, y: 15 } },
  ],
  pipes: [
    { id: 'SAN-1', fromStructureId: 'SAN MH 1', toStructureId: 'SAN MH 2', system: 'SAN', diameterMm: 200, material: 'PVC', slopePercent: 0.4, lengthMeters: 40.0, calloutText: '40.0m - 200mmØ PVC SANITARY @ 0.40%', calloutPosition: { x: 200, y: 280 }, leaderLine: true },
  ],
};

const SHEET_WM: SyntheticCadPdfOptions = {
  legend: false, schedule: false,
  structures: [
    { id: 'VLV 1', type: 'VALVE', x: 250, y: 330, size: 12, labelOffset: { x: 0, y: 10 } },
    { id: 'HYD 1', type: 'HYDRANT', x: 420, y: 330, size: 12, labelOffset: { x: 12, y: 0 } },
  ],
  pipes: [
    { id: 'WM-1', fromStructureId: 'VLV 1', toStructureId: 'HYD 1', system: 'WATERMAIN', diameterMm: 150, material: 'PVC', lengthMeters: 34.0, calloutText: '34.0m - 150mmØ PVC WATERMAIN', calloutPosition: { x: 300, y: 345 }, leaderLine: true, vertices: [{ x: 250, y: 330 }, { x: 420, y: 330 }] },
  ],
};

describe('conformance (a): parameterized vector sheets', () => {
  it('storm trunk at true 1:200 — exact structures, runs, CB group', async () => {
    const facts = await factsFor('sheet-200', SHEET_200);

    expect(facts.structures).toHaveLength(3);
    for (const def of SHEET_200_STRUCTURES.filter((s) => s.type === 'MH')) {
      const s = expectStructure(facts, def.id, def.rimElevation!, def.invertElevation!);
      expect(s.depth).toBeCloseTo(def.rimElevation! - def.invertElevation!, 6);
    }
    // CB depth is rim − invert = 100.2 − 98.6 = 1.6, stated nowhere else.
    expect(facts.catchbasins).toEqual([
      expect.objectContaining({ type: 'SINGLE_CB', quantity: 1, depth: 1.6 }),
    ]);

    expect(facts.sewers).toHaveLength(3);
    expectRun(facts, 'STMH 1-STMH 2', { length: 20.0, diameter: 300, slope: 0.5 });
    expectRun(facts, 'STMH 2-STMH 3', { length: 20.0, diameter: 375, slope: 0.4 });
    // The uncalled lead: length comes from drawn geometry alone —
    // 100pt / ptPerM(200) = 7.0556m, reported at 0.1m rounding (±0.1).
    const lead = facts.sewers.find((r) => r.runLabel === 'CB 1-STMH 2')!;
    expect(lead).toBeDefined();
    expect(Math.abs(lead.length! - 100 / ptPerM(200))).toBeLessThanOrEqual(0.1);
    // Its diameter is stated NOWHERE on the sheet: null, and withheld —
    // never a default (this assertion is what the cad-invariants fix serves).
    expect(lead.pipeDiameter).toBeNull();
    expect(facts.withheld ?? []).toContainEqual(
      expect.objectContaining({ entity: 'CB 1-STMH 2', field: 'diameter', kind: 'withheld' }),
    );
  });

  it('storm trunk at true 1:500 — exact, and silent (a conforming sheet warns about nothing)', async () => {
    const facts = await factsFor('sheet-500', SHEET_500);

    expect(facts.structures).toHaveLength(3);
    expectStructure(facts, 'STMH 1', 100.5, 97.5);
    expectStructure(facts, 'STMH 2', 100.3, 97.3);
    expectStructure(facts, 'STMH 3', 100.1, 97.1);
    expect(facts.sewers).toHaveLength(2);
    expectRun(facts, 'STMH 1-STMH 2', { length: 25.0, diameter: 300, slope: 0.5 });
    expectRun(facts, 'STMH 2-STMH 3', { length: 25.0, diameter: 300, slope: 0.5 });
    expect(facts.warnings).toEqual([]);
    // Nothing is withheld or defaulted on a conforming sheet. Since PR27
    // the only records are the derived-depth bookkeeping entries (each
    // structure's depth is computed rim − low invert and flagged derived).
    expect((facts.withheld ?? []).filter((w) => w.kind !== 'derived')).toEqual([]);
    expect((facts.withheld ?? []).filter((w) => w.kind === 'derived' && w.field === 'depth'))
      .toHaveLength(3);
  });

  it('storm variant — 4 MH + 2 CB, five runs with distinct diameters/slopes', async () => {
    const facts = await factsFor('sheet-variant', SHEET_VARIANT);

    expect(facts.structures).toHaveLength(4);
    for (const def of SHEET_VARIANT_STRUCTURES.filter((s) => s.type === 'MH')) {
      expectStructure(facts, def.id, def.rimElevation!, def.invertElevation!);
    }
    // Two single CBs; the group's depth is the analytic mean of the two
    // rim−invert depths: (1.6 + 1.4) / 2 = 1.5.
    expect(facts.catchbasins).toHaveLength(1);
    expect(facts.catchbasins[0]).toEqual(
      expect.objectContaining({ type: 'SINGLE_CB', quantity: 2 }),
    );
    expect(facts.catchbasins[0].depth).toBeCloseTo(1.5, 4);

    expect(facts.sewers).toHaveLength(5);
    for (const pipe of SHEET_VARIANT_PIPES) {
      expectRun(facts, `${pipe.fromStructureId}-${pipe.toStructureId}`, {
        length: pipe.lengthMeters!, diameter: pipe.diameterMm, slope: pipe.slopePercent!,
      });
    }
    // Geometry is drawn at 5pt/m against a 1:200 note: the calibration
    // stays unverified ('detected', residual beyond the 25% conflict line)
    // and the conflict is warned — but stated callout values above are
    // unaffected.
    expect(facts.calibrations).toHaveLength(1);
    expect(facts.calibrations![0].source).toBe('detected');
    expect(facts.calibrations![0].residual!).toBeGreaterThan(0.25);
    expect(facts.warnings.some((w) => w.includes('stated dimensions disagree'))).toBe(true);
  });

  it('watermain sheet — the run itself is exact', async () => {
    const facts = await factsFor('sheet-wm', SHEET_WM);
    expect(facts.watermain).toHaveLength(1);
    expect(facts.watermain[0].length).toBe(34.0);
    expect(facts.watermain[0].pipeDiameter).toBe(150);
    expect(facts.watermainValves).toEqual([{ valveSize: '150mm', quantity: 1 }]);
  });

  // CLOSED by PR27: fact-layer derivation in reconcileTakeoff fills depth
  // as rim − low invert wherever both elevations are read (flagged
  // 'derived' in facts.withheld) — terminal structures included.
  // Analytic: 101.40 − 98.44 = 2.96.
  it('terminal structure carries its analytic depth (rim − invert)', async () => {
    const facts = await factsFor('sheet-variant', SHEET_VARIANT);
    const s = expectStructure(facts, 'STMH 4', 101.4, 98.44);
    expect(s.depth).toBeCloseTo(2.96, 6);
  });

  // KNOWN GAP: on a sanitary sheet the text path names structures
  // "SAN MH 1" while the vector path names the same nodes "MH 1", and the
  // run appears both as the text callout ("40m-200mm SAN") and as a vector
  // line item ("MH 1-MH 2") — reconcile does not unify them, so the sheet's
  // 2 structures / 1 run are double-counted as 4 / 2.
  it.fails('sanitary sheet — one census: 2 structures, 1 run (no text/vector duplicates)', async () => {
    const facts = await factsFor('sheet-san', SHEET_SAN);
    expect(facts.structures).toHaveLength(2);
    expect(facts.sewers).toHaveLength(1);
  });

  // KNOWN GAP: the geometric symbol fallback classifies non-valve nodes as
  // VALVE on sheets with no watermain at all, and cad-invariants counts
  // them into a phantom 150mm valve group. Analytic: no watermain content
  // of any kind on the storm variant sheet.
  it.fails('watermain-free sheet reports no valves, specials, or watermain runs', async () => {
    const facts = await factsFor('sheet-variant', SHEET_VARIANT);
    expect(facts.watermain).toEqual([]);
    expect(facts.watermainSpecials).toEqual([]);
    expect(facts.watermainValves).toEqual([]);
  });

  // KNOWN GAP: on the watermain sheet the hydrant and valve symbols are
  // classified as manhole-like nodes by the geometric fallback — the facts
  // gain two phantom structures ("MH 1" type DCBMH, "MH 2") and a phantom
  // DOUBLE_CB group, while the hydrant itself is never counted as a
  // HYDRANT ASSEMBLY special (quantity should be 1).
  it.fails('watermain furniture census — no phantom structures/CBs, hydrant counted', async () => {
    const facts = await factsFor('sheet-wm', SHEET_WM);
    expect(facts.structures).toEqual([]);
    expect(facts.catchbasins).toEqual([]);
    expect(facts.watermainSpecials).toEqual([{ specialName: 'HYDRANT ASSEMBLY', quantity: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// (b) Scale conformance — the PR 12 contract
// ---------------------------------------------------------------------------

const SHEET_NO_NOTE: SyntheticCadPdfOptions = {
  legend: false, schedule: false, scaleNote: null,
  structures: [
    MH('STMH 1', 150, 400, 100.5, 97.5),
    MH('STMH 2', 350, 400, 100.3, 97.3),
    MH('STMH 3', 550, 400, 100.1, 97.1),
  ],
  pipes: [
    { id: 'STM-1', fromStructureId: 'STMH 1', toStructureId: 'STMH 2', system: 'STORM', diameterMm: 300, material: 'PVC', slopePercent: 0.5, lengthMeters: 40.0, calloutText: '40.0m - 300mmØ PVC STORM @ 0.50%', calloutPosition: { x: 200, y: 420 }, leaderLine: true },
    { id: 'STM-2', fromStructureId: 'STMH 2', toStructureId: 'STMH 3', system: 'STORM', diameterMm: 375, material: 'PVC', leaderLine: false },
  ],
};

const SHEET_AMBIGUOUS: SyntheticCadPdfOptions = {
  legend: false, schedule: false,
  extraScaleNotes: ['DETAIL AT BOILER ROOM - SCALE 1:50'],
  structures: [MH('STMH 1', 150, 400, 100.5, 97.5), MH('STMH 2', 350, 400, 100.3, 97.3)],
  pipes: [
    { id: 'STM-1', fromStructureId: 'STMH 1', toStructureId: 'STMH 2', system: 'STORM', diameterMm: 300, material: 'PVC', slopePercent: 0.5, lengthMeters: 40.0, calloutText: '40.0m - 300mmØ PVC STORM @ 0.50%', calloutPosition: { x: 200, y: 420 }, leaderLine: true },
  ],
};

describe('conformance (b): scale calibration', () => {
  it('note matches geometry (1:200) — calibration promotes to stated', async () => {
    const facts = await factsFor('sheet-200', SHEET_200);
    expect(facts.calibrations).toHaveLength(1);
    const cal = facts.calibrations![0];
    expect(cal.source).toBe('stated');
    expect(cal.scalePtPerM).toBeCloseTo(ptPerM(200), 3);
    expect(cal.residual!).toBeLessThan(0.01);
    expect(cal.detectedText).toContain('SCALE 1:200');
    expect(cal.candidates).toEqual([200]);
  });

  it('note matches geometry (1:500) — calibration promotes to stated at that ratio', async () => {
    const facts = await factsFor('sheet-500', SHEET_500);
    const cal = facts.calibrations![0];
    expect(cal.source).toBe('stated');
    expect(cal.scalePtPerM).toBeCloseTo(ptPerM(500), 3);
    expect(cal.residual!).toBeLessThan(0.01);
  });

  it('no scale note — no value adopted, drawn quantities withheld, stated values kept', async () => {
    const facts = await factsFor('sheet-no-note', SHEET_NO_NOTE);
    expect(facts.calibrations).toHaveLength(1);
    const cal = facts.calibrations![0];
    expect(cal.scalePtPerM).toBeNull();
    expect(cal.source).toBe('absent');
    expect(cal.candidates).toEqual([]);

    const withheld = facts.withheld ?? [];
    expect(withheld).toContainEqual(
      expect.objectContaining({ entity: 'Sheet 1', field: 'scale', kind: 'withheld' }),
    );
    expect(
      withheld.find((w) => w.field === 'scale')!.question,
    ).toContain('no scale note');

    // The callout-stated run needs no scale and keeps its exact values…
    expectRun(facts, 'STMH 1-STMH 2', { length: 40.0, diameter: 300, slope: 0.5 });
    // …while the uncalled run is unmeasurable: length null (never a
    // fallback-scale conversion), and the question is withheld.
    const unmeasured = expectRun(facts, 'STMH 2-STMH 3', { length: null, diameter: null, slope: null });
    expect(unmeasured.length).toBeNull();
    expect(withheld).toContainEqual(
      expect.objectContaining({ entity: 'STMH 2-STMH 3', field: 'length', kind: 'withheld' }),
    );
  });

  it('conflicting scale notes — ambiguous, withheld, no value adopted', async () => {
    const facts = await factsFor('sheet-ambiguous', SHEET_AMBIGUOUS);
    expect(facts.calibrations).toHaveLength(1);
    const cal = facts.calibrations![0];
    expect(cal.source).toBe('ambiguous');
    expect(cal.scalePtPerM).toBeNull();
    expect([...(cal.candidates ?? [])].sort((a, b) => a - b)).toEqual([50, 200]);

    const scaleItem = (facts.withheld ?? []).find((w) => w.field === 'scale');
    expect(scaleItem).toBeDefined();
    expect(scaleItem!.question).toContain('conflicting scale notes (1:200, 1:50)');
    // Stated callout values are scale-independent and survive.
    expectRun(facts, 'STMH 1-STMH 2', { length: 40.0, diameter: 300, slope: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// (c) Grammar conformance — the PR 30 dialects, parser + assembler level
// ---------------------------------------------------------------------------

describe('conformance (c): callout grammar dialects', () => {
  const structureCases: [string, object][] = [
    // "#" separator dialect
    ['STMH #1', { label: 'STMH 1', kind: 'MH', diameterMm: null, existing: false, system: 'STM' }],
    ['CB #4A', { label: 'CB 4A', kind: 'CB', diameterMm: null, existing: false }],
    // status prefixes — existing-flag comes from the prefix TEXT
    ['EX CBMH1035 (1200Ø)', { label: 'CBMH1035', kind: 'CBMH', diameterMm: 1200, existing: true }],
    ['EX. MH #4A', { label: 'MH 4A', kind: 'MH', diameterMm: null, existing: true }],
    ['NEW MH 5', { label: 'MH 5', kind: 'MH', diameterMm: null, existing: false }],
    ['PROP. CB 2', { label: 'CB 2', kind: 'CB', diameterMm: null, existing: false }],
    ['PR. MH 7', { label: 'MH 7', kind: 'MH', diameterMm: null, existing: false }],
    // compound kind spellings remap to the canonical kind
    ['CB/MH #1', { label: 'CBMH 1', kind: 'CBMH', diameterMm: null, existing: false }],
    ['DBL/CB 3', { label: 'DCB 3', kind: 'DCB', diameterMm: null, existing: false }],
    // id-first dialect: kind trails in parentheses, system from the prefix
    ['SA3 (MH)', { label: 'MH 3', kind: 'MH', diameterMm: null, existing: false, system: 'SAN' }],
    ['ST1 (CBMH)', { label: 'CBMH 1', kind: 'CBMH', diameterMm: null, existing: false, system: 'STM' }],
    ['ST3 (CB)', { label: 'CB 3', kind: 'CB', diameterMm: null, existing: false, system: 'STM' }],
    // system-qualified baseline
    ['SAN MH 2', { label: 'MH 2', kind: 'MH', diameterMm: null, existing: false, system: 'SAN' }],
  ];
  it.each(structureCases)('structure label %s', (line, expected) => {
    expect(parseStructureLabel(line)).toEqual(expected);
  });

  it('structureDescription restores the SAN qualifier the label drops', () => {
    expect(structureDescription(parseStructureLabel('SAN MH 2')!)).toBe('SAN MH 2');
    expect(structureDescription(parseStructureLabel('STMH #1')!)).toBe('STMH 1');
  });

  const runCases: [string, object][] = [
    // "#" as the diameter unit separator
    ['19.2m-250# PVC STM @ 0.30%', { length: 19.2, diameterMm: 250, system: 'STORM', material: 'PVC', typeClass: null, slopePct: 0.3, existing: false }],
    // EX prefix + DR class
    ['EX SAN 7.2m - 250mmØ DR 35 @ 0.05%', { length: 7.2, diameterMm: 250, system: 'SAN', material: 'DR 35', typeClass: 35, slopePct: 0.05, existing: true }],
    // canonical length-first
    ['83.7m-375mmØ SAN @ 0.02%', { length: 83.7, diameterMm: 375, system: 'SAN', material: null, typeClass: null, slopePct: 0.02, existing: false }],
    // diameter-first with parenthesised length
    ['450mm PVC @ 0.5% (25.0m)', { length: 25.0, diameterMm: 450, system: 'UNKNOWN', material: 'PVC', typeClass: null, slopePct: 0.5, existing: false }],
  ];
  it.each(runCases)('run callout %s', (line, expected) => {
    expect(parseRunCallout(line)).toEqual(expected);
  });

  it('watermain callouts', () => {
    expect(parseWatermainCallout('EX. 300 mmØ PVC WATERMAIN')).toEqual({
      diameterMm: 300, lengthM: null, material: 'PVC', existing: true,
    });
    expect(parseWatermainCallout('150mm FIRE SERVICE')).toEqual({
      diameterMm: 150, lengthM: null, material: null, existing: false, service: 'FIRE',
    });
  });

  it('elevations', () => {
    expect(parseElevation('T/G=224.95')).toEqual({ type: 'TG', direction: null, value: 224.95 });
    expect(parseElevation('N INV=223.350')).toEqual({ type: 'INV', direction: 'N', value: 223.35 });
  });

  it('transcript assembly: per-structure blocks yield exact elevations', () => {
    const facts = assembleTranscriptTakeoff(
      [{ tile: 1, blocks: [
        ['STMH 1', 'T/G=100.50', 'INV=97.50'],
        ['STMH 2', 'T/G=100.30', 'INV=97.30'],
      ] }],
      'Conformance Transcript',
    );
    expect(facts.structures).toHaveLength(2);
    expectStructure(facts, 'STMH 1', 100.5, 97.5);
    expectStructure(facts, 'STMH 2', 100.3, 97.3);
  });
});

// ---------------------------------------------------------------------------
// (d) Invariant / verifier conformance — the PR 13 contract
// ---------------------------------------------------------------------------

const SHEET_BAD_DEPTH: SyntheticCadPdfOptions = {
  legend: false, schedule: false,
  structures: [
    MH('STMH 1', 150, 400, 100.5, 97.5),
    MH('STMH 2', 350, 400, 100.3, 97.3),
    // Invert ABOVE rim: depth = 100.00 − 100.50 = −0.50 — a DEPTH_VALIDITY
    // error by construction, and the sheet's only violation.
    MH('STMH 9', 600, 200, 100.0, 100.5),
  ],
  pipes: [
    { id: 'STM-1', fromStructureId: 'STMH 1', toStructureId: 'STMH 2', system: 'STORM', diameterMm: 300, material: 'PVC', slopePercent: 0.5, lengthMeters: 40.0, calloutText: '40.0m - 300mmØ PVC STORM @ 0.50%', calloutPosition: { x: 200, y: 420 }, leaderLine: true },
  ],
};

describe('conformance (d): invariant verification withheld items', () => {
  it('one engineered DEPTH_VALIDITY violation → exactly one verification withheld item', async () => {
    const facts = await factsFor('sheet-bad-depth', SHEET_BAD_DEPTH);
    const verification = (facts.withheld ?? []).filter((w) => w.field === 'verification');
    expect(verification).toHaveLength(1);
    expect(verification[0].kind).toBe('withheld');
    expect(verification[0].defaultApplied).toBeNull();
    expect(verification[0].question).toContain('rim and invert elevation');
    expect(facts.warnings.some((w) => w.includes('1 invariant violation(s) flagged for verification'))).toBe(true);
  });

  it('clean sheet → zero verification withheld items', async () => {
    const facts = await factsFor('sheet-200', SHEET_200);
    const verification = (facts.withheld ?? []).filter((w) => w.field === 'verification');
    expect(verification).toEqual([]);
    expect(facts.warnings.some((w) => w.includes('flagged for verification'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (e) Schedule conformance — the PR 31 contract
// ---------------------------------------------------------------------------

describe('conformance (e): schedule-table runs', () => {
  it('row parser: analytic rows parse exactly', () => {
    expect(parseScheduleRunRow(['ST1', '29.6 m', '250 mm dia.', 'PVC DR35', '1.0%'])).toEqual({
      id: 'ST1', length: 29.6, diameterMm: 250, slopePct: 1.0, material: 'PVC DR35',
    });
    // "#" dialect id, no material cell
    expect(parseScheduleRunRow(['ST #2', '12.0 m', '300 mm', '0.5%'])).toEqual({
      id: 'ST2', length: 12.0, diameterMm: 300, slopePct: 0.5, material: null,
    });
  });

  it('row parser: structure-schedule rows and EX rows are refused, never guessed', () => {
    expect(parseScheduleRunRow(['MH1', '29.6 m', '250 mm', 'PVC DR35', '1.0%'])).toBeNull();
    expect(parseScheduleRunRow(['EX ST1', '29.6 m', '250 mm', '1.0%'])).toBeNull();
  });

  it('transcript harvest: schedule rows become exact runs with schedule provenance', () => {
    const facts = assembleTranscriptTakeoff(
      [{ tile: 1, blocks: [[
        'ST1 | 29.6 m | 250 mm dia. | PVC DR35 | 1.0%',
        'SA2 | 41.0 m | 200 mm dia. | PVC DR35 | 0.4%',
      ]] }],
      'Conformance Schedule',
    );
    expect(facts.sewers).toHaveLength(2);
    const st1 = facts.sewers.find((s) => s.runLabel === 'ST1')!;
    expect(st1).toBeDefined();
    // PR27: stated schedule lengths are recorded in whole metres,
    // rounding up — the sheet's 29.6 m is recorded as 30.
    expect(st1.length).toBe(30);
    expect(st1.pipeDiameter).toBe(250);
    expect(st1.slope).toBe(1.0);
    expect(st1.source?.method).toBe('schedule');
    const sa2 = facts.sewers.find((s) => s.runLabel === 'SA2')!;
    expect(sa2).toBeDefined();
    expect(sa2.length).toBe(41.0);
    expect(sa2.pipeDiameter).toBe(200);
    expect(sa2.slope).toBe(0.4);
  });
});
