/**
 * Deterministic spatial assembly of the PDF text layer into TakeoffFacts.
 * Composes Task 1 (pdf-text.ts positions) + Task 2 (callout-parser.ts grammar)
 * + Task 3 (reconcile.ts dedup) — no LLM, no vision, zero cost. See pdf-text.ts
 * for when this path is viable (isTextyPage) vs falling back to vision.
 */
import { PageText, PositionedText } from './pdf-text';
import {
  parseRunCallout, parseStructureLabel, parseElevation, parseWatermainCallout,
  isDanglingRunHead, isRunContinuation, parseSubdrainCallout, ParsedStructure,
  structureDescription, chamberWarning,
} from './callout-parser';
import { reconcileTakeoff } from './reconcile';
import { withConfidence } from './confidence';
import { appendPhysicsWarnings } from './physics-checks';
import { normalizeLabel } from './compare-facts';
import { detectTables, tableToSewers } from './schedule-table';
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact, CatchbasinGroupFact, FactSource, WithheldItem } from './types';

interface Line { text: string; x: number; y: number; }

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

function cbKindType(kind: ParsedStructure['kind']): CatchbasinGroupFact['type'] | null {
  switch (kind) {
    case 'CB': return 'SINGLE_CB';
    case 'DCB': return 'DOUBLE_CB';
    case 'DICB': return 'DITCH_INLET_CB';
    case 'DDICB': return 'DOUBLE_DITCH_INLET_CB';
    default: return null;
  }
}

// Step 1: merge split callouts. A dangling run head ("45.0m - 250mmØ") is joined
// with its nearest unconsumed continuation ("PVC STM @ 0.50%") within 40pt.
function mergeLines(items: PositionedText[]): Line[] {
  const consumed = new Set<number>();
  const lines: Line[] = [];
  for (let i = 0; i < items.length; i++) {
    if (consumed.has(i)) continue;
    const head = items[i];
    if (isDanglingRunHead(head.text)) {
      let bestJ = -1, bestD = Infinity;
      for (let j = 0; j < items.length; j++) {
        if (j === i || consumed.has(j) || !isRunContinuation(items[j].text)) continue;
        const d = dist(head, items[j]);
        if (d <= 40 && d < bestD) { bestD = d; bestJ = j; }
      }
      if (bestJ !== -1) {
        consumed.add(i); consumed.add(bestJ);
        lines.push({ text: `${head.text} ${items[bestJ].text}`, x: head.x, y: head.y });
        continue;
      }
    }
    consumed.add(i);
    lines.push({ text: head.text, x: head.x, y: head.y });
  }
  return lines;
}

export function assembleTextTakeoff(pages: PageText[], projectName: string): TakeoffFacts {
  const structures: StructureFact[] = [];
  const warnings: string[] = [];
  const withheld: WithheldItem[] = [];
  const catchbasinLabels = new Map<CatchbasinGroupFact['type'], Set<string>>();
  const catchbasinSource = new Map<CatchbasinGroupFact['type'], FactSource>();
  const sewers: SewerFact[] = [];
  const watermain: WatermainFact[] = [];

  for (const page of pages) {
    // Schedule tables first: an endpoint-labelled schedule row is strictly better
    // evidence than the same pipe's dimension callout, and reconcile.ts prefers it.
    for (const table of detectTables(page)) sewers.push(...tableToSewers(table, page.page));

    const lines = mergeLines(page.items);

    // Step 2: classify each merged line. Step 4 (filter existing) is applied inline.
    const liveStructures: { parsed: ParsedStructure; x: number; y: number; topElevation: number | null; inverts: number[]; evidence: string }[] = [];
    const elevations: { type: 'TG' | 'INV'; value: number; x: number; y: number }[] = [];

    for (const line of lines) {
      const run = parseRunCallout(line.text);
      if (run) {
        if (!run.existing) {
          sewers.push({
            runLabel: `${run.length}m-${run.diameterMm}mm${run.system === 'SAN' ? ' SAN' : run.system === 'STORM' ? ' STM' : ''}`,
            isLineItem: false,
            length: run.length,
            pipeDiameter: run.diameterMm,
            typeClass: run.typeClass,
            slope: run.slopePct,
            depth: null,
            source: { method: 'text-layer', page: page.page, evidence: line.text },
          });
        }
        continue;
      }
      const subdrain = parseSubdrainCallout(line.text);
      if (subdrain) {
        if (!subdrain.existing) {
          sewers.push({
            runLabel: 'SUBDRAIN',
            isLineItem: false,
            length: subdrain.length,
            pipeDiameter: subdrain.diameterMm,
            typeClass: null,
            slope: null,
            depth: null,
            source: { method: 'text-layer', page: page.page, evidence: line.text },
          });
        }
        continue;
      }
      const structure = parseStructureLabel(line.text);
      if (structure) {
        if (!structure.existing) {
          liveStructures.push({ parsed: structure, x: line.x, y: line.y, topElevation: null, inverts: [], evidence: line.text });
        }
        continue;
      }
      const elevation = parseElevation(line.text);
      if (elevation) {
        elevations.push({ type: elevation.type, value: elevation.value, x: line.x, y: line.y });
        continue;
      }
      const wm = parseWatermainCallout(line.text);
      if (wm && !wm.existing) {
        // Emit even with no stated length. Most drawings label the main
        // ("200mmØ PVC WATERMAIN") and leave the length implied by the drawn
        // line, so requiring a length dropped the pipe entirely — scoring a
        // correct read as a miss. Detection and measurement are separate
        // failures; matchWatermain phase 3 pairs on diameter alone.
        // ocSc/avgCover are NOT stamped here: the callout never states them,
        // so the fact says null (unstated) and the estimator defaults are
        // applied — and recorded as withheld — at pricing (costing-rules.ts).
        const sizeAndType = `${wm.diameterMm}mm${wm.material ? ` ${wm.material}` : ''}`;
        watermain.push({
          sizeAndType,
          length: wm.lengthM ?? 0,
          pipeDiameter: wm.diameterMm,
          ocSc: null,
          avgCover: null,
          source: { method: 'text-layer', page: page.page, evidence: line.text },
        });
        if (wm.lengthM == null) {
          withheld.push({
            entity: sizeAndType,
            field: 'length',
            kind: 'withheld',
            question: `Length of the ${sizeAndType} watermain is not stated on the drawing — scale it off the plan. Left blank and not priced.`,
            defaultApplied: null,
          });
        }
      }
    }

    // Step 3: attach each elevation to the nearest live structure within 100pt.
    for (const e of elevations) {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < liveStructures.length; i++) {
        const d = dist(e, liveStructures[i]);
        if (d <= 100 && d < bestD) { bestD = d; best = i; }
      }
      if (best === -1) continue;
      if (e.type === 'TG') liveStructures[best].topElevation = e.value;
      else liveStructures[best].inverts.push(e.value);
    }

    // Step 5: CB/DCB/DICB/DDICB become catchbasin group counts; the rest are structures.
    for (const s of liveStructures) {
      const cbType = cbKindType(s.parsed.kind);
      if (cbType) {
        const labels = catchbasinLabels.get(cbType) ?? new Set<string>();
        labels.add(normalizeLabel(s.parsed.label));
        catchbasinLabels.set(cbType, labels);
        if (!catchbasinSource.has(cbType)) {
          catchbasinSource.set(cbType, { method: 'text-layer', page: page.page, evidence: s.evidence });
        }
      } else {
        structures.push({
          description: structureDescription(s.parsed),
          topElevation: s.topElevation,
          lowInvert: s.inverts.length ? Math.min(...s.inverts) : null,
          highInvert: s.inverts.length >= 2 ? Math.max(...s.inverts) : null,
          pipeOutDiameter: null,
          structureType: s.parsed.kind === 'CHAMBER' ? 'CHAMBER' : null,
          depth: null,
          diameter: s.parsed.diameterMm,
          source: { method: 'text-layer', page: page.page, evidence: s.evidence },
        });
        if (s.parsed.kind === 'CHAMBER') warnings.push(chamberWarning(s.parsed.label, []));
      }
    }
  }

  const catchbasins: CatchbasinGroupFact[] = Array.from(catchbasinLabels.entries()).map(([type, labels]) => ({
    type, quantity: labels.size, wallThickness: null, depth: null,
    source: catchbasinSource.get(type),
  }));

  // Step 8 — confidence is assessed from the reconciled facts' own signals
  // (provenance coverage, withheld questions, coverage warnings), never a
  // constant: the `confidence: 1` below is a placeholder withConfidence
  // immediately replaces. See confidence.ts. Physics notes
  // (physics-checks.ts) are appended after the assessment: they are not
  // confidence signals.
  return appendPhysicsWarnings(withConfidence(reconcileTakeoff({
    projectName, jobNumber: '', date: '',
    structures, catchbasins, sewers, watermain,
    watermainSpecials: [], watermainValves: [],
    confidence: 1, warnings, withheld,
  })));
}
