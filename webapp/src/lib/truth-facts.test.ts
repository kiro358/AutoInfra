import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  readTruthFacts,
  mergeTruthFacts,
  listTruthCandidates,
  loadTruthManifest,
  resolveTruthFacts,
} from './truth-facts';
import { TakeoffFacts } from './types';

const tf = (o: Partial<TakeoffFacts> = {}): TakeoffFacts => ({
  projectName: 'T', jobNumber: '', date: '',
  structures: [], catchbasins: [], sewers: [], watermain: [],
  watermainSpecials: [], watermainValves: [], confidence: 1, warnings: [], ...o,
});
const sewer = (runLabel: string) => ({ runLabel, isLineItem: false, length: 10, pipeDiameter: 250, typeClass: null, slope: null, depth: null });

// Smoke test against the real (empty) SHORT template that ships in the repo.
// Confirms the sheet/column wiring is valid and an unfilled template yields no
// facts — the full metric is exercised by compare-facts.test.ts.
const TEMPLATE = path.resolve(__dirname, '../../../empty_templates/SHORT-NEW - Copy (3).xlsx');

describe('readTruthFacts', () => {
  it.skipIf(!fs.existsSync(TEMPLATE))('parses a workbook into the TakeoffFacts shape', async () => {
    const facts = await readTruthFacts(TEMPLATE, 'EMPTY TEMPLATE');
    expect(Array.isArray(facts.structures)).toBe(true);
    expect(Array.isArray(facts.sewers)).toBe(true);
    expect(Array.isArray(facts.watermain)).toBe(true);
    // An unfilled template has no structures and no real pipe runs — the only
    // pre-printed sewer rows are the standard fee line-items (VIDEO/LAYOUT/AS BUILT).
    expect(facts.structures).toHaveLength(0);
    expect(facts.watermain).toHaveLength(0);
    expect(facts.sewers.every((s) => s.isLineItem)).toBe(true);
  });
});

describe('mergeTruthFacts (genuine multi-workbook site splits)', () => {
  it('concatenates runs/structures and sums catchbasins by type', () => {
    const a = tf({ sewers: [sewer('MH 1-MH 2')], structures: [{ description: 'MH 1' } as any], catchbasins: [{ type: 'SINGLE_CB', quantity: 3, wallThickness: null, depth: null }] });
    const b = tf({ sewers: [sewer('MH 3-MH 4')], structures: [{ description: 'MH 3' } as any], catchbasins: [{ type: 'SINGLE_CB', quantity: 2, wallThickness: null, depth: null }, { type: 'DOUBLE_CB', quantity: 1, wallThickness: null, depth: null }] });
    const m = mergeTruthFacts([a, b], 'SITE');
    expect(m.sewers.map((s) => s.runLabel)).toEqual(['MH 1-MH 2', 'MH 3-MH 4']);
    expect(m.structures).toHaveLength(2);
    expect(m.catchbasins.find((c) => c.type === 'SINGLE_CB')!.quantity).toBe(5); // 3 + 2
    expect(m.catchbasins.find((c) => c.type === 'DOUBLE_CB')!.quantity).toBe(1);
  });
});

describe('listTruthCandidates (junk filter)', () => {
  it('drops generated/backup/quote/material-quote/sand&gravel but KEEPS budget estimates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truthcand-'));
    for (const f of [
      'PROJECT.xlsx', '1220 WILSON AVE. BUDGET.xlsx',      // real truth (budget no longer wrongly excluded)
      'eval_run_golden_123.xlsx', 'PROJECT backup.xlsx', 'QUOTE.xlsx',
      'Sand & Gravel Material Quotes.xlsx', 'notes.pdf',
    ]) fs.writeFileSync(path.join(dir, f), '');
    const got = listTruthCandidates(dir).sort();
    expect(got).toEqual(['1220 WILSON AVE. BUDGET.xlsx', 'PROJECT.xlsx']);
  });
});

describe('loadTruthManifest / resolveTruthFacts', () => {
  it('returns {} for a missing manifest and strips the _readme key', () => {
    expect(loadTruthManifest('/no/such/manifest.json')).toEqual({});
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'man-')), 'm.json');
    fs.writeFileSync(p, JSON.stringify({ _readme: 'x', 'PROJ': { truth: 'a.xlsx' } }));
    const m = loadTruthManifest(p);
    expect(m._readme).toBeUndefined();
    expect(m['PROJ']).toEqual({ truth: 'a.xlsx' });
  });
  it('excludes a project marked exclude in the manifest', async () => {
    const got = await resolveTruthFacts('/anything', 'PROJ', { PROJ: { exclude: true } });
    expect(got).toBeNull();
  });
});
