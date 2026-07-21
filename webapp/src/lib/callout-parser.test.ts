import { describe, it, expect } from 'vitest';
import {
  parseRunCallout, parseStructureLabel, parseElevation, parseWatermainCallout,
  isDanglingRunHead, isRunContinuation,
} from './callout-parser';

describe('parseRunCallout', () => {
  it('parses the dash form with system and slope', () => {
    expect(parseRunCallout('83.7m-375mmØ SAN @ 0.02%')).toEqual({
      length: 83.7, diameterMm: 375, system: 'SAN', material: null, typeClass: null, slopePct: 0.02, existing: false,
    });
  });
  it('parses the EX + material form', () => {
    expect(parseRunCallout('EX SAN 7.2m - 250mmØ DR 35 @ 0.05%')).toEqual({
      length: 7.2, diameterMm: 250, system: 'SAN', material: 'DR 35', typeClass: 35, slopePct: 0.05, existing: true,
    });
  });
  it('parses storm with PVC material', () => {
    const r = parseRunCallout('45.0m - 250mm PVC STM @ 0.5%')!;
    expect(r.system).toBe('STORM');
    expect(r.material).toBe('PVC');
    expect(r.diameterMm).toBe(250);
    expect(r.slopePct).toBe(0.5);
  });
  it('normalizes per-mille slope', () => {
    // 20‰ written as "@ 20‰" or "@ 20" on some sets -> 2.0%
    expect(parseRunCallout('30.0m-200mmØ SAN @ 20‰')!.slopePct).toBe(2.0);
  });
  it('snaps near-miss diameters to the standard series', () => {
    expect(parseRunCallout('12.0m-374mmØ STM @ 1.0%')!.diameterMm).toBe(375);
  });
  it('returns null for non-run text', () => {
    expect(parseRunCallout('T/G=224.95')).toBeNull();
    expect(parseRunCallout('DRAWN BY: ML')).toBeNull();
    expect(parseRunCallout('EX. 300 mmØ PVC WATERMAIN')).toBeNull(); // watermain, not sewer
  });
});

describe('dangling run heads (callout split across two text lines)', () => {
  it('detects head and continuation', () => {
    expect(isDanglingRunHead('EX SAN 87.4m - 250mmØ')).toBe(true);
    expect(isDanglingRunHead('83.7m-375mmØ SAN @ 0.02%')).toBe(false);
    expect(isRunContinuation('DR 35 @ 0.05%')).toBe(true);
    expect(isRunContinuation('STMH 1')).toBe(false);
  });
  it('parses head+continuation when joined', () => {
    const r = parseRunCallout('EX SAN 87.4m - 250mmØ DR 35 @ 0.05%')!;
    expect(r.length).toBe(87.4);
    expect(r.typeClass).toBe(35);
  });
});

describe('parseStructureLabel', () => {
  it('parses concatenated CAD ids with diameter', () => {
    expect(parseStructureLabel('EX CBMH1035 (1200Ø)')).toEqual({
      label: 'CBMH1035', kind: 'CBMH', diameterMm: 1200, existing: true,
    });
  });
  it('parses spaced ids', () => {
    expect(parseStructureLabel('STMH 1')).toEqual({ label: 'STMH 1', kind: 'MH', diameterMm: null, existing: false });
    expect(parseStructureLabel('EX SAN MH 02')).toEqual({ label: 'MH 02', kind: 'MH', diameterMm: null, existing: true });
    expect(parseStructureLabel('MH 101')).toEqual({ label: 'MH 101', kind: 'MH', diameterMm: null, existing: false });
    expect(parseStructureLabel('DCBMH 2')!.kind).toBe('DCBMH');
    expect(parseStructureLabel('DICB 3')!.kind).toBe('DICB');
  });
  it('requires an id number (legend-entry "CB" alone is not a structure)', () => {
    expect(parseStructureLabel('CB')).toBeNull();
    expect(parseStructureLabel('WM')).toBeNull();
    expect(parseStructureLabel('CB 10')!.kind).toBe('CB');
  });
});

describe('parseElevation', () => {
  it('parses T/G and directional inverts, both = styles', () => {
    expect(parseElevation('T/G=224.95')).toEqual({ type: 'TG', direction: null, value: 224.95 });
    expect(parseElevation('T/G = 312.46')).toEqual({ type: 'TG', direction: null, value: 312.46 });
    expect(parseElevation('N INV=223.350')).toEqual({ type: 'INV', direction: 'N', value: 223.35 });
    expect(parseElevation('SW INV = 310.60')).toEqual({ type: 'INV', direction: 'SW', value: 310.6 });
  });
  it('rejects run callouts and plain numbers', () => {
    expect(parseElevation('83.7m-375mmØ SAN @ 0.02%')).toBeNull();
    expect(parseElevation('224.95')).toBeNull();
  });
});

describe('parseWatermainCallout', () => {
  it('parses the corpus forms', () => {
    expect(parseWatermainCallout('EX. 300 mmØ PVC WATERMAIN')).toEqual({
      diameterMm: 300, lengthM: null, material: 'PVC', existing: true,
    });
    expect(parseWatermainCallout('EX WM - 250 mm')).toEqual({ diameterMm: 250, lengthM: null, material: null, existing: true });
    expect(parseWatermainCallout('124.0m - 150mmØ PVC WM')).toEqual({ diameterMm: 150, lengthM: 124.0, material: 'PVC', existing: false });
  });
  it('rejects sewer callouts', () => {
    expect(parseWatermainCallout('83.7m-375mmØ SAN @ 0.02%')).toBeNull();
  });
});
