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
import { isSpecialistDisabled } from './specialists';

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
  /** Items whose text the symbol-font decode actually rewrote on this
   *  page (PR47 Phase 0: the SHX/symbol-font dialect's routing-time
   *  signal — a page whose callouts needed decoding carries its dialect
   *  on its face). Present only when at least one item was rewritten. */
  symbolFontItems?: number;
}

// --- Symbol-font encoded callouts ---------------------------------------------
// Some CAD plots set their dimension callouts in a symbol font whose glyphs
// sit at code points shifted +0x1D from ASCII (the font's space is U+0003,
// its '.' is U+0011, its 'm' is 'P', its '@' is '#', ...). pdf.js has no
// ToUnicode map for such a font, so extraction returns the raw codes —
// control characters and punctuation where the callout should be:
//   "\u0018\u0011\u001aP\u0003\u0010\u0003\u0015\u0013\u0013PP\u0091\u000367250\u0003#\u0003\u0015\u0011\u0018\u0008"
// is the drafter's "5.7m - 200mmØ STORM @ 2.5%". Structure labels and
// elevations on the same sheets use a normal font and extract cleanly, so the
// page looks texty and yields structures while every run reads as garbage and
// is silently dropped (Uxbridge Pool: 23 truth runs, 0 extracted).
//
// The decode is gated so tightly that it can only fire on this font's items:
//   - at least two characters below U+0020 (real text items never carry
//     control characters), AND
//   - EVERY character at or below U+0060, or in the glyph table below — the
//     shifted font's raw alphabet tops out at 'P' (its 'm'); a single
//     lowercase letter or other real-font character disqualifies the item,
//     so mixed-font prose is never rewritten.
// The result must still look like text (a letter survives, no control
// residue); anything else returns the item unchanged. Decoding is purely
// normalisation: the decoded string faces the same strict callout grammar
// as any other line, so a symbol-font item that is not a callout (a title,
// a legal description) decodes to prose the parsers ignore, exactly as the
// raw codes were ignored before.
const SYMBOL_FONT_SHIFT = 0x1d;
const SYMBOL_FONT_GLYPHS: Record<number, string> = { 0x91: 'Ø' };

export function decodeSymbolFontText(text: string): string {
  let controls = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20) controls++;
    else if (code > 0x60 && !(code in SYMBOL_FONT_GLYPHS)) return text;
  }
  if (controls < 2) return text;
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code in SYMBOL_FONT_GLYPHS) { out += SYMBOL_FONT_GLYPHS[code]; continue; }
    const shifted = code + SYMBOL_FONT_SHIFT;
    out += shifted >= 0x20 && shifted <= 0x7e ? String.fromCharCode(shifted) : ch;
  }
  if (!/[A-Za-z]/.test(out) || /[\u0000-\u001f]/.test(out)) return text;
  return out;
}

/**
 * The S9 dialect seam (PR47 Phase 1, see specialists.ts): the symbol-font
 * decode as extraction actually applies it -- with the specialist's
 * kill switch (DISABLE_SHX_DECODE) set, the raw item passes through
 * exactly as pdf.js returned it (the pre-PR #47 behaviour: such items
 * then face the grammar as the raw codes they are).
 */
export function decodePageItemText(raw: string): string {
  return isSpecialistDisabled('S9-shx-dialect') ? raw : decodeSymbolFontText(raw);
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
        let symbolFontItems = 0;
        for (const it of content.items as any[]) {
          const raw = String(it.str || '').trim();
          const text = decodePageItemText(raw);
          if (text !== raw) symbolFontItems++;
          if (!text) continue;
          // transform = [a, b, c, d, e, f]; e/f are the glyph origin in user space.
          items.push({ text, x: it.transform[4], y: it.transform[5], width: it.width ?? 0, height: it.height ?? 0 });
        }
        out.push({ page: pageNum, width: viewport.width, height: viewport.height, items, ...(symbolFontItems > 0 ? { symbolFontItems } : {}) });
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

const ELEVATION_ITEM = /\b(?:INV|T\/G|RIM)\s*[:=]?\s*\d/;

/**
 * How many of the page's text items carry an elevation value (INV / T/G /
 * RIM with a number). Elevations are the densest annotation class on a
 * servicing plan — a page whose layer carries callout forms but ZERO
 * elevation items is a page whose annotation set is only partially in the
 * layer (the rest is strokes or a drawn table). PR46's dual-read trigger
 * (extraction.ts) keys on exactly that absence.
 */
export function countElevationItems(pt: PageText): number {
  let n = 0;
  for (const i of pt.items) if (ELEVATION_ITEM.test(i.text)) n++;
  return n;
}

/**
 * Callout-keyword hits over the page's joined text — the same count
 * isTextyPage's density gate uses, exposed for routing diagnostics
 * (PR46's dual-read trigger requires a minimum annotation density before
 * it will spend vision on a texty page).
 */
export function countCalloutKeywordHits(pt: PageText): number {
  return pt.items.map((i) => i.text).join(' ').match(CALLOUT_KW)?.length ?? 0;
}

export function isTextyPage(pt: PageText): boolean {
  const joined = pt.items.map((i) => i.text).join(' ');
  const hits = joined.match(CALLOUT_KW)?.length ?? 0;
  if (hits < 10) return false;
  return hasAnnotationForm(pt);
}
