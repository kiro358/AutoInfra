import { describe, it, expect } from 'vitest';
import {
  parseRunCallout, parseStructureLabel, parseElevation, parseWatermainCallout,
  isDanglingRunHead, isRunContinuation, parseSubdrainCallout,
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

  it('detects the diameter-first head of a wrapped callout', () => {
    expect(isDanglingRunHead('300mm PVC STM')).toBe(true);
    expect(isDanglingRunHead('250mmØ PVC SAN')).toBe(true);
    expect(isDanglingRunHead('525mm CONC STM')).toBe(true);
    expect(isDanglingRunHead('300mm CL III')).toBe(true);
  });
  it('does not treat a complete or non-pipe line as a diameter-first head', () => {
    // already whole — slope and length both on the line
    expect(isDanglingRunHead('450mm PVC @ 0.5% (25.0m)')).toBe(false);
    // structure callouts state a diameter too
    expect(isDanglingRunHead('EX CBMH1035 (1200Ø)')).toBe(false);
    expect(isDanglingRunHead('STMH 1')).toBe(false);
    // a size with no pipe signal at all
    expect(isDanglingRunHead('1200mm')).toBe(false);
    // other systems own their grammar
    expect(isDanglingRunHead('EX. 300 mmØ PVC WATERMAIN')).toBe(false);
    expect(isDanglingRunHead('150mm PVC SUBDRAIN')).toBe(false);
  });
  it('detects slope/length tails that follow a diameter-first head', () => {
    expect(isRunContinuation('@ 1.00% (25.0m)')).toBe(true);
    expect(isRunContinuation('@ 0.50% - 45.0m')).toBe(true);
    expect(isRunContinuation('@ 0.30%')).toBe(true);
    expect(isRunContinuation('PVC STM')).toBe(true);
    expect(isRunContinuation('STM')).toBe(true);
    expect(isRunContinuation('INSULATED')).toBe(true);
    expect(isRunContinuation('(25.0m)')).toBe(true);
  });
  it('never treats a structure, elevation or whole run as a tail', () => {
    expect(isRunContinuation('SAN MH 5')).toBe(false);
    expect(isRunContinuation('T/G=224.95')).toBe(false);
    expect(isRunContinuation('45.0m - 250mm PVC STM @ 0.5%')).toBe(false);
    expect(isRunContinuation('EX. 300 mmØ PVC WATERMAIN')).toBe(false);
    expect(isRunContinuation('DRAWN BY: ML')).toBe(false);
  });
  it('parses the two- and three-line wrapped forms once joined', () => {
    expect(parseRunCallout('300mm PVC STM @ 1.00% (25.0m)')).toMatchObject({
      length: 25.0, diameterMm: 300, system: 'STORM', material: 'PVC', slopePct: 1.0,
    });
    expect(parseRunCallout('250mmØ PVC SAN @ 0.50% - 45.0m')).toMatchObject({
      length: 45.0, diameterMm: 250, system: 'SAN', material: 'PVC', slopePct: 0.5,
    });
    expect(parseRunCallout('8.4m - 300mm PVC STM @ 1.00% INSULATED')).toMatchObject({
      length: 8.4, diameterMm: 300, system: 'STORM', material: 'PVC', slopePct: 1.0, insulated: true,
    });
    expect(parseRunCallout('15.5m - 450mm PVC STM @ 0.30%')).toMatchObject({
      length: 15.5, diameterMm: 450, system: 'STORM', material: 'PVC', slopePct: 0.3,
    });
  });
});

describe('parseStructureLabel', () => {
  it('parses concatenated CAD ids with diameter', () => {
    expect(parseStructureLabel('EX CBMH1035 (1200Ø)')).toEqual({
      label: 'CBMH1035', kind: 'CBMH', diameterMm: 1200, existing: true,
    });
  });
  it('parses spaced ids', () => {
    expect(parseStructureLabel('STMH 1')).toEqual({ label: 'STMH 1', kind: 'MH', diameterMm: null, existing: false, system: 'STM' });
    expect(parseStructureLabel('EX SAN MH 02')).toEqual({ label: 'MH 02', kind: 'MH', diameterMm: null, existing: true, system: 'SAN' });
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

describe('grammar coverage (Phase 0)', () => {
  it('parses multi-part junction ids', () => {
    const jf = parseStructureLabel('JF 6-3-1')!;
    expect(jf.kind).toBe('JF');
    expect(jf.label).toBe('JF 6-3-1');
  });

  it('parses EF structures with zero-padded ids', () => {
    const ef = parseStructureLabel('EF 04')!;
    expect(ef.kind).toBe('EF');
    expect(ef.label).toBe('EF 04');
  });

  it('parses a chamber written id-first', () => {
    const ch = parseStructureLabel('C100 CHAMBER')!;
    expect(ch.kind).toBe('CHAMBER');
    expect(ch.label).toBe('C100');
  });

  it('does not mistake EF/JF prefixes inside other words', () => {
    expect(parseStructureLabel('OFFSET 12')).toBeNull();
  });

  it('parses subdrain runs', () => {
    expect(parseSubdrainCallout('67.0m - 150mmØ SUBDRAIN')).toEqual({ length: 67, diameterMm: 150, existing: false });
    expect(parseSubdrainCallout('EX. 83.7m - 200mmØ SUBDRAIN')).toEqual({ length: 83.7, diameterMm: 200, existing: true });
    expect(parseSubdrainCallout('83.7m-375mmØ SAN @ 0.02%')).toBeNull();
  });

  describe('subdrain callouts with a diameter but no stated length (Oakville Fire Hall)', () => {
    it('emits the pipe by diameter alone when no length is tightly coupled to it', () => {
      expect(parseSubdrainCallout('150mm SUBDRAIN')).toEqual({ length: 0, diameterMm: 150, existing: false });
      expect(parseSubdrainCallout('200mm SUBDRAIN')).toEqual({ length: 0, diameterMm: 200, existing: false });
      expect(parseSubdrainCallout('SWALE WITH 150mm SUBDRAIN')).toEqual({ length: 0, diameterMm: 150, existing: false });
    });

    it('chooses the diameter nearest the SUBDRAIN keyword when multiple figures present', () => {
      // Regression pin: when a line carries both another pipe's diameter (300mm STM)
      // and the subdrain's diameter (150mm), pick the one nearest to the keyword
      expect(parseSubdrainCallout('300mm STM C/W 150mm SUBDRAIN')).toEqual({ length: 0, diameterMm: 150, existing: false });
    });

    it('emits existing: true on the diameter-only branch when EX is present', () => {
      expect(parseSubdrainCallout('EX. 150mm SUBDRAIN')).toEqual({ length: 0, diameterMm: 150, existing: true });
    });

    it('does not mistake an unrelated width for the pipe length (bioswale trap)', () => {
      // "1.8m" is the bioswale width, not the subdrain's length — it is not tightly
      // coupled to the diameter the way "67.0m - 150mmØ" is, so it must be ignored
      // rather than misread as the pipe's length.
      expect(parseSubdrainCallout('1.8m BIOSWALE WITH 200mm SUBDRAIN')).toEqual({ length: 0, diameterMm: 200, existing: false });
    });

    it('emits nothing when the line carries no diameter at all', () => {
      expect(parseSubdrainCallout('SUBDRAIN WITH 0.5m CLEARANCE')).toBeNull();
      expect(parseSubdrainCallout('SUBDRAIN. REFER TO DRAWING')).toBeNull();
      expect(parseSubdrainCallout('SUBDRAIN PIPES TO BE SET ON AT LEAST 1.0% GRADE DRAINING TO A POSITIVE FROST-FREE OUTLET.')).toBeNull();
    });

    it('handles diameter notations with the diameter symbol', () => {
      // Real corpus line with Ø symbol
      expect(parseSubdrainCallout('PR 150mmØ SUBDRAIN c/w')).toEqual({ length: 0, diameterMm: 150, existing: false });
    });
  });

  it('keeps EX detection working on the new kinds', () => {
    expect(parseStructureLabel('EX JF 4-1-1')!.existing).toBe(true);
  });

  describe('Bradford regression pins (Jellyfish product codes)', () => {
    it('rejects JF model codes (non-hyphenated)', () => {
      // JF1000, JF2000 are product model numbers, not structure ids
      expect(parseStructureLabel('JF1000')).toBeNull();
      expect(parseStructureLabel('JF2000')).toBeNull();
    });

    it('extracts real hyphenated JF ids from structured text', () => {
      // Real structure ids must be hyphenated (e.g., JF 6-3-1)
      const result1 = parseStructureLabel('PROPOSED JELLYFISH JF4-1-1 UNIT c/w OFFLINE');
      expect(result1?.kind).toBe('JF');
      expect(result1?.label).toBe('JF4-1-1');
    });

    it('extracts hyphenated JF ids from parenthesized contexts', () => {
      // When model code and genuine id appear on the same line, match the hyphenated one
      const result = parseStructureLabel('HATCH JF2000 (JF6-3-1)');
      expect(result?.kind).toBe('JF');
      expect(result?.label).toBe('JF6-3-1');
    });
  });
});

// ---------------------------------------------------------------------------------------
// Grammar expansion: the common Ontario municipal callout variants that the original
// grammar did not cover. Each block below mirrors one drawing convention, so a failure
// here names the exact syntax that regressed.
// ---------------------------------------------------------------------------------------

describe('parseRunCallout — diameter-first forms with a trailing length', () => {
  it('parses "<dia> <material> @ <slope> (<length>)"', () => {
    expect(parseRunCallout('450mm PVC @ 0.5% (25.0m)')).toEqual({
      length: 25, diameterMm: 450, system: 'UNKNOWN', material: 'PVC', typeClass: null,
      slopePct: 0.5, existing: false,
    });
    expect(parseRunCallout('250mm PVC @ 1.0% (45m)')).toEqual({
      length: 45, diameterMm: 250, system: 'UNKNOWN', material: 'PVC', typeClass: null,
      slopePct: 1.0, existing: false,
    });
  });

  it('parses a concrete class run with no slope stated', () => {
    expect(parseRunCallout('300mm CONC CL III (12.5m)')).toEqual({
      length: 12.5, diameterMm: 300, system: 'UNKNOWN', material: 'CONC', typeClass: 3,
      slopePct: null, existing: false,
    });
  });

  it('accepts a bare (unparenthesised) trailing length', () => {
    const r = parseRunCallout('450mm PVC STM @ 0.5% 25.0m')!;
    expect(r.length).toBe(25);
    expect(r.diameterMm).toBe(450);
    expect(r.system).toBe('STORM');
  });

  it('carries EX through the diameter-first path', () => {
    expect(parseRunCallout('EX. 300mm CONC STM @ 1.0% (40.0m)')!.existing).toBe(true);
  });

  it('refuses a diameter-first line with no length at all', () => {
    // Without a length there is nothing to price — emitting length 0 here would invent a run.
    expect(parseRunCallout('450mm PVC')).toBeNull();
    expect(parseRunCallout('450mm PVC @ 0.5%')).toBeNull();
  });

  it('refuses a diameter-first line with no corroborating pipe signal', () => {
    // A bare size + distance with no slope, material, class or system tag is not a run.
    expect(parseRunCallout('1200mm CLEARANCE (3.0m)')).toBeNull();
  });

  it('does not read a structure barrel diameter as a pipe run', () => {
    // Regression guard for the diameter-first path: "(1200Ø)" is the manhole barrel.
    expect(parseRunCallout('EX CBMH1035 (1200Ø)')).toBeNull();
    expect(parseRunCallout('STMH 1 (1200Ø)')).toBeNull();
  });
});

describe('parseRunCallout — material written ahead of the diameter', () => {
  it('parses "<material> <dia> <system> @ <slope> (<length>)"', () => {
    expect(parseRunCallout('PVC 250mm STM @ 0.5% (40.0m)')).toEqual({
      length: 40, diameterMm: 250, system: 'STORM', material: 'PVC', typeClass: null,
      slopePct: 0.5, existing: false,
    });
  });

  it('parses the concrete variant with no system tag', () => {
    expect(parseRunCallout('CONC 375mm @ 1.2% (15m)')).toEqual({
      length: 15, diameterMm: 375, system: 'UNKNOWN', material: 'CONC', typeClass: null,
      slopePct: 1.2, existing: false,
    });
  });
});

describe('parseRunCallout — length stated with "of"', () => {
  it('parses "<length>m of <dia> <material> <system>"', () => {
    expect(parseRunCallout('50m of 200mm PVC SAN')).toEqual({
      length: 50, diameterMm: 200, system: 'SAN', material: 'PVC', typeClass: null,
      slopePct: null, existing: false,
    });
    expect(parseRunCallout('25m of 300mm STM')).toEqual({
      length: 25, diameterMm: 300, system: 'STORM', material: null, typeClass: null,
      slopePct: null, existing: false,
    });
  });
});

describe('parseRunCallout — type/class designations', () => {
  it('parses DR / SDR ratings with or without a separator', () => {
    expect(parseRunCallout('45.0m - 250mm DR35 @ 0.5%')!.typeClass).toBe(35);
    expect(parseRunCallout('45.0m - 250mm DR-28 @ 0.5%')!.typeClass).toBe(28);
    expect(parseRunCallout('45.0m - 250mm DR 28 @ 0.5%')!.typeClass).toBe(28);
    expect(parseRunCallout('45.0m - 250mm SDR35 @ 0.5%')!.typeClass).toBe(35);
  });

  it('keeps the DR rating when a pipe material is also named', () => {
    // "PVC DR35" is the common spelling: PVC is the material, 35 the class. Before the
    // standalone DR probe the first material match (PVC) hid the rating entirely.
    const r = parseRunCallout('45.0m - 250mm PVC DR35 SAN @ 0.5%')!;
    expect(r.material).toBe('PVC');
    expect(r.typeClass).toBe(35);
  });

  it('parses roman concrete strength classes', () => {
    expect(parseRunCallout('12.0m - 600mm CONC CL III @ 1.0%')!.typeClass).toBe(3);
    expect(parseRunCallout('12.0m - 600mm CONC CL IV @ 1.0%')!.typeClass).toBe(4);
    expect(parseRunCallout('12.0m - 600mm CONC CLASS 5 @ 1.0%')!.typeClass).toBe(5);
  });

  it('does not read a centreline station as a pipe class', () => {
    // "CL 100+00" is a chainage note; the arabic class form is capped at two digits.
    expect(parseRunCallout('12.0m - 600mm CONC @ 1.0% ALONG CL 100+00')!.typeClass).toBeNull();
  });

  it('recognises RCP as a material', () => {
    expect(parseRunCallout('12.0m - 600mm RCP STM @ 1.0%')!.material).toBe('RCP');
  });
});

describe('parseRunCallout — insulation', () => {
  it('flags the insulated spellings', () => {
    expect(parseRunCallout('30.0m - 200mmØ SAN @ 1.0% INS')!.insulated).toBe(true);
    expect(parseRunCallout('30.0m - 200mmØ SAN @ 1.0% INS.')!.insulated).toBe(true);
    expect(parseRunCallout('30.0m - 200mmØ SAN @ 1.0% P.INS')!.insulated).toBe(true);
    expect(parseRunCallout('30.0m - 200mmØ SAN @ 1.0% POLY INS')!.insulated).toBe(true);
    expect(parseRunCallout('30.0m - 200mmØ SAN @ 1.0% INSULATED')!.insulated).toBe(true);
    expect(parseRunCallout('30.0m - 200mmØ SAN @ 1.0% C/W INSULATION')!.insulated).toBe(true);
  });

  it('leaves the flag unset on an ordinary run', () => {
    expect(parseRunCallout('30.0m - 200mmØ SAN @ 1.0%')!.insulated).toBeUndefined();
  });

  it('does not fire on words that merely start with INS', () => {
    expect(parseRunCallout('30.0m - 200mmØ SAN @ 1.0% INSPECTION PORT')!.insulated).toBeUndefined();
  });
});

describe('parseStructureLabel — spelled-out structure names', () => {
  it('parses multi-word vault and chamber names', () => {
    expect(parseStructureLabel('DOUBLE CHECK VALVE VAULT')).toEqual({
      label: 'DOUBLE CHECK VALVE VAULT', kind: 'VAULT', diameterMm: null, existing: false,
    });
    expect(parseStructureLabel('SERVICE VAULT')).toEqual({
      label: 'SERVICE VAULT', kind: 'VAULT', diameterMm: null, existing: false,
    });
    expect(parseStructureLabel('VALVE CHAMBER 1')).toEqual({
      label: 'VALVE CHAMBER 1', kind: 'CHAMBER', diameterMm: null, existing: false,
    });
  });

  it('parses hyphenated spellings', () => {
    expect(parseStructureLabel('DOUBLE-CHECK VALVE VAULT')!.label).toBe('DOUBLE CHECK VALVE VAULT');
    expect(parseStructureLabel('HEAD-WALL 2')!.kind).toBe('HW');
  });

  it('parses tanks and flared end sections', () => {
    expect(parseStructureLabel('INFILTRATION TANK')).toEqual({
      label: 'INFILTRATION TANK', kind: 'TANK', diameterMm: null, existing: false,
    });
    expect(parseStructureLabel('FLARED END SECTION')).toEqual({
      label: 'FLARED END SECTION', kind: 'FES', diameterMm: null, existing: false,
    });
    expect(parseStructureLabel('OUTLET CONTROL STRUCTURE 1')).toEqual({
      label: 'OUTLET CONTROL STRUCTURE 1', kind: 'OCS', diameterMm: null, existing: false,
    });
  });

  it('carries the existing/proposed prefix', () => {
    expect(parseStructureLabel('EX. FLARED END SECTION')!.existing).toBe(true);
    expect(parseStructureLabel('EXISTING SERVICE VAULT')!.existing).toBe(true);
    expect(parseStructureLabel('PROPOSED INFILTRATION TANK 3')).toEqual({
      label: 'INFILTRATION TANK 3', kind: 'TANK', diameterMm: null, existing: false,
    });
  });

  it('picks up a leading or parenthesised barrel diameter', () => {
    expect(parseStructureLabel('1200Ø VALVE CHAMBER 1')!.diameterMm).toBe(1200);
    expect(parseStructureLabel('DOUBLE CHECK VALVE VAULT (1500Ø)')!.diameterMm).toBe(1500);
  });

  it('will not turn a note or legend row into a structure', () => {
    // The spelled-out patterns are anchored to the whole line precisely so that prose
    // mentioning a structure type does not fabricate one (see CLAUDE.md on fabrication).
    expect(parseStructureLabel('FLARED END SECTION DETAIL')).toBeNull();
    expect(parseStructureLabel('SEE INFILTRATION TANK NOTES ON DWG 5')).toBeNull();
    expect(parseStructureLabel('CONNECT TO EXISTING SERVICE VAULT AT PROPERTY LINE')).toBeNull();
  });
});

describe('parseStructureLabel — abbreviated headwall / outlet codes', () => {
  it('parses the short codes with ids', () => {
    expect(parseStructureLabel('HW 1')).toEqual({ label: 'HW 1', kind: 'HW', diameterMm: null, existing: false });
    expect(parseStructureLabel('OCS 1')).toEqual({ label: 'OCS 1', kind: 'OCS', diameterMm: null, existing: false });
    expect(parseStructureLabel('FES 2')).toEqual({ label: 'FES 2', kind: 'FES', diameterMm: null, existing: false });
  });

  it('parses the written-out headwall to the same kind', () => {
    const hw = parseStructureLabel('HEADWALL 2')!;
    expect(hw.kind).toBe('HW');
    expect(hw.label).toBe('HEADWALL 2');
  });

  it('does not match a code without an id', () => {
    expect(parseStructureLabel('HW')).toBeNull();
    expect(parseStructureLabel('OCS')).toBeNull();
  });

  it('does not mistake HWL (high water level) for a headwall', () => {
    expect(parseStructureLabel('HWL 250.00')).toBeNull();
  });
});

describe('parseStructureLabel — SWM chamber model designations', () => {
  it('parses the hyphenated and spaced model codes', () => {
    expect(parseStructureLabel('MC-3500')).toEqual({ label: 'MC-3500', kind: 'CHAMBER', diameterMm: null, existing: false });
    expect(parseStructureLabel('SC-740')).toEqual({ label: 'SC-740', kind: 'CHAMBER', diameterMm: null, existing: false });
    expect(parseStructureLabel('STC 4000')).toEqual({ label: 'STC 4000', kind: 'CHAMBER', diameterMm: null, existing: false });
    expect(parseStructureLabel('DCVC-200')).toEqual({ label: 'DCVC-200', kind: 'CHAMBER', diameterMm: null, existing: false });
  });

  it('parses the heavy-duty C-series code, whose HD suffix is unambiguous', () => {
    expect(parseStructureLabel('C100HD')!.label).toBe('C100HD');
    expect(parseStructureLabel('C100HD')!.kind).toBe('CHAMBER');
  });

  it('parses a bare C-series code only when brand- or CHAMBER-qualified', () => {
    // Measured on the golden set: a bare "C###" is overwhelmingly a civil SHEET NUMBER
    // (C401, C501) or a material spec (ASTM C33, AWWA C900). Accepting it unqualified
    // fabricated structures on four projects, so it needs a disambiguator.
    expect(parseStructureLabel('C100')).toBeNull();
    expect(parseStructureLabel('C401')).toBeNull();
    expect(parseStructureLabel('C100 CHAMBER')).toEqual({ label: 'C100', kind: 'CHAMBER', diameterMm: null, existing: false });
    expect(parseStructureLabel('CULTEC C100HD CHAMBERS')!.label).toBe('C100HD');
    expect(parseStructureLabel('CULTEC C100')!.label).toBe('C100');
  });

  it('does not mint a chamber from a sheet reference or a material spec', () => {
    expect(parseStructureLabel('STONE PER DETAIL ON C501.')).toBeNull();
    expect(parseStructureLabel('accordance with ASTM C33 No. 8, high')).toBeNull();
    expect(parseStructureLabel('PIPE TO AWWA. C900 & C905')).toBeNull();
    expect(parseStructureLabel('SEE DRAWING C002 FOR GRADING')).toBeNull();
  });

  it('requires the multi-letter model codes to stand alone or be brand-qualified', () => {
    // "DRAWING OF MC-3500 UNIT" is a detail reference on the sheet, not a unit being built.
    expect(parseStructureLabel('DRAWING OF MC-3500 UNIT')).toBeNull();
    expect(parseStructureLabel('MC-3500 CHAMBER')!.label).toBe('MC-3500');
    expect(parseStructureLabel('EX. STC 6000')).toEqual({ label: 'STC 6000', kind: 'CHAMBER', diameterMm: null, existing: true });
  });

  it('parses hyphenated Jellyfish ids and still rejects Jellyfish model codes', () => {
    // The model allowlist deliberately excludes JF, so the Bradford pins below still hold.
    expect(parseStructureLabel('JF 4-1-1')!.label).toBe('JF 4-1-1');
    expect(parseStructureLabel('JF 6-3-1')!.kind).toBe('JF');
    expect(parseStructureLabel('JF1000')).toBeNull();
    expect(parseStructureLabel('JF2000')).toBeNull();
  });

  it('does not treat an ordinary structure code as a model', () => {
    expect(parseStructureLabel('CB 10')!.kind).toBe('CB');
    expect(parseStructureLabel('DCB 3')!.kind).toBe('DCB');
  });
});

describe('parseElevation — invert equations', () => {
  it('parses plain and directional inverts', () => {
    expect(parseElevation('INV 258.46')).toEqual({ type: 'INV', direction: null, value: 258.46 });
    expect(parseElevation('N INV=223.35')).toEqual({ type: 'INV', direction: 'N', value: 223.35 });
    expect(parseElevation('SW INV = 310.60')).toEqual({ type: 'INV', direction: 'SW', value: 310.6 });
    expect(parseElevation('BOTTOM INV 258.30')).toEqual({ type: 'INV', direction: 'BOTTOM', value: 258.3 });
    expect(parseElevation('OUT INV 150.20')).toEqual({ type: 'INV', direction: 'OUT', value: 150.2 });
  });

  it('accepts the direction on either side of the keyword', () => {
    expect(parseElevation('INV OUT = 150.20')).toEqual({ type: 'INV', direction: 'OUT', value: 150.2 });
    expect(parseElevation('INV. IN 250.30')).toEqual({ type: 'INV', direction: 'IN', value: 250.3 });
  });

  it('normalizes spelled-out directions to their compass letters', () => {
    expect(parseElevation('NORTH INV 223.35')!.direction).toBe('N');
    expect(parseElevation('INVERT WEST 223.35')!.direction).toBe('W');
    expect(parseElevation('OUTLET INV 223.35')!.direction).toBe('OUT');
  });
});

describe('parseElevation — top of grate equations', () => {
  it('parses the T/G spellings', () => {
    expect(parseElevation('T/G=224.95')).toEqual({ type: 'TG', direction: null, value: 224.95 });
    expect(parseElevation('T/G. = 193.45')).toEqual({ type: 'TG', direction: null, value: 193.45 });
    expect(parseElevation('T.G. 193.45')).toEqual({ type: 'TG', direction: null, value: 193.45 });
    expect(parseElevation('TG 193.45')).toEqual({ type: 'TG', direction: null, value: 193.45 });
  });

  it('parses the TOP / RIM / GRATE synonyms', () => {
    expect(parseElevation('TOP 260.15')).toEqual({ type: 'TG', direction: null, value: 260.15 });
    expect(parseElevation('RIM 250.00')).toEqual({ type: 'TG', direction: null, value: 250 });
    expect(parseElevation('GRATE 180.50')).toEqual({ type: 'TG', direction: null, value: 180.5 });
    expect(parseElevation('TOP OF GRATE = 224.95')).toEqual({ type: 'TG', direction: null, value: 224.95 });
  });

  it('still rejects text that is not an elevation equation', () => {
    expect(parseElevation('224.95')).toBeNull();
    expect(parseElevation('IN 250.00')).toBeNull();
    expect(parseElevation('MH 101')).toBeNull();
    expect(parseElevation('83.7m-375mmØ SAN @ 0.02%')).toBeNull();
    expect(parseElevation('TOP OF PIPE TO BE 250.00 MIN')).toBeNull();
  });
});

describe('parseWatermainCallout — mainlines, services and leads', () => {
  it('parses the plain mainline forms', () => {
    expect(parseWatermainCallout('150mm PVC WM')).toEqual({
      diameterMm: 150, lengthM: null, material: 'PVC', existing: false,
    });
    expect(parseWatermainCallout('200mm DR-18 WATERMAIN')).toEqual({
      diameterMm: 200, lengthM: null, material: 'DR-18', existing: false,
    });
    expect(parseWatermainCallout('200mm WATER MAIN')!.diameterMm).toBe(200);
  });

  it('parses domestic and fire services', () => {
    expect(parseWatermainCallout('100mm DOMESTIC WATER')).toEqual({
      diameterMm: 100, lengthM: null, material: null, existing: false, service: 'DOMESTIC',
    });
    expect(parseWatermainCallout('150mm FIRE SERVICE')).toEqual({
      diameterMm: 150, lengthM: null, material: null, existing: false, service: 'FIRE',
    });
  });

  it('parses hydrant leads, including the parenthesised diameter form', () => {
    expect(parseWatermainCallout('HYDRANT LEAD (150mm)')).toEqual({
      diameterMm: 150, lengthM: null, material: null, existing: false, service: 'HYDRANT_LEAD',
    });
    expect(parseWatermainCallout('HYD LEAD (150mm)')!.service).toBe('HYDRANT_LEAD');
    expect(parseWatermainCallout('6.0m - 150mm PVC HYDRANT LEAD')).toEqual({
      diameterMm: 150, lengthM: 6, material: 'PVC', existing: false, service: 'HYDRANT_LEAD',
    });
  });

  it('flags insulated watermain', () => {
    expect(parseWatermainCallout('150mm PVC WM P.INS')!.insulated).toBe(true);
    expect(parseWatermainCallout('150mm PVC WM')!.insulated).toBeUndefined();
  });

  it('keeps the new watermain forms out of the sewer-run parser', () => {
    expect(parseRunCallout('150mm FIRE SERVICE')).toBeNull();
    expect(parseRunCallout('100mm DOMESTIC WATER')).toBeNull();
    expect(parseRunCallout('HYDRANT LEAD (150mm)')).toBeNull();
  });

  it('does not treat a stormwater quality unit as watermain', () => {
    // Guard on the widened keyword set: WM_RE must never key off a bare "WATER".
    expect(parseWatermainCallout('600mm WATER QUALITY UNIT')).toBeNull();
    expect(parseWatermainCallout('STORMWATER MANAGEMENT POND 300mm')).toBeNull();
  });
});

describe('parseRunCallout — leading length with the "m" unit omitted', () => {
  // Drafters routinely drop the unit off the leading length: "44.1 - 200mmØ PVC ...".
  // This shape dominates White Oak Woodbine, where it is ~690 of the unparsed lines.
  it('parses a unit-less leading length when the diameter carries a unit', () => {
    expect(parseRunCallout('44.1 - 200# PVC CL. 65.0 STM @ 0.30%')).toMatchObject({
      length: 44.1, diameterMm: 200, system: 'STORM', material: 'PVC', slopePct: 0.3,
    });
    expect(parseRunCallout('75.0 - 750mm HDPE STM')).toMatchObject({
      length: 75.0, diameterMm: 750, system: 'STORM', material: 'HDPE',
    });
  });

  it('still requires a pipe signal, so aggregate specs are not runs', () => {
    // "75-200mm CLEAR" is clear-stone bedding, not a 200mm pipe 75m long.
    expect(parseRunCallout('75-200mm CLEAR')).toBeNull();
    expect(parseRunCallout('19-50mm CRUSHED STONE')).toBeNull();
  });

  it('requires an explicit diameter unit, so a bare number pair is not a run', () => {
    // Without this guard a job number reads as a 2026m run of 50mm pipe.
    expect(parseRunCallout('2026 - 050 STM')).toBeNull();
    expect(parseRunCallout('2026 - 050 STM @ 0.5%')).toBeNull();
  });

  it('does not change how a length WITH its unit is read', () => {
    expect(parseRunCallout('83.7m-375mmØ SAN @ 0.02%')).toMatchObject({ length: 83.7, diameterMm: 375 });
  });
});

describe('EX. prefix butted against the length (no space)', () => {
  // "EX.110.0 - 450Ø ..." — the period runs straight into the digit, so the existing-marker
  // regex must not demand whitespace after it. Mis-flagging these prices existing pipe as new.
  it('marks a run existing when EX. abuts the length', () => {
    expect(parseRunCallout('EX.110.0 - 450Ø CONC STM @ 1.25%')).toMatchObject({ existing: true });
    expect(parseRunCallout('EX.61.0 - 200Ø PVC SAN @ 1.00%')).toMatchObject({ existing: true });
    expect(parseRunCallout('EX.9.0-675Ø CONC')).toMatchObject({ existing: true });
  });

  it('still marks the spaced forms existing', () => {
    expect(parseRunCallout('EX. 110.0 - 450Ø CONC STM @ 1.25%')).toMatchObject({ existing: true });
    expect(parseRunCallout('EX 83.7m-375mmØ SAN @ 0.02%')).toMatchObject({ existing: true });
  });

  it('does not treat a proposed run as existing', () => {
    expect(parseRunCallout('83.7m-375mmØ SAN @ 0.02%')).toMatchObject({ existing: false });
    expect(parseRunCallout('44.1 - 200# PVC CL. 65.0 STM @ 0.30%')).toMatchObject({ existing: false });
  });
});

// 460 Bayly St E (Odan/Detech, 2026): every one of these lines was read correctly by the
// vision step and then dropped or mis-classified by the grammar, which zeroed the estimate.
describe('Odan/Detech callout style (460 Bayly St E)', () => {
  it('reads "EL"/"ELEV" after the elevation keyword', () => {
    expect(parseElevation('RIM ELEV 89.70')).toEqual({ type: 'TG', direction: null, value: 89.7 });
    expect(parseElevation('RIM EL 90.81')).toEqual({ type: 'TG', direction: null, value: 90.81 });
    expect(parseElevation('SW INV EL 84.84')).toEqual({ type: 'INV', direction: 'SW', value: 84.84 });
    expect(parseElevation('E INV ELEVATION 85.97')).toEqual({ type: 'INV', direction: 'E', value: 85.97 });
  });

  it('reads a stated diameter written with mm', () => {
    expect(parseStructureLabel('PROP STMH MH 100 (2400mmØ)')!.diameterMm).toBe(2400);
    expect(parseStructureLabel('PROP STMH MH 2 (1800 mmØ)')!.diameterMm).toBe(1800);
  });

  it('keeps EX when it precedes a system code that is not the matched kind', () => {
    expect(parseStructureLabel('EX STMH MH 3')).toMatchObject({ label: 'MH 3', existing: true });
    expect(parseStructureLabel('EXISTING MH 5')!.existing).toBe(true);
    expect(parseStructureLabel('PROP STMH MH 3')!.existing).toBe(false);
  });

  it('records the sewer system so storm and sanitary MH 1 stay distinct', () => {
    expect(parseStructureLabel('PROP SAN MH 1')!.system).toBe('SAN');
    expect(parseStructureLabel('PROP STMH MH 1 (1200 mmØ)')!.system).toBe('STM');
    expect(parseStructureLabel('PROP CB 3')!.system).toBeUndefined();
  });

  it('recognizes Cultec chambers named by product', () => {
    expect(parseStructureLabel('RECHARGER 902HD')).toEqual({ label: '902 HD', kind: 'CHAMBER', diameterMm: null, existing: false });
    expect(parseStructureLabel('CONTACTOR 100HD')!.label).toBe('100 HD');
  });
});
