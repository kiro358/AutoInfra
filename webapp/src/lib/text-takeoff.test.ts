import { describe, it, expect } from 'vitest';
import { assembleTextTakeoff } from './text-takeoff';
import { PageText } from './pdf-text';

const page = (items: { text: string; x: number; y: number }[]): PageText => ({
  page: 1, width: 2592, height: 1728,
  items: items.map((i) => ({ ...i, width: 50, height: 8 })),
});

describe('assembleTextTakeoff', () => {
  it('assembles structures with associated elevations', () => {
    const facts = assembleTextTakeoff([page([
      { text: 'EX SAN MH 02', x: 100, y: 500 },   // existing — excluded
      { text: 'STMH 1', x: 400, y: 500 },
      { text: 'T/G=224.95', x: 402, y: 490 },
      { text: 'N INV=223.350', x: 402, y: 480 },
      { text: 'S INV=223.250', x: 402, y: 470 },
      { text: 'T/G=999.99', x: 2000, y: 100 },     // orphan elevation — dropped
    ])], 'T');
    expect(facts.structures).toHaveLength(1);
    const s = facts.structures[0];
    expect(s.description).toBe('STMH 1');
    expect(s.topElevation).toBe(224.95);
    expect(s.lowInvert).toBe(223.25);
    expect(s.highInvert).toBe(223.35);
  });

  it('assembles runs, merging split callouts, excluding existing', () => {
    const facts = assembleTextTakeoff([page([
      { text: '83.7m-375mmØ SAN @ 0.02%', x: 100, y: 800 },
      { text: '45.0m - 250mmØ', x: 300, y: 700 },       // dangling head…
      { text: 'PVC STM @ 0.50%', x: 305, y: 692 },      // …continuation just below
      { text: 'EX SAN 7.2m - 250mmØ DR 35 @ 0.05%', x: 900, y: 600 }, // existing — excluded
    ])], 'T');
    expect(facts.sewers).toHaveLength(2);
    const dims = facts.sewers.map((s) => `${s.length}/${s.pipeDiameter}`).sort();
    expect(dims).toEqual(['45/250', '83.7/375']);
    expect(facts.sewers.find((s) => s.pipeDiameter === 250)!.slope).toBe(0.5);
  });

  it('counts CB kinds as catchbasin groups, not structures', () => {
    const facts = assembleTextTakeoff([page([
      { text: 'CB 1', x: 100, y: 500 }, { text: 'CB 2', x: 300, y: 500 },
      { text: 'CB 2', x: 700, y: 200 },  // duplicate label (appears on 2 sheets) — counted once
      { text: 'DCB 1', x: 500, y: 500 },
      { text: 'CBMH 3', x: 600, y: 400 }, // CBMH is a structure, not a CB group
    ])], 'T');
    expect(facts.structures.map((s) => s.description)).toEqual(['CBMH 3']);
    expect(facts.catchbasins).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'SINGLE_CB', quantity: 2 }),
      expect.objectContaining({ type: 'DOUBLE_CB', quantity: 1 }),
    ]));
  });

  it('excludes existing watermain but keeps the stated length on the live one', () => {
    const facts = assembleTextTakeoff([page([
      { text: '124.0m - 150mmØ PVC WM', x: 100, y: 500 },
      { text: 'EX WM - 250 mm', x: 300, y: 500 }, // existing — excluded regardless of length
    ])], 'T');
    expect(facts.watermain).toHaveLength(1);
    expect(facts.watermain[0]).toMatchObject({ length: 124, pipeDiameter: 150 });
  });

  it('assembles subdrains as sewer line items with runLabel SUBDRAIN, excluding existing', () => {
    const facts = assembleTextTakeoff([page([
      { text: '67.0m - 150mmØ SUBDRAIN', x: 100, y: 500 },
      { text: 'EX. 83.7m - 200mmØ SUBDRAIN', x: 300, y: 400 }, // existing — excluded
    ])], 'Oakville');
    expect(facts.sewers).toHaveLength(1);
    const subdrain = facts.sewers[0];
    expect(subdrain.runLabel).toBe('SUBDRAIN');
    expect(subdrain.isLineItem).toBe(false);
    expect(subdrain.length).toBe(67);
    expect(subdrain.pipeDiameter).toBe(150);
  });

  describe('subdrain callouts with a diameter but no stated length (Oakville Fire Hall verbatim lines)', () => {
    it('detects a diameter-only subdrain and collapses repeated identical mentions', () => {
      const facts = assembleTextTakeoff([page([
        { text: '150mm SUBDRAIN', x: 100, y: 600 },
        { text: '150mm SUBDRAIN', x: 300, y: 500 },
        { text: '150mm SUBDRAIN', x: 500, y: 400 },
        { text: '150mm SUBDRAIN', x: 700, y: 300 },
      ])], 'Oakville');
      const subdrains = facts.sewers.filter((s) => s.runLabel === 'SUBDRAIN');
      expect(subdrains).toHaveLength(1);
      expect(subdrains[0].pipeDiameter).toBe(150);
      expect(subdrains[0].length).toBe(0);
    });

    it('emits nothing for a subdrain callout with no diameter on the line', () => {
      const facts = assembleTextTakeoff([page([
        { text: 'SUBDRAIN WITH 0.5m CLEARANCE', x: 100, y: 600 },
        { text: 'SUBDRAIN. REFER TO DRAWING', x: 300, y: 500 },
      ])], 'Oakville');
      expect(facts.sewers.filter((s) => s.runLabel === 'SUBDRAIN')).toHaveLength(0);
    });
  });

  describe('watermain detection without a stated length', () => {
    it('emits a proposed main whose callout carries no length', () => {
      const facts = assembleTextTakeoff([page([
        { text: '200mmØ PVC WATERMAIN', x: 100, y: 600 },
        { text: 'EX. 300 mmØ PVC WATERMAIN', x: 100, y: 500 }, // existing — excluded
      ])], 'T');
      expect(facts.watermain).toHaveLength(1);
      expect(facts.watermain[0].pipeDiameter).toBe(200);
      expect(facts.watermain[0].length).toBe(0);
    });

    it('prefers a stated length over an unmeasured duplicate of the same size', () => {
      const facts = assembleTextTakeoff([page([
        { text: '150mmØ PVC WATERMAIN', x: 100, y: 600 },
        { text: '124.0m - 150mmØ PVC WM', x: 100, y: 400 },
      ])], 'T');
      expect(facts.watermain).toHaveLength(1);
      expect(facts.watermain[0].length).toBe(124);
    });
  });

  it('treats chamber structures as their own kind, not shadows of MH', () => {
    const facts = assembleTextTakeoff([page([
      { text: 'C100 CHAMBER', x: 100, y: 500 },
      { text: 'MH2 CHAMBER', x: 300, y: 400 }, // CHAMBER check runs first
      { text: 'MH 1', x: 500, y: 300 },
    ])], 'T');
    expect(facts.structures).toHaveLength(3);
    const c100 = facts.structures.find((s) => s.description === 'C100');
    const mh2 = facts.structures.find((s) => s.description === 'MH2');
    const mh1 = facts.structures.find((s) => s.description === 'MH 1');
    expect(c100).toBeDefined();
    expect(mh2).toBeDefined();
    expect(mh1).toBeDefined();
  });
});
