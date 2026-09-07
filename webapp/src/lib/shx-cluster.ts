/**
 * SHX Stroke Clustering along Principal Orientation Axis.
 *
 * Clusters glyph-sized CAD vector strokes into oriented word and line bounding boxes
 * by constructing a spatial adjacency graph, computing principal orientation angle
 * via PCA, and grouping strokes along the estimated baseline into character blocks.
 */
import { CadColor, CadGeometryPage, CadPath, CadPoint, distance } from './cad-geometry';

export interface OrientedBoundingBox {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationAngleDeg: number;
  corners: [CadPoint, CadPoint, CadPoint, CadPoint];
}

export interface ShxCharacterBlock {
  strokeIds: string[];
  centroid: CadPoint;
  uCoord: number; // coordinate along baseline axis
  extent: { width: number; height: number };
}

export interface ShxTextCluster {
  id: string;
  paths: CadPath[];
  strokeCount: number;
  obb: OrientedBoundingBox;
  principalAngleRad: number;
  characters: ShxCharacterBlock[];
  bbox: [number, number, number, number];
  layerName?: string;
  color?: CadColor;
}

/**
 * Spatial hash grid for fast nearest neighbor clustering of stroke centroids.
 */
class SpatialHashGrid {
  private cellSize: number;
  private grid: Map<string, number[]> = new Map();

  constructor(cellSize: number = 15.0) {
    this.cellSize = cellSize;
  }

  private key(cellX: number, cellY: number): string {
    return `${cellX},${cellY}`;
  }

  public insert(index: number, x: number, y: number): void {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const k = this.key(cx, cy);
    let cell = this.grid.get(k);
    if (!cell) {
      cell = [];
      this.grid.set(k, cell);
    }
    cell.push(index);
  }

  public queryNeighbors(x: number, y: number): number[] {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const neighbors: number[] = [];

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = this.grid.get(this.key(cx + dx, cy + dy));
        if (cell) {
          neighbors.push(...cell);
        }
      }
    }

    return neighbors;
  }
}

/**
 * Disjoint Set Union (DSU) for connected component labeling.
 */
class DisjointSet {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  public find(i: number): number {
    if (this.parent[i] === i) return i;
    this.parent[i] = this.find(this.parent[i]);
    return this.parent[i];
  }

  public union(i: number, j: number): void {
    const rootI = this.find(i);
    const rootJ = this.find(j);
    if (rootI !== rootJ) {
      this.parent[rootI] = rootJ;
    }
  }
}

/**
 * Computes principal orientation angle (radians) of a set of 2D points using PCA.
 */
export function computePrincipalOrientation(points: CadPoint[]): number {
  if (points.length < 2) return 0;

  let meanX = 0;
  let meanY = 0;
  for (const p of points) {
    meanX += p.x;
    meanY += p.y;
  }
  meanX /= points.length;
  meanY /= points.length;

  let covXX = 0;
  let covYY = 0;
  let covXY = 0;

  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    covXX += dx * dx;
    covYY += dy * dy;
    covXY += dx * dy;
  }

  // If variance is isotropic or degenerate, default to horizontal (0)
  if (Math.abs(covXX - covYY) < 1e-6 && Math.abs(covXY) < 1e-6) {
    return 0;
  }

  // Principal eigenvector angle
  return 0.5 * Math.atan2(2 * covXY, covXX - covYY);
}

/**
 * Computes the Oriented Bounding Box (OBB) for a set of paths at orientation theta.
 */
export function computeOBB(
  paths: CadPath[],
  thetaRad: number
): { obb: OrientedBoundingBox; characters: ShxCharacterBlock[] } {
  const cosT = Math.cos(thetaRad);
  const sinT = Math.sin(thetaRad);

  const allPoints: CadPoint[] = [];
  const strokeInfos: {
    path: CadPath;
    centroid: CadPoint;
    u: number;
    v: number;
  }[] = [];

  for (const p of paths) {
    for (const pt of p.points) {
      allPoints.push(pt);
    }
    const cx = (p.bbox[0] + p.bbox[2]) / 2;
    const cy = (p.bbox[1] + p.bbox[3]) / 2;
    const u = cx * cosT + cy * sinT;
    const v = -cx * sinT + cy * cosT;
    strokeInfos.push({ path: p, centroid: { x: cx, y: cy }, u, v });
  }

  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;

  for (const pt of allPoints) {
    const u = pt.x * cosT + pt.y * sinT;
    const v = -pt.x * sinT + pt.y * cosT;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const width = Math.max(8, maxU - minU);
  const height = Math.max(6, maxV - minV);
  const midU = (minU + maxU) / 2;
  const midV = (minV + maxV) / 2;

  const centerX = midU * cosT - midV * sinT;
  const centerY = midU * sinT + midV * cosT;

  const halfW = width / 2;
  const halfH = height / 2;

  // 4 corners of OBB: (-halfW, -halfH), (halfW, -halfH), (halfW, halfH), (-halfW, halfH)
  const corners: [CadPoint, CadPoint, CadPoint, CadPoint] = [
    {
      x: centerX - halfW * cosT + halfH * sinT,
      y: centerY - halfW * sinT - halfH * cosT,
    },
    {
      x: centerX + halfW * cosT + halfH * sinT,
      y: centerY + halfW * sinT - halfH * cosT,
    },
    {
      x: centerX + halfW * cosT - halfH * sinT,
      y: centerY + halfW * sinT + halfH * cosT,
    },
    {
      x: centerX - halfW * cosT - halfH * sinT,
      y: centerY - halfW * sinT + halfH * cosT,
    },
  ];

  // Group strokes into character blocks sorted by u-coordinate along baseline
  strokeInfos.sort((a, b) => a.u - b.u);
  const characters: ShxCharacterBlock[] = [];

  let curBlock: { strokeIds: string[]; uSum: number; count: number; uMin: number; uMax: number; vMin: number; vMax: number } | null = null;

  for (const s of strokeInfos) {
    if (!curBlock) {
      curBlock = {
        strokeIds: [s.path.id],
        uSum: s.u,
        count: 1,
        uMin: s.u,
        uMax: s.u,
        vMin: s.v,
        vMax: s.v,
      };
    } else {
      // If stroke is close to the current character block along u (within ~5pt)
      if (s.u - curBlock.uMax <= 5.0) {
        curBlock.strokeIds.push(s.path.id);
        curBlock.uSum += s.u;
        curBlock.count++;
        curBlock.uMax = Math.max(curBlock.uMax, s.u);
        curBlock.vMin = Math.min(curBlock.vMin, s.v);
        curBlock.vMax = Math.max(curBlock.vMax, s.v);
      } else {
        const avgU = curBlock.uSum / curBlock.count;
        const avgV = (curBlock.vMin + curBlock.vMax) / 2;
        characters.push({
          strokeIds: curBlock.strokeIds,
          centroid: {
            x: avgU * cosT - avgV * sinT,
            y: avgU * sinT + avgV * cosT,
          },
          uCoord: avgU,
          extent: {
            width: Math.max(4, curBlock.uMax - curBlock.uMin),
            height: Math.max(4, curBlock.vMax - curBlock.vMin),
          },
        });
        curBlock = {
          strokeIds: [s.path.id],
          uSum: s.u,
          count: 1,
          uMin: s.u,
          uMax: s.u,
          vMin: s.v,
          vMax: s.v,
        };
      }
    }
  }

  if (curBlock) {
    const avgU = curBlock.uSum / curBlock.count;
    const avgV = (curBlock.vMin + curBlock.vMax) / 2;
    characters.push({
      strokeIds: curBlock.strokeIds,
      centroid: {
        x: avgU * cosT - avgV * sinT,
        y: avgU * sinT + avgV * cosT,
      },
      uCoord: avgU,
      extent: {
        width: Math.max(4, curBlock.uMax - curBlock.uMin),
        height: Math.max(4, curBlock.vMax - curBlock.vMin),
      },
    });
  }

  const rotDeg = (thetaRad * 180) / Math.PI;

  return {
    obb: {
      centerX,
      centerY,
      width,
      height,
      rotationAngleDeg: rotDeg,
      corners,
    },
    characters,
  };
}

/**
 * Clusters glyph-sized CAD vector strokes into oriented text word/line clusters.
 */
export function clusterShxStrokes(
  geometry: CadGeometryPage,
  adjacencyThreshold: number = 14.0
): ShxTextCluster[] {
  // 1. Filter glyphCandidate strokes (< 25pt extent, short length, not closed loops)
  const candidateStrokes = geometry.paths.filter((p) => {
    if (p.classification === 'glyphCandidate') return true;
    if (p.extent.maxDim <= 22 && p.totalLength < 60 && !p.isClosed) return true;
    return false;
  });

  if (candidateStrokes.length === 0) {
    return [];
  }

  const strokeCentroids: CadPoint[] = candidateStrokes.map((p) => ({
    x: (p.bbox[0] + p.bbox[2]) / 2,
    y: (p.bbox[1] + p.bbox[3]) / 2,
  }));

  // 2. Build Spatial Hash Grid and Adjacency Graph
  const grid = new SpatialHashGrid(adjacencyThreshold);
  for (let i = 0; i < candidateStrokes.length; i++) {
    grid.insert(i, strokeCentroids[i].x, strokeCentroids[i].y);
  }

  const dsu = new DisjointSet(candidateStrokes.length);

  for (let i = 0; i < candidateStrokes.length; i++) {
    const ptI = strokeCentroids[i];
    const neighbors = grid.queryNeighbors(ptI.x, ptI.y);

    for (const j of neighbors) {
      if (i >= j) continue;
      const ptJ = strokeCentroids[j];
      if (distance(ptI, ptJ) <= adjacencyThreshold) {
        dsu.union(i, j);
      }
    }
  }

  // 3. Group connected stroke paths
  const componentMap = new Map<number, CadPath[]>();
  for (let i = 0; i < candidateStrokes.length; i++) {
    const root = dsu.find(i);
    let comp = componentMap.get(root);
    if (!comp) {
      comp = [];
      componentMap.set(root, comp);
    }
    comp.push(candidateStrokes[i]);
  }

  // 4. Compute principal orientation and OBB for each cluster
  const clusters: ShxTextCluster[] = [];
  let clusterSeq = 0;

  for (const [_, paths] of componentMap) {
    if (paths.length === 0) continue;

    // Collect centroids for PCA orientation
    const pts = paths.map((p) => ({
      x: (p.bbox[0] + p.bbox[2]) / 2,
      y: (p.bbox[1] + p.bbox[3]) / 2,
    }));

    const theta = computePrincipalOrientation(pts);
    const { obb, characters } = computeOBB(paths, theta);

    // Axis-aligned bounding box enclosing all paths
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const p of paths) {
      if (p.bbox[0] < minX) minX = p.bbox[0];
      if (p.bbox[1] < minY) minY = p.bbox[1];
      if (p.bbox[2] > maxX) maxX = p.bbox[2];
      if (p.bbox[3] > maxY) maxY = p.bbox[3];
    }

    const firstColor = paths.find((p) => p.strokeColor)?.strokeColor;
    const firstLayer = paths.find((p) => p.layerName)?.layerName;

    clusters.push({
      id: `shx_cluster_${++clusterSeq}`,
      paths,
      strokeCount: paths.length,
      obb,
      principalAngleRad: theta,
      characters,
      bbox: [minX, minY, maxX, maxY],
      layerName: firstLayer,
      color: firstColor,
    });
  }

  return clusters;
}
