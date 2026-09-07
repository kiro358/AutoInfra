import { describe, it, expect } from 'vitest';
import { extractVectorTakeoff } from './vector-takeoff';
import { createSyntheticCadPdf } from './test-fixtures/synthetic-cad-pdf';
import {
  buildVerificationQueries,
  applyVerificationAnswers,
} from './vector-verifier';
import { BoundSiteNetwork } from './cad-annotations';

describe('vector-takeoff end-to-end extraction', () => {
  it('extracts complete TakeoffFacts from synthetic CAD drawing with zero LLM calls', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const facts = await extractVectorTakeoff(Buffer.from(pdfBytes), [1], 'Synthetic Test Project');

    expect(facts.projectName).toBe('Synthetic Test Project');
    expect(facts.structures.length).toBeGreaterThanOrEqual(2);
    expect(facts.catchbasins.length).toBeGreaterThanOrEqual(1);
    expect(facts.sewers.length).toBeGreaterThanOrEqual(2);
    expect(facts.watermain.length).toBeGreaterThanOrEqual(1);

    // Verify structures
    const stmh1 = facts.structures.find((s) => s.description.includes('STMH 1') || s.description.includes('MH 1'));
    expect(stmh1).toBeDefined();
    expect(stmh1?.topElevation).toBeGreaterThan(90);
    expect(stmh1?.lowInvert).toBeGreaterThan(90);

    // Verify sewers
    const stormRun = facts.sewers.find((s) => s.pipeDiameter === 300);
    expect(stormRun).toBeDefined();
    expect(stormRun?.slope).toBe(0.5);
    expect(stormRun?.length).toBe(40.0);

    // Verify watermain
    const wm = facts.watermain.find((w) => w.pipeDiameter === 150);
    expect(wm).toBeDefined();
    expect(wm?.length).toBeGreaterThanOrEqual(30);

    // Verify specials and valves
    expect(facts.watermainSpecials.length).toBeGreaterThanOrEqual(1);
    expect(facts.watermainValves.length).toBeGreaterThanOrEqual(1);
  });
});

describe('vector-verifier targeted queries', () => {
  it('builds targeted verification queries for anomalies and applies answers', () => {
    const mockBound: BoundSiteNetwork = {
      network: {
        page: 1,
        width: 800,
        height: 600,
        nodes: new Map([
          [
            'node_1',
            {
              id: 'node_1',
              symbolCandidateId: 'sym_1',
              centroid: { x: 100, y: 100 },
              symbolType: 'MH',
              bbox: [90, 90, 110, 110],
              incomingEdgeIds: [],
              outgoingEdgeIds: ['edge_1'],
              confidence: 0.6,
              elevations: [],
              annotationIds: [],
            },
          ],
        ]),
        edges: [
          {
            id: 'edge_1',
            fromNodeId: 'node_1',
            toNodeId: 'node_missing',
            polyline: [{ x: 100, y: 100 }, { x: 200, y: 100 }],
            drawnLengthPt: 100,
            drawnLengthMeters: 20,
            system: 'STORM',
            strokeStyle: { lineWidth: 2, dashArray: [] },
            confidence: 0.6,
          },
        ],
        scaleRatio: 5.0,
        stats: { nodeCount: 1, edgeCount: 1, stormEdgeCount: 1, sanitaryEdgeCount: 0, watermainEdgeCount: 0 },
      },
      nodes: new Map([
        [
          'node_1',
          {
            id: 'node_1',
            symbolCandidateId: 'sym_1',
            centroid: { x: 100, y: 100 },
            symbolType: 'MH',
            bbox: [90, 90, 110, 110],
            incomingEdgeIds: [],
            outgoingEdgeIds: ['edge_1'],
            confidence: 0.6,
            elevations: [],
            annotationIds: [],
          },
        ],
      ]),
      edges: [
        {
          id: 'edge_1',
          fromNodeId: 'node_1',
          toNodeId: 'node_missing',
          polyline: [{ x: 100, y: 100 }, { x: 200, y: 100 }],
          drawnLengthPt: 100,
          drawnLengthMeters: 20,
          system: 'STORM',
          strokeStyle: { lineWidth: 2, dashArray: [] },
          confidence: 0.6,
          annotationIds: [],
        },
      ],
      unboundAnnotations: [],
      stats: { totalAnnotations: 0, boundToNodes: 0, boundToEdges: 0, unbound: 0 },
    };

    const mockValidation = {
      score: 0.7,
      violations: [
        {
          invariant: 'ENDPOINT_COMPLETENESS' as const,
          entityId: 'edge_1',
          entityType: 'edge' as const,
          description: 'Edge edge_1 missing terminal node',
          severity: 'error' as const,
          location: [150, 100] as [number, number],
        },
      ],
      validEntities: {
        projectName: 'Test',
        jobNumber: '',
        date: '2026-09-01',
        structures: [],
        catchbasins: [],
        sewers: [],
        watermain: [],
        watermainSpecials: [],
        watermainValves: [],
        confidence: 0.7,
        warnings: [],
      },
    };

    const queries = buildVerificationQueries(mockValidation, mockBound);
    expect(queries.length).toBe(1);
    expect(queries[0].type).toBe('MISSING_TERMINAL');
    expect(queries[0].entityId).toBe('edge_1');

    const updated = applyVerificationAnswers(mockBound, [
      {
        queryId: queries[0].id,
        entityId: 'edge_1',
        verifiedValue: 'STMH 1-STMH 2',
        confidence: 0.95,
      },
    ]);

    expect(updated.edges[0].boundRunLabel).toBe('STMH 1-STMH 2');
    expect(updated.edges[0].confidence).toBe(0.95);
  });
});
