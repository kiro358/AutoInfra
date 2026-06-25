import { describe, it, expect } from 'vitest';
import {
  normalizeSlope,
  snapToPipeDiameter,
  snapToMHSize,
  repairTruncatedJson,
  tryParseJSONWithRepair,
  deduplicateManholes,
  deduplicateSewers,
  deduplicateWatermain,
  deduplicateSpecials,
  deduplicateValves,
} from './extraction';

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
