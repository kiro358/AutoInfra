/**
 * Page classifier (PR47 Phase 0) — the recorded taxonomy: page kinds
 * P1–P6 and family tags from routing-time signals only. The fixtures
 * are the study's measured shapes (pdf_schedule_conventions.md §1a/§2.2):
 * a clean texty plan page, Ultimate Drive's partial layer (134 keyword
 * hits, zero elevation items, dense drawn content), the excluded prose
 * page the PR46 census killed (18 hits), an SHX-sparse sheet, a Gerrard
 * raster page, and Uxbridge's symbol-font-decoded callouts.
 */
import { describe, it, expect } from 'vitest';
import { classifyPage, classifyPages, type PageSignalInput } from './page-classifier';

const base: PageSignalInput = {
  page: 1,
  items: 400, chars: 9000, texty: true, annotationForm: true,
  soloYield: 6, soloRunYield: 3, elevationItems: 24, keywordHits: 210,
  pathOps: null, imageOps: null, symbolFontItems: null,
};
const sig = (over: Partial<PageSignalInput>): PageSignalInput => ({ ...base, ...over });

describe('classifyPage — page kinds', () => {
  it('P1 claimed: texty, elevations present, solo bearing proven', () => {
    const c = classifyPage(sig({}));
    expect(c.kind).toBe('P1');
    expect(c.kindTier).toBe('claimed');
    expect(c.families).toEqual([]);
  });

  it('P1 suspect: texty but neither yields nor elevations were measured', () => {
    const c = classifyPage(sig({ soloYield: null, soloRunYield: null, elevationItems: null, keywordHits: null }));
    expect(c.kind).toBe('P1');
    expect(c.kindTier).toBe('suspect');
  });

  it('P3 claimed: texty, zero elevation items, keyword density at the gate', () => {
    const c = classifyPage(sig({ elevationItems: 0, keywordHits: 134 }));
    expect(c.kind).toBe('P3');
    expect(c.kindTier).toBe('claimed');
  });

  it('zero elevation items without the density proof stays P1, suspect', () => {
    // The PR46 census's excluded prose shape (18 hits): partial layer
    // suspected, never claimed.
    const c = classifyPage(sig({ elevationItems: 0, keywordHits: 18 }));
    expect(c.kind).toBe('P1');
    expect(c.kindTier).toBe('suspect');
    expect(c.families.find((f) => f.tag === 'partial-layer')).toBeUndefined();
  });

  it('P2 claimed: annotation form without the texty verdict', () => {
    const c = classifyPage(sig({ texty: false, soloYield: null, soloRunYield: null }));
    expect(c.kind).toBe('P2');
    expect(c.kindTier).toBe('claimed');
  });

  it('P4 claimed: sparse items and chars, no forms (the SHX / cover shape)', () => {
    const c = classifyPage(sig({ texty: false, annotationForm: false, items: 13, chars: 142 }));
    expect(c.kind).toBe('P4');
    expect(c.kindTier).toBe('claimed');
  });

  it('P5 claimed: text-bearing details/notes page, items >= 30, no forms', () => {
    const c = classifyPage(sig({ texty: false, annotationForm: false, items: 210, chars: 15000 }));
    expect(c.kind).toBe('P5');
    expect(c.kindTier).toBe('claimed');
  });

  it('P6 claimed when an image was measured, suspect when nothing was', () => {
    const claimed = classifyPage(sig({ items: 0, chars: 0, texty: false, annotationForm: false, imageOps: 4, pathOps: 12 }));
    expect(claimed.kind).toBe('P6');
    expect(claimed.kindTier).toBe('claimed');
    const suspect = classifyPage(sig({ items: 0, chars: 0, texty: false, annotationForm: false }));
    expect(suspect.kind).toBe('P6');
    expect(suspect.kindTier).toBe('suspect');
  });

  it('unextracted page (items unmeasured) degrades to a suspect kind, never a claim', () => {
    const withChars = classifyPage(sig({ items: null, chars: 5000, texty: null, annotationForm: null }));
    expect(withChars.kindTier).toBe('suspect');
    const noChars = classifyPage(sig({ items: null, chars: null, texty: null, annotationForm: null }));
    expect(noChars.kind).toBe('P6');
    expect(noChars.kindTier).toBe('suspect');
  });
});

describe('classifyPage — family tags', () => {
  it('partial-layer claimed only when the full PR46 conjunction was measured', () => {
    const c = classifyPage(sig({ elevationItems: 0, keywordHits: 134, pathOps: 34051 }));
    expect(c.families).toContainEqual({ tag: 'partial-layer', tier: 'claimed' });
    // A claimed partial layer is where a drawn schedule can hide — the
    // schedule tag stays suspect (its detector reads transcript rows).
    expect(c.families).toContainEqual({ tag: 'drawn-schedule', tier: 'suspect' });
  });

  it('partial-layer suspect when drawn content was never measured', () => {
    const c = classifyPage(sig({ elevationItems: 0, keywordHits: 134, pathOps: null }));
    expect(c.families).toContainEqual({ tag: 'partial-layer', tier: 'suspect' });
    expect(c.families.find((f) => f.tag === 'drawn-schedule')).toBeUndefined();
  });

  it('partial-layer stays suspect when the drawn gate refutes dispatch', () => {
    const c = classifyPage(sig({ elevationItems: 0, keywordHits: 134, pathOps: 4408 }));
    expect(c.families).toContainEqual({ tag: 'partial-layer', tier: 'suspect' });
  });

  it('partial-layer suspect when solo bearing was never measured', () => {
    const c = classifyPage(sig({ elevationItems: 0, keywordHits: 134, pathOps: 34051, soloYield: null, soloRunYield: null }));
    expect(c.families).toContainEqual({ tag: 'partial-layer', tier: 'suspect' });
  });

  it('no partial-layer tag when any text-side conjunct fails', () => {
    const withElevations = classifyPage(sig({ elevationItems: 3, keywordHits: 134, pathOps: 34051 }));
    expect(withElevations.families).toEqual([]);
    const sparse = classifyPage(sig({ elevationItems: 0, keywordHits: 18, pathOps: 34051 }));
    expect(sparse.families.find((f) => f.tag === 'partial-layer')).toBeUndefined();
  });

  it('shx-dialect claimed at >= 2 decoded items, suspect at exactly 1, absent at 0', () => {
    expect(classifyPage(sig({ symbolFontItems: 23 })).families).toContainEqual({ tag: 'shx-dialect', tier: 'claimed' });
    expect(classifyPage(sig({ symbolFontItems: 1 })).families).toContainEqual({ tag: 'shx-dialect', tier: 'suspect' });
    expect(classifyPage(sig({ symbolFontItems: 0 })).families.find((f) => f.tag === 'shx-dialect')).toBeUndefined();
    expect(classifyPage(sig({ symbolFontItems: null })).families.find((f) => f.tag === 'shx-dialect')).toBeUndefined();
  });
});

describe('classifyPages', () => {
  it('maps inputs in order, preserving page numbers and echoing signals', () => {
    const out = classifyPages([sig({ page: 3 }), sig({ page: 7, items: 0, imageOps: 2 })]);
    expect(out.map((c) => c.page)).toEqual([3, 7]);
    expect(out[0].signals.keywordHits).toBe(210);
    expect(out[1].kind).toBe('P6');
  });
});
