/**
 * Physical Network Invariants & Confidence Scoring.
 *
 * Evaluates topological, geometric, and hydraulic invariants across the
 * BoundSiteNetwork graph to compute mathematically grounded confidence signals
 * and pinpoint physical anomalies ($0 cost).
 */
import { BoundSiteEdge, BoundSiteNetwork, BoundSiteNode } from './cad-annotations';
import {
  CatchbasinGroupFact,
  SewerFact,
  StructureFact,
  TakeoffFacts,
  WatermainFact,
  WatermainSpecialFact,
  WatermainValveFact,
  WithheldItem,
} from './types';

export type InvariantType =
  | 'ENDPOINT_COMPLETENESS'
  | 'HYDRAULIC_DROP'
  | 'LENGTH_CONSERVATION'
  | 'CAPACITY_CONTINUITY'
  | 'DEPTH_VALIDITY';

export interface InvariantViolation {
  invariant: InvariantType;
  entityId: string;
  entityType: 'node' | 'edge';
  description: string;
  severity: 'error' | 'warning';
  location?: [number, number]; // [x, y] in pt
}

export interface NetworkValidationResult {
  score: number;
  violations: InvariantViolation[];
  validEntities: TakeoffFacts;
}

/**
 * Evaluates physical, geometric, and hydraulic invariants on a BoundSiteNetwork.
 */
export function evaluateNetworkInvariants(
  boundNetwork: BoundSiteNetwork
): NetworkValidationResult {
  const violations: InvariantViolation[] = [];
  const nodes = boundNetwork.nodes;
  const edges = boundNetwork.edges;

  // ----------------------------------------------------
  // Invariant 1: Endpoint Completeness
  // ----------------------------------------------------
  for (const edge of edges) {
    const fromNode = nodes.get(edge.fromNodeId);
    const toNode = nodes.get(edge.toNodeId);

    if (!fromNode || !toNode) {
      violations.push({
        invariant: 'ENDPOINT_COMPLETENESS',
        entityId: edge.id,
        entityType: 'edge',
        description: `Edge ${edge.id} has missing terminal nodes (from: ${edge.fromNodeId}, to: ${edge.toNodeId})`,
        severity: 'error',
        location: edge.polyline.length > 0 ? [edge.polyline[0].x, edge.polyline[0].y] : undefined,
      });
    } else if (fromNode.id === toNode.id) {
      violations.push({
        invariant: 'ENDPOINT_COMPLETENESS',
        entityId: edge.id,
        entityType: 'edge',
        description: `Edge ${edge.id} starts and ends at the same node ${fromNode.id}`,
        severity: 'error',
        location: [fromNode.centroid.x, fromNode.centroid.y],
      });
    }
  }

  // ----------------------------------------------------
  // Invariant 2: Hydraulic Drop
  // ----------------------------------------------------
  for (const edge of edges) {
    if (edge.system === 'STORM' || edge.system === 'SAN') {
      const fromNode = nodes.get(edge.fromNodeId);
      const toNode = nodes.get(edge.toNodeId);

      if (
        fromNode?.invertElevation != null &&
        toNode?.invertElevation != null
      ) {
        const fromInv = fromNode.invertElevation;
        const toInv = toNode.invertElevation;
        const drop = fromInv - toInv;

        // If slope is positive, fromInv must be greater than toInv
        if (drop <= 0) {
          violations.push({
            invariant: 'HYDRAULIC_DROP',
            entityId: edge.id,
            entityType: 'edge',
            description: `Gravity sewer run ${edge.id} has non-positive hydraulic drop (from: ${fromInv.toFixed(2)}, to: ${toInv.toFixed(2)}, drop: ${drop.toFixed(2)}m)`,
            severity: 'error',
            location: edge.polyline.length > 0 ? [edge.polyline[0].x, edge.polyline[0].y] : undefined,
          });
        }
      }
    }
  }

  // ----------------------------------------------------
  // Invariant 3: Length Conservation
  // (Disabled on uncalibrated sheets: drawnLengthMeters is null there, so
  // there is no drawn length to conserve against — the check must not run
  // on invented units.)
  // ----------------------------------------------------
  for (const edge of edges) {
    if (edge.calloutLengthMeters != null && edge.drawnLengthMeters != null && edge.drawnLengthMeters > 0) {
      const stated = edge.calloutLengthMeters;
      const drawn = edge.drawnLengthMeters;
      const diff = Math.abs(drawn - stated);
      const relDiff = stated > 0 ? diff / stated : 0;

      // Flag warning if difference > 10% and > 2m
      if (relDiff > 0.1 && diff > 2.0) {
        violations.push({
          invariant: 'LENGTH_CONSERVATION',
          entityId: edge.id,
          entityType: 'edge',
          description: `Edge ${edge.id} drawn length (${drawn.toFixed(1)}m) diverges from stated callout (${stated.toFixed(1)}m) by ${(relDiff * 100).toFixed(0)}%`,
          severity: 'warning',
          location:
            edge.polyline.length > 1
              ? [
                  (edge.polyline[0].x + edge.polyline[1].x) / 2,
                  (edge.polyline[0].y + edge.polyline[1].y) / 2,
                ]
              : undefined,
        });
      }
    }
  }

  // ----------------------------------------------------
  // Invariant 4: Pipe Capacity Continuity
  // ----------------------------------------------------
  for (const [nodeId, node] of nodes) {
    const incomingPipes = node.incomingEdgeIds
      .map((eId) => edges.find((e) => e.id === eId))
      .filter((e): e is BoundSiteEdge => e != null && e.diameterMm != null);

    const outgoingPipes = node.outgoingEdgeIds
      .map((eId) => edges.find((e) => e.id === eId))
      .filter((e): e is BoundSiteEdge => e != null && e.diameterMm != null);

    for (const inPipe of incomingPipes) {
      for (const outPipe of outgoingPipes) {
        if (inPipe.system === outPipe.system && (inPipe.system === 'STORM' || inPipe.system === 'SAN')) {
          if (inPipe.diameterMm! > outPipe.diameterMm!) {
            violations.push({
              invariant: 'CAPACITY_CONTINUITY',
              entityId: nodeId,
              entityType: 'node',
              description: `Structure ${node.boundLabel || nodeId} has incoming pipe (${inPipe.diameterMm}mm) larger than outgoing pipe (${outPipe.diameterMm}mm)`,
              severity: 'warning',
              location: [node.centroid.x, node.centroid.y],
            });
          }
        }
      }
    }
  }

  // ----------------------------------------------------
  // Invariant 5: Depth Validity
  // ----------------------------------------------------
  for (const [nodeId, node] of nodes) {
    if (node.rimElevation != null && node.invertElevation != null) {
      const depth = node.rimElevation - node.invertElevation;

      if (depth <= 0) {
        violations.push({
          invariant: 'DEPTH_VALIDITY',
          entityId: nodeId,
          entityType: 'node',
          description: `Structure ${node.boundLabel || nodeId} has negative or zero depth (rim: ${node.rimElevation.toFixed(2)}, inv: ${node.invertElevation.toFixed(2)})`,
          severity: 'error',
          location: [node.centroid.x, node.centroid.y],
        });
      } else if (depth < 0.8 || depth > 12.0) {
        violations.push({
          invariant: 'DEPTH_VALIDITY',
          entityId: nodeId,
          entityType: 'node',
          description: `Structure ${node.boundLabel || nodeId} depth (${depth.toFixed(2)}m) is outside typical civil range (0.8m - 12.0m)`,
          severity: 'warning',
          location: [node.centroid.x, node.centroid.y],
        });
      }
    }
  }

  // Compute confidence score
  let score = 1.0;
  for (const v of violations) {
    if (v.severity === 'error') score -= 0.15;
    else score -= 0.05;
  }
  score = Math.max(0.1, Math.min(1.0, score));

  // ----------------------------------------------------
  // Build TakeoffFacts validEntities output
  // ----------------------------------------------------
  const structureFacts: StructureFact[] = [];
  let singleCbCount = 0;
  let doubleCbCount = 0;
  let dicbCount = 0;
  let singleCbDepths: number[] = [];

  let structSeq = 0;
  for (const [_, node] of nodes) {
    if (
      node.kind === 'MANHOLE' ||
      node.symbolType === 'MH' ||
      node.symbolType === 'CBMH' ||
      node.symbolType === 'DCBMH'
    ) {
      const depth =
        node.rimElevation != null && node.invertElevation != null
          ? Math.max(0, node.rimElevation - node.invertElevation)
          : null;

      const desc = node.boundLabel || `MH ${++structSeq}`;
      structureFacts.push({
        description: desc,
        topElevation: node.rimElevation ?? null,
        lowInvert: node.invertElevation ?? null,
        highInvert: node.invertElevation ?? null,
        pipeOutDiameter: null,
        structureType: node.symbolType,
        depth,
      });

      // Also record CBMH/DCBMH in catchbasins
      if (node.symbolType === 'DCBMH') {
        doubleCbCount++;
      }
    } else if (
      node.kind === 'CATCHBASIN' ||
      node.symbolType === 'CB' ||
      node.symbolType === 'DICB'
    ) {
      const depth =
        node.rimElevation != null && node.invertElevation != null
          ? Math.max(0, node.rimElevation - node.invertElevation)
          : 1.8;

      if (node.symbolType === 'DICB') {
        dicbCount++;
      } else {
        singleCbCount++;
        singleCbDepths.push(depth);
      }
    }
  }

  const catchbasinFacts: CatchbasinGroupFact[] = [];
  if (singleCbCount > 0) {
    const avgDepth =
      singleCbDepths.length > 0
        ? singleCbDepths.reduce((a, b) => a + b, 0) / singleCbDepths.length
        : 1.8;
    catchbasinFacts.push({
      type: 'SINGLE_CB',
      quantity: singleCbCount,
      wallThickness: 150,
      depth: avgDepth,
    });
  }
  if (doubleCbCount > 0) {
    catchbasinFacts.push({
      type: 'DOUBLE_CB',
      quantity: doubleCbCount,
      wallThickness: 200,
      depth: 2.0,
    });
  }
  if (dicbCount > 0) {
    catchbasinFacts.push({
      type: 'DITCH_INLET_CB',
      quantity: dicbCount,
      wallThickness: 150,
      depth: 1.8,
    });
  }

  const withheld: WithheldItem[] = [];
  const uncalibratedNote =
    'the sheet\u2019s scale could not be determined, so the drawn length cannot be converted';

  const sewerFacts: SewerFact[] = [];
  for (const edge of edges) {
    if (edge.system === 'STORM' || edge.system === 'SAN') {
      const fromNode = nodes.get(edge.fromNodeId);
      const toNode = nodes.get(edge.toNodeId);

      const fromLabel = fromNode?.boundLabel || fromNode?.id || 'UP';
      const toLabel = toNode?.boundLabel || toNode?.id || 'DN';
      const runLabel = edge.boundRunLabel || `${fromLabel}-${toLabel}`;

      // Stated callout wins; drawn length only exists on calibrated sheets.
      // Both absent => the length is unmeasurable: emit null and withhold
      // the question instead of pricing an invented number.
      const length = edge.calloutLengthMeters ?? edge.drawnLengthMeters;
      if (length == null) {
        withheld.push({
          entity: runLabel,
          field: 'length',
          kind: 'withheld',
          question: `Length of run ${runLabel} is not stated in a callout and ${uncalibratedNote} \u2014 scale it off the plan. Left blank and not priced.`,
          defaultApplied: null,
        });
      }
      // No silent diameter default (the pre-conformance code substituted
      // 200 SAN / 300 STORM): a diameter the sheet never states is withheld
      // as a question, exactly like an unmeasurable length above — inventing
      // a pipe size is the same fabrication as inventing a scale (PR 12).
      const pipeDiameter = edge.diameterMm ?? null;
      if (pipeDiameter == null) {
        withheld.push({
          entity: runLabel,
          field: 'diameter',
          kind: 'withheld',
          question: `Diameter of run ${runLabel} is not stated in a callout — confirm the pipe size. Left blank and not priced.`,
          defaultApplied: null,
        });
      }

      sewerFacts.push({
        runLabel,
        isLineItem: edge.system === 'SAN' || edge.material === 'SUBDRAIN',
        lineItemType: edge.material === 'SUBDRAIN' ? 'SUBDRAIN' : undefined,
        length,
        pipeDiameter,
        typeClass: edge.typeClass ?? null,
        slope: edge.slopePercent ?? null,
        depth: 2.5,
        // Provenance: lengths here are stated callouts or scale
        // measurements off drawn geometry, already convention-processed
        // by applyEstimatorConventions — reconcile's whole-metre rule
        // for stated text/schedule lengths must not re-round them.
        source: { method: 'vector' },
      });
    }
  }

  const watermainFacts: WatermainFact[] = [];
  const watermainSpecials: WatermainSpecialFact[] = [];
  const watermainValves: WatermainValveFact[] = [];

  for (const edge of edges) {
    if (edge.system === 'WATERMAIN') {
      const measured = edge.calloutLengthMeters ?? edge.drawnLengthMeters;
      const dia = edge.diameterMm || 150;
      const mat = edge.material || 'PVC';
      const sizeAndType = `${dia}mm ${mat} WATERMAIN`;
      if (measured == null) {
        // Same posture as the text path's unmeasured watermain: the fact is
        // emitted (detection is real) with length 0 = not priced, and the
        // missing measurement is withheld as a question.
        withheld.push({
          entity: sizeAndType,
          field: 'length',
          kind: 'withheld',
          question: `Length of the ${sizeAndType} watermain is not stated in a callout and ${uncalibratedNote} \u2014 scale it off the plan. Left blank and not priced.`,
          defaultApplied: null,
        });
      }
      watermainFacts.push({
        sizeAndType,
        length: measured ?? 0,
        pipeDiameter: dia,
        ocSc: 1.1,
        avgCover: 1.8,
      });
    }
  }

  let hydCount = 0;
  let valveCount = 0;
  for (const [_, node] of nodes) {
    if (node.symbolType === 'HYDRANT') hydCount++;
    if (node.symbolType === 'VALVE') valveCount++;
  }

  if (hydCount > 0) {
    watermainSpecials.push({
      specialName: 'HYDRANT ASSEMBLY',
      quantity: hydCount,
    });
  }
  if (valveCount > 0) {
    watermainValves.push({
      valveSize: '150mm',
      quantity: valveCount,
    });
  }

  const validEntities: TakeoffFacts = {
    projectName: 'CAD Extraction',
    jobNumber: '',
    date: new Date().toISOString().split('T')[0],
    structures: structureFacts,
    catchbasins: catchbasinFacts,
    sewers: sewerFacts,
    watermain: watermainFacts,
    watermainSpecials,
    watermainValves,
    confidence: score,
    warnings: violations.map((v) => `${v.severity.toUpperCase()}: ${v.description}`),
    ...(withheld.length > 0 ? { withheld } : {}),
  };

  return {
    score,
    violations,
    validEntities,
  };
}
