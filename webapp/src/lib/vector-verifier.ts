/**
 * Targeted LLM Invariant Verifier.
 *
 * In Phase 4, the LLM is demoted from reading full sheets to answering small,
 * targeted verification queries on invariant violations or low-confidence SHX decodings
 * (e.g. cropped region of an ambiguous label or disconnected junction).
 *
 * Zero LLM calls are made when confidence is high and invariants pass.
 */
import { BoundSiteNetwork } from './cad-annotations';
import { InvariantViolation, NetworkValidationResult } from './cad-invariants';

export interface VerificationQuery {
  id: string;
  type: 'AMBIGUOUS_LABEL' | 'MISSING_TERMINAL' | 'HYDRAULIC_ANOMALY' | 'OTHER';
  entityId: string;
  location?: [number, number];
  question: string;
}

export interface VerificationAnswer {
  queryId: string;
  entityId: string;
  verifiedValue?: string;
  confidence: number;
}

/**
 * Builds targeted verification queries from invariant violations.
 */
export function buildVerificationQueries(
  validation: NetworkValidationResult,
  boundNetwork: BoundSiteNetwork
): VerificationQuery[] {
  const queries: VerificationQuery[] = [];
  let qSeq = 0;

  for (const v of validation.violations) {
    if (v.severity === 'error') {
      if (v.invariant === 'ENDPOINT_COMPLETENESS') {
        queries.push({
          id: `q_${++qSeq}`,
          type: 'MISSING_TERMINAL',
          entityId: v.entityId,
          location: v.location,
          question: `Is pipe segment ${v.entityId} connected to a manhole, catchbasin, or existing outlet at [${v.location ? v.location.join(',') : 'unknown'}]?`,
        });
      } else if (v.invariant === 'HYDRAULIC_DROP') {
        queries.push({
          id: `q_${++qSeq}`,
          type: 'HYDRAULIC_ANOMALY',
          entityId: v.entityId,
          location: v.location,
          question: `What are the exact invert elevations for upstream and downstream structures of run ${v.entityId}?`,
        });
      } else if (v.invariant === 'DEPTH_VALIDITY') {
        queries.push({
          id: `q_${++qSeq}`,
          type: 'OTHER',
          entityId: v.entityId,
          location: v.location,
          question: `What is the exact rim and invert elevation for structure ${v.entityId}?`,
        });
      }
    }
  }

  return queries;
}

/**
 * Applies verifier answers to update the BoundSiteNetwork.
 */
export function applyVerificationAnswers(
  boundNetwork: BoundSiteNetwork,
  answers: VerificationAnswer[]
): BoundSiteNetwork {
  const updatedNodes = new Map(boundNetwork.nodes);
  const updatedEdges = [...boundNetwork.edges];

  for (const ans of answers) {
    const node = updatedNodes.get(ans.entityId);
    if (node && ans.verifiedValue) {
      node.boundLabel = ans.verifiedValue;
      node.confidence = Math.max(node.confidence, ans.confidence);
    }

    const edge = updatedEdges.find((e) => e.id === ans.entityId);
    if (edge && ans.verifiedValue) {
      edge.boundRunLabel = ans.verifiedValue;
      edge.confidence = Math.max(edge.confidence, ans.confidence);
    }
  }

  return {
    ...boundNetwork,
    nodes: updatedNodes,
    edges: updatedEdges,
  };
}
