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

// Verbatim basenames from 2026-009 55 ERIC T. SMITH WAY,AURORA.
const ERIC_SMITH = [
  '55ETS-A01D1-Imperv-Liner-Jan30-25 (1).pdf',
  '55EricTSmithWay-A01D2-SPA-Nov15-24 - Copy.pdf',
  '55EricTSmithWay-A01EC-SPA-Nov15-24 - Copy.pdf',
  '55EricTSmithWay-A01SG-SPA-Nov15-24.pdf',
  '55EricTSmithWay-A01SS-SPA-Nov15-24.pdf',
  '55EricTSmithWay-A01T-SPA-Nov15-24 - Copy.pdf',
  'January 27\'26 2026-009 55 Eric T. Smith Way QUOTE.pdf',
  'QUOTE_2026-009-Excavation_Backfill_55_EricT.SmithWay_Aurora_Rev01_2026-01-28.pdf',
  'Rice - quote.pdf',
  'Topsite bid leveling 2026-04-15 completed.pdf',
  'Topsite bid leveling 2026-04-15.pdf',
];

describe('selectDrawingPdfs with sheet-code ranking', () => {
  it('keeps the site-servicing drawing and drops quotes and bid-levelling sheets', () => {
    const picked = selectDrawingPdfs(ERIC_SMITH);
    expect(picked).toContain('55EricTSmithWay-A01SS-SPA-Nov15-24.pdf');
    expect(picked.some((p) => /bid leveling/i.test(p))).toBe(false);
    expect(picked.some((p) => /quote/i.test(p))).toBe(false);
  });

  it('ranks the servicing sheet ahead of grading/erosion and prunes detail sheets', () => {
    const picked = selectDrawingPdfs(ERIC_SMITH);
    const idx = (frag: string) => picked.findIndex((p) => p.includes(frag));
    expect(idx('A01SS')).toBeGreaterThanOrEqual(0);
    expect(idx('A01SS')).toBeLessThan(idx('A01EC'));
    // Standard detail sheets (D1, D2) are pruned when a servicing plan exists
    expect(picked.some((p) => p.includes('A01D1'))).toBe(false);
    expect(picked.some((p) => p.includes('A01D2'))).toBe(false);
  });

  it('selects SS-1 and prunes standard detail sheets (Proposed Commercial case)', () => {
    const files = [
      '3. 24133 - SS-1.pdf',
      '4. 24133 - DET-1.pdf',
      '5. 24133 - DET-2.pdf',
      '6. 24133 - DET-3.pdf',
      '7. 24133 - DET-4.pdf',
      '8. 24133 - DET-5.pdf',
    ];
    const picked = selectDrawingPdfs(files);
    expect(picked).toEqual(['3. 24133 - SS-1.pdf']);
  });

  it('hard-excludes schedule of values and tender documents (Gerrard Shelter case)', () => {
    const files = [
      '2535 Gerrard Shelter - Civil Schedule of Values– Appendix H.pdf',
      '1.1.3- 4.06 25.12.12 2535 Gerrard St Shelter - Appendix G-Topsite.pdf',
      '2535 Gerrard Shelter - Civil Schedule of Values– Appendix H - Topsite.pdf',
    ];
    const picked = selectDrawingPdfs(files);
    expect(picked).toEqual(['1.1.3- 4.06 25.12.12 2535 Gerrard St Shelter - Appendix G-Topsite.pdf']);
  });
});

