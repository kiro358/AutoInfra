import { describe, it, expect } from 'vitest';
import { selectDrawingPdfs } from './dataset';

describe('selectDrawingPdfs', () => {
  it('picks explicit civil/servicing drawings and drops quotes/geotech', () => {
    const out = selectDrawingPdfs([
      'ANNEX C - Construction Drawings - Civil.pdf',
      'Project Quote.pdf',
      'Geotechnical Report.pdf',
    ]);
    expect(out).toEqual(['ANNEX C - Construction Drawings - Civil.pdf']);
  });

  it('does not let the "site" hint fire on "topsite" (Eric Smith bug)', () => {
    // Real folder shape: coded drawing sheets (A01SS = Site Servicing) plus a tiny
    // "Topsite bid leveling" doc, quotes, and a locates request. The servicing sheet
    // must be selected; the bid-leveling / quote / locate files must not.
    const out = selectDrawingPdfs([
      'Topsite bid leveling 2026-04-15.pdf',
      '55EricTSmithWay-A01SS-SPA-Nov15-24.pdf',
      '55EricTSmithWay-A01SG-SPA-Nov15-24.pdf',
      'QUOTE_2026-009 Final Quote.pdf',
      'granular quote/rice.pdf',
      'Locates Request/55 Eric T Smith - Locate Limits.pdf',
    ]);
    expect(out).toContain('55EricTSmithWay-A01SS-SPA-Nov15-24.pdf');
    expect(out).not.toContain('Topsite bid leveling 2026-04-15.pdf');
    // "granular quote/rice.pdf" has a clean basename but a "quote" path segment.
    expect(out.some((f) => /quote/i.test(f))).toBe(false);
    expect(out.some((f) => /locate/i.test(f))).toBe(false);
  });

  it('matches civil hints as whole words in a nested path', () => {
    const out = selectDrawingPdfs(['Drawings/Civil/C101 Servicing Plan.pdf', 'Drawings/Arch/A100 Cover Sheet.pdf']);
    expect(out).toEqual(['Drawings/Civil/C101 Servicing Plan.pdf']);
  });
});
