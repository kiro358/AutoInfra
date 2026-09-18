/**
 * Deterministic assembly of vision-model tile transcripts into TakeoffFacts.
 * Sibling to text-takeoff.ts (Task 4), but the input shape is already grouped
 * into visual "blocks" by the transcribing model (see modular-prompts.ts
 * getTranscriptionPrompt), so there is no spatial/distance search here — a
 * block's lines belong together by construction. Composes the same Task 2
 * (callout-parser.ts grammar) + Task 3 (reconcile.ts dedup) building blocks
 * as text-takeoff.ts; see that file for the shared conventions (runLabel
 * template, CB-kind mapping, elevation min/max rule) this file intentionally
 * mirrors rather than re-deriving.
 */
import {
  parseRunCallout, parseStructureLabel, parseElevation, parseWatermainCallout,
  isDanglingRunHead, isRunContinuation, ParsedStructure, ParsedRun,
} from './callout-parser';
import { reconcileTakeoff } from './reconcile';
import { normalizeLabel } from './compare-facts';
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact, CatchbasinGroupFact, TileTranscript } from './types';

function cbKindType(kind: ParsedStructure['kind']): CatchbasinGroupFact['type'] | null {
  switch (kind) {
    case 'CB': return 'SINGLE_CB';
    case 'DCB': return 'DOUBLE_CB';
    case 'DICB': return 'DITCH_INLET_CB';
    case 'DDICB': return 'DOUBLE_DITCH_INLET_CB';
    default: return null;
  }
}

interface Sink {
  structures: StructureFact[];
  catchbasinLabels: Map<CatchbasinGroupFact['type'], Set<string>>;
  sewers: SewerFact[];
  watermain: WatermainFact[];
}

/**
 * How many visual lines one wrapped callout may span. Crowded drawings wrap over
 * three ("15.5m - 450mm" / "PVC STM" / "@ 0.30%"); beyond that a "join" is far more
 * likely to be eating the next annotation than finishing this one.
 */
const MAX_WRAPPED_LINES = 3;
/**
 * Does folding one more continuation line in actually tell us something new? This is what
 * stops a greedy join at the end of its callout instead of swallowing the NEXT pipe's tail:
 * a second "@ 0.50%" adds no field the first one did not, because every parser regex is
 * first-match-wins.
 */
function addsDetail(before: ParsedRun, after: ParsedRun): boolean {
  return (before.slopePct === null && after.slopePct !== null)
    || (before.material === null && after.material !== null)
    || (before.typeClass === null && after.typeClass !== null)
    || (before.system === 'UNKNOWN' && after.system !== 'UNKNOWN')
    || (!before.insulated && after.insulated === true);
}
// Step 1: within a block, join a dangling run head with the continuation lines that
// follow it. Blocks carry the visual grouping already, so — unlike text-takeoff's
// cross-page nearest-neighbour search — adjacency in the array is enough.
//
// The join is greedy but only ever COMMITTED at a point where the merged text parses as a
// run, and only while each extra line adds a field (see addsDetail). A head whose
// continuations never produce a parseable run is left untouched, line by line, rather than
// emitted as a merged string the grammar cannot read.
function joinBlockLines(block: string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < block.length; i++) {
    const head = block[i];
    if (isDanglingRunHead(head)) {
      let accumulated = head;
      let accumulatedRun = parseRunCallout(accumulated);
      let bestIndex = -1;
      let bestText = '';
      for (let j = i + 1; j < block.length && j - i < MAX_WRAPPED_LINES; j++) {
        if (!isRunContinuation(block[j])) break;
        const candidate = `${accumulated} ${block[j]}`;
        const candidateRun = parseRunCallout(candidate);
        if (candidateRun === null) {
          // Merging must never destroy a parse we already had; but a diameter-first head
          // ("300mm PVC STM") does not parse until its length arrives, so keep building.
          if (accumulatedRun !== null) break;
          accumulated = candidate;
          continue;
        }
        if (accumulatedRun !== null && !addsDetail(accumulatedRun, candidateRun)) break;
        accumulated = candidate;
        accumulatedRun = candidateRun;
        bestIndex = j;
        bestText = accumulated;
      }
      if (bestIndex !== -1) {
        lines.push(bestText);
        i = bestIndex; // consume every line folded into the callout
        continue;
      }
    }
    lines.push(head);
  }
  return lines;
}

// Steps 2-3: classify a set of lines that belong together (a joined block, or
// the cells of a split schedule-table row — see step 4). If any line parses
// as a structure label, the whole set is a structure block: the remaining
// lines are tried as elevations and attach to it. Any line that is neither
// the structure label nor a parseable elevation is NOT guessed at (e.g. as a
// run/watermain callout) — it's warned about, same "never silently drop"
// policy as the unparseable-schedule-row case below. Otherwise each line is
// tried independently as a run / watermain callout. Returns whether the
// grammar made sense of ANY of the lines (used to decide whether an
// unparseable schedule row deserves a warning).
function processLines(lines: string[], out: Sink, warnings: string[]): boolean {
  const structureLine = lines.find((l) => parseStructureLabel(l));
  if (structureLine) {
    const parsed = parseStructureLabel(structureLine)!;
    if (parsed.existing) return true; // recognized, intentionally excluded

    let topElevation: number | null = null;
    const inverts: number[] = [];
    for (const line of lines) {
      if (line === structureLine) continue;
      const e = parseElevation(line);
      if (!e) {
        warnings.push(`Unrecognized line in structure block: "${line}"`);
        continue;
      }
      if (e.type === 'TG') topElevation = e.value;
      else inverts.push(e.value);
    }

    const cbType = cbKindType(parsed.kind);
    if (cbType) {
      const labels = out.catchbasinLabels.get(cbType) ?? new Set<string>();
      labels.add(normalizeLabel(parsed.label));
      out.catchbasinLabels.set(cbType, labels);
    } else {
      out.structures.push({
        description: parsed.label,
        topElevation,
        lowInvert: inverts.length ? Math.min(...inverts) : null,
        highInvert: inverts.length >= 2 ? Math.max(...inverts) : null,
        pipeOutDiameter: null,
        structureType: null,
        depth: null,
      });
    }
    return true;
  }

  let matched = false;
  for (const line of lines) {
    const run = parseRunCallout(line);
    if (run) {
      matched = true;
      if (!run.existing) {
        out.sewers.push({
          runLabel: `${run.length}m-${run.diameterMm}mm${run.system === 'SAN' ? ' SAN' : run.system === 'STORM' ? ' STM' : ''}`,
          isLineItem: false,
          length: run.length,
          pipeDiameter: run.diameterMm,
          typeClass: run.typeClass,
          slope: run.slopePct,
          depth: null,
        });
      }
      continue;
    }
    const wm = parseWatermainCallout(line);
    if (wm) {
      matched = true;
      if (!wm.existing && wm.lengthM != null) {
        out.watermain.push({
          sizeAndType: `${wm.diameterMm}mm${wm.material ? ` ${wm.material}` : ''}`,
          length: wm.lengthM,
          pipeDiameter: wm.diameterMm,
          ocSc: 1.1,
          avgCover: 1.8,
        });
      }
    }
  }
  return matched;
}

export function assembleTranscriptTakeoff(transcripts: TileTranscript[], projectName: string): TakeoffFacts {
  const out: Sink = {
    structures: [],
    catchbasinLabels: new Map(),
    sewers: [],
    watermain: [],
  };
  const warnings: string[] = [];

  for (const tile of transcripts) {
    // Tile-level sanity: filter out synthetic incrementing repeating sequences
    // (e.g. tile transcribing 80 repeating CB lines with identical T/G & inverts)
    const seenElevCount = new Map<string, number>();
    const validBlocks = tile.blocks.filter((block) => {
      const text = Array.isArray(block) ? block.join(' ') : String(block);
      const m = text.match(/T\/?G\s*=\s*\d+\.\d+.*INV\s*=\s*\d+\.\d+/i);
      if (m) {
        const key = m[0].replace(/\s+/g, '');
        const count = seenElevCount.get(key) || 0;
        if (count >= 4) return false; // Synthetic repetition loop in tile
        seenElevCount.set(key, count + 1);
      }
      return true;
    });

    for (const block of validBlocks) {
      const joined = joinBlockLines(block);

      // Step 4: schedule-table rows (contain " | ") are split on the delimiter
      // and each cell tried against the parsers, independent of the rest of
      // the block. An all-cells-unparseable row is logged, never guessed.
      const remaining: string[] = [];
      for (const line of joined) {
        if (line.includes(' | ')) {
          const cells = line.split(' | ').map((c) => c.trim());
          const matched = processLines(cells, out, warnings);
          if (!matched) warnings.push(`Unparseable schedule row: "${line}"`);
        } else {
          remaining.push(line);
        }
      }
      if (remaining.length > 0) processLines(remaining, out, warnings);
    }
  }

  const catchbasins: CatchbasinGroupFact[] = Array.from(out.catchbasinLabels.entries()).map(([type, labels]) => ({
    type, quantity: labels.size, wallThickness: null, depth: null,
  }));

  // Step 5: cross-tile duplicates (10% tile overlap) die here — structures by
  // label, runs by the exact-signature/dual-label rules.
  return reconcileTakeoff({
    projectName, jobNumber: '', date: '',
    structures: out.structures, catchbasins, sewers: out.sewers, watermain: out.watermain,
    watermainSpecials: [], watermainValves: [],
    confidence: 1, warnings,
  });
}
