/**
 * Legend & Symbol Dictionary Node Extraction.
 *
 * Identifies structure symbol centroids and classifications (MH, CB, CBMH, DCBMH,
 * DICB, Hydrant, Valve) from CAD vector geometry and drawing legends.
 */
import { CadColor, CadGeometryPage, CadPath, CadPoint, distance } from './cad-geometry';
import { PageText, PositionedText } from './pdf-text';

export type StructureSymbolType =
  | 'MH'
  | 'CB'
  | 'CBMH'
  | 'DCBMH'
  | 'DICB'
  | 'HYDRANT'
  | 'VALVE'
  | 'UNKNOWN';

export interface StructureSymbolCandidate {
  id: string;
  type: StructureSymbolType;
  centroid: CadPoint;
  bbox: [number, number, number, number];
  size: number;
  confidence: number;
  source: 'legend-matched' | 'geometric-shape';
  description?: string;
  color?: CadColor;
  layerName?: string;
  associatedPathIds: string[];
}

export interface LegendTemplate {
  symbolType: StructureSymbolType;
  description: string;
  isCircle: boolean;
  isRect: boolean;
  concentricCount: number;
  size: number;
  color?: CadColor;
  layerName?: string;
}

export interface LegendDetectionResult {
  bbox?: [number, number, number, number];
  templates: LegendTemplate[];
}

/**
 * Normalizes text for legend matching.
 */
function normalizeLegendText(text: string): string {
  return text.toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Classifies legend text description into a StructureSymbolType.
 */
export function classifyLegendDescription(desc: string): StructureSymbolType | null {
  const u = normalizeLegendText(desc);

  if (u.includes('DOUBLE') && (u.includes('CB') || u.includes('CATCHBASIN'))) {
    return 'DCBMH';
  }
  if (u.includes('CBMH') || (u.includes('CATCHBASIN') && u.includes('MANHOLE'))) {
    return 'CBMH';
  }
  if (u.includes('DICB') || (u.includes('DITCH') && u.includes('INLET'))) {
    return 'DICB';
  }
  if (u.includes('CATCHBASIN') || u.includes('CB') || u.includes('CATCH BASIN')) {
    return 'CB';
  }
  if (u.includes('MANHOLE') || u.includes('MH') || u.includes('MAINTENANCE HOLE')) {
    return 'MH';
  }
  if (u.includes('HYDRANT') || u.includes('HYD')) {
    return 'HYDRANT';
  }
  if (u.includes('GATE VALVE') || u.includes('VALVE') || u.includes('VLV')) {
    return 'VALVE';
  }

  return null;
}

/**
 * Detects the Legend box and builds symbol templates from legend entries.
 */
export function detectLegend(
  geometry: CadGeometryPage,
  pageText?: PageText
): LegendDetectionResult {
  if (!pageText || pageText.items.length === 0) {
    return { templates: [] };
  }

  // Find legend header text
  const legendHeader = pageText.items.find((item) =>
    /\bLEGEND\b/i.test(item.text)
  );
  if (!legendHeader) {
    return { templates: [] };
  }

  // Estimate legend bounding box
  // In CAD sheets, legend items are typically within ~350pt horizontally and ~300pt vertically of header
  const lxMin = legendHeader.x - 40;
  const lxMax = legendHeader.x + 320;
  const lyMin = Math.max(0, legendHeader.y - 300);
  const lyMax = legendHeader.y + 30;
  const legendBbox: [number, number, number, number] = [lxMin, lyMin, lxMax, lyMax];

  // Find legend text items inside legend box
  const legendTexts: PositionedText[] = pageText.items.filter(
    (item) =>
      item.x >= lxMin &&
      item.x <= lxMax &&
      item.y >= lyMin &&
      item.y <= lyMax &&
      !/\bLEGEND\b/i.test(item.text)
  );

  const templates: LegendTemplate[] = [];

  for (const item of legendTexts) {
    const symType = classifyLegendDescription(item.text);
    if (!symType) continue;

    // Look for vector symbol geometry immediately to the left of the description text
    const nearbyPaths = geometry.paths.filter((p) => {
      const pCentroidX = (p.bbox[0] + p.bbox[2]) / 2;
      const pCentroidY = (p.bbox[1] + p.bbox[3]) / 2;
      return (
        pCentroidX >= item.x - 50 &&
        pCentroidX <= item.x - 2 &&
        Math.abs(pCentroidY - item.y) <= 18 &&
        p.extent.maxDim <= 35
      );
    });

    if (nearbyPaths.length > 0) {
      // Analyze the template shape
      let isCircle = false;
      let isRect = false;
      let concentricCount = nearbyPaths.length;
      let maxDim = 0;
      let color: CadColor | undefined;
      let layerName: string | undefined;

      for (const p of nearbyPaths) {
        if (p.extent.maxDim > maxDim) maxDim = p.extent.maxDim;
        if (!color && p.strokeColor) color = p.strokeColor;
        if (!layerName && p.layerName) layerName = p.layerName;

        const curveCount = p.subpaths.reduce(
          (acc, sp) => acc + sp.segments.filter((s) => s.type === 'curve').length,
          0
        );
        if (curveCount >= 2 || (p.isClosed && p.extent.aspectRatio >= 0.8)) {
          isCircle = true;
        } else if (p.isClosed && p.extent.aspectRatio >= 0.6) {
          isRect = true;
        }
      }

      templates.push({
        symbolType: symType,
        description: item.text,
        isCircle,
        isRect,
        concentricCount,
        size: maxDim > 0 ? maxDim : 12,
        color,
        layerName,
      });
    }
  }

  return { bbox: legendBbox, templates };
}

/**
 * Checks if a point or bbox lies inside a bounding box.
 */
function isInsideBbox(
  x: number,
  y: number,
  bbox?: [number, number, number, number]
): boolean {
  if (!bbox) return false;
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
}

interface ClusteredSymbolPath {
  centroid: CadPoint;
  bbox: [number, number, number, number];
  paths: CadPath[];
  size: number;
}

/**
 * Clusters overlapping / concentric vector paths into composite symbol nodes.
 */
function clusterSymbolPaths(paths: CadPath[]): ClusteredSymbolPath[] {
  const clusters: ClusteredSymbolPath[] = [];

  for (const path of paths) {
    const pCentroid: CadPoint = {
      x: (path.bbox[0] + path.bbox[2]) / 2,
      y: (path.bbox[1] + path.bbox[3]) / 2,
    };

    let matchedCluster: ClusteredSymbolPath | null = null;
    for (const cl of clusters) {
      if (distance(pCentroid, cl.centroid) <= 6.0) {
        matchedCluster = cl;
        break;
      }
    }

    if (matchedCluster) {
      matchedCluster.paths.push(path);
      // Expand cluster bbox
      matchedCluster.bbox[0] = Math.min(matchedCluster.bbox[0], path.bbox[0]);
      matchedCluster.bbox[1] = Math.min(matchedCluster.bbox[1], path.bbox[1]);
      matchedCluster.bbox[2] = Math.max(matchedCluster.bbox[2], path.bbox[2]);
      matchedCluster.bbox[3] = Math.max(matchedCluster.bbox[3], path.bbox[3]);
      // Update centroid as average
      matchedCluster.centroid = {
        x: (matchedCluster.bbox[0] + matchedCluster.bbox[2]) / 2,
        y: (matchedCluster.bbox[1] + matchedCluster.bbox[3]) / 2,
      };
      matchedCluster.size = Math.max(
        matchedCluster.size,
        matchedCluster.bbox[2] - matchedCluster.bbox[0],
        matchedCluster.bbox[3] - matchedCluster.bbox[1]
      );
    } else {
      clusters.push({
        centroid: pCentroid,
        bbox: [...path.bbox],
        paths: [path],
        size: path.extent.maxDim,
      });
    }
  }

  return clusters;
}

/**
 * Geometric shape classifier fallback for a clustered symbol.
 */
function classifyClusterGeometrically(
  cluster: ClusteredSymbolPath
): { type: StructureSymbolType; confidence: number } {
  const paths = cluster.paths;
  const pathCount = paths.length;

  let totalCurves = 0;
  let hasClosedPath = false;
  let straightLineCount = 0;

  for (const p of paths) {
    for (const sp of p.subpaths) {
      if (sp.isClosed) hasClosedPath = true;
      for (const seg of sp.segments) {
        if (seg.type === 'curve') totalCurves++;
        if (seg.type === 'line') straightLineCount++;
      }
    }
  }

  const hasStraightLines = straightLineCount > 0;
  const width = cluster.bbox[2] - cluster.bbox[0];
  const height = cluster.bbox[3] - cluster.bbox[1];
  const maxDim = Math.max(width, height);
  const minDim = Math.min(width, height);
  const aspectRatio = maxDim > 0 ? minDim / maxDim : 1;

  // 1. Concentric circles (CBMH or DCBMH)
  if (pathCount >= 3) {
    return { type: 'DCBMH', confidence: 0.9 };
  }
  if (pathCount === 2) {
    if (totalCurves >= 4 || (aspectRatio >= 0.75 && hasClosedPath)) {
      return { type: 'CBMH', confidence: 0.9 };
    }
  }

  // 2. Hydrant: circle/dot with cross ticks
  if (totalCurves >= 2 && hasStraightLines && pathCount >= 2) {
    return { type: 'HYDRANT', confidence: 0.85 };
  }

  // 3. Valve: bow-tie triangles or multi-line valve
  if (hasStraightLines && totalCurves === 0 && (pathCount >= 2 || !hasClosedPath)) {
    return { type: 'VALVE', confidence: 0.8 };
  }

  // 4. Rectangle / Square (CB / DICB): purely straight lines without curves
  if (totalCurves === 0 && (hasClosedPath || straightLineCount >= 4) && aspectRatio >= 0.6) {
    return { type: 'CB', confidence: 0.85 };
  }

  // 5. Single Circle (MH): curves present
  if (totalCurves >= 2 || (hasClosedPath && aspectRatio >= 0.85)) {
    return { type: 'MH', confidence: 0.85 };
  }

  return { type: 'MH', confidence: 0.7 };
}

/**
 * Extracts structure symbol candidates from CAD geometry.
 */
export function extractStructureSymbols(
  geometry: CadGeometryPage,
  pageText?: PageText
): StructureSymbolCandidate[] {
  // Step 1: Detect Legend box and templates
  const { bbox: legendBbox, templates } = detectLegend(geometry, pageText);

  // Step 2: Filter candidate symbol paths across the sheet
  // Filter out paths inside legend box or page borders / large frames
  const candidatePaths = geometry.paths.filter((p) => {
    const cx = (p.bbox[0] + p.bbox[2]) / 2;
    const cy = (p.bbox[1] + p.bbox[3]) / 2;

    if (isInsideBbox(cx, cy, legendBbox)) return false;

    // Filter out border lines / sheet bounds (margins within 25pt of page edge)
    if (
      p.bbox[0] <= 25 &&
      p.bbox[2] >= geometry.width - 25 &&
      p.bbox[1] <= 25 &&
      p.bbox[3] >= geometry.height - 25
    ) {
      return false;
    }

    // Must be classified as symbolCandidate or small candidate
    if (p.classification === 'symbolCandidate') return true;

    // Also include small closed loops or circles with extent <= 32pt
    if (p.extent.maxDim >= 4 && p.extent.maxDim <= 32 && p.extent.aspectRatio >= 0.55) {
      return true;
    }

    return false;
  });

  // Step 3: Cluster nearby symbol paths (concentric circles, ticks, multi-part symbols)
  const clusters = clusterSymbolPaths(candidatePaths);

  // Step 4: Classify each cluster (Legend matching -> Geometric fallback)
  const symbols: StructureSymbolCandidate[] = [];
  let symSeq = 0;

  for (const cl of clusters) {
    let matchedType: StructureSymbolType = 'UNKNOWN';
    let confidence = 0.5;
    let source: 'legend-matched' | 'geometric-shape' = 'geometric-shape';
    let description: string | undefined;

    // Try template matching if legend templates exist
    if (templates.length > 0) {
      let bestTemplate: LegendTemplate | null = null;
      let bestScore = 0;

      for (const t of templates) {
        let score = 0;

        // Size similarity
        const sizeRatio = Math.min(cl.size, t.size) / Math.max(cl.size, t.size);
        if (sizeRatio >= 0.65) score += 0.3;

        // Concentric count match
        if (cl.paths.length === t.concentricCount) score += 0.4;

        // Shape match (circle vs rect)
        const isClusterCircle = cl.paths.some((p) =>
          p.subpaths.some((sp) => sp.segments.some((seg) => seg.type === 'curve'))
        );
        if (t.isCircle && isClusterCircle) score += 0.3;
        else if (t.isRect && !isClusterCircle) score += 0.3;

        // Layer / Color match
        const clColor = cl.paths.find((p) => p.strokeColor)?.strokeColor;
        if (t.color && clColor && t.color.hex === clColor.hex) score += 0.2;
        const clLayer = cl.paths.find((p) => p.layerName)?.layerName;
        if (t.layerName && clLayer && t.layerName === clLayer) score += 0.2;

        if (score > bestScore && score >= 0.5) {
          bestScore = score;
          bestTemplate = t;
        }
      }

      if (bestTemplate) {
        matchedType = bestTemplate.symbolType;
        confidence = Math.min(0.98, bestScore + 0.2);
        source = 'legend-matched';
        description = bestTemplate.description;
      }
    }

    // Fallback to geometric shape classification if not matched by legend
    if (matchedType === 'UNKNOWN' || source === 'geometric-shape') {
      const geoResult = classifyClusterGeometrically(cl);
      matchedType = geoResult.type;
      confidence = geoResult.confidence;
      source = 'geometric-shape';
    }

    const firstColor = cl.paths.find((p) => p.strokeColor)?.strokeColor;
    const firstLayer = cl.paths.find((p) => p.layerName)?.layerName;

    symbols.push({
      id: `sym_${++symSeq}`,
      type: matchedType,
      centroid: cl.centroid,
      bbox: cl.bbox,
      size: cl.size,
      confidence,
      source,
      description,
      color: firstColor,
      layerName: firstLayer,
      associatedPathIds: cl.paths.map((p) => p.id),
    });
  }

  return symbols;
}
