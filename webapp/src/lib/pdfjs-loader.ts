/**
 * Shared pdfjs-dist loader: singleton-promise dynamic import + workerSrc resolution.
 * Used by both the tile-rasterization path (rasterize.ts) and the text-layer
 * extraction path (pdf-text.ts) — keep this the single source of truth so a fix
 * to worker-resolution (e.g. a Cloud Run path issue) only needs to be made once.
 */

let pdfjsPromise: Promise<any> | null = null;
export async function getPdfjs(): Promise<any> {
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
