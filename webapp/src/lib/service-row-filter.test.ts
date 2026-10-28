import { describe, it, expect } from 'vitest';
import {
  dropServiceOnlyRows,
  isServiceOnlyRow,
  isServiceRowFilterDisabled,
} from './service-row-filter';
import type { SewerFact, TakeoffFacts } from './types';

function factsWith(sewers: SewerFact[]): TakeoffFacts {
  return {
    projectName: 'P',
    jobNumber: '',
    date: '2026-10-28',
    structures: [],
    catchbasins: [],
    sewers,
    watermain: [],
    watermainSpecials: [],
    watermainValves: [],
    confidence: 0,
    warnings: [],
  };
}

function row(partial: Partial<SewerFact>): SewerFact {
  return {
    runLabel: '',
    isLineItem: true,
    length: null,
    pipeDiameter: null,
    typeClass: null,
    slope: null,
    depth: null,
    ...partial,
  };
}

/** The three rows 2026-073 formed live (PR 61), verbatim labels. */
const SHOPPERS_ROWS: SewerFact[] = [
  row({ runLabel: 'VIDEO ($25/m)' }),
  row({ runLabel: 'LAYOUT' }),
  row({ runLabel: 'AS BUILT' }),
];

const REAL_RUN: SewerFact = row({
  runLabel: '12m-150mm STM',
  isLineItem: false,
  length: 12,
  pipeDiameter: 150,
  typeClass: 2.35,
});

describe('service-row filter (PR 64)', () => {
  it('drops the three 2026-073 shapes and counts them with their labels', () => {
    const facts = factsWith([REAL_RUN, ...SHOPPERS_ROWS]);
    const { facts: out, dropped } = dropServiceOnlyRows(facts);
    expect(dropped).toEqual({
      count: 3,
      labels: ['VIDEO ($25/m)', 'LAYOUT', 'AS BUILT'],
      byKind: { VIDEO: 1, LAYOUT: 1, 'AS BUILT': 1 },
    });
    expect(out.sewers).toEqual([REAL_RUN]);
    // The input is not mutated.
    expect(facts.sewers).toHaveLength(4);
  });

  it('returns the identical facts object when nothing matches (byte-identical non-firing path)', () => {
    const facts = factsWith([REAL_RUN, row({ runLabel: 'SWALE' })]);
    const { facts: out, dropped } = dropServiceOnlyRows(facts);
    expect(out).toBe(facts);
    expect(dropped.count).toBe(0);
  });

  it('a service label WITH a quantity survives', () => {
    expect(isServiceOnlyRow(row({ runLabel: 'VIDEO ($25/m)', length: 306.5 }))).toBe(false);
    expect(isServiceOnlyRow(row({ runLabel: 'LAYOUT', pipeDiameter: 300 }))).toBe(false);
    expect(isServiceOnlyRow(row({ runLabel: 'AS BUILT', slope: 1.5 }))).toBe(false);
    expect(isServiceOnlyRow(row({ runLabel: 'VIDEO', depth: 2.1 }))).toBe(false);
    expect(isServiceOnlyRow(row({ runLabel: 'LAYOUT', typeClass: 2.35 }))).toBe(false);
  });

  it('a real run named similarly survives', () => {
    // Structure-bearing label: a run that mentions a service.
    expect(isServiceOnlyRow(row({ runLabel: 'MH 1 VIDEO INSPECTION', isLineItem: false }))).toBe(false);
    expect(isServiceOnlyRow(row({ runLabel: 'CB 2 - LAYOUT', isLineItem: false }))).toBe(false);
    // Dimension stated in the label itself.
    expect(isServiceOnlyRow(row({ runLabel: 'VIDEO INSPECTION 300mm' }))).toBe(false);
    // Non-fee line items (SWALE is a drainage feature, priced with labour).
    expect(isServiceOnlyRow(row({ runLabel: 'SWALE' }))).toBe(false);
  });

  it('the kill switch uses disable-when-set semantics', () => {
    expect(isServiceRowFilterDisabled({})).toBe(false);
    expect(isServiceRowFilterDisabled({ DISABLE_SERVICE_ROW_FILTER: '1' })).toBe(true);
    expect(isServiceRowFilterDisabled({ DISABLE_SERVICE_ROW_FILTER: 'false' })).toBe(false);
    expect(isServiceRowFilterDisabled({ DISABLE_SERVICE_ROW_FILTER: '0' })).toBe(false);
    expect(isServiceRowFilterDisabled({ DISABLE_SERVICE_ROW_FILTER: 'off' })).toBe(false);
  });
});
