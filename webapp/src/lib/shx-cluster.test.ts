import { describe, it, expect } from 'vitest';
import {
  clusterShxStrokes,
  computeOBB,
  computePrincipalOrientation,
} from './shx-cluster';
import { CadGeometryPage, CadPath } from './cad-geometry';

describe('shx-cluster orientation & OBB calculation', () => {
  it('computes principal orientation angle accurately', () => {
    // Horizontal line of points: angle ~ 0
    const horizontalPts = [
      { x: 10, y: 50 },
      { x: 20, y: 50 },
      { x: 30, y: 50 },
      { x: 40, y: 50 },
    ];
    const thetaH = computePrincipalOrientation(horizontalPts);
    expect(Math.abs(thetaH)).toBeLessThan(0.05);

    // 45 degree line of points: angle ~ π/4 (0.785 rad)
    const angledPts = [
      { x: 10, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 30 },
      { x: 40, y: 40 },
    ];
    const theta45 = computePrincipalOrientation(angledPts);
    expect(theta45).toBeCloseTo(Math.PI / 4, 2);

    // Vertical line of points: angle ~ π/2 (1.57 rad) or -π/2
    const verticalPts = [
      { x: 50, y: 10 },
      { x: 50, y: 20 },
      { x: 50, y: 30 },
      { x: 50, y: 40 },
    ];
    const thetaV = computePrincipalOrientation(verticalPts);
    expect(Math.abs(Math.abs(thetaV) - Math.PI / 2)).toBeLessThan(0.05);
  });

  it('computes oriented bounding box (OBB) with 4 corners and character blocks', () => {
    const mockPaths: CadPath[] = [
      {
        id: 'stroke_1',
        subpaths: [],
        points: [{ x: 10, y: 20 }, { x: 10, y: 30 }],
        bbox: [10, 20, 10, 30],
        extent: { width: 0, height: 10, maxDim: 10, minDim: 0, aspectRatio: 0 },
        totalLength: 10,
        isClosed: false,
        lineWidth: 1,
        dashArray: [],
        classification: 'glyphCandidate',
        opType: 'stroke',
      },
      {
        id: 'stroke_2',
        subpaths: [],
        points: [{ x: 20, y: 20 }, { x: 20, y: 30 }],
        bbox: [20, 20, 20, 30],
        extent: { width: 0, height: 10, maxDim: 10, minDim: 0, aspectRatio: 0 },
        totalLength: 10,
        isClosed: false,
        lineWidth: 1,
        dashArray: [],
        classification: 'glyphCandidate',
        opType: 'stroke',
      },
    ];

    const { obb, characters } = computeOBB(mockPaths, 0);
    expect(obb.width).toBeGreaterThanOrEqual(10);
    expect(obb.height).toBeGreaterThanOrEqual(6);
    expect(obb.corners.length).toBe(4);
    expect(characters.length).toBe(2);
  });
});

describe('clusterShxStrokes on vector geometry', () => {
  it('clusters adjacent glyphCandidate strokes into word lines', () => {
    // Construct 3 distinct word clusters separated spatially
    const paths: CadPath[] = [];

    // Word 1: "MH 1" at (100, 200) horizontal
    for (let i = 0; i < 6; i++) {
      paths.push({
        id: `w1_s${i}`,
        subpaths: [],
        points: [{ x: 100 + i * 4, y: 200 }, { x: 100 + i * 4, y: 210 }],
        bbox: [100 + i * 4, 200, 100 + i * 4, 210],
        extent: { width: 0, height: 10, maxDim: 10, minDim: 0, aspectRatio: 0 },
        totalLength: 10,
        isClosed: false,
        lineWidth: 1,
        dashArray: [],
        classification: 'glyphCandidate',
        opType: 'stroke',
      });
    }

    // Word 2: "300mm" at (400, 400) at 45 degrees
    for (let i = 0; i < 8; i++) {
      const x = 400 + i * 3 * Math.cos(Math.PI / 4);
      const y = 400 + i * 3 * Math.sin(Math.PI / 4);
      paths.push({
        id: `w2_s${i}`,
        subpaths: [],
        points: [{ x, y }, { x, y: y + 8 }],
        bbox: [x, y, x, y + 8],
        extent: { width: 0, height: 8, maxDim: 8, minDim: 0, aspectRatio: 0 },
        totalLength: 8,
        isClosed: false,
        lineWidth: 1,
        dashArray: [],
        classification: 'glyphCandidate',
        opType: 'stroke',
      });
    }

    const mockGeometry: CadGeometryPage = {
      page: 1,
      width: 1000,
      height: 1000,
      paths,
      polylines: [],
      layers: ['3-STORM'],
      stats: {
        totalPaths: paths.length,
        glyphCandidates: paths.length,
        lineworkCandidates: 0,
        symbolCandidates: 0,
        otherPaths: 0,
      },
    };

    const clusters = clusterShxStrokes(mockGeometry, 14.0);

    expect(clusters.length).toBe(2);

    const horizontalCluster = clusters.find((c) => Math.abs(c.obb.centerX - 110) < 15);
    expect(horizontalCluster).toBeDefined();
    expect(horizontalCluster?.strokeCount).toBe(6);
    expect(Math.abs(horizontalCluster!.obb.rotationAngleDeg)).toBeLessThan(10);

    const angledCluster = clusters.find((c) => Math.abs(c.obb.centerX - 410) < 25);
    expect(angledCluster).toBeDefined();
    expect(angledCluster?.strokeCount).toBe(8);
    expect(angledCluster!.obb.rotationAngleDeg).toBeGreaterThan(20);
  });
});
