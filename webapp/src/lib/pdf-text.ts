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
  const doc = await lib.getDocument({ data: new Uint8Array(pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength)), isEvalSupported: false, useSystemFonts: true }).promise;
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

// A page is "texty" (text-layer path viable) when its drawing annotations —
// not just the prose around the drawing — are in the text layer. Two gates:
//   1. callout-keyword density >= 10 (the historical gate), AND
//   2. at least one hit in annotation FORM: a numeric callout shape that
//      legend/notes prose does not produce — a mm diameter, an @ slope, an
//      INV/T/G/RIM elevation carrying a value, or a numbered structure label.
// Gate 2 exists because SHX sheets carry ONLY prose in their text layer:
// Holiday Inn's SS-1 servicing sheet scored exactly 10 keyword hits — every
// one from its legend and general notes ("STORM STRUCTURES…", "SANITARY
// SEWER") — while its annotations are SHX strokes absent from the layer, so
// the keyword gate alone diverted the only sheet carrying runs/inverts to
// the text path, which extracted nothing (prod: runs 0/13, fieldAcc 0.0).
// Calibrated on the 26-project golden census (pr16_census): across all 135
// pages, gate 2 flips exactly that one page; every page whose text layer
// yields entities carries at least one annotation-form hit, and genuinely
// texty servicing sheets carry 100+ keyword hits with dozens of forms.
const CALLOUT_KW = /\b(STM|SAN(?:ITARY)?|STORM|INV|PVC|HDPE|CBMH|DCBMH|DICB|WATERMAIN|WM|T\/G)\b|\d+\s*mm|@\s*\d/gi;
const ANNOTATION_FORM = /\d+\s*mm|@\s*\d|\b(?:INV|T\/G|RIM)\s*[:=]?\s*\d|\b(?:STMH|SANMH|SAMH|CBMH|DCBMH|DDICB|DICB|DCB|MH|CB)\s*\d+/i;

/**
 * True when the page's text layer carries at least one callout in annotation
 * FORM (see gate 2 above). Legend/notes prose does not produce these shapes,
 * so this is the cheapest text-layer proof that a page is takeoff-bearing —
 * PR17's locator union (extraction.ts) uses it to recover bearing pages the
 * vision locator missed. It is NOT a texty verdict on its own: a page can
 * carry annotation forms while its callouts are SHX strokes the text grammar
 * cannot assemble (the PR16 fallback pages), so density still gates routing.
 */
export function hasAnnotationForm(pt: PageText): boolean {
  return ANNOTATION_FORM.test(pt.items.map((i) => i.text).join(' '));
}

export function isTextyPage(pt: PageText): boolean {
  const joined = pt.items.map((i) => i.text).join(' ');
  const hits = joined.match(CALLOUT_KW)?.length ?? 0;
  if (hits < 10) return false;
  return hasAnnotationForm(pt);
}
