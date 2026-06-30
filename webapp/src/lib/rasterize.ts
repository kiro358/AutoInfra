/**
 * PDF → high-DPI image tiles, for legible ingestion of large-format CAD sheets.
 *
 * Civil drawings are 24"×36" (or larger) sheets. Sending the whole PDF to the
 * model lets the provider downsample each page below legibility, so fine
 * schedule/annotation text becomes unreadable and the model fabricates. Instead
 * we rasterize the located pages at ~150 DPI and split them into overlapping
 * tiles small enough that the model sees the text at full fidelity.
 *
 * Uses pdfjs-dist (no system deps) + @napi-rs/canvas (prebuilt) so it runs both
 * locally and on Cloud Run without GraphicsMagick/Ghostscript.
 */
import { createCanvas, type SKRSContext2D, type Canvas } from '@napi-rs/canvas';

export interface TileOptions {
  dpi?: number;
  tilePx?: number;
  overlapPx?: number;
  maxTilesPerPage?: number;
}

export interface PageTiles {
  page: number; // 1-indexed
  tiles: Buffer[]; // PNG buffers, reading order (row-major)
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

let pdfjsPromise: Promise<any> | null = null;
async function getPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
      // In Node, pdfjs runs a "fake worker" that imports this file on the main thread.
      try {
        lib.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      } catch {
        lib.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';
      }
      return lib;
    });
  }
  return pdfjsPromise;
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
            tiles.push(tile.toBuffer('image/png'));
          }
        }
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

/** Convenience: flat list of PNG tiles across the given pages, capped overall. */
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
