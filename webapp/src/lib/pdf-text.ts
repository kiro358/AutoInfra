/**
 * Positioned text extraction from PDF text layers.
 *
 * ~1/3 of the drawing corpus (TrueType CAD plots) carries the servicing callouts
 * as real text objects; for those, this module replaces vision entirely: exact
 * strings, exact coordinates, zero LLM cost. SHX plots/scans yield only
 * title-block text and are detected by isTextyPage() so the vision path can
 * take over (see extraction.ts EXTRACTION_MODE=hybrid).
 *
 * Coordinates are PDF user space (origin BOTTOM-LEFT, y grows upward).
 */
import { getPdfjs } from './pdfjs-loader';

export interface PositionedText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageText {
  page: number;
  width: number;
  height: number;
  items: PositionedText[];
}

export async function extractPageText(pdfBuffer: Buffer, pages?: number[]): Promise<PageText[]> {
  const lib = await getPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(pdfBuffer), isEvalSupported: false, useSystemFonts: true }).promise;
  const out: PageText[] = [];
  try {
    const wanted = pages && pages.length > 0 ? pages : Array.from({ length: doc.numPages }, (_, i) => i + 1);
    for (const pageNum of wanted) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const items: PositionedText[] = [];
        for (const it of content.items as any[]) {
          const text = String(it.str || '').trim();
          if (!text) continue;
          // transform = [a, b, c, d, e, f]; e/f are the glyph origin in user space.
          items.push({ text, x: it.transform[4], y: it.transform[5], width: it.width ?? 0, height: it.height ?? 0 });
        }
        out.push({ page: pageNum, width: viewport.width, height: viewport.height, items });
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.destroy?.();
  }
  return out;
}

// A page is "texty" (text-layer path viable) when its callout-keyword density is
// high enough that the drawing annotations — not just the title block — are text.
// Thresholds calibrated on the golden corpus: texty servicing sheets show 100+
// keyword hits; SHX/raster sheets show <10 (all from the title block).
const CALLOUT_KW = /\b(STM|SAN(?:ITARY)?|STORM|INV|PVC|HDPE|CBMH|DCBMH|DICB|WATERMAIN|WM|T\/G)\b|\d+\s*mm|@\s*\d/gi;

export function isTextyPage(pt: PageText): boolean {
  const joined = pt.items.map((i) => i.text).join(' ');
  const hits = joined.match(CALLOUT_KW)?.length ?? 0;
  return hits >= 10;
}
