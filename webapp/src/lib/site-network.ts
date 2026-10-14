/**
 * Pipe Linework Polylines & Topological Network Graph.
 *
 * Traces continuous pipe polylines between structure centroids and builds
 * the topological SiteNetwork graph (nodes and edges).
 *
 * Coordinates are PDF user space (pt units, origin BOTTOM-LEFT, y grows upward).
 */
import { CadColor, CadGeometryPage, CadPoint, CadPolyline, distance } from './cad-geometry';
import { detectLegend, StructureSymbolCandidate, StructureSymbolType } from './cad-symbols';
import { PageText } from './pdf-text';
import { SheetCalibration } from './types';

export type PipeSystem = 'STORM' | 'SAN' | 'WATERMAIN' | 'UNKNOWN';

export interface StrokeStyle {
  color?: CadColor;
  lineWidth: number;
  dashArray: number[];
  layerName?: string;
}

export interface SiteNode {
  id: string;
  symbolCandidateId: string;
  centroid: CadPoint;
  symbolType: StructureSymbolType;
  kind?: 'MANHOLE' | 'CATCHBASIN' | 'HYDRANT' | 'VALVE' | 'UNKNOWN';
  label?: string;
  bbox: [number, number, number, number];
  incomingEdgeIds: string[];
  outgoingEdgeIds: string[];
  color?: CadColor;
  layerName?: string;
  confidence: number;
}

export interface SiteEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  polyline: CadPoint[];
  drawnLengthPt: number;
  /** Drawn length converted at the sheet's calibrated scale. Null when the
   *  sheet has no calibration (see SiteNetwork.calibration) — the length is
   *  then *unmeasurable*, not zero and not defaulted. */
  drawnLengthMeters: number | null;
  system: PipeSystem;
  strokeStyle: StrokeStyle;
  confidence: number;
  runLabel?: string;
  diameterMm?: number;
  material?: string;
  slopePercent?: number;
  calloutLengthMeters?: number;
}

export interface SiteNetwork {
  page: number;
  width: number;
  height: number;
  nodes: Map<string, SiteNode>;
  edges: SiteEdge[];
  /** pt per meter, or null when the sheet's scale could not be determined
   *  unambiguously (see `calibration`). Null disables every drawn-geometry
   *  measurement on the sheet — there is deliberately no default. */
  scaleRatio: number | null;
  /** The calibration record behind `scaleRatio` (value + source + evidence).
   *  Optional only so hand-built networks in older tests stay valid;
   *  buildSiteNetwork always populates it. */
  calibration?: SheetCalibration;
  stats: {
    nodeCount: number;
    edgeCount: number;
    stormEdgeCount: number;
    sanitaryEdgeCount: number;
    watermainEdgeCount: number;
  };
}

/** Raw outcome of scanning a sheet's text for scale notes. */
export interface ScaleDetection {
  /** pt per metre when exactly one distinct scale note was found, else null. */
  scalePtPerM: number | null;
  source: 'detected' | 'ambiguous' | 'absent';
  /** The raw text of the (first) accepted scale note. */
  detectedText?: string;
  /** Every distinct scale denominator found on the sheet. */
  candidates: number[];
}

const SCALE_NOTE_RE = /SCALE\s*1\s*:\s*(\d+)/gi;

/** (1000mm / denom) * (72pt / 25.4mm) — pt per metre for a 1:denom note. */
function scalePtPerMForDenominator(denom: number): number {
  return (1000 / denom) * (72 / 25.4);
}

/**
 * Scans the sheet text for scale notes (suggestion only — adoption happens
 * in buildSiteNetwork / verifyCalibration). A single distinct denominator
 * (however many times repeated) is a detection; two or more *distinct*
 * denominators are a conflict and suggest nothing (the enlarged-detail
 * trap: a plan sheet carrying a detail's 1:50 note next to its own 1:500).
 */
export function detectDrawingScaleDetailed(pageText?: PageText): ScaleDetection {
  if (!pageText) return { scalePtPerM: null, source: 'absent', candidates: [] };

  const byDenominator = new Map<number, string>();
  for (const item of pageText.items) {
    for (const m of item.text.matchAll(SCALE_NOTE_RE)) {
      const denom = parseInt(m[1], 10);
      if (denom > 0 && !byDenominator.has(denom)) {
        byDenominator.set(denom, item.text);
      }
    }
  }

  const candidates = [...byDenominator.keys()];
  if (candidates.length === 0) {
    return { scalePtPerM: null, source: 'absent', candidates };
  }
  if (candidates.length > 1) {
    return { scalePtPerM: null, source: 'ambiguous', candidates };
  }
  const denom = candidates[0];
  return {
    scalePtPerM: scalePtPerMForDenominator(denom),
    source: 'detected',
    detectedText: byDenominator.get(denom),
    candidates,
  };
}

/**
 * Detects scale ratio (pt per meter) from the sheet's scale note.
 * Returns null when there is no note or the notes conflict — there is
 * deliberately NO fallback constant: an unknown scale means drawn geometry
 * cannot be measured, and callers must say so instead of inventing lengths
 * (the pre-PR-12 code silently substituted 5.0 pt/m).
 */
export function detectDrawingScale(pageText?: PageText): number | null {
  return detectDrawingScaleDetailed(pageText).scalePtPerM;
}

/** Verification tolerance: stated dimensions confirming the detected scale
 *  within this relative residual promote the record to 'stated'. */
export const SCALE_VERIFY_TOLERANCE = 0.1;
/** Beyond this residual the stated dimensions flatly contradict the note —
 *  surfaced as a warning (warn, don't block). */
export const SCALE_CONFLICT_TOLERANCE = 0.25;

/**
 * Verifies a detected calibration against stated dimensions on the same
 * sheet: each sample pairs a drawn length (pt) with the length the drawing
 * states for the same run (m), implying its own pt/m. With ≥2 samples, the
 * median implied scale is the sheet's geometric truth as far as the
 * estimator is concerned: agreement within SCALE_VERIFY_TOLERANCE promotes
 * the record to 'stated'; strong disagreement keeps 'detected' but records
 * the residual so the caller can warn. Never overwrites the adopted value —
 * conflicts are reported, not resolved by fiat.
 */
export function verifyCalibration(
  calibration: SheetCalibration,
  samples: { drawnLengthPt: number; statedLengthM: number }[]
): { calibration: SheetCalibration; conflict: boolean } {
  if (calibration.source !== 'detected' || calibration.scalePtPerM == null) {
    return { calibration, conflict: false };
  }
  const implied = samples
    .filter((s) => s.drawnLengthPt > 0 && s.statedLengthM > 0)
    .map((s) => s.drawnLengthPt / s.statedLengthM)
    .sort((a, b) => a - b);
  if (implied.length < 2) {
    return { calibration: { ...calibration, residual: null }, conflict: false };
  }
  const median = implied[Math.floor(implied.length / 2)];
  const adopted = calibration.scalePtPerM;
  const residual = Math.abs(median - adopted) / adopted;
  if (residual <= SCALE_VERIFY_TOLERANCE) {
    return { calibration: { ...calibration, source: 'stated', residual }, conflict: false };
  }
  return {
    calibration: { ...calibration, residual },
    conflict: residual > SCALE_CONFLICT_TOLERANCE,
  };
}

/**
 * Infers pipe system from stroke style, color, dash array, and layer name.
 */
export function inferPipeSystem(style: StrokeStyle): PipeSystem {
  const layer = (style.layerName || '').toUpperCase();
  if (layer.includes('STM') || layer.includes('STORM')) return 'STORM';
  if (layer.includes('SAN')) return 'SAN';
  if (layer.includes('WATER') || layer.includes('WM')) return 'WATERMAIN';

  if (style.dashArray && style.dashArray.length > 0) {
    return 'STORM';
  }

  if (style.color) {
    const { r, g, b } = style.color;
    // Green -> Sanitary
    if (g > 100 && g > r * 1.3 && g > b * 1.3) {
      return 'SAN';
    }
    // Deep blue -> Watermain
    if (b > 150 && b > r * 1.5 && b > g * 1.2 && style.lineWidth >= 2.0) {
      return 'WATERMAIN';
    }
    // Cyan/Blue -> Storm or Watermain
    if (b > 120 && g > 100 && r < 100) {
      return 'STORM';
    }
  }

  return 'UNKNOWN';
}

/**
 * Determines whether two stroke styles are compatible for chaining.
 */
function isCompatibleStrokeStyle(s1: StrokeStyle, s2: StrokeStyle): boolean {
  if (s1.dashArray.length !== s2.dashArray.length) return false;
  if (Math.abs(s1.lineWidth - s2.lineWidth) > 1.0) return false;
  if (s1.color && s2.color) {
    if (s1.color.hex !== s2.color.hex) return false;
  }
  if (s1.layerName && s2.layerName) {
    if (s1.layerName !== s2.layerName) return false;
  }
  return true;
}

/**
 * Checks if a point is close to any structure node.
 */
function isNearAnyNode(pt: CadPoint, nodes: SiteNode[], threshold: number = 8.0): boolean {
  for (const n of nodes) {
    if (distance(pt, n.centroid) <= threshold) return true;
  }
  return false;
}

/**
 * Chains contiguous line segments into longer polylines, stopping at structure nodes.
 */
function chainLinework(
  polylines: CadPolyline[],
  nodes: SiteNode[],
  tolerance: number = 4.0
): CadPolyline[] {
  const remaining = polylines.map((pl) => ({
    points: [...pl.points],
    length: pl.length,
    style: {
      color: pl.strokeColor,
      lineWidth: pl.lineWidth,
      dashArray: pl.dashArray,
      layerName: pl.layerName,
    },
    used: false,
  }));

  const chained: CadPolyline[] = [];
  let seq = 0;

  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].used) continue;
    remaining[i].used = true;

    let currentPoints = [...remaining[i].points];
    const currentStyle = remaining[i].style;
    let expanded = true;

    while (expanded) {
      expanded = false;
      const startPt = currentPoints[0];
      const endPt = currentPoints[currentPoints.length - 1];

      // If endpoints already touch structure nodes, do not chain past them!
      const startAtNode = isNearAnyNode(startPt, nodes, 10.0);
      const endAtNode = isNearAnyNode(endPt, nodes, 10.0);

      if (startAtNode && endAtNode) {
        break;
      }

      for (let j = 0; j < remaining.length; j++) {
        if (remaining[j].used) continue;
        if (!isCompatibleStrokeStyle(currentStyle, remaining[j].style)) continue;

        const otherPts = remaining[j].points;
        const otherStart = otherPts[0];
        const otherEnd = otherPts[otherPts.length - 1];

        // End-to-Start connection (only if endPt is not already a structure node)
        if (!endAtNode && distance(endPt, otherStart) <= tolerance) {
          currentPoints.push(...otherPts.slice(1));
          remaining[j].used = true;
          expanded = true;
          break;
        }
        // End-to-End connection
        else if (!endAtNode && distance(endPt, otherEnd) <= tolerance) {
          const rev = [...otherPts].reverse();
          currentPoints.push(...rev.slice(1));
          remaining[j].used = true;
          expanded = true;
          break;
        }
        // Start-to-End connection (only if startPt is not already a structure node)
        else if (!startAtNode && distance(startPt, otherEnd) <= tolerance) {
          currentPoints.unshift(...otherPts.slice(0, -1));
          remaining[j].used = true;
          expanded = true;
          break;
        }
        // Start-to-Start connection
        else if (!startAtNode && distance(startPt, otherStart) <= tolerance) {
          const rev = [...otherPts].reverse();
          currentPoints.unshift(...rev.slice(0, -1));
          remaining[j].used = true;
          expanded = true;
          break;
        }
      }
    }

    // Compute length and bounding box
    let totalLen = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let pIdx = 0; pIdx < currentPoints.length; pIdx++) {
      const pt = currentPoints[pIdx];
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;

      if (pIdx > 0) {
        totalLen += distance(currentPoints[pIdx - 1], pt);
      }
    }

    chained.push({
      id: `poly_chain_${++seq}`,
      points: currentPoints,
      length: totalLen,
      bbox: [minX, minY, maxX, maxY],
      strokeColor: currentStyle.color,
      lineWidth: currentStyle.lineWidth,
      dashArray: currentStyle.dashArray,
      layerName: currentStyle.layerName,
    });
  }

  return chained;
}

/**
 * Finds the nearest structure node to a given point within a snapping tolerance.
 */
function findNearestNode(
  pt: CadPoint,
  nodes: SiteNode[],
  snapRadius: number = 25.0
): SiteNode | null {
  let nearest: SiteNode | null = null;
  let minDist = snapRadius;

  for (const node of nodes) {
    const d = distance(pt, node.centroid);
    if (d < minDist) {
      minDist = d;
      nearest = node;
    }
  }

  return nearest;
}

/**
 * Checks if a bbox is inside another bbox.
 */
function isBboxInside(
  inner: [number, number, number, number],
  outer?: [number, number, number, number]
): boolean {
  if (!outer) return false;
  return (
    inner[0] >= outer[0] - 5 &&
    inner[2] <= outer[2] + 5 &&
    inner[1] >= outer[1] - 5 &&
    inner[3] <= outer[3] + 5
  );
}

/**
 * Builds the SiteNetwork graph (nodes and edges) from CAD vector geometry and symbols.
 */
export function buildSiteNetwork(
  geometry: CadGeometryPage,
  symbols: StructureSymbolCandidate[],
  scale?: number,
  pageText?: PageText
): SiteNetwork {
  // Scale is calibration, not a magic constant: an explicit caller-supplied
  // scale is an act of adoption ('explicit'); otherwise the sheet's own
  // scale note is the only suggestion, and ambiguity/absence records null.
  let calibration: SheetCalibration;
  if (scale != null) {
    calibration = { scalePtPerM: scale, source: 'explicit', page: geometry.page };
  } else {
    const detection = detectDrawingScaleDetailed(pageText);
    calibration = {
      scalePtPerM: detection.scalePtPerM,
      source: detection.source,
      page: geometry.page,
      detectedText: detection.detectedText,
      candidates: detection.candidates,
    };
  }
  const scaleRatio = calibration.scalePtPerM;
  const legendInfo = detectLegend(geometry, pageText);

  // 1. Create SiteNodes from StructureSymbolCandidates
  const nodeMap = new Map<string, SiteNode>();
  const nodeList: SiteNode[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const nodeId = `node_${i + 1}`;

    let kind: SiteNode['kind'] = 'UNKNOWN';
    if (sym.type === 'MH' || sym.type === 'CBMH' || sym.type === 'DCBMH') kind = 'MANHOLE';
    else if (sym.type === 'CB' || sym.type === 'DICB') kind = 'CATCHBASIN';
    else if (sym.type === 'HYDRANT') kind = 'HYDRANT';
    else if (sym.type === 'VALVE') kind = 'VALVE';

    const node: SiteNode = {
      id: nodeId,
      symbolCandidateId: sym.id,
      centroid: sym.centroid,
      symbolType: sym.type,
      kind,
      bbox: sym.bbox,
      incomingEdgeIds: [],
      outgoingEdgeIds: [],
      color: sym.color,
      layerName: sym.layerName,
      confidence: sym.confidence,
    };

    nodeMap.set(nodeId, node);
    nodeList.push(node);
  }

  // 2. Filter linework candidates and chain contiguous segments
  // Filter out border lines, table grids, legend frames
  const pipeLinework = geometry.polylines.filter((pl) => {
    // Filter out page boundary frames
    if (
      pl.bbox[0] <= 25 &&
      pl.bbox[2] >= geometry.width - 25 &&
      pl.bbox[1] <= 25 &&
      pl.bbox[3] >= geometry.height - 25
    ) {
      return false;
    }

    // Filter out polylines inside the legend bounding box
    if (isBboxInside(pl.bbox, legendInfo.bbox)) {
      return false;
    }

    // Must have length >= 10pt
    if (pl.length < 10) return false;

    return true;
  });

  const chainedLinework = chainLinework(pipeLinework, nodeList, 4.0);

  // 3. Connect linework to structure nodes
  const edges: SiteEdge[] = [];
  let edgeSeq = 0;
  const connectedPairs = new Set<string>();

  for (const pl of chainedLinework) {
    if (pl.points.length < 2) continue;

    const startPt = pl.points[0];
    const endPt = pl.points[pl.points.length - 1];

    const nodeFrom = findNearestNode(startPt, nodeList, 25.0);
    const nodeTo = findNearestNode(endPt, nodeList, 25.0);

    if (nodeFrom && nodeTo && nodeFrom.id !== nodeTo.id) {
      const pairKey =
        nodeFrom.id < nodeTo.id
          ? `${nodeFrom.id}->${nodeTo.id}`
          : `${nodeTo.id}->${nodeFrom.id}`;

      if (connectedPairs.has(pairKey)) continue;
      connectedPairs.add(pairKey);

      const edgeId = `edge_${++edgeSeq}`;
      const strokeStyle: StrokeStyle = {
        color: pl.strokeColor,
        lineWidth: pl.lineWidth,
        dashArray: pl.dashArray,
        layerName: pl.layerName,
      };

      const system = inferPipeSystem(strokeStyle);
      const drawnLengthPt = pl.length;
      // Uncalibrated sheet => unmeasurable edge (null), never a defaulted
      // conversion. Consumers must treat null as "cannot measure".
      const drawnLengthMeters =
        scaleRatio != null && scaleRatio > 0 ? drawnLengthPt / scaleRatio : null;

      const edge: SiteEdge = {
        id: edgeId,
        fromNodeId: nodeFrom.id,
        toNodeId: nodeTo.id,
        polyline: pl.points,
        drawnLengthPt,
        drawnLengthMeters,
        system,
        strokeStyle,
        confidence: 0.9,
      };

      edges.push(edge);
      nodeFrom.outgoingEdgeIds.push(edgeId);
      nodeTo.incomingEdgeIds.push(edgeId);
    }
  }

  let stormEdgeCount = 0;
  let sanitaryEdgeCount = 0;
  let watermainEdgeCount = 0;

  for (const e of edges) {
    if (e.system === 'STORM') stormEdgeCount++;
    else if (e.system === 'SAN') sanitaryEdgeCount++;
    else if (e.system === 'WATERMAIN') watermainEdgeCount++;
  }

  return {
    page: geometry.page,
    width: geometry.width,
    height: geometry.height,
    nodes: nodeMap,
    edges,
    scaleRatio,
    calibration,
    stats: {
      nodeCount: nodeMap.size,
      edgeCount: edges.length,
      stormEdgeCount,
      sanitaryEdgeCount,
      watermainEdgeCount,
    },
  };
}
