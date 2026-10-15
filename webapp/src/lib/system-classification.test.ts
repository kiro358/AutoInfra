import { describe, it, expect } from 'vitest';
import {
  labelSystem,
  runEndpointTokens,
  classifySystems,
  groupBySystem,
  nonEmptySectionCount,
} from './system-classification';

describe('labelSystem', () => {
  it('reads the deterministic assemblers\' trailing system token on run labels', () => {
    expect(labelSystem('75m-375mm STM')).toBe('STORM');
    expect(labelSystem('1.4m-250mm SAN')).toBe('SAN');
    expect(labelSystem('12m-300mm')).toBe('UNKNOWN');
  });

  it('reads structure-label qualifiers (SAN prefix kept, STMH/SANMH fused kinds)', () => {
    expect(labelSystem('SAN MH 1')).toBe('SAN');
    expect(labelSystem('STMH 2')).toBe('STORM');
    expect(labelSystem('SANMH 1')).toBe('SAN');
    expect(labelSystem('ST CBMH 2')).toBe('STORM');
    expect(labelSystem('SA DCBMH 3')).toBe('SAN');
    expect(labelSystem('SANITARY MH 4')).toBe('SAN');
  });

  it('never guesses: bare IDs, suffix series and run IDs stay UNKNOWN', () => {
    expect(labelSystem('MH 1')).toBe('UNKNOWN');
    expect(labelSystem('MH 1A')).toBe('UNKNOWN'); // "A" series is sanitary on SOME projects only
    expect(labelSystem('CBMH 102')).toBe('UNKNOWN');
    expect(labelSystem('ST 1')).toBe('UNKNOWN'); // a schedule run ID, not a system claim
    expect(labelSystem('SUBDRAIN')).toBe('UNKNOWN');
    expect(labelSystem('MH 2-MH 1')).toBe('UNKNOWN');
    expect(labelSystem('')).toBe('UNKNOWN');
  });
});

describe('runEndpointTokens', () => {
  it('extracts normalized structure tokens from endpoint pairs', () => {
    expect(runEndpointTokens('STMH 1-MH 2/INS.')).toEqual(['MH1', 'MH2']);
    expect(runEndpointTokens('MH 01-CBMH 2')).toEqual(['MH1', 'CBMH2']);
    expect(runEndpointTokens('MH 8-CONN.')).toEqual(['MH8']); // sentinel endpoint dropped
  });

  it('returns [] for dimension labels and line items', () => {
    expect(runEndpointTokens('75m-375mm STM')).toEqual([]);
    expect(runEndpointTokens('SUBDRAIN')).toEqual([]);
    expect(runEndpointTokens('VIDEO ($20/m)')).toEqual([]);
  });
});

describe('classifySystems', () => {
  it('classes by label first (structures and runs)', () => {
    const cls = classifySystems(
      [{ description: 'STMH 1' }, { description: 'SAN MH 1' }, { description: 'MH 7' }],
      [{ runLabel: '10m-300mm STM' }, { runLabel: '10m-200mm SAN' }, { runLabel: '10m-200mm' }]
    );
    expect(cls.structureSystems).toEqual(['STORM', 'SAN', 'UNKNOWN']);
    expect(cls.sewerSystems).toEqual(['STORM', 'SAN', 'UNKNOWN']);
    expect(cls.structureVia).toEqual(['label', 'label', 'none']);
    expect(cls.sewerVia).toEqual(['label', 'label', 'none']);
  });

  it('recovers a dropped qualifier from the structure\'s source evidence', () => {
    const cls = classifySystems(
      [
        { description: 'MH 1', source: { evidence: 'STM MH 1' } },
        { description: 'MH 2', source: { evidence: 'STM MH 3' } }, // evidence names ANOTHER structure
        { description: 'MH 3' }, // no evidence at all
      ],
      []
    );
    expect(cls.structureSystems).toEqual(['STORM', 'UNKNOWN', 'UNKNOWN']);
    expect(cls.structureVia).toEqual(['evidence', 'none', 'none']);
  });

  it('derives a run\'s system from agreeing endpoint structures, then the peer structure\'s from the run', () => {
    const cls = classifySystems(
      [{ description: 'STMH 1' }, { description: 'MH 2' }, { description: 'MH 9' }],
      [{ runLabel: 'MH 2-MH 1' }]
    );
    expect(cls.sewerSystems).toEqual(['STORM']);
    expect(cls.sewerVia).toEqual(['endpoints']);
    expect(cls.structureSystems).toEqual(['STORM', 'STORM', 'UNKNOWN']);
    expect(cls.structureVia).toEqual(['label', 'runs', 'none']);
  });

  it('refuses derivation when a number exists in both systems (ambiguous token)', () => {
    const cls = classifySystems(
      [{ description: 'STMH 1' }, { description: 'SAN MH 1' }, { description: 'MH 5' }],
      [{ runLabel: 'MH 1-MH 5' }]
    );
    // "MH 1" is claimed by both networks — nothing may inherit through it.
    expect(cls.sewerSystems).toEqual(['UNKNOWN']);
    expect(cls.structureSystems).toEqual(['STORM', 'SAN', 'UNKNOWN']);
  });

  it('refuses derivation when connected runs disagree', () => {
    const cls = classifySystems(
      [{ description: 'MH 4' }],
      [{ runLabel: 'MH 4-MH 8', isLineItem: false }, { runLabel: '10m-300mm SAN' }]
    );
    // Only one run actually touches MH 4 and it is unclassed; the SAN run is a
    // dimension label with no endpoints, so MH 4 stays UNKNOWN.
    expect(cls.structureSystems).toEqual(['UNKNOWN']);
  });

  it('never derives through line items', () => {
    const cls = classifySystems(
      [{ description: 'STMH 1' }, { description: 'MH 2' }],
      [{ runLabel: 'MH 1-MH 2', isLineItem: true }]
    );
    expect(cls.sewerSystems).toEqual(['UNKNOWN']);
    expect(cls.structureSystems).toEqual(['STORM', 'UNKNOWN']);
  });
});

describe('groupBySystem / nonEmptySectionCount', () => {
  it('partitions stably into storm / sanitary / unspecified', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const systems = ['SAN', 'STORM', 'UNKNOWN', 'STORM', 'SAN'] as const;
    expect(groupBySystem(items, [...systems])).toEqual({
      storm: ['b', 'd'],
      sanitary: ['a', 'e'],
      unspecified: ['c'],
    });
    expect(nonEmptySectionCount([...systems])).toBe(3);
    expect(nonEmptySectionCount(['STORM', 'STORM'])).toBe(1);
    expect(nonEmptySectionCount([])).toBe(0);
  });
});
