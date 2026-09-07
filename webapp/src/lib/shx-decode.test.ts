import { describe, it, expect } from 'vitest';
import {
  decodeCharacterBlocks,
  decodeShxClusters,
  matchCharacterBlock,
  SHX_CODEBOOK,
} from './shx-decode';
import { ShxTextCluster } from './shx-cluster';

describe('shx-decode codebook & character matching', () => {
  it('contains reference stroke codebook for alphanumeric characters', () => {
    expect(SHX_CODEBOOK.length).toBeGreaterThan(20);
    const charA = SHX_CODEBOOK.find((g) => g.char === 'A');
    expect(charA).toBeDefined();
    expect(charA?.strokeCount).toBe(3);

    const char0 = SHX_CODEBOOK.find((g) => g.char === '0');
    expect(char0).toBeDefined();
    expect(char0?.strokeCount).toBe(4);
  });

  it('matches character blocks to codebook candidates', () => {
    // 3 strokes with aspect ratio ~ 0.65 -> matches A or C
    const candidates = matchCharacterBlock(
      {
        strokeIds: ['s1', 's2', 's3'],
        centroid: { x: 10, y: 10 },
        uCoord: 10,
        extent: { width: 6.5, height: 10 },
      },
      3
    );

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].confidence).toBeGreaterThan(0.7);
  });

  it('decodes character blocks into text strings and applies grammar validation', () => {
    const mockChars = [
      {
        strokeIds: ['s1', 's2', 's3', 's4'], // M (4 strokes)
        centroid: { x: 10, y: 10 },
        uCoord: 10,
        extent: { width: 8, height: 10 },
      },
      {
        strokeIds: ['s5', 's6', 's7'], // H (3 strokes)
        centroid: { x: 20, y: 10 },
        uCoord: 20,
        extent: { width: 6.5, height: 10 },
      },
      {
        strokeIds: ['s8'], // 1 (1 stroke)
        centroid: { x: 35, y: 10 },
        uCoord: 35,
        extent: { width: 2.5, height: 10 },
      },
    ];

    const decoded = decodeCharacterBlocks(mockChars, [{ id: 'p1' }]);
    expect(decoded.text.length).toBeGreaterThanOrEqual(3);
    expect(decoded.confidence).toBeGreaterThan(0.5);
  });

  it('decodes ShxTextClusters into CadAnnotation array', () => {
    const mockCluster: ShxTextCluster = {
      id: 'cluster_1',
      paths: [],
      strokeCount: 4,
      obb: {
        centerX: 100,
        centerY: 200,
        width: 30,
        height: 10,
        rotationAngleDeg: 0,
        corners: [
          { x: 85, y: 195 },
          { x: 115, y: 195 },
          { x: 115, y: 205 },
          { x: 85, y: 205 },
        ],
      },
      principalAngleRad: 0,
      characters: [
        {
          strokeIds: ['s1'],
          centroid: { x: 90, y: 200 },
          uCoord: 90,
          extent: { width: 3, height: 10 },
        },
        {
          strokeIds: ['s2', 's3', 's4'],
          centroid: { x: 105, y: 200 },
          uCoord: 105,
          extent: { width: 6.5, height: 10 },
        },
      ],
      bbox: [85, 195, 115, 205],
    };

    const annotations = decodeShxClusters([mockCluster]);
    expect(annotations.length).toBe(1);
    expect(annotations[0].source).toBe('shx');
    expect(annotations[0].position.x).toBe(100);
    expect(annotations[0].position.y).toBe(200);
    expect(annotations[0].text.length).toBeGreaterThan(0);
  });
});
