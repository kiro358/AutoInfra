/**
 * Shared pdfjs-dist loader: singleton-promise dynamic import + worker setup.
 * Used by both the tile-rasterization path (rasterize.ts) and the text-layer
 * extraction path (pdf-text.ts) — keep this the single source of truth so a fix
 * to worker-resolution (e.g. a Cloud Run path issue) only needs to be made once.
 *
 * In Node, pdfjs runs a "fake worker" on the main thread. By default it does
 * that by `import(workerSrc)` at runtime — a path Next's standalone file tracer
 * cannot see, so pdf.worker.mjs was missing from the Docker image ("Setting up
 * fake worker failed: Cannot find module .../pdf.worker.mjs"). Importing the
 * worker statically and exposing it on `globalThis.pdfjsWorker` makes pdfjs use
 * the already-loaded handler and makes the file visible to the tracer.
 */

let pdfjsPromise: Promise<any> | null = null;
export async function getPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [lib, worker] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        // @ts-expect-error — the worker entry ships without type declarations
        import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
      ]);
      (globalThis as any).pdfjsWorker ??= worker;
      return lib;
    })().catch((err) => {
      pdfjsPromise = null; // allow a retry instead of caching the failure forever
      throw err;
    });
  }
  return pdfjsPromise;
}
