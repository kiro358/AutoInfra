import { describe, it, expect } from 'vitest';
import { assessConfidence, withConfidence, EMPTY_ASSEMBLY_SCORE } from './confidence';
import { priceTakeoff } from './costing-rules';
import { parseFacts } from './extraction';
import { TakeoffFacts, StructureFact, FactSource } from './types';

const base = (over: Partial<TakeoffFacts> = {}): TakeoffFacts => ({
  projectName: 'P', jobNumber: '', date: '',
  structures: [], catchbasins: [], sewers: [], watermain: [],
  watermainSpecials: [], watermainValves: [],
  confidence: 1, warnings: [], withheld: [],
  ...over,
});

const struct = (source?: FactSource): StructureFact => ({
  description: 'MH 1', topElevation: 100, lowInvert: 97, highInvert: null,
  pipeOutDiameter: 300, structureType: null, depth: null, source,
});
const READ: FactSource = { method: 'transcript', tile: 1, evidence: 'MH 1' };
const fourClean = () => base({ structures: [struct(READ), struct(READ), struct(READ), struct(READ)] });

describe('assessConfidence', () => {
  it('scores 1.0 with an empty breakdown when every signal is clean', () => {
    const a = assessConfidence(fourClean());
    expect(a.score).toBe(1);
    expect(a.factors).toEqual([]);
  });

  it('craters an empty assembly to the floor', () => {
    const a = assessConfidence(base());
    expect(a.score).toBe(EMPTY_ASSEMBLY_SCORE);
    expect(a.factors).toHaveLength(1);
    expect(a.factors[0].signal).toBe('empty-assembly');
  });

  it('deducts for unprovenanced facts in proportion to their share', () => {
    const facts = base({ structures: [struct(READ), struct(READ), struct(), struct()] });
    const a = assessConfidence(facts);
    const f = a.factors.find((x) => x.signal === 'unprovenanced-facts')!;
    expect(f.count).toBe(2);
    expect(f.total).toBe(4);
    expect(f.factor).toBeCloseTo(1 - 0.65 * 0.5, 4);
    expect(a.score).toBeCloseTo(f.factor, 4);
  });

  it('deducts for single-pass (unverifiable) facts', () => {
    const sp: FactSource = { method: 'single-pass' };
    const a = assessConfidence(base({ structures: [struct(sp), struct(sp), struct(sp), struct(sp)] }));
    const f = a.factors.find((x) => x.signal === 'unverifiable-method')!;
    expect(f.count).toBe(4);
    expect(a.score).toBeCloseTo(1 - 0.65, 4);
  });

  it('deducts for withheld questions, capped at one per fact', () => {
    const facts = fourClean();
    facts.withheld = [
      { entity: 'MH 1', field: 'length', kind: 'withheld', question: 'q', defaultApplied: null },
      { entity: 'MH 2', field: 'length', kind: 'withheld', question: 'q', defaultApplied: null },
    ];
    const a = assessConfidence(facts);
    const f = a.factors.find((x) => x.signal === 'withheld-questions')!;
    expect(f.count).toBe(2);
    expect(f.factor).toBeCloseTo(1 - 0.45 * 0.5, 4);
  });

  it('deducts for defaulted values (the priced-withheld signal)', () => {
    const facts = fourClean();
    facts.withheld = [
      { entity: '200mm PVC', field: 'ocSc', kind: 'defaulted', question: 'q', defaultApplied: { value: 1.1, source: 'estimator default' } },
      { entity: '200mm PVC', field: 'avgCover', kind: 'defaulted', question: 'q', defaultApplied: { value: 1.8, source: 'estimator default' } },
    ];
    const a = assessConfidence(facts);
    const f = a.factors.find((x) => x.signal === 'defaulted-values')!;
    expect(f.count).toBe(2);
    expect(f.factor).toBeCloseTo(1 - 0.65 * 0.5, 4);
  });

  it('deducts per coverage warning, multiplicatively', () => {
    const facts = fourClean();
    facts.warnings = ['Coverage: an entire network appears to be missing.', 'Coverage: 2 pipe run endpoint(s) lead to structures that are not in this takeoff.'];
    const a = assessConfidence(facts);
    const f = a.factors.find((x) => x.signal === 'coverage-warnings')!;
    expect(f.count).toBe(2);
    expect(f.factor).toBeCloseTo(0.85 * 0.85, 4);
    expect(a.score).toBeCloseTo(f.factor, 4);
  });

  it('reports derived values without deducting them', () => {
    const facts = fourClean();
    facts.withheld = [
      { entity: 'MH 1', field: 'diameter', kind: 'derived', question: 'q', defaultApplied: { value: 1200, source: 'largest connected pipe' } },
    ];
    const a = assessConfidence(facts);
    const f = a.factors.find((x) => x.signal === 'derived-values')!;
    expect(f.count).toBe(1);
    expect(f.factor).toBe(1);
    expect(a.score).toBe(1);
  });

  it('the breakdown multiplies to the score', () => {
    const facts = base({ structures: [struct(READ), struct(), struct(READ), struct()] });
    facts.withheld = [
      { entity: 'X', field: 'ocSc', kind: 'defaulted', question: 'q', defaultApplied: { value: 1.1, source: 'd' } },
      { entity: 'Y', field: 'length', kind: 'withheld', question: 'q', defaultApplied: null },
    ];
    facts.warnings = ['Coverage: dangling endpoints.'];
    const a = assessConfidence(facts);
    const product = a.factors.reduce((acc, f) => acc * f.factor, 1);
    expect(a.score).toBeCloseTo(product, 3);
    expect(a.factors.map((f) => f.signal)).toEqual(
      expect.arrayContaining(['unprovenanced-facts', 'defaulted-values', 'withheld-questions', 'coverage-warnings'])
    );
  });

  it('ignores non-coverage warnings (the corpus warning stream is mostly informational)', () => {
    const facts = fourClean();
    facts.warnings = ['Unparseable schedule row: "x"', 'Moved 1 surface catchbasin(s) out of the structure list.'];
    expect(assessConfidence(facts).score).toBe(1);
  });
});

describe('withConfidence', () => {
  it('replaces only the confidence fields and does not mutate the input', () => {
    const facts = fourClean();
    const out = withConfidence(facts);
    expect(out).not.toBe(facts);
    expect(facts.confidence).toBe(1);
    expect(facts.confidenceFactors).toBeUndefined();
    expect(out.confidence).toBe(1);
    expect(out.confidenceFactors).toEqual([]);
    expect(out.structures).toBe(facts.structures);
    expect(out.warnings).toBe(facts.warnings);
  });
});

describe('wiring', () => {
  it('parseFacts stamps single-pass provenance and scores it as unverifiable, ignoring the model self-report', () => {
    const facts = parseFacts({
      manholes: [{ description: 'MH 1', topElevation: 100, lowInvert: 97 }],
      catchbasins: { groups: [] }, sewers: [], watermain: [],
      watermainSpecials: [], watermainValves: [],
      confidence: 0.99, warnings: [],
    }, 'P');
    expect(facts.structures[0].source?.method).toBe('single-pass');
    // 1 fact, fully unverifiable: 1 − 0.65. The raw 0.99 plays no part.
    expect(facts.confidence).toBeCloseTo(0.35, 4);
    expect(facts.confidenceFactors?.map((f) => f.signal)).toContain('unverifiable-method');
  });

  it('priceTakeoff lands the defaulted-values deduction on the estimator-facing result', () => {
    const facts = base({
      watermain: [{
        sizeAndType: '200mm PVC', length: 40, pipeDiameter: 200, ocSc: null, avgCover: null,
        source: { method: 'text-layer', page: 1, evidence: '200mm PVC WM' },
      }],
    });
    const result = priceTakeoff(facts);
    const f = result.confidenceFactors?.find((x) => x.signal === 'defaulted-values');
    expect(f).toBeDefined();
    expect(f!.count).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(1);
    expect(result.confidence).toBeCloseTo(f!.factor, 3);
  });
});
