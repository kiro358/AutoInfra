import { describe, it, expect } from 'vitest';
import {
  extractCadGeometry,
  transformPoint,
  multiplyMatrices,
  distance,
  approxBezierLength,
  parseColor,
  classifyPath,
} from './cad-geometry';
import {
  createSyntheticCadPdf,
  DEFAULT_SYNTHETIC_STRUCTURES,
  DEFAULT_SYNTHETIC_PIPES,
  DEFAULT_SYNTHETIC_LAYERS,
} from './test-fixtures/synthetic-cad-pdf';

describe('cad-geometry matrix & math helpers', () => {
  it('correctly multiplies 2D affine matrices and transforms points', () => {
    // Translation matrix: move right 100, up 200
    const t: [number, number, number, number, number, number] = [1, 0, 0, 1, 100, 200];
    const p = { x: 10, y: 20 };
    const pTransformed = transformPoint(p, t);
    expect(pTransformed.x).toBe(110);
    expect(pTransformed.y).toBe(220);

    // Scale matrix: 2x
    const s: [number, number, number, number, number, number] = [2, 0, 0, 2, 0, 0];
    const combined = multiplyMatrices(t, s);
    const pScaledAndTransformed = transformPoint(p, combined);
    // (10 * 2) + 100 = 120, (20 * 2) + 200 = 240
    expect(pScaledAndTransformed.x).toBe(120);
    expect(pScaledAndTransformed.y).toBe(240);
  });

  it('calculates Euclidean distance and bezier curve length', () => {
    const d = distance({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(d).toBe(5);

    const bLen = approxBezierLength(
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 }
    );
    expect(bLen).toBeGreaterThan(10);
    expect(bLen).toBeLessThan(30);
  });

  it('parses colors from hex strings and RGB numeric arrays', () => {
    const c1 = parseColor('#00cc00');
    expect(c1).toEqual({ r: 0, g: 204, b: 0, hex: '#00cc00' });

    const c2 = parseColor([0, 0.55, 0.85]);
    expect(c2).toBeDefined();
    expect(c2?.hex).toBe('#008cd9');

    const c3 = parseColor([255, 0, 128]);
    expect(c3).toBeDefined();
    expect(c3?.hex).toBe('#ff0080');

    expect(parseColor(null)).toBeUndefined();
    expect(parseColor('invalid')).toBeUndefined();
  });

  it('classifies paths geometrically', () => {
    // Circle symbol: small, aspect ratio ~ 1.0, closed / curve
    const symClass = classifyPath([100, 100, 114, 114], 44, true, 1, 4);
    expect(symClass).toBe('symbolCandidate');

    // Linework candidate: long line segment
    const lineClass = classifyPath([100, 100, 300, 100], 200, false, 1, 0);
    expect(lineClass).toBe('lineworkCandidate');

    // Glyph candidate: short open stroke
    const glyphClass = classifyPath([100, 100, 108, 112], 12, false, 1, 0);
    expect(glyphClass).toBe('glyphCandidate');
  });
});

describe('extractCadGeometry on synthetic CAD drawings', () => {
  it('extracts vector paths, polylines, and layers from default synthetic CAD PDF', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const cadPage = await extractCadGeometry(pdfBytes, 1);

    expect(cadPage.page).toBe(1);
    expect(cadPage.width).toBe(842);
    expect(cadPage.height).toBe(595);

    expect(cadPage.paths.length).toBeGreaterThan(15);
    expect(cadPage.stats.totalPaths).toBe(cadPage.paths.length);

    // Verify symbols are detected as symbolCandidate
    const symbols = cadPage.paths.filter(
      (p) => p.classification === 'symbolCandidate'
    );
    expect(symbols.length).toBeGreaterThanOrEqual(4);

    // Check that structure centroids match default coordinates roughly
    const foundCentroid = symbols.some(
      (s) =>
        Math.abs((s.bbox[0] + s.bbox[2]) / 2 - 150) < 5 &&
        Math.abs((s.bbox[1] + s.bbox[3]) / 2 - 400) < 5
    );
    expect(foundCentroid).toBe(true);

    // Verify linework polylines are extracted
    expect(cadPage.polylines.length).toBeGreaterThanOrEqual(3);
    const stormPoly = cadPage.polylines.find(
      (pl) =>
        pl.points.some((pt) => Math.abs(pt.x - 150) < 5 && Math.abs(pt.y - 400) < 5) &&
        pl.points.some((pt) => Math.abs(pt.x - 350) < 5 && Math.abs(pt.y - 400) < 5)
    );
    expect(stormPoly).toBeDefined();

    // Verify layer names are extracted
    expect(cadPage.layers).toContain('3-STORM');
    expect(cadPage.layers).toContain('2-SANITARY');
    expect(cadPage.layers).toContain('1-WATERMAIN');
  });

  it('preserves stroke colors, dash arrays, and line widths', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const cadPage = await extractCadGeometry(pdfBytes, 1);

    // Look for a dashed storm pipe
    const dashed = cadPage.paths.find((p) => p.dashArray.length > 0);
    expect(dashed).toBeDefined();
    expect(dashed?.dashArray).toEqual([6, 3]);

    // Check line width
    const thickLine = cadPage.paths.find((p) => p.lineWidth >= 1.5);
    expect(thickLine).toBeDefined();

    // Check colors
    const coloredPaths = cadPage.paths.filter((p) => p.strokeColor != null);
    expect(coloredPaths.length).toBeGreaterThan(10);
  });

  it('throws on invalid page index', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    await expect(extractCadGeometry(pdfBytes, 99)).rejects.toThrow(/Invalid pageIndex/);
  });
});
