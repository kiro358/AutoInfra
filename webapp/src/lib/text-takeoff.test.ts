import { describe, it, expect } from 'vitest';
import { assembleTextTakeoff } from './text-takeoff';
import { PageText, decodeSymbolFontText } from './pdf-text';

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

describe('assembleTextTakeoff — provenance & withheld (PR 8)', () => {
  it('attaches text-layer source (page + evidence) to structures, runs and watermain', () => {
    const facts = assembleTextTakeoff([{
      page: 4, width: 2592, height: 1728,
      items: [
        { text: 'STMH 1', x: 400, y: 500, width: 50, height: 8 },
        { text: 'T/G=224.95', x: 402, y: 490, width: 50, height: 8 },
        { text: '83.7m-375mmØ SAN @ 0.02%', x: 100, y: 800, width: 50, height: 8 },
        { text: '200mmØ PVC WATERMAIN 120.0m', x: 100, y: 300, width: 50, height: 8 },
      ],
    }], 'T');
    expect(facts.structures[0].source).toEqual({ method: 'text-layer', page: 4, evidence: 'STMH 1' });
    expect(facts.sewers[0].source).toEqual({ method: 'text-layer', page: 4, evidence: '83.7m-375mmØ SAN @ 0.02%' });
    expect(facts.watermain[0].source).toEqual({ method: 'text-layer', page: 4, evidence: '200mmØ PVC WATERMAIN 120.0m' });
    expect(facts.watermain[0].ocSc).toBeNull();
    expect(facts.watermain[0].avgCover).toBeNull();
  });

  it('withholds the length of an unmeasured watermain callout', () => {
    const facts = assembleTextTakeoff([page([
      { text: '200mmØ PVC WATERMAIN', x: 100, y: 300 },
    ])], 'T');
    expect(facts.watermain).toHaveLength(1);
    expect(facts.withheld ?? []).toEqual([
      expect.objectContaining({ field: 'length', kind: 'withheld', defaultApplied: null }),
    ]);
  });
});

// Symbol-font callouts (PR 22): extractPageText decodes the font's shifted
// glyphs before assembly (see pdf-text.ts decodeSymbolFontText). These items
// are the verbatim raw extractions from Uxbridge Pool's servicing sheet,
// passed through that same decode, as production items arrive.
describe('assembleTextTakeoff — symbol-font callouts (Uxbridge dialect)', () => {
  const decodedPage = (items: { text: string; x: number; y: number }[]): PageText => page(
    items.map((i) => ({ ...i, text: decodeSymbolFontText(i.text) })),
  );

  it('assembles a complete symbol-font run callout', () => {
    const facts = assembleTextTakeoff([decodedPage([
      { text: '\u0018\u0011\u001aP\u0003\u0010\u0003\u0015\u0013\u0013PP\u0091\u000367250\u0003#\u0003\u0015\u0011\u0018\u0008', x: 1082, y: 241 }, // "5.7m - 200mmØ STORM @ 2.5%"
    ])], 'T');
    expect(facts.sewers).toHaveLength(1);
    expect(facts.sewers[0]).toMatchObject({ length: 5.7, pipeDiameter: 200, slope: 2.5 });
    expect(facts.sewers[0].runLabel).toContain('STM');
  });

  it('joins a symbol-font head with its plain-font slope tail', () => {
    const facts = assembleTextTakeoff([decodedPage([
      { text: '\u0014\u0011\u0016P\u0003\u0010\u0003\u0014\u0018\u0013PP\u0091\u000367250', x: 642, y: 1272 }, // "1.3m - 150mmØ STORM"
      { text: '@ 2.0% (INSULATE)', x: 659, y: 1260 },
    ])], 'T');
    expect(facts.sewers).toHaveLength(1);
    expect(facts.sewers[0]).toMatchObject({ length: 1.3, pipeDiameter: 150, slope: 2 });
  });

  it('does not mint entities from decoded legend lines for existing pipes', () => {
    const facts = assembleTextTakeoff([decodedPage([
      { text: '(;\u0011\u0003\u0016\u0013\u0013PP\u0091\u0003:$7(50$,1', x: 362, y: 609 }, // "EX. 300mmØ WATERMAIN"
      { text: '(;\u0011\u0003\u0015\u0013\u0013PP\u0091\u00036$1,7$5<', x: 301, y: 1010 }, // "EX. 200mmØ SANITARY"
    ])], 'T');
    expect(facts.sewers).toHaveLength(0);
    expect(facts.watermain).toHaveLength(0);
  });
});

describe('assembleTextTakeoff — PR25 grammar extensions', () => {
  it('emits the EF component named in an OGS parenthetical alongside its host', () => {
    const facts = assembleTextTakeoff([page([
      { text: 'CBMH33 (OGS3-EF04)', x: 100, y: 100 },
    ])], 'CRIMSON');
    expect(facts.structures.map((s) => s.description).sort()).toEqual(['CBMH33', 'EF 04']);
  });

  it('reads a DOMESTIC callout as watermain, not as a sewer run', () => {
    const facts = assembleTextTakeoff([page([
      { text: 'PROP. 68.00m - 150mmØ PVC DOMESTIC', x: 100, y: 100 },
    ])], 'STEVENSON');
    expect(facts.sewers).toEqual([]);
    expect(facts.watermain).toHaveLength(1);
    expect(facts.watermain[0].pipeDiameter).toBe(150);
    expect(facts.watermain[0].length).toBe(68);
  });
});
