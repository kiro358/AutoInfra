import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPageText, isTextyPage } from './pdf-text';

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
