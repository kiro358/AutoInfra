import { describe, it, expect } from 'vitest';
import {
  buildSiteNetwork,
  detectDrawingScale,
  detectDrawingScaleDetailed,
  inferPipeSystem,
  verifyCalibration,
} from './site-network';
import { extractCadGeometry } from './cad-geometry';
import { extractStructureSymbols } from './cad-symbols';
import { extractPageText } from './pdf-text';
import { createSyntheticCadPdf } from './test-fixtures/synthetic-cad-pdf';
import { PageText } from './pdf-text';

function pageTextWith(items: string[]): PageText {
  return {
    page: 1,
    width: 842,
    height: 595,
    items: items.map((text, i) => ({ text, x: 50, y: 50 + i * 12, width: 60, height: 10 })),
  };
}

describe('site-network scale & system inference', () => {
  it('detects scale ratio from drawing text; no note means null, never a default', () => {
    const scale200 = detectDrawingScale(pageTextWith(['SCALE 1:200']));
    // 1000 / 200 * (72 / 25.4) ≈ 14.17
    expect(scale200).toBeCloseTo(14.17, 1);

    // PR 12: the silent 5.0 pt/m fallback is gone. Unknown scale is null.
    expect(detectDrawingScale(undefined)).toBeNull();
    expect(detectDrawingScale(pageTextWith(['GENERAL NOTES', 'NORTH ARROW']))).toBeNull();
  });

  it('treats repeated identical notes as one detection, distinct notes as ambiguous', () => {
    const repeated = detectDrawingScaleDetailed(
      pageTextWith(['SCALE 1:200', 'SCALE 1:200  |  DRAWING NO. SS-101'])
    );
    expect(repeated.source).toBe('detected');
    expect(repeated.scalePtPerM).toBeCloseTo(14.17, 1);
    expect(repeated.candidates).toEqual([200]);

    const conflict = detectDrawingScaleDetailed(
      pageTextWith(['SCALE 1:200', 'DETAIL A — SCALE 1:50'])
    );
    expect(conflict.source).toBe('ambiguous');
    expect(conflict.scalePtPerM).toBeNull();
    expect(conflict.candidates).toEqual([200, 50]);

    const absent = detectDrawingScaleDetailed(pageTextWith(['TITLE BLOCK']));
    expect(absent.source).toBe('absent');
    expect(absent.scalePtPerM).toBeNull();
    expect(absent.candidates).toEqual([]);
  });

  it('verifies a detected scale against stated dimensions (promote / conflict / insufficient)', () => {
    const base = {
      scalePtPerM: 14.1732, // 1:200
      source: 'detected' as const,
      page: 1,
      detectedText: 'SCALE 1:200',
      candidates: [200],
    };
    // Stated dimensions imply ~14.17 pt/m -> promoted to 'stated'
    const promoted = verifyCalibration(base, [
      { drawnLengthPt: 283.5, statedLengthM: 20 },
      { drawnLengthPt: 141.7, statedLengthM: 10 },
    ]);
    expect(promoted.calibration.source).toBe('stated');
    expect(promoted.calibration.residual).toBeLessThan(0.1);
    expect(promoted.conflict).toBe(false);

    // Stated dimensions imply 5 pt/m -> flat contradiction, value NOT overwritten
    const conflicted = verifyCalibration(base, [
      { drawnLengthPt: 200, statedLengthM: 40 },
      { drawnLengthPt: 80, statedLengthM: 16 },
    ]);
    expect(conflicted.calibration.source).toBe('detected');
    expect(conflicted.calibration.scalePtPerM).toBeCloseTo(14.17, 1);
    expect(conflicted.calibration.residual).toBeGreaterThan(0.25);
    expect(conflicted.conflict).toBe(true);

    // A single sample cannot verify
    const insufficient = verifyCalibration(base, [{ drawnLengthPt: 200, statedLengthM: 40 }]);
    expect(insufficient.calibration.source).toBe('detected');
    expect(insufficient.calibration.residual).toBeNull();
    expect(insufficient.conflict).toBe(false);
  });

  it('infers pipe system from stroke colors, dash arrays, and layers', () => {
    // Dashed line -> STORM
    expect(
      inferPipeSystem({
        lineWidth: 2.0,
        dashArray: [6, 3],
      })
    ).toBe('STORM');

    // Layer name 3-STORM -> STORM
    expect(
      inferPipeSystem({
        lineWidth: 2.0,
        dashArray: [],
        layerName: '3-STORM',
      })
    ).toBe('STORM');

    // Green color -> SAN
    expect(
      inferPipeSystem({
        lineWidth: 2.0,
        dashArray: [],
        color: { r: 0, g: 180, b: 20, hex: '#00b414' },
      })
    ).toBe('SAN');

    // Deep blue thick line -> WATERMAIN
    expect(
      inferPipeSystem({
        lineWidth: 2.5,
        dashArray: [],
        color: { r: 0, g: 50, b: 230, hex: '#0032e6' },
      })
    ).toBe('WATERMAIN');
  });
});

describe('buildSiteNetwork on synthetic CAD drawings', () => {
  it('builds a topological SiteNetwork graph with nodes and connected pipe edges', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const geometry = await extractCadGeometry(pdfBytes.slice(), 1);
    const pageTexts = await extractPageText(Buffer.from(pdfBytes.slice()));
    const symbols = extractStructureSymbols(geometry, pageTexts[0]);

    const network = buildSiteNetwork(geometry, symbols, 5.0, pageTexts[0]);

    expect(network.nodes.size).toBeGreaterThanOrEqual(5);
    expect(network.edges.length).toBeGreaterThanOrEqual(3);

    // Verify Storm edges exist
    expect(network.stats.stormEdgeCount).toBeGreaterThanOrEqual(1);

    // Verify Sanitary edges exist
    expect(network.stats.sanitaryEdgeCount).toBeGreaterThanOrEqual(1);

    // Check connected structures on edges
    for (const edge of network.edges) {
      expect(network.nodes.has(edge.fromNodeId)).toBe(true);
      expect(network.nodes.has(edge.toNodeId)).toBe(true);
      expect(edge.fromNodeId).not.toBe(edge.toNodeId);
      expect(edge.drawnLengthMeters).toBeGreaterThan(0);
      expect(edge.polyline.length).toBeGreaterThanOrEqual(2);
    }

    // Verify a storm edge connects STMH 1 and STMH 2 coordinates
    const stormMain = network.edges.find((e) => {
      const nodeFrom = network.nodes.get(e.fromNodeId)!;
      const nodeTo = network.nodes.get(e.toNodeId)!;
      const hasWest = Math.abs(nodeFrom.centroid.x - 150) < 10 || Math.abs(nodeTo.centroid.x - 150) < 10;
      const hasEast = Math.abs(nodeFrom.centroid.x - 350) < 10 || Math.abs(nodeTo.centroid.x - 350) < 10;
      return hasWest && hasEast && Math.abs(nodeFrom.centroid.y - 400) < 10;
    });

    expect(stormMain).toBeDefined();
    expect(stormMain?.system).toBe('STORM');
  });

  it('correctly handles multi-segment pipe paths with intermediate vertices', async () => {
    const pdfWithBends = await createSyntheticCadPdf({
      legend: false,
      schedule: false,
      structures: [
        { id: 'MH 1', type: 'MH', x: 100, y: 300 },
        { id: 'MH 2', type: 'MH', x: 400, y: 500 },
      ],
      pipes: [
        {
          id: 'SAN-BEND',
          fromStructureId: 'MH 1',
          toStructureId: 'MH 2',
          system: 'SAN',
          diameterMm: 250,
          vertices: [
            { x: 100, y: 300 },
            { x: 250, y: 300 }, // corner bend
            { x: 250, y: 500 }, // corner bend
            { x: 400, y: 500 },
          ],
        },
      ],
    });

    const geometry = await extractCadGeometry(pdfWithBends.slice(), 1);
    const symbols = extractStructureSymbols(geometry);
    const network = buildSiteNetwork(geometry, symbols, 5.0);

    expect(network.nodes.size).toBe(2);
    expect(network.edges.length).toBe(1);

    const edge = network.edges[0];
    expect(edge.system).toBe('SAN');
    // Drawn pt length = 150 + 200 + 150 = 500pt
    expect(edge.drawnLengthPt).toBeCloseTo(500, 0);
    expect(edge.drawnLengthMeters).toBeCloseTo(100, 0);
    // An explicit caller scale is recorded as an adoption
    expect(network.calibration?.source).toBe('explicit');
    expect(network.calibration?.scalePtPerM).toBe(5.0);
  });

  it('records a detected calibration from the sheet scale note when no scale is passed', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const geometry = await extractCadGeometry(pdfBytes.slice(), 1);
    const pageTexts = await extractPageText(Buffer.from(pdfBytes.slice()));
    const symbols = extractStructureSymbols(geometry, pageTexts[0]);

    // The fixture sheet states "SCALE 1:200" in its title block
    const network = buildSiteNetwork(geometry, symbols, undefined, pageTexts[0]);

    expect(network.calibration?.source).toBe('detected');
    expect(network.calibration?.detectedText).toContain('SCALE 1:200');
    expect(network.scaleRatio).toBeCloseTo(14.17, 1);
    for (const edge of network.edges) {
      expect(edge.drawnLengthMeters).not.toBeNull();
      expect(edge.drawnLengthMeters!).toBeCloseTo(edge.drawnLengthPt / 14.1732, 3);
    }
  });

  it('leaves drawn lengths unmeasurable (null) when the sheet has no determinable scale', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const geometry = await extractCadGeometry(pdfBytes.slice(), 1);
    const symbols = extractStructureSymbols(geometry);

    // No explicit scale and a text layer with no scale note at all
    const network = buildSiteNetwork(geometry, symbols, undefined, pageTextWith(['SOME NOTES']));

    expect(network.scaleRatio).toBeNull();
    expect(network.calibration?.source).toBe('absent');
    expect(network.edges.length).toBeGreaterThan(0);
    for (const edge of network.edges) {
      expect(edge.drawnLengthMeters).toBeNull();
      expect(edge.drawnLengthPt).toBeGreaterThan(0);
    }
  });
});
