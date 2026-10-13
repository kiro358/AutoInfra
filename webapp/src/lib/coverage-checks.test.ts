import { describe, it, expect } from 'vitest';
import { partialMissWarnings, appendCoverageWarnings } from './coverage-checks';
import { TakeoffFacts, StructureFact, SewerFact } from './types';

const facts = (over: Partial<TakeoffFacts>): TakeoffFacts => ({
  projectName: 'T', jobNumber: '', date: '',
  structures: [], catchbasins: [], sewers: [], watermain: [],
  watermainSpecials: [], watermainValves: [], confidence: 1, warnings: [],
  ...over,
});
const struct = (description: string): StructureFact => ({
  description, topElevation: null, lowInvert: null, highInvert: null,
  pipeOutDiameter: null, structureType: null, depth: null,
});
const run = (runLabel: string, over: Partial<SewerFact> = {}): SewerFact => ({
  runLabel, isLineItem: false, length: 10, pipeDiameter: 250,
  typeClass: null, slope: 1, depth: null, ...over,
});

describe('partialMissWarnings — dangling run endpoints', () => {
  it('reports an endpoint whose structure is absent', () => {
    const w = partialMissWarnings(facts({
      structures: [struct('MH 1')],
      sewers: [run('MH 1 - MH 9')],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('Coverage:');
    expect(w[0]).toContain('MH9');
  });

  it('is silent when every endpoint is in the takeoff', () => {
    const w = partialMissWarnings(facts({
      structures: [struct('MH 1'), struct('MH 2')],
      sewers: [run('MH 1 - MH 2')],
    }));
    expect(w).toEqual([]);
  });

  it('matches system-prefixed endpoints against bare structure labels', () => {
    const w = partialMissWarnings(facts({
      structures: [struct('MH 1'), struct('MH 2')],
      sewers: [run('STMH 1 - STMH 2')],
    }));
    expect(w).toEqual([]);
  });

  it('never reports the connection sentinel or existing-structure endpoints', () => {
    const w = partialMissWarnings(facts({
      structures: [struct('MH 1'), struct('MH 8')],
      sewers: [run('MH 8 - CONN.'), run('MH 1 - EX MH 9')],
    }));
    expect(w).toEqual([]);
  });

  it('ignores dimension callouts and line items — they name no endpoints', () => {
    const w = partialMissWarnings(facts({
      structures: [],
      sewers: [run('45.0m-250mm'), run('MH 1 - MH 9', { isLineItem: true })],
    }));
    expect(w).toEqual([]);
  });

  it('treats a catchbasin endpoint as present when its group has a quantity', () => {
    const base = {
      structures: [struct('MH 1')],
      sewers: [run('MH 1 - CB 3')],
    };
    expect(partialMissWarnings(facts({
      ...base,
      catchbasins: [{ type: 'SINGLE_CB', quantity: 2, wallThickness: null, depth: null }],
    }))).toEqual([]);
    const w = partialMissWarnings(facts({ ...base, catchbasins: [] }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('CB3');
  });

  it('names the family when an entire suffixed network is absent', () => {
    const w = partialMissWarnings(facts({
      structures: [struct('MH 1'), struct('MH 2')],
      sewers: [run('MH 1 - MH 10N'), run('MH 2 - MH 11N')],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('entire network');
    expect(w[0]).toContain('MH10N');
    expect(w[0]).toContain('MH11N');
  });

  it('falls back to the stray-endpoint warning when part of the family IS present', () => {
    const w = partialMissWarnings(facts({
      structures: [struct('MH 1'), struct('MH 12N')],
      sewers: [run('MH 1 - MH 10N')],
    }));
    expect(w).toHaveLength(1);
    expect(w[0]).not.toContain('entire network');
    expect(w[0]).toContain('MH10N');
  });

  it('reports each missing endpoint once, however many runs name it', () => {
    const w = partialMissWarnings(facts({
      structures: [struct('MH 1'), struct('MH 2')],
      sewers: [run('MH 1 - MH 9'), run('MH 2 - MH 9')],
    }));
    expect(w).toHaveLength(1);
    expect(w[0].match(/MH9/g)).toHaveLength(1);
  });
});

describe('appendCoverageWarnings', () => {
  it('appends the warnings without touching any fact', () => {
    const f = facts({
      structures: [struct('MH 1')],
      sewers: [run('MH 1 - MH 9')],
      warnings: ['pre-existing'],
    });
    const out = appendCoverageWarnings(f);
    expect(out.warnings[0]).toBe('pre-existing');
    expect(out.warnings).toHaveLength(2);
    const { warnings: _a, ...rest } = out;
    const { warnings: _b, ...orig } = f;
    expect(rest).toEqual(orig);
  });

  it('is idempotent — re-running over re-reconciled facts adds nothing twice', () => {
    const f = facts({
      structures: [struct('MH 1')],
      sewers: [run('MH 1 - MH 9')],
    });
    const once = appendCoverageWarnings(f);
    const twice = appendCoverageWarnings(once);
    expect(twice.warnings).toEqual(once.warnings);
  });

  it('returns the facts unchanged when there is nothing to report', () => {
    const f = facts({
      structures: [struct('MH 1'), struct('MH 2')],
      sewers: [run('MH 1 - MH 2')],
    });
    expect(appendCoverageWarnings(f)).toBe(f);
  });
});
