/**
 * Vector-Native CAD Takeoff Pipeline.
 *
 * Full CAD vector geometry and topology extraction pipeline (Phases 1-4).
 * Combines low-level vector path parsing, symbol dictionary detection,
 * topological network graphing, leader-line annotation binding, physical
 * invariant checking, schedule table extraction, and estimator convention reconciliation ($0 LLM cost).
 */
import { CadAnnotation, bindAnnotationsToNetwork } from './cad-annotations';
import { extractCadGeometry } from './cad-geometry';
import { evaluateNetworkInvariants } from './cad-invariants';
import { extractStructureSymbols } from './cad-symbols';
import { applyEstimatorConventions } from './convention-rules';
import { extractPageText, isTextyPage, PageText } from './pdf-text';
import { mergeTakeoffs, reconcileTakeoff } from './reconcile';
import { clusterShxStrokes } from './shx-cluster';
import { decodeShxClusters } from './shx-decode';
import { buildSiteNetwork, verifyCalibration } from './site-network';
import { assembleTextTakeoff } from './text-takeoff';
import { TakeoffFacts, WithheldItem } from './types';

/**
 * Extracts TakeoffFacts directly from CAD vector geometry and topology.
 */
export async function extractVectorTakeoff(
  pdfBuffer: Buffer | Uint8Array,
  pages?: number[],
  projectName: string = 'Vector Takeoff'
): Promise<TakeoffFacts> {
  const nodeBuf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  const allPageTexts = await extractPageText(nodeBuf.slice(0), pages);
  const pageNumbers =
    pages && pages.length > 0
      ? pages
      : allPageTexts.map((p) => p.page);

  const pageFacts: TakeoffFacts[] = [];

  for (const pageNum of pageNumbers) {
    const pageText = allPageTexts.find((p) => p.page === pageNum);
    const geometry = await extractCadGeometry(nodeBuf.slice(0), pageNum);

    // 1. If page is texty, extract exact text layer + schedule tables
    let textFacts: TakeoffFacts | null = null;
    if (pageText && isTextyPage(pageText)) {
      textFacts = assembleTextTakeoff([pageText], projectName);
    }

    // 2. Extract text annotations from PDF text layer
    const annotations: CadAnnotation[] = [];
    if (pageText) {
      for (let idx = 0; idx < pageText.items.length; idx++) {
        const it = pageText.items[idx];
        annotations.push({
          id: `txt_${pageNum}_${idx + 1}`,
          text: it.text,
          bbox: [it.x, it.y, it.x + it.width, it.y + it.height],
          position: { x: it.x + it.width / 2, y: it.y + it.height / 2 },
          source: 'text-layer',
          confidence: 1.0,
        });
      }
    }

    // 3. Extract SHX vector stroke annotations
    const shxClusters = clusterShxStrokes(geometry);
    if (shxClusters.length > 0) {
      const shxAnnotations = decodeShxClusters(shxClusters);
      annotations.push(...shxAnnotations);
    }

    // 4. Extract structure symbols (Legend matching -> geometric fallback)
    const symbols = extractStructureSymbols(geometry, pageText);

    // 5. Build topological SiteNetwork graph
    const network = buildSiteNetwork(geometry, symbols, undefined, pageText);

    // 6. Bind annotations to structures and pipes via leader lines & proximity
    const boundNetwork = bindAnnotationsToNetwork(network, annotations, geometry);

    // 6b. Scale calibration: verify the detected note (if any) against the
    // stated callout lengths bound to this sheet's runs. Agreement promotes
    // the record to 'stated'; a flat contradiction is warned, never silently
    // overwritten. No calibration at all is withheld as a question below.
    let calibration = network.calibration;
    const scaleWarnings: string[] = [];
    if (calibration && calibration.source === 'detected') {
      const samples = boundNetwork.edges
        .filter((e) => e.calloutLengthMeters != null)
        .map((e) => ({ drawnLengthPt: e.drawnLengthPt, statedLengthM: e.calloutLengthMeters! }));
      const verified = verifyCalibration(calibration, samples);
      calibration = verified.calibration;
      network.calibration = calibration;
      if (verified.conflict) {
        scaleWarnings.push(
          `Sheet ${pageNum}: stated dimensions disagree with the detected scale note "${calibration.detectedText ?? ''}" by ~${Math.round((calibration.residual ?? 0) * 100)}% \u2014 drawn-geometry quantities on this sheet may be wrong (check for enlarged details).`
        );
      }
    }

    // 7. Evaluate natural network invariants (hydraulics, capacity, depth, length)
    const validation = evaluateNetworkInvariants(boundNetwork);

    // 8. Apply estimator conventions (rounding, label normalization, grouping)
    let vectorPageFacts = applyEstimatorConventions(validation.validEntities);
    vectorPageFacts.projectName = projectName;

    // 8b. Attach the sheet's calibration record; when the sheet could not
    // be calibrated, say so explicitly (warning + withheld question) \u2014
    // drawn lengths on it were NOT converted with any default scale.
    if (calibration) {
      vectorPageFacts.calibrations = [...(vectorPageFacts.calibrations ?? []), calibration];
      if (calibration.scalePtPerM == null) {
        const candidates = calibration.candidates ?? [];
        const reason =
          calibration.source === 'ambiguous'
            ? `conflicting scale notes (${candidates.map((d) => `1:${d}`).join(', ')})`
            : 'no scale note (SCALE 1:N) found';
        scaleWarnings.push(
          `Sheet ${pageNum}: scale not determined \u2014 ${reason}; drawn geometry was not converted to metres. Only stated callout values are used.`
        );
        const withheldItem: WithheldItem = {
          entity: `Sheet ${pageNum}`,
          field: 'scale',
          kind: 'withheld',
          question: `Drawing scale for sheet ${pageNum} could not be determined (${reason}) \u2014 confirm the sheet scale. Drawn lengths on this sheet were left unmeasured rather than converted at an assumed scale.`,
          defaultApplied: null,
        };
        vectorPageFacts.withheld = [...(vectorPageFacts.withheld ?? []), withheldItem];
      }
    }
    if (scaleWarnings.length > 0) {
      vectorPageFacts.warnings = [...vectorPageFacts.warnings, ...scaleWarnings];
    }

    // 9. Merge text layer facts (primary) with vector topology facts
    if (textFacts) {
      vectorPageFacts = mergeTakeoffs(textFacts, vectorPageFacts);
    }

    pageFacts.push(vectorPageFacts);
  }

  if (pageFacts.length === 0) {
    return {
      projectName,
      jobNumber: '',
      date: new Date().toISOString().split('T')[0],
      structures: [],
      catchbasins: [],
      sewers: [],
      watermain: [],
      watermainSpecials: [],
      watermainValves: [],
      confidence: 0,
      warnings: ['No vector pages extracted.'],
    };
  }

  // Merge facts across all pages
  let merged = pageFacts[0];
  for (let i = 1; i < pageFacts.length; i++) {
    merged = mergeTakeoffs(merged, pageFacts[i]);
  }

  return reconcileTakeoff(merged);
}
