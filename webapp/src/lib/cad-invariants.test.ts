import { describe, it, expect } from 'vitest';
import { evaluateNetworkInvariants } from './cad-invariants';
import { BoundSiteNetwork } from './cad-annotations';
import { createSyntheticCadPdf } from './test-fixtures/synthetic-cad-pdf';
import { extractCadGeometry } from './cad-geometry';
import { extractStructureSymbols } from './cad-symbols';
import { buildSiteNetwork } from './site-network';
import { extractPageText } from './pdf-text';
import { bindAnnotationsToNetwork, CadAnnotation } from './cad-annotations';

describe('cad-invariants network validation', () => {
  it('evaluates a valid BoundSiteNetwork with high score and zero critical errors', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const geometry = await extractCadGeometry(pdfBytes.slice(), 1);
    const pageTexts = await extractPageText(Buffer.from(pdfBytes.slice()));
    const symbols = extractStructureSymbols(geometry, pageTexts[0]);
    const network = buildSiteNetwork(geometry, symbols, 5.0, pageTexts[0]);

    const annotations: CadAnnotation[] = pageTexts[0].items.map((it, idx) => ({
      id: `annot_${idx + 1}`,
      text: it.text,
      bbox: [it.x, it.y, it.x + it.width, it.y + it.height],
      position: { x: it.x + it.width / 2, y: it.y + it.height / 2 },
      source: 'text-layer',
      confidence: 1.0,
    }));

    const bound = bindAnnotationsToNetwork(network, annotations, geometry);
    const result = evaluateNetworkInvariants(bound);

    expect(result.score).toBeGreaterThanOrEqual(0.8);
    const errors = result.violations.filter((v) => v.severity === 'error');
    expect(errors.length).toBe(0);

    // Verify validEntities TakeoffFacts output
    expect(result.validEntities.structures.length).toBeGreaterThanOrEqual(3);
    expect(result.validEntities.catchbasins.length).toBeGreaterThanOrEqual(1);
    expect(result.validEntities.sewers.length).toBeGreaterThanOrEqual(2);
    expect(result.validEntities.watermain.length).toBeGreaterThanOrEqual(1);
  });

  it('detects Invariant 1 (Endpoint completeness) and Invariant 5 (Depth validity)', () => {
    const invalidNetwork: BoundSiteNetwork = {
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
              outgoingEdgeIds: ['edge_bad'],
              confidence: 1.0,
              rimElevation: 100.0,
              invertElevation: 102.0, // INVERT HIGHER THAN RIM -> DEPTH <= 0 ERROR!
              elevations: [],
              annotationIds: [],
            },
          ],
        ]),
        edges: [
          {
            id: 'edge_bad',
            fromNodeId: 'node_1',
            toNodeId: 'node_nonexistent', // MISSING TERMINAL NODE!
            polyline: [
              { x: 100, y: 100 },
              { x: 200, y: 100 },
            ],
            drawnLengthPt: 100,
            drawnLengthMeters: 20,
            system: 'STORM',
            strokeStyle: { lineWidth: 2, dashArray: [] },
            confidence: 1.0,
          },
        ],
        scaleRatio: 5.0,
        stats: {
          nodeCount: 1,
          edgeCount: 1,
          stormEdgeCount: 1,
          sanitaryEdgeCount: 0,
          watermainEdgeCount: 0,
        },
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
            outgoingEdgeIds: ['edge_bad'],
            confidence: 1.0,
            rimElevation: 100.0,
            invertElevation: 102.0, // Error
            elevations: [],
            annotationIds: [],
          },
        ],
      ]),
      edges: [
        {
          id: 'edge_bad',
          fromNodeId: 'node_1',
          toNodeId: 'node_nonexistent',
          polyline: [
            { x: 100, y: 100 },
            { x: 200, y: 100 },
          ],
          drawnLengthPt: 100,
          drawnLengthMeters: 20,
          system: 'STORM',
          strokeStyle: { lineWidth: 2, dashArray: [] },
          confidence: 1.0,
          annotationIds: [],
        },
      ],
      unboundAnnotations: [],
      stats: {
        totalAnnotations: 0,
        boundToNodes: 0,
        boundToEdges: 0,
        unbound: 0,
      },
    };

    const result = evaluateNetworkInvariants(invalidNetwork);
    expect(result.score).toBeLessThan(0.8);

    const endpErr = result.violations.find((v) => v.invariant === 'ENDPOINT_COMPLETENESS');
    expect(endpErr).toBeDefined();
    expect(endpErr?.severity).toBe('error');

    const depthErr = result.violations.find((v) => v.invariant === 'DEPTH_VALIDITY');
    expect(depthErr).toBeDefined();
    expect(depthErr?.severity).toBe('error');
  });

  it('detects Invariant 2 (Hydraulic drop) on adverse slope', () => {
    const adverseSlopeNetwork: BoundSiteNetwork = {
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
              confidence: 1.0,
              rimElevation: 105.0,
              invertElevation: 100.0,
              elevations: [],
              annotationIds: [],
            },
          ],
          [
            'node_2',
            {
              id: 'node_2',
              symbolCandidateId: 'sym_2',
              centroid: { x: 200, y: 100 },
              symbolType: 'MH',
              bbox: [190, 90, 210, 110],
              incomingEdgeIds: ['edge_1'],
              outgoingEdgeIds: [],
              confidence: 1.0,
              rimElevation: 105.0,
              invertElevation: 101.5, // DOWNSTREAM INVERT HIGHER THAN UPSTREAM!
              elevations: [],
              annotationIds: [],
            },
          ],
        ]),
        edges: [
          {
            id: 'edge_1',
            fromNodeId: 'node_1',
            toNodeId: 'node_2',
            polyline: [
              { x: 100, y: 100 },
              { x: 200, y: 100 },
            ],
            drawnLengthPt: 100,
            drawnLengthMeters: 20,
            system: 'STORM',
            strokeStyle: { lineWidth: 2, dashArray: [] },
            confidence: 1.0,
          },
        ],
        scaleRatio: 5.0,
        stats: {
          nodeCount: 2,
          edgeCount: 1,
          stormEdgeCount: 1,
          sanitaryEdgeCount: 0,
          watermainEdgeCount: 0,
        },
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
            confidence: 1.0,
            rimElevation: 105.0,
            invertElevation: 100.0,
            elevations: [],
            annotationIds: [],
          },
        ],
        [
          'node_2',
          {
            id: 'node_2',
            symbolCandidateId: 'sym_2',
            centroid: { x: 200, y: 100 },
            symbolType: 'MH',
            bbox: [190, 90, 210, 110],
            incomingEdgeIds: ['edge_1'],
            outgoingEdgeIds: [],
            confidence: 1.0,
            rimElevation: 105.0,
            invertElevation: 101.5,
            elevations: [],
            annotationIds: [],
          },
        ],
      ]),
      edges: [
        {
          id: 'edge_1',
          fromNodeId: 'node_1',
          toNodeId: 'node_2',
          polyline: [
            { x: 100, y: 100 },
            { x: 200, y: 100 },
          ],
          drawnLengthPt: 100,
          drawnLengthMeters: 20,
          system: 'STORM',
          strokeStyle: { lineWidth: 2, dashArray: [] },
          confidence: 1.0,
          annotationIds: [],
        },
      ],
      unboundAnnotations: [],
      stats: {
        totalAnnotations: 0,
        boundToNodes: 0,
        boundToEdges: 0,
        unbound: 0,
      },
    };

    const result = evaluateNetworkInvariants(adverseSlopeNetwork);
    const dropErr = result.violations.find((v) => v.invariant === 'HYDRAULIC_DROP');
    expect(dropErr).toBeDefined();
    expect(dropErr?.severity).toBe('error');
  });
});
