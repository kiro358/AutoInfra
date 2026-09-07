import { describe, it, expect } from 'vitest';
import {
  buildSiteNetwork,
  detectDrawingScale,
  inferPipeSystem,
} from './site-network';
import { extractCadGeometry } from './cad-geometry';
import { extractStructureSymbols } from './cad-symbols';
import { extractPageText } from './pdf-text';
import { createSyntheticCadPdf } from './test-fixtures/synthetic-cad-pdf';

describe('site-network scale & system inference', () => {
  it('detects scale ratio from drawing text or falls back', () => {
    const scale200 = detectDrawingScale({
      page: 1,
      width: 842,
      height: 595,
      items: [{ text: 'SCALE 1:200', x: 50, y: 50, width: 60, height: 10 }],
    });
    // 1000 / 200 * (72 / 25.4) ≈ 14.17
    expect(scale200).toBeCloseTo(14.17, 1);

    const fallback = detectDrawingScale(undefined, 5.0);
    expect(fallback).toBe(5.0);
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
  });
});
