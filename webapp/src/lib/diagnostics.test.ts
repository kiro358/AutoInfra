/**
 * Diagnostics (PR18) — the per-run record that attributes content loss
 * stage by stage, and the warnings that surface silent tile loss.
 *
 * The fixtures mirror extraction.test.ts: a genuinely texty servicing page
 * (labels + elevations + run callouts) and a no-content page the classifier
 * routes to vision.
 */
import { describe, it, expect, vi } from 'vitest';
import { assembleHybridTakeoff, unionLocatedPages } from './extraction';
import {
  buildExtractionDiagnostics,
  deriveRenderedPerPage,
  entityCountsByKind,
  tileDiagnosticsWarnings,
} from './diagnostics';
import { isTextyPage, PageText } from './pdf-text';
import { TileTranscript } from './types';

const ptPage = (page: number, items: { text: string; x: number; y: number }[]): PageText => ({
  page, width: 2592, height: 1728,
  items: items.map((i) => ({ ...i, width: 120, height: 12 })),
});

const yieldingPage = ptPage(1, [
  { text: 'STMH 1', x: 100, y: 900 },
  { text: 'T/G=224.95', x: 105, y: 885 },
  { text: 'N INV=223.35', x: 105, y: 870 },
  { text: '45.0m - 250mmØ PVC STM @ 0.50%', x: 400, y: 900 },
  { text: '60.0m - 300mmØ PVC STM @ 0.35%', x: 400, y: 800 },
  { text: '30.0m - 200mmØ PVC SAN @ 1.00%', x: 400, y: 700 },
]);

const rasterPage = ptPage(3, [
  { text: 'GENERAL NOTES AND INDEX', x: 100, y: 900 },
  { text: 'SHEET LIST', x: 100, y: 850 },
]);

const rasterTiles: TileTranscript[] = [
  { tile: 1, blocks: [['MH 7', 'RIM: 90.50', 'INV: 88.10'], ['22.0m - 200mmØ PVC @ 1.00%']] },
];

describe('diagnostics on a hybrid run fixture', () => {
  it('populates locator, pages, and per-source + final assembly counts', async () => {
    expect(isTextyPage(yieldingPage)).toBe(true);
    expect(isTextyPage(rasterPage)).toBe(false);

    const transcribe = vi.fn(async (_pages: number[]) => rasterTiles);
    const hybrid = await assembleHybridTakeoff([yieldingPage, rasterPage], [1, 3], 'T', transcribe);

    // The hybrid assembly exposes the per-source counts and the yields it
    // computed for its own fallback check — diagnostics records them, it
    // does not recompute them.
    expect(hybrid.textCounts.structures).toBeGreaterThanOrEqual(1);
    expect(hybrid.textCounts.sewers).toBeGreaterThanOrEqual(3);
    expect(hybrid.transcriptCounts).toEqual({ structures: 1, sewers: 1, watermain: 0, catchbasins: 0 });
    expect(hybrid.textyPageYields[1]).toBeGreaterThanOrEqual(4);
    expect(hybrid.textyPageYields[3]).toBeUndefined();

    const record = buildExtractionDiagnostics({
      mode: 'hybrid',
      durationMs: 1234,
      locator: { ran: true, rawPicks: [1, 3], unionAdded: [], finalPages: [1, 3], tileAllFallback: false },
      pages: [
        { page: 1, route: 'text', textChars: 120, textYield: hybrid.textyPageYields[1] ?? null, tilesPlanned: null, tilesRendered: null },
        { page: 3, route: 'vision', textChars: 40, textYield: null, tilesPlanned: 12, tilesRendered: 12 },
      ],
      tiles: { planned: 12, rendered: 12, uploaded: 12, transcribed: 1, missingAfterRetry: 0, degenerateDiscarded: 0, blocks: 2 },
      sources: [
        { path: 'text', counts: hybrid.textCounts },
        ...(hybrid.transcriptCounts ? [{ path: 'transcript' as const, counts: hybrid.transcriptCounts }] : []),
      ],
      finalFacts: hybrid.facts,
    });

    expect(record.version).toBe(1);
    expect(record.mode).toBe('hybrid');
    expect(record.locator.finalPages).toEqual([1, 3]);
    expect(record.pages.map((p) => p.route)).toEqual(['text', 'vision']);
    expect(record.pages[0].textYield).toBeGreaterThanOrEqual(4);
    expect(record.pages[1].textYield).toBeNull();
    expect(record.assembly.sources.map((s) => s.path)).toEqual(['text', 'transcript']);
    // Final counts describe the merged facts actually returned.
    expect(record.assembly.final).toEqual(entityCountsByKind(hybrid.facts));
    expect(record.assembly.final.structures).toBeGreaterThanOrEqual(2); // STMH 1 (text) + MH 7 (vision)
  });

  it('records locator union additions with their admission reasons', () => {
    const pt = (page: number, texts: string[]): PageText => ({
      page, width: 2592, height: 1728,
      items: texts.map((text, i) => ({ text, x: 100, y: 900 - i * 20, width: 120, height: 12 })),
    });
    // Annotation-form evidence, zero yield (the SHX shape).
    const annPage = pt(2, ['250mmØ PVC STM', '375mmØ PVC STM', 'PVC PIPE ALONG ALIGNMENT']);
    // Yield-only evidence: two named structures, no digit anywhere.
    const yieldPage = pt(3, ['HEADWALL', 'FLARED END SECTION']);
    const locatedPage = pt(1, ['TITLE BLOCK']);

    const union = unionLocatedPages([1], [locatedPage, annPage, yieldPage], 'T');
    expect(union.added).toEqual([
      { page: 2, reason: 'annotation-form' },
      { page: 3, reason: 'text-yield' },
    ]);

    const record = buildExtractionDiagnostics({
      mode: 'hybrid',
      durationMs: 1,
      locator: {
        ran: true,
        rawPicks: [1],
        unionAdded: union.added.map((a) => ({ page: a.page, reason: a.reason })),
        finalPages: union.pages,
        tileAllFallback: false,
      },
      pages: [],
      tiles: { planned: null, rendered: null, uploaded: null, transcribed: null, missingAfterRetry: null, degenerateDiscarded: null, blocks: null },
      sources: [],
      finalFacts: {
        projectName: 'T', jobNumber: '', date: '', structures: [], catchbasins: [],
        sewers: [], watermain: [], watermainSpecials: [], watermainValves: [],
        confidence: 0, warnings: [],
      },
    });

    expect(record.locator.rawPicks).toEqual([1]);
    expect(record.locator.unionAdded).toEqual([
      { page: 2, reason: 'annotation-form' },
      { page: 3, reason: 'text-yield' },
    ]);
    expect(record.locator.finalPages).toEqual([1, 2, 3]);
  });
});

describe('tileDiagnosticsWarnings — silent tile loss surfacing (audit 6c/6a)', () => {
  const base = { planned: 24, rendered: 24, uploaded: 24, transcribed: 24, missingAfterRetry: 0, degenerateDiscarded: 0, blocks: 60 };

  it('fires when tiles are still missing after the retry', () => {
    const w = tileDiagnosticsWarnings({ ...base, transcribed: 16, missingAfterRetry: 8 });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('lost 8 tile(s) of 24 rendered');
    expect(w[0]).toContain('8 tile(s) never returned, even after one retry');
  });

  it('fires when tiles are discarded as degenerate, and names both losses together', () => {
    const w = tileDiagnosticsWarnings({ ...base, missingAfterRetry: 2, degenerateDiscarded: 3 });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('lost 5 tile(s)');
    expect(w[0]).toContain('3 tile(s) discarded as degenerate repetition');
  });

  it('is silent on a complete transcription', () => {
    expect(tileDiagnosticsWarnings(base)).toEqual([]);
  });

  it('fires on cap truncation (rendered < planned) and names both counts', () => {
    const w = tileDiagnosticsWarnings({ ...base, planned: 35, rendered: 24, transcribed: 24 });
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('35 tile(s) are needed');
    expect(w[0]).toContain('only 24 were rendered');
  });

  it('does not call a render failure truncation', () => {
    const w = tileDiagnosticsWarnings({ ...base, planned: 35, rendered: 0, transcribed: null, renderFailed: true });
    expect(w).toEqual([]);
  });

  it('never uses the coverage-warning shapes that feed the confidence signal', () => {
    const w = tileDiagnosticsWarnings({ ...base, planned: 35, rendered: 20, missingAfterRetry: 4 });
    for (const s of w) {
      expect(s.startsWith('Coverage:')).toBe(false);
      expect(s).not.toMatch(/AI call\(s\) failed/);
    }
  });
});

describe('deriveRenderedPerPage', () => {
  it('splits the flat rendered list by render order under both caps', () => {
    const planned = [{ page: 1, planned: 20 }, { page: 2, planned: 20 }, { page: 3, planned: 20 }];
    expect(deriveRenderedPerPage(planned, 24, 320, 60)).toEqual([20, 20, 20]);
    // Per-page cap binds first.
    expect(deriveRenderedPerPage(planned, 16, 320, 48)).toEqual([16, 16, 16]);
    // Total cap binds: later pages starve in render order.
    expect(deriveRenderedPerPage(planned, 24, 30, 30)).toEqual([20, 10, 0]);
  });

  it('reports nulls when the derivation does not reconcile with the actual total', () => {
    const planned = [{ page: 1, planned: 20 }, { page: 2, planned: 20 }];
    expect(deriveRenderedPerPage(planned, 24, 320, 17)).toEqual([null, null]);
  });
});
