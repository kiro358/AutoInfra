/**
 * PR47 Phase 1 — the specialist registry (specialists.ts): completeness,
 * kill-switch semantics, and the fail-pre/pass-post proof for each
 * formalised proto-specialist — with its switch set, the specialist's
 * behaviour is off; unset, the behaviour is exactly today's.
 *
 * Fixture shapes mirror the specialists' own suites (the PR #62 / PR #64
 * cases in transcript-takeoff.test.ts) so the switch is the only variable.
 *
 * Cross-references — the specialists' pre-existing suites stay where they
 * are and keep covering the enabled behaviour in depth:
 *   S6-detached-elevation : transcript-takeoff.test.ts (PR #64 L1 cases)
 *   S7-enumeration-scope  : scope-guards.test.ts (PR #48), reconcile tests
 *   S9-shx-dialect        : pdf-text.test.ts, shx-decode.test.ts
 *   S10-value-first       : transcript-takeoff.test.ts (PR #62 cases)
 *   image-only-locator    : extraction.test.ts (PR #51 cases)
 *   dual-read-trigger     : extraction.test.ts (PR 46 kill-switch cases)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SPECIALIST_REGISTRY, isSpecialistDisabled, type SpecialistId } from './specialists';
import { isDualReadTriggerDisabled } from './extraction';
import { decodePageItemText } from './pdf-text';
import { clampImplausibleCatchbasinGroups } from './reconcile';
import { assembleTranscriptTakeoff } from './transcript-takeoff';
import type { TileTranscript } from './types';

const TOUCHED_ENV = [
  'DISABLE_DETACHED_ELEVATION',
  'DISABLE_ENUMERATION_SCOPE',
  'DISABLE_SHX_DECODE',
  'DISABLE_VALUE_FIRST_ELEVATIONS',
  'ENABLE_IMAGE_ONLY_LOCATOR',
  'DISABLE_DUAL_READ_TRIGGER',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of TOUCHED_ENV) savedEnv[k] = process.env[k];
afterEach(() => {
  for (const k of TOUCHED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const tile = (blocks: string[][], tileNo = 1): TileTranscript[] => [
  { tile: tileNo, blocks },
];

/** Structure lookup in the assembler's own convention (cf.
 *  transcript-takeoff.test.ts's byLabel). */
const byLabel = (facts: ReturnType<typeof assembleTranscriptTakeoff>, want: string) =>
  facts.structures.find((x) => x.description.replace(/\s/g, '') === want);

describe('specialist registry (PR47 Phase 1)', () => {
  it('registers exactly the six formalised proto-specialists plus S2 (PR48) and S4 (PR58)', () => {
    expect(SPECIALIST_REGISTRY.map((s) => s.id)).toEqual([
      'S6-detached-elevation',
      'S7-enumeration-scope',
      'S9-shx-dialect',
      'S10-value-first',
      'image-only-locator',
      'dual-read-trigger',
      'S2-wm-table-miner',
      'S4-col-frag',
    ]);
  });

  it('S4 kill switch: DISABLE_COL_FRAG follows disable-when-set', () => {
    const id: SpecialistId = 'S4-col-frag';
    const env = (v?: string) => (v === undefined ? {} : { DISABLE_COL_FRAG: v });
    expect(isSpecialistDisabled(id, env())).toBe(false);
    expect(isSpecialistDisabled(id, env('false'))).toBe(false);
    expect(isSpecialistDisabled(id, env('1'))).toBe(true);
  });

  it('every entry is complete (families, origin, detector, kill switch)', () => {
    for (const s of SPECIALIST_REGISTRY) {
      expect(s.families.length, s.id).toBeGreaterThan(0);
      expect(s.origin.length, s.id).toBeGreaterThan(0);
      expect(s.detector.length, s.id).toBeGreaterThan(20);
      expect(s.killSwitchEnv.length, s.id).toBeGreaterThan(0);
    }
  });

  it("disable-when-set: only truthy-ish values disable; 'false' never does", () => {
    const id: SpecialistId = 'S10-value-first';
    const env = (v?: string) => (v === undefined ? {} : { DISABLE_VALUE_FIRST_ELEVATIONS: v });
    expect(isSpecialistDisabled(id, env())).toBe(false);
    expect(isSpecialistDisabled(id, env(''))).toBe(false);
    expect(isSpecialistDisabled(id, env('false'))).toBe(false);
    expect(isSpecialistDisabled(id, env('0'))).toBe(false);
    expect(isSpecialistDisabled(id, env('no'))).toBe(false);
    expect(isSpecialistDisabled(id, env('1'))).toBe(true);
    expect(isSpecialistDisabled(id, env('true'))).toBe(true);
    expect(isSpecialistDisabled(id, env('yes'))).toBe(true);
  });

  it("enable-unless-false: only the exact value 'false' disables", () => {
    const env = (v?: string) => (v === undefined ? {} : { ENABLE_IMAGE_ONLY_LOCATOR: v });
    expect(isSpecialistDisabled('image-only-locator', env())).toBe(false);
    expect(isSpecialistDisabled('image-only-locator', env('true'))).toBe(false);
    expect(isSpecialistDisabled('image-only-locator', env('0'))).toBe(false);
    expect(isSpecialistDisabled('image-only-locator', env('false'))).toBe(true);
  });

  it('the dual-read kill switch delegates to the registry (agreement matrix)', () => {
    for (const v of [undefined, '', 'false', '0', 'no', '1', 'true', 'FALSE', ' yes ']) {
      const env = v === undefined ? {} : { DISABLE_DUAL_READ_TRIGGER: v };
      expect(isDualReadTriggerDisabled(env)).toBe(isSpecialistDisabled('dual-read-trigger', env));
    }
  });
});

describe('S10-value-first — DISABLE_VALUE_FIRST_ELEVATIONS', () => {
  // The PR #62 fixture shape: value-first rim line, then two bare inverts.
  const blocks = [['MH1A', '277.09 T/G', '275.64', '275.61']];

  it('adopts the value-first rim and the bare inverts when enabled', () => {
    const facts = assembleTranscriptTakeoff(tile(blocks), 'test');
    const mh = byLabel(facts, 'MH1A');
    expect(mh?.topElevation).toBe(277.09);
    expect(mh?.lowInvert).toBe(275.61);
    expect(mh?.highInvert).toBe(275.64);
  });

  it('adopts neither when disabled (the pre-PR #62 orphan warnings return)', () => {
    process.env.DISABLE_VALUE_FIRST_ELEVATIONS = '1';
    const facts = assembleTranscriptTakeoff(tile(blocks), 'test');
    const mh = byLabel(facts, 'MH1A');
    expect(mh?.topElevation).toBeNull();
    expect(mh?.lowInvert).toBeNull();
    expect(facts.warnings.some((w) => w.includes('277.09'))).toBe(true);
  });
});

describe('S6-detached-elevation — DISABLE_DETACHED_ELEVATION', () => {
  it('M1: adopts a bare directional invert when enabled, leaves the keyword rim either way', () => {
    // The PR #64 L1a fixture shape.
    const blocks = [
      ['DCBMH 2', 'NE 258.30'],
      ['DCBMH 2', 'T/G 260.00'],
    ];
    const on = assembleTranscriptTakeoff(tile(blocks), 'test');
    expect(byLabel(on, 'DCBMH2')?.lowInvert).toBe(258.3);

    process.env.DISABLE_DETACHED_ELEVATION = '1';
    const off = assembleTranscriptTakeoff(tile(blocks), 'test');
    const mh = byLabel(off, 'DCBMH2');
    expect(mh?.lowInvert).toBeNull();
    expect(mh?.topElevation).toBe(260);
  });

  it('M3: rescues a garbled-label block reads onto its sibling when enabled only', () => {
    // The PR #64 L1a rescue fixture shape.
    const tiles: TileTranscript[] = [
      {
        tile: 1, blocks: [
          ['CBMH2', 'T/G 129.10'],
          ['CRMH2', 'T/G 129.10', 'N.INV 125.91', 'W.INV 125.88'],
        ],
      },
    ];
    const on = assembleTranscriptTakeoff(tiles, 'test');
    expect(byLabel(on, 'CBMH2')?.lowInvert).toBe(125.88);
    expect(byLabel(on, 'CBMH2')?.highInvert).toBe(125.91);

    process.env.DISABLE_DETACHED_ELEVATION = '1';
    const off = assembleTranscriptTakeoff(tiles, 'test');
    expect(byLabel(off, 'CBMH2')?.lowInvert).toBeNull();
  });

  it('isolation: disabling S6 does not disable S10 value-first adoption', () => {
    process.env.DISABLE_DETACHED_ELEVATION = '1';
    const facts = assembleTranscriptTakeoff(tile([['MH1A', '277.09 T/G', '275.64', '275.61']]), 'test');
    expect(byLabel(facts, 'MH1A')?.topElevation).toBe(277.09);
  });
});

describe('S7-enumeration-scope — DISABLE_ENUMERATION_SCOPE', () => {
  const schedule = Array.from({ length: 45 }, (_, i) => [`CB-${i + 1}`]);

  it('counts an enumeration-only schedule as zero CBs when enabled', () => {
    const facts = assembleTranscriptTakeoff(tile(schedule), 'test');
    expect(facts.catchbasins.reduce((a, g) => a + g.quantity, 0)).toBe(0);
  });

  it('counts every enumerated catchbasin when disabled', () => {
    process.env.DISABLE_ENUMERATION_SCOPE = '1';
    const facts = assembleTranscriptTakeoff(tile(schedule), 'test');
    expect(facts.catchbasins.reduce((a, g) => a + g.quantity, 0)).toBe(45);
  });

  it('the plausibility clamp is the same specialist (off = untouched)', () => {
    const groups = [{ type: 'SINGLE_CB' as const, quantity: 100, wallThickness: null, depth: null }];
    const on = clampImplausibleCatchbasinGroups(groups, 10);
    expect(on.catchbasins[0].quantity).toBe(20);
    expect(on.clamped).toEqual([{ type: 'SINGLE_CB', quantity: 100, clampedTo: 20 }]);

    process.env.DISABLE_ENUMERATION_SCOPE = '1';
    const off = clampImplausibleCatchbasinGroups(groups, 10);
    expect(off.catchbasins[0].quantity).toBe(100);
    expect(off.clamped).toEqual([]);
  });
});

describe('S9-shx-dialect — DISABLE_SHX_DECODE', () => {
  // The Uxbridge symbol-font example (pdf-text.ts header), built from
  // code points: reads "5.7m - 200mmØ STORM @ 2.5%" once decoded.
  const raw = String.fromCodePoint(
    0x18, 0x11, 0x1a, 0x50, 0x03, 0x10, 0x03, 0x15, 0x13, 0x13, 0x50, 0x50,
    0x91, 0x03, 0x36, 0x37, 0x32, 0x35, 0x30, 0x03, 0x23, 0x03, 0x15, 0x11, 0x18, 0x08,
  );

  it('decodes symbol-font items when enabled', () => {
    expect(decodePageItemText(raw)).toBe('5.7m - 200mmØ STORM @ 2.5%');
  });

  it('passes the raw item through when disabled', () => {
    process.env.DISABLE_SHX_DECODE = '1';
    expect(decodePageItemText(raw)).toBe(raw);
  });
});

describe('specialist firing records (diagnostics input)', () => {
  it('assembleTranscriptTakeoff reports S6/S7/S10 firings via statsOut', () => {
    const stats: { specialists: Record<string, { fired: number; detail?: Record<string, number> }> } = { specialists: {} };
    const tiles: TileTranscript[] = [
      {
        tile: 1, blocks: [
          ['MH1A', '277.09 T/G', '275.64', '275.61'],
          ['DCBMH 2', 'NE 258.30'],
          ['DCBMH 2', 'T/G 260.00'],
        ],
      },
    ];
    assembleTranscriptTakeoff(tiles, 'test', stats);
    // S10 counts adopted LINES: the value-first rim + its two bare inverts.
    expect(stats.specialists['S10-value-first'].fired).toBe(3);
    expect(stats.specialists['S6-detached-elevation'].fired).toBe(1);
    expect(stats.specialists['S6-detached-elevation'].detail?.M1).toBe(1);
    expect(stats.specialists['S7-enumeration-scope'].fired).toBe(0);
  });
});
