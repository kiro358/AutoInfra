/**
 * Leader Line & Spatial Annotation Binding.
 *
 * Binds callout text annotations (from text layer or decoded SHX) to their owning
 * structure node or pipe edge in the SiteNetwork using leader line tracing,
 * perpendicular distance, and spatial alignment.
 */
import { CadGeometryPage, CadPoint, distance } from './cad-geometry';
import {
  parseElevation,
  parseRunCallout,
  parseStructureLabel,
  parseSubdrainCallout,
  parseWatermainCallout,
} from './callout-parser';
import { SiteEdge, SiteNetwork, SiteNode } from './site-network';

export interface CadAnnotation {
  id: string;
  text: string;
  bbox: [number, number, number, number]; // [minX, minY, maxX, maxY]
  position: CadPoint;
  rotationDeg?: number;
  source: 'text-layer' | 'shx' | 'ocr';
  confidence: number;
}

export interface BoundNodeElevation {
  type: 'TG' | 'INV';
  direction: string | null;
  value: number;
  confidence: number;
}

export interface BoundSiteNode extends SiteNode {
  boundLabel?: string;
  boundKind?: string;
  rimElevation?: number;
  invertElevation?: number;
  elevations: BoundNodeElevation[];
  structureDiameterMm?: number;
  isExisting?: boolean;
  annotationIds: string[];
}

export interface BoundSiteEdge extends SiteEdge {
  boundRunLabel?: string;
  diameterMm?: number;
  material?: string;
  typeClass?: number;
  slopePercent?: number;
  calloutLengthMeters?: number;
  isExisting?: boolean;
  annotationIds: string[];
}

export interface BoundSiteNetwork {
  network: SiteNetwork;
  nodes: Map<string, BoundSiteNode>;
  edges: BoundSiteEdge[];
  unboundAnnotations: CadAnnotation[];
  stats: {
    totalAnnotations: number;
    boundToNodes: number;
    boundToEdges: number;
    unbound: number;
  };
}

/**
 * Calculates perpendicular distance from a point P to a line segment AB.
 */
export function pointToSegmentDistance(p: CadPoint, a: CadPoint, b: CadPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);

  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return distance(p, { x: projX, y: projY });
}

/**
 * Calculates minimum distance from a point P to a polyline.
 */
export function pointToPolylineDistance(p: CadPoint, polyline: CadPoint[]): number {
  if (polyline.length === 0) return Infinity;
  if (polyline.length === 1) return distance(p, polyline[0]);

  let minDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentDistance(p, polyline[i], polyline[i + 1]);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Parses flexible elevation lines (e.g. "RIM 100.50", "INV 97.50", "T/G 102.3").
 */
function parseFlexibleElevation(
  text: string
): { type: 'TG' | 'INV'; value: number } | null {
  const std = parseElevation(text);
  if (std) return { type: std.type, value: std.value };

  const rimMatch = text.match(/\b(?:RIM|T\/?G|GR(?:OUND)?)\s*[:=]?\s*(\d{2,3}(?:\.\d{1,3})?)/i);
  if (rimMatch) {
    return { type: 'TG', value: parseFloat(rimMatch[1]) };
  }

  const invMatch = text.match(/\b(?:INV(?:ERT)?)\s*[:=]?\s*(\d{2,3}(?:\.\d{1,3})?)/i);
  if (invMatch) {
    return { type: 'INV', value: parseFloat(invMatch[1]) };
  }

  return null;
}

/**
 * Binds annotations to SiteNodes and SiteEdges.
 */
export function bindAnnotationsToNetwork(
  network: SiteNetwork,
  annotations: CadAnnotation[],
  geometry?: CadGeometryPage
): BoundSiteNetwork {
  // Initialize bound nodes
  const boundNodes = new Map<string, BoundSiteNode>();
  for (const [id, node] of network.nodes) {
    boundNodes.set(id, {
      ...node,
      elevations: [],
      annotationIds: [],
    });
  }

  // Initialize bound edges
  const boundEdges: BoundSiteEdge[] = network.edges.map((edge) => ({
    ...edge,
    annotationIds: [],
  }));

  const unboundAnnotations: CadAnnotation[] = [];
  const boundAnnotationIds = new Set<string>();

  // Helper to extract potential leader lines from geometry
  const leaderLines: { start: CadPoint; end: CadPoint; length: number }[] = [];
  if (geometry) {
    for (const pl of geometry.polylines) {
      if (pl.length >= 6 && pl.length <= 60 && pl.points.length >= 2) {
        leaderLines.push({
          start: pl.points[0],
          end: pl.points[pl.points.length - 1],
          length: pl.length,
        });
      }
    }
  }

  for (const annot of annotations) {
    const text = annot.text.trim();
    if (!text) continue;

    let bound = false;

    // 1. Try leader line binding first
    for (const leader of leaderLines) {
      const startNearText =
        distance(leader.start, annot.position) <= 20.0 ||
        (leader.start.x >= annot.bbox[0] - 5 &&
          leader.start.x <= annot.bbox[2] + 5 &&
          leader.start.y >= annot.bbox[1] - 5 &&
          leader.start.y <= annot.bbox[3] + 5);

      const endNearText =
        distance(leader.end, annot.position) <= 20.0 ||
        (leader.end.x >= annot.bbox[0] - 5 &&
          leader.end.x <= annot.bbox[2] + 5 &&
          leader.end.y >= annot.bbox[1] - 5 &&
          leader.end.y <= annot.bbox[3] + 5);

      if (startNearText || endNearText) {
        const targetPt = startNearText ? leader.end : leader.start;

        // Check if target point hits a node
        let nearestNode: BoundSiteNode | null = null;
        let minNodeDist = 20.0;
        for (const [_, n] of boundNodes) {
          const d = distance(targetPt, n.centroid);
          if (d < minNodeDist) {
            minNodeDist = d;
            nearestNode = n;
          }
        }

        // Check if target point hits an edge
        let nearestEdge: BoundSiteEdge | null = null;
        let minEdgeDist = 15.0;
        for (const e of boundEdges) {
          const d = pointToPolylineDistance(targetPt, e.polyline);
          if (d < minEdgeDist) {
            minEdgeDist = d;
            nearestEdge = e;
          }
        }

        // Apply binding to node or edge based on parsed semantics
        const struct = parseStructureLabel(text);
        const elev = parseFlexibleElevation(text);
        const run = parseRunCallout(text);
        const wm = parseWatermainCallout(text);
        const subdrain = parseSubdrainCallout(text);

        if ((struct || elev) && nearestNode) {
          if (struct) {
            nearestNode.boundLabel = struct.label;
            nearestNode.boundKind = struct.kind;
            if (struct.diameterMm) nearestNode.structureDiameterMm = struct.diameterMm;
            if (struct.existing) nearestNode.isExisting = true;
          }
          if (elev) {
            if (elev.type === 'TG') nearestNode.rimElevation = elev.value;
            else if (elev.type === 'INV') nearestNode.invertElevation = elev.value;
            nearestNode.elevations.push({
              type: elev.type,
              direction: null,
              value: elev.value,
              confidence: annot.confidence,
            });
          }
          nearestNode.annotationIds.push(annot.id);
          bound = true;
          break;
        } else if ((run || wm || subdrain) && nearestEdge) {
          if (run) {
            nearestEdge.diameterMm = run.diameterMm;
            nearestEdge.slopePercent = run.slopePct ?? undefined;
            nearestEdge.calloutLengthMeters = run.length;
            if (run.material) nearestEdge.material = run.material;
            if (run.typeClass) nearestEdge.typeClass = run.typeClass;
            if (run.existing) nearestEdge.isExisting = true;
          } else if (wm) {
            nearestEdge.diameterMm = wm.diameterMm;
            if (wm.lengthM != null) nearestEdge.calloutLengthMeters = wm.lengthM;
            if (wm.material) nearestEdge.material = wm.material;
            if (wm.existing) nearestEdge.isExisting = true;
          } else if (subdrain) {
            nearestEdge.diameterMm = subdrain.diameterMm;
            nearestEdge.calloutLengthMeters = subdrain.length;
            nearestEdge.material = 'SUBDRAIN';
          }
          nearestEdge.annotationIds.push(annot.id);
          bound = true;
          break;
        }
      }
    }

    if (bound) {
      boundAnnotationIds.add(annot.id);
      continue;
    }

    // 2. Proximity-based binding
    const struct = parseStructureLabel(text);
    const elev = parseFlexibleElevation(text);
    const run = parseRunCallout(text);
    const wm = parseWatermainCallout(text);
    const subdrain = parseSubdrainCallout(text);

    if (struct || elev) {
      let nearestNode: BoundSiteNode | null = null;
      let minNodeDist = 45.0;

      for (const [_, n] of boundNodes) {
        const d = distance(annot.position, n.centroid);
        if (d < minNodeDist) {
          minNodeDist = d;
          nearestNode = n;
        }
      }

      if (nearestNode) {
        if (struct) {
          nearestNode.boundLabel = struct.label;
          nearestNode.boundKind = struct.kind;
          if (struct.diameterMm) nearestNode.structureDiameterMm = struct.diameterMm;
          if (struct.existing) nearestNode.isExisting = true;
        }
        if (elev) {
          if (elev.type === 'TG') nearestNode.rimElevation = elev.value;
          else if (elev.type === 'INV') nearestNode.invertElevation = elev.value;
          nearestNode.elevations.push({
            type: elev.type,
            direction: null,
            value: elev.value,
            confidence: annot.confidence,
          });
        }
        nearestNode.annotationIds.push(annot.id);
        bound = true;
        boundAnnotationIds.add(annot.id);
      }
    } else if (run || wm || subdrain) {
      let nearestEdge: BoundSiteEdge | null = null;
      let minEdgeDist = 45.0;

      for (const e of boundEdges) {
        const d = pointToPolylineDistance(annot.position, e.polyline);
        if (d < minEdgeDist) {
          minEdgeDist = d;
          nearestEdge = e;
        }
      }

      if (nearestEdge) {
        if (run) {
          nearestEdge.diameterMm = run.diameterMm;
          nearestEdge.slopePercent = run.slopePct ?? undefined;
          nearestEdge.calloutLengthMeters = run.length;
          if (run.material) nearestEdge.material = run.material;
          if (run.typeClass) nearestEdge.typeClass = run.typeClass;
          if (run.existing) nearestEdge.isExisting = true;
        } else if (wm) {
          nearestEdge.diameterMm = wm.diameterMm;
          if (wm.lengthM != null) nearestEdge.calloutLengthMeters = wm.lengthM;
          if (wm.material) nearestEdge.material = wm.material;
          if (wm.existing) nearestEdge.isExisting = true;
        } else if (subdrain) {
          nearestEdge.diameterMm = subdrain.diameterMm;
          nearestEdge.calloutLengthMeters = subdrain.length;
          nearestEdge.material = 'SUBDRAIN';
        }
        nearestEdge.annotationIds.push(annot.id);
        bound = true;
        boundAnnotationIds.add(annot.id);
      }
    }

    if (!bound) {
      unboundAnnotations.push(annot);
    }
  }

  let boundToNodes = 0;
  for (const [_, n] of boundNodes) {
    if (n.annotationIds.length > 0) boundToNodes++;
  }

  let boundToEdges = 0;
  for (const e of boundEdges) {
    if (e.annotationIds.length > 0) boundToEdges++;
  }

  return {
    network,
    nodes: boundNodes,
    edges: boundEdges,
    unboundAnnotations,
    stats: {
      totalAnnotations: annotations.length,
      boundToNodes,
      boundToEdges,
      unbound: unboundAnnotations.length,
    },
  };
}
