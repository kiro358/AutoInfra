import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { readTruthFacts } from './truth-facts';

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
