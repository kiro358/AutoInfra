import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPageText, isTextyPage, PageText } from './pdf-text';

async function makeFixturePdf(lines: { text: string; x: number; y: number }[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const l of lines) page.drawText(l.text, { x: l.x, y: l.y, size: 10, font });
  return Buffer.from(await doc.save());
}

describe('extractPageText', () => {
  it('returns items with text and coordinates', async () => {
    const buf = await makeFixturePdf([
      { text: '83.7m-375mm SAN @ 0.02%', x: 100, y: 700 },
      { text: 'STMH 1', x: 100, y: 650 },
    ]);
    const pages = await extractPageText(buf);
    expect(pages).toHaveLength(1);
    expect(pages[0].page).toBe(1);
    const texts = pages[0].items.map((i) => i.text);
    expect(texts.join(' ')).toContain('83.7m-375mm SAN @ 0.02%');
    expect(texts.join(' ')).toContain('STMH 1');
    const stmh = pages[0].items.find((i) => i.text.includes('STMH'))!;
    expect(stmh.x).toBeGreaterThan(50);
    expect(stmh.y).toBeGreaterThan(600);
  });

  it('respects the pages filter and skips out-of-range pages', async () => {
    const buf = await makeFixturePdf([{ text: 'only page', x: 50, y: 700 }]);
    const pages = await extractPageText(buf, [1, 99]);
    expect(pages).toHaveLength(1);
  });
});

describe('isTextyPage', () => {
  it('is false for pages with only title-block noise, true for callout-dense pages', async () => {
    const noise = await extractPageText(await makeFixturePdf([{ text: 'DRAWN BY: ML  SCALE 1:500', x: 50, y: 700 }]));
    expect(isTextyPage(noise[0])).toBe(false);
    const dense = await extractPageText(await makeFixturePdf(
      Array.from({ length: 12 }, (_, i) => ({ text: `${10 + i}.5m-250mm STM @ 0.50%  INV=221.${i}0`, x: 60, y: 700 - i * 20 }))
    ));
    expect(isTextyPage(dense[0])).toBe(true);
  });
});

// The annotation-form gate: keyword density alone counts PROSE (legend and
// general-notes lines are full of STORM/SANITARY/WATERMAIN). A page is texty
// only when at least one hit has the numeric shape of a drawing callout.
describe('isTextyPage — annotation-form gate', () => {
  const pt = (texts: string[]): PageText => ({
    page: 1, width: 2592, height: 1728,
    items: texts.map((text, i) => ({ text, x: 100, y: 1500 - i * 30, width: 200, height: 12 })),
  });
  const KW = /\b(STM|SAN(?:ITARY)?|STORM|INV|PVC|HDPE|CBMH|DCBMH|DICB|WATERMAIN|WM|T\/G)\b|\d+\s*mm|@\s*\d/gi;
  const kwHits = (texts: string[]) => texts.join(' ').match(KW)?.length ?? 0;

  it('rejects a legend/notes-only page that crosses the keyword threshold on prose alone (Holiday Inn SS-1 shape)', () => {
    const legend = [
      'SANITARY SEWER LEGEND',
      'STORM STRUCTURES WITH ASTERISK ARE TO BE CONFIRMED',
      'STORM WATER STORAGE SYSTEM NOTES',
      'WATERMAIN GENERAL NOTES',
      'SANITARY CONNECTIONS TO BE VERIFIED',
      'STORM SEWER NOTES',
      'STORM DRAINAGE REPORT REFERENCE',
      'SANITARY NOTES',
      'STORM',
      'SANITARY',
    ];
    // The fixture really does cross the historical >=10 keyword gate — that
    // is the bug being pinned: every hit is prose, none is a callout form.
    expect(kwHits(legend)).toBeGreaterThanOrEqual(10);
    expect(isTextyPage(pt(legend))).toBe(false);
  });

  it('accepts a real texty servicing sheet (run callouts, elevations, labels)', () => {
    const sheet = [
      'STMH 1',
      'T/G=224.95',
      'N INV=223.350',
      '83.7m-375mmØ SAN @ 0.02%',
      '45.0m - 250mmØ PVC STM @ 0.50%',
      'CBMH 4',
      'INV=221.50',
      '60.0m - 300mmØ PVC STM @ 0.35%',
    ];
    expect(isTextyPage(pt(sheet))).toBe(true);
  });

  it('boundary: exactly at the keyword threshold with exactly one annotation form stays texty', () => {
    // Oakville p6 shape from the corpus census: kw=10, a single numbered
    // structure label — and that page's text layer yields real entities.
    const page = [
      'STORM', 'SANITARY', 'STORM', 'SANITARY', 'STORM',
      'SANITARY', 'STORM', 'SANITARY', 'WATERMAIN',
      'CBMH 4',
    ];
    expect(kwHits(page)).toBe(10);
    expect(isTextyPage(pt(page))).toBe(true);
  });

  it('boundary: annotation forms without keyword density stay non-texty (density gate retained)', () => {
    const sizes = ['250mm', '300mm', '375mm', '450mm', '525mm', '600mm', '750mm', '900mm', '1050mm'];
    expect(kwHits(sizes)).toBe(9);
    expect(isTextyPage(pt(sizes))).toBe(false);
  });

  it('accepts the space-form elevation (INV 221.50, no separator) as an annotation form', () => {
    const page = [
      'STORM', 'SANITARY', 'STORM', 'SANITARY', 'STORM',
      'SANITARY', 'STORM', 'SANITARY', 'STORM',
      'INV 221.50',
    ];
    expect(kwHits(page)).toBeGreaterThanOrEqual(10);
    expect(isTextyPage(pt(page))).toBe(true);
  });
});
