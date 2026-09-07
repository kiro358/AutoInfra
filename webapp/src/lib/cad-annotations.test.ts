import { describe, it, expect } from 'vitest';
import {
  bindAnnotationsToNetwork,
  CadAnnotation,
  pointToPolylineDistance,
  pointToSegmentDistance,
} from './cad-annotations';
import { extractCadGeometry } from './cad-geometry';
import { extractStructureSymbols } from './cad-symbols';
import { buildSiteNetwork } from './site-network';
import { extractPageText } from './pdf-text';
import { createSyntheticCadPdf } from './test-fixtures/synthetic-cad-pdf';

describe('cad-annotations distance calculations', () => {
  it('calculates point-to-segment perpendicular distance correctly', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };

    // Point directly above midpoint of segment
    const p1 = { x: 50, y: 20 };
    expect(pointToSegmentDistance(p1, a, b)).toBe(20);

    // Point beyond segment endpoint A
    const p2 = { x: -10, y: 0 };
    expect(pointToSegmentDistance(p2, a, b)).toBe(10);

    // Point beyond segment endpoint B
    const p3 = { x: 110, y: 0 };
    expect(pointToSegmentDistance(p3, a, b)).toBe(10);
  });

  it('calculates point-to-polyline minimum distance', () => {
    const polyline = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    const p = { x: 50, y: 15 };
    expect(pointToPolylineDistance(p, polyline)).toBe(15);
  });
});

describe('bindAnnotationsToNetwork on synthetic CAD drawings', () => {
  it('binds text callouts, elevations, and pipe parameters to the network graph', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const geometry = await extractCadGeometry(pdfBytes.slice(), 1);
    const pageTexts = await extractPageText(Buffer.from(pdfBytes.slice()));
    const symbols = extractStructureSymbols(geometry, pageTexts[0]);
    const network = buildSiteNetwork(geometry, symbols, 5.0, pageTexts[0]);

    // Convert PageText items to CadAnnotation objects
    const annotations: CadAnnotation[] = pageTexts[0].items.map((it, idx) => ({
      id: `annot_${idx + 1}`,
      text: it.text,
      bbox: [it.x, it.y, it.x + it.width, it.y + it.height],
      position: { x: it.x + it.width / 2, y: it.y + it.height / 2 },
      source: 'text-layer',
      confidence: 1.0,
    }));

    const bound = bindAnnotationsToNetwork(network, annotations, geometry);

    expect(bound.stats.boundToNodes).toBeGreaterThanOrEqual(3);
    expect(bound.stats.boundToEdges).toBeGreaterThanOrEqual(2);

    // Verify STMH 1 or STMH 2 received bound labels and elevations
    const stmhNode = Array.from(bound.nodes.values()).find(
      (n) => n.boundLabel === 'STMH 1' || n.boundLabel === 'STMH 2'
    );
    expect(stmhNode).toBeDefined();
    expect(stmhNode?.rimElevation).toBeGreaterThan(90);
    expect(stmhNode?.invertElevation).toBeGreaterThan(90);

    // Verify Storm pipe edge received diameter, material, and slope
    const stormEdge = bound.edges.find((e) => e.system === 'STORM' && e.diameterMm === 300);
    expect(stormEdge).toBeDefined();
    expect(stormEdge?.diameterMm).toBe(300);
    expect(stormEdge?.slopePercent).toBe(0.5);
    expect(stormEdge?.material).toBe('PVC');
    expect(stormEdge?.calloutLengthMeters).toBe(40.0);
  });
});
