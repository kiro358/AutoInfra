/**
 * PDF → high-DPI image tiles, for legible ingestion of large-format CAD sheets.
 *
 * Civil drawings are 24"×36" (or larger) sheets. Sending the whole PDF to the
 * model lets the provider downsample each page below legibility, so fine
 * schedule/annotation text becomes unreadable and the model fabricates. Instead
 * we rasterize the located pages at ~150 DPI, split into overlapping JPEG
 * tiles small enough that the model sees the text at full fidelity.
 *
 * Uses pdfjs-dist (no system deps) + @napi-rs/canvas (prebuilt) so it runs both
 * locally and on Cloud Run without GraphicsMagick/Ghostscript.
 */
import { createCanvas, type SKRSContext2D, type Canvas } from '@napi-rs/canvas';
import { getPdfjs } from './pdfjs-loader';

// Tiles/thumbnails are encoded as JPEG: for CAD line-art on white it is 3-5x
// smaller than PNG (faster uploads, smaller model payload) with negligible
// legibility loss at high quality. Callers must use this mime type.
export const IMAGE_MIME = 'image/jpeg';
const TILE_JPEG_QUALITY = 90;
const THUMB_JPEG_QUALITY = 80;

export interface TileOptions {
  dpi?: number;
  tilePx?: number;
  overlapPx?: number;
  maxTilesPerPage?: number;
}

export interface PageTiles {
  page: number; // 1-indexed
  tiles: Buffer[]; // JPEG buffers, reading order (row-major)
}

// pdfjs needs a canvas factory to create intermediate canvases in Node.
class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(Math.max(1, width), Math.max(1, height));
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc: { canvas: Canvas; context: SKRSContext2D }, width: number, height: number) {
    cc.canvas.width = Math.max(1, width);
    cc.canvas.height = Math.max(1, height);
  }
  destroy(cc: { canvas: Canvas; context: SKRSContext2D }) {
    cc.canvas.width = 0;
    cc.canvas.height = 0;
  }
}

/**
 * Render the given (1-indexed) pages of a PDF to overlapping PNG tiles.
 * Pages outside the document range are skipped.
 */
export async function renderPdfPagesToTiles(
  pdfBuffer: Buffer,
  pages: number[],
  opts: TileOptions = {}
): Promise<PageTiles[]> {
  const { dpi = 150, tilePx = 1600, overlapPx = 160, maxTilesPerPage = 16 } = opts;
  const lib = await getPdfjs();
  const canvasFactory = new NodeCanvasFactory();

  // Fresh Uint8Array copy — pdfjs takes ownership of the buffer it's given.
  const data = new Uint8Array(pdfBuffer);
  const doc = await lib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    canvasFactory,
  }).promise;

  const result: PageTiles[] = [];
  try {
    const wanted = pages && pages.length > 0
      ? pages
      : Array.from({ length: doc.numPages }, (_, i) => i + 1);

    for (const pageNum of wanted) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      try {
        const viewport = page.getViewport({ scale: dpi / 72 });
        const W = Math.ceil(viewport.width);
        const H = Math.ceil(viewport.height);
        const full = createCanvas(W, H);
        const ctx = full.getContext('2d');
        // White background (CAD PDFs are often transparent).
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        await page.render({ canvasContext: ctx as unknown as object, viewport, canvasFactory }).promise;

        const step = Math.max(1, tilePx - overlapPx);
        const cols = Math.max(1, Math.ceil((W - overlapPx) / step));
        const rows = Math.max(1, Math.ceil((H - overlapPx) / step));
        const tiles: Buffer[] = [];
        for (let r = 0; r < rows && tiles.length < maxTilesPerPage; r++) {
          for (let c = 0; c < cols && tiles.length < maxTilesPerPage; c++) {
            const sx = Math.min(c * step, Math.max(0, W - tilePx));
            const sy = Math.min(r * step, Math.max(0, H - tilePx));
            const sw = Math.min(tilePx, W - sx);
            const sh = Math.min(tilePx, H - sy);
            if (sw <= 0 || sh <= 0) continue;
            const tile = createCanvas(sw, sh);
            tile.getContext('2d').drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
            // Async encode runs off the main thread; the sync toBuffer() froze the
            // server for seconds per page, stalling job polls and health checks.
            tiles.push(await tile.encode('jpeg', TILE_JPEG_QUALITY));
            tile.width = 0; // release native pixel memory now, not at next GC
            tile.height = 0;
          }
        }
        // A 36x48in sheet at 150 DPI is a ~155 MB canvas; free it before the next page.
        full.width = 0;
        full.height = 0;
        result.push({ page: pageNum, tiles });
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.destroy?.();
  }
  return result;
}

/**
 * Render every page to a single downscaled thumbnail (one image per page) for
 * cheap page-type classification (the page locator). Resolution is high enough to
 * read sheet titles / section headers and see whether a page is a servicing plan,
 * profile, or schedule vs. siltation / detail / cover / notes.
 */
export async function renderPageThumbnails(
  pdfBuffer: Buffer,
  opts: { maxPx?: number; pages?: number[] } = {}
): Promise<{ page: number; img: Buffer }[]> {
  const { maxPx = 1500 } = opts;
  const lib = await getPdfjs();
  const canvasFactory = new NodeCanvasFactory();
  const data = new Uint8Array(pdfBuffer);
  const doc = await lib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    canvasFactory,
  }).promise;

  const out: { page: number; img: Buffer }[] = [];
  try {
    const wanted = opts.pages && opts.pages.length > 0
      ? opts.pages.filter((p) => p >= 1 && p <= doc.numPages)
      : Array.from({ length: doc.numPages }, (_, i) => i + 1);
    for (const pageNum of wanted) {
      const page = await doc.getPage(pageNum);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = maxPx / Math.max(base.width, base.height);
        const viewport = page.getViewport({ scale });
        const W = Math.ceil(viewport.width);
        const H = Math.ceil(viewport.height);
        const canvas = createCanvas(W, H);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, H);
        await page.render({ canvasContext: ctx as unknown as object, viewport, canvasFactory }).promise;
        out.push({ page: pageNum, img: await canvas.encode('jpeg', THUMB_JPEG_QUALITY) });
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.destroy?.();
  }
  return out;
}

/** Drawn-content census for one page, from its pdf.js operator list. */
export interface DrawnContentStat {
  /** Path construction/paint operators (constructPath, stroke, fill, …):
   *  a vector CAD sheet carries tens of thousands; a text document a few
   *  hundred at most; a pure scan ~zero (its content is one image). */
  pathOps: number;
  /** Painted raster images (photo bases, scanned sheets, logos). */
  imageOps: number;
}

/**
 * Measure how much DRAWN content the given pages carry, without rendering.
 * Used by the locator's image-only pass (extraction.ts): pages the text
 * layer cannot read at all are otherwise indistinguishable from blank or
 * prose pages; a dense vector operator list (or, for scans, a painted
 * full-page image behind an empty text layer) is the positive evidence
 * that a page holds a drawing rather than a document. Pages outside the
 * document range are skipped; a page whose operator list fails to load is
 * simply absent from the result (no evidence → not a candidate).
 */
export async function measureDrawnContent(
  pdfBuffer: Buffer,
  pages: number[],
): Promise<Map<number, DrawnContentStat>> {
  const out = new Map<number, DrawnContentStat>();
  if (pages.length === 0) return out;
  const lib = await getPdfjs();
  const OPS = lib.OPS;
  const canvasFactory = new NodeCanvasFactory();
  const data = new Uint8Array(pdfBuffer);
  const doc = await lib.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    canvasFactory,
  }).promise;
  try {
    for (const pageNum of pages) {
      if (pageNum < 1 || pageNum > doc.numPages) continue;
      const page = await doc.getPage(pageNum);
      try {
        const ol = await page.getOperatorList();
        let pathOps = 0;
        let imageOps = 0;
        for (const fn of ol.fnArray) {
          if (
            fn === OPS.constructPath || fn === OPS.stroke || fn === OPS.fill ||
            fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke ||
            fn === OPS.closeStroke || fn === OPS.closeFillStroke ||
            fn === OPS.closeEOFillStroke || fn === OPS.endPath
          ) pathOps++;
          else if (
            fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject ||
            fn === OPS.paintImageMaskXObject
          ) imageOps++;
        }
        out.set(pageNum, { pathOps, imageOps });
      } catch {
        // No operator list → no drawn-content evidence for this page.
      } finally {
        page.cleanup?.();
      }
    }
  } finally {
    await doc.destroy?.();
  }
  return out;
}

/** Convenience: flat list of JPEG tiles across the given pages, capped overall. */
export async function renderTilesFlat(
  pdfBuffer: Buffer,
  pages: number[],
  opts: TileOptions & { maxTilesTotal?: number } = {}
): Promise<Buffer[]> {
  const { maxTilesTotal = 48, ...tileOpts } = opts;
  const perPage = await renderPdfPagesToTiles(pdfBuffer, pages, tileOpts);
  const flat: Buffer[] = [];
  for (const p of perPage) {
    for (const t of p.tiles) {
      flat.push(t);
      if (flat.length >= maxTilesTotal) return flat;
    }
  }
  return flat;
}
