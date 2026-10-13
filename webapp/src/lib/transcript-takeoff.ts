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
  parseScheduleRunRow,
  structureDescription, chamberWarning, HASH_STRUCTURE_HEADER_RE,
  isDanglingRunHead, isRunContinuation, ParsedStructure, ParsedRun,
} from './callout-parser';
import { reconcileTakeoff } from './reconcile';
import { withConfidence } from './confidence';
import { appendCoverageWarnings } from './coverage-checks';
import { normalizeLabel } from './compare-facts';
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact, CatchbasinGroupFact, TileTranscript, FactSource, WithheldItem } from './types';

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
  /** Provenance of the first label seen per CB type — the group's source. */
  catchbasinFirstSource: Map<CatchbasinGroupFact['type'], FactSource>;
  sewers: SewerFact[];
  watermain: WatermainFact[];
  /** Values the transcripts never stated (see WithheldItem in types.ts). */
  withheld: WithheldItem[];
  /**
   * Coverage bookkeeping (see coverageWarningsFor): every structure/CB label
   * the grammar can see in the transcripts, keyed by normalized label with
   * the raw label kept for display, and the labels seen only as EXISTING
   * (intentionally excluded from the takeoff, so never "missing").
   */
  mentionedStructures: Map<string, string>;
  mentionedCatchbasins: Map<CatchbasinGroupFact['type'], Map<string, string>>;
  mentionedExisting: Set<string>;
}

/**
 * Record a line (or schedule-row cell) the grammar recognises as a structure
 * label, for the coverage check. Runs on exactly the lines the assembler
 * itself processes (post repetition-filter, post line-join), so "mentioned"
 * means "the assembler had this label in front of it".
 */
function noteMention(sink: Sink, line: string): void {
  const parsed = parseStructureLabel(line);
  if (!parsed) return;
  const norm = normalizeLabel(parsed.label);
  if (!norm) return;
  if (parsed.existing) {
    sink.mentionedExisting.add(norm);
    return;
  }
  const cbType = cbKindType(parsed.kind);
  if (cbType) {
    const byLabel = sink.mentionedCatchbasins.get(cbType) ?? new Map<string, string>();
    if (!byLabel.has(norm)) byLabel.set(norm, parsed.label);
    sink.mentionedCatchbasins.set(cbType, byLabel);
  } else if (!sink.mentionedStructures.has(norm)) {
    sink.mentionedStructures.set(norm, parsed.label);
  }
}

const rawList = (labels: string[], cap = 8): string =>
  labels.slice(0, cap).join(', ') + (labels.length > cap ? `, … (+${labels.length - cap} more)` : '');

/**
 * Assembly-level partial-miss warnings (the facts-level endpoint rule lives
 * in coverage-checks.ts). Two signals, both computed against the assembler's
 * own sink — NOT the reconciled facts — so deliberate downstream removals
 * (reconcile's junk filters, the phase-suffix collapse, the catchbasin
 * ceiling) never masquerade as assembly losses; those carry their own
 * warnings already.
 *
 *  - Mentioned but not assembled: a label the transcripts contain that never
 *    reached the sink. Today this is how schedule-carried structures and
 *    mis-routed block headers vanish without a trace.
 *  - Empty assembly: transcripts came back but produced no takeoff at all —
 *    the takeoff is missing, not empty, and must not read as a clean zero.
 */
export function coverageWarningsFor(
  transcripts: TileTranscript[],
  sink: Sink,
  assembled: TakeoffFacts
): string[] {
  const warnings: string[] = [];

  const assembledStructures = new Set(sink.structures.map((s) => normalizeLabel(s.description)));
  const lostStructures = [...sink.mentionedStructures.entries()]
    .filter(([norm]) => !assembledStructures.has(norm) && !sink.mentionedExisting.has(norm))
    .map(([, raw]) => raw);
  if (lostStructures.length > 0) {
    warnings.push(
      `Coverage: ${lostStructures.length} structure label(s) appear in the tile transcripts but are not in this takeoff ` +
        `(${rawList(lostStructures)}). They may sit in schedules or tables outside the takeoff's scope, or their callout ` +
        `blocks could not be assembled — verify them against the drawings.`
    );
  }

  for (const [type, mentioned] of sink.mentionedCatchbasins) {
    const recorded = sink.catchbasinLabels.get(type) ?? new Set<string>();
    const lost = [...mentioned.entries()]
      .filter(([norm]) => !recorded.has(norm) && !sink.mentionedExisting.has(norm))
      .map(([, raw]) => raw);
    if (lost.length > 0) {
      warnings.push(
        `Coverage: ${lost.length} ${type} label(s) appear in the tile transcripts but were not counted in the ` +
          `catchbasin groups (${rawList(lost)}). They may sit in schedules or tables outside the takeoff's scope, ` +
          `or their callout blocks could not be assembled — verify the catchbasin count against the drawings.`
      );
    }
  }

  const entityCount =
    assembled.structures.length + assembled.sewers.length + assembled.watermain.length +
    assembled.catchbasins.length;
  if (transcripts.length > 0 && entityCount === 0) {
    const tiles = transcripts.length;
    const blocks = transcripts.reduce((n, t) => n + (t.blocks?.length ?? 0), 0);
    warnings.push(
      `Coverage: the transcription returned ${tiles} tile(s) / ${blocks} block(s) but nothing could be assembled ` +
        `into a takeoff. The located pages may not carry the servicing drawings, or their callouts use a form the ` +
        `assembler cannot read — treat this takeoff as missing, not as an empty project.`
    );
  }

  return warnings;
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
const STANDALONE_SIZE_RE = /^\s*\(?\s*(\d{3,4})\s*(?:MM)?\s*[ØO]\s*\)?\s*$/i;

function processLines(lines: string[], out: Sink, warnings: string[], tile: number): boolean {
  const structureLine = lines.find((l) => parseStructureLabel(l));
  if (structureLine) {
    const parsed = parseStructureLabel(structureLine)!;
    if (parsed.existing) return true; // recognized, intentionally excluded

    let topElevation: number | null = null;
    let diameterMm = parsed.diameterMm;
    const inverts: number[] = [];
    for (const line of lines) {
      if (line === structureLine) continue;
      // The size is often wrapped onto its own line: "PROP STM MH 100 / (2400 mmØ) / ...".
      const size = STANDALONE_SIZE_RE.exec(line);
      if (size) {
        diameterMm ??= parseInt(size[1], 10);
        continue;
      }
      const e = parseElevation(line);
      if (!e) {
        warnings.push(`Unrecognized line in structure block: "${line}"`);
        continue;
      }
      if (e.type === 'TG') {
        // A second rim means the vision step merged the NEXT structure's callout into this
        // block (460 Bayly: MH 9's 88.09 followed by MH 200's 86.78). Its lines are not this
        // structure's — taking them made a 2400mm MH 1.76m deep and #N/A in the workbook.
        if (topElevation !== null) {
          warnings.push(`Structure block for ${parsed.label} holds a second rim (${e.value}); later lines ignored: "${lines.slice(lines.indexOf(line)).join(' / ')}"`);
          break;
        }
        topElevation = e.value;
      } else inverts.push(e.value);
    }

    const cbType = cbKindType(parsed.kind);
    if (cbType) {
      const labels = out.catchbasinLabels.get(cbType) ?? new Set<string>();
      labels.add(normalizeLabel(parsed.label));
      out.catchbasinLabels.set(cbType, labels);
      if (!out.catchbasinFirstSource.has(cbType)) {
        out.catchbasinFirstSource.set(cbType, { method: 'transcript', tile, evidence: structureLine });
      }
    } else {
      out.structures.push({
        description: structureDescription(parsed),
        topElevation,
        lowInvert: inverts.length ? Math.min(...inverts) : null,
        highInvert: inverts.length >= 2 ? Math.max(...inverts) : null,
        pipeOutDiameter: null,
        structureType: parsed.kind === 'CHAMBER' ? 'CHAMBER' : null,
        depth: null,
        diameter: diameterMm,
        source: { method: 'transcript', tile, evidence: structureLine },
      });
      if (parsed.kind === 'CHAMBER') warnings.push(chamberWarning(parsed.label, lines));
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
          source: { method: 'transcript', tile, evidence: line },
        });
      }
      continue;
    }
    const wm = parseWatermainCallout(line);
    if (wm) {
      matched = true;
      // Emit even with no stated length. Most drawings label the main
      // ("200mmØ PVC WATERMAIN") and leave the length implied by the drawn
      // line, so requiring a length dropped the pipe entirely — scoring a
      // correct read as a miss. Detection and measurement are separate
      // failures; matchWatermain phase 3 pairs on diameter alone, and
      // reconcileTakeoff sums the sizes, so an unmeasured callout that sits
      // alongside a measured one of the same diameter contributes nothing.
      // Same rule as assembleTextTakeoff — keep the two assemblers in step.
      // ocSc/avgCover are NOT stamped here either: unstated means null, and
      // the estimator defaults are applied — and recorded as withheld — at
      // pricing (costing-rules.ts).
      if (!wm.existing) {
        const sizeAndType = `${wm.diameterMm}mm${wm.material ? ` ${wm.material}` : ''}`;
        out.watermain.push({
          sizeAndType,
          length: wm.lengthM ?? 0,
          pipeDiameter: wm.diameterMm,
          ocSc: null,
          avgCover: null,
          source: { method: 'transcript', tile, evidence: line },
        });
        if (wm.lengthM == null) {
          out.withheld.push({
            entity: sizeAndType,
            field: 'length',
            kind: 'withheld',
            question: `Length of the ${sizeAndType} watermain is not stated on the drawing — scale it off the plan. Left blank and not priced.`,
            defaultApplied: null,
          });
        }
      }
    }
  }
  return matched;
}

export function assembleTranscriptTakeoff(transcripts: TileTranscript[], projectName: string): TakeoffFacts {
  const out: Sink = {
    structures: [],
    catchbasinLabels: new Map(),
    catchbasinFirstSource: new Map(),
    sewers: [],
    watermain: [],
    withheld: [],
    mentionedStructures: new Map(),
    mentionedCatchbasins: new Map(),
    mentionedExisting: new Set(),
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

      // Coverage bookkeeping: every label the grammar can see in this block,
      // including schedule-row cells the assembly deliberately does not
      // harvest (the "#" header filter below) — a mention that never reaches
      // the sink is surfaced by coverageWarningsFor, not silently lost.
      for (const line of joined) {
        noteMention(out, line);
        if (line.includes(' | ')) {
          for (const cell of line.split(' | ')) noteMention(out, cell.trim());
        }
      }

      // Step 4: schedule-table rows (contain " | "). A row that parses whole
      // as a run schedule (parseScheduleRunRow) is harvested as one run;
      // every other row is split on the delimiter and each cell tried against
      // the parsers, independent of the rest of the block. An
      // all-cells-unparseable row is logged, never guessed.
      // One exclusion: a header cell in the "#" dialect ("STMH #1") is NOT
      // admitted from a schedule row. Callout blocks in that dialect are the
      // block grammar's business, but a structure schedule's numbering runs
      // past the takeoff's scope (Ultimate Drive: STMH #1..#24 scheduled,
      // 13 taken off) — harvesting schedule structures is the schedule-table
      // work's call, with its own scope rules. Dropping the cell reproduces
      // the row's pre-"#"-grammar fate: its other cells are still tried, and
      // if nothing parses the row is logged below.
      const remaining: string[] = [];
      for (const line of joined) {
        if (line.includes(' | ')) {
          const rawCells = line.split(' | ').map((c) => c.trim());
          // Run-schedule rows first: a row shaped (id | length | diameter |
          // material | slope) is ONE pipe whose fields live in separate
          // cells. Split apart below, no cell parses alone and the run is
          // lost — the schedule never fires. The row parser is strict about
          // the shape (see parseScheduleRunRow); anything it refuses falls
          // through to the per-cell reading unchanged. The harvested run
          // keeps its schedule id as its label: the id is its identity,
          // which reconcile's stitching honours (distinct ids never merge,
          // however identical their attributes).
          const sched = parseScheduleRunRow(rawCells);
          if (sched) {
            out.sewers.push({
              runLabel: sched.id,
              isLineItem: false,
              length: sched.length,
              pipeDiameter: sched.diameterMm,
              typeClass: null,
              slope: sched.slopePct,
              depth: null,
              source: { method: 'schedule', tile: tile.tile, evidence: line },
            });
            continue;
          }
          const cells = rawCells
            .filter((c) => !HASH_STRUCTURE_HEADER_RE.test(c));
          const matched = processLines(cells, out, warnings, tile.tile);
          if (!matched) warnings.push(`Unparseable schedule row: "${line}"`);
        } else {
          remaining.push(line);
        }
      }
      if (remaining.length > 0) processLines(remaining, out, warnings, tile.tile);
    }
  }

  const catchbasins: CatchbasinGroupFact[] = Array.from(out.catchbasinLabels.entries()).map(([type, labels]) => ({
    type, quantity: labels.size, wallThickness: null, depth: null,
    source: out.catchbasinFirstSource.get(type),
  }));

  // Step 5: cross-tile duplicates (10% tile overlap) die here — structures by
  // label, runs by the exact-signature/dual-label rules.
  const reconciled = reconcileTakeoff({
    projectName, jobNumber: '', date: '',
    structures: out.structures, catchbasins, sewers: out.sewers, watermain: out.watermain,
    watermainSpecials: [], watermainValves: [],
    confidence: 1, warnings, withheld: out.withheld,
  });

  // Step 6: partial-miss surfacing — purely additive warnings (assembly-level
  // here, facts-level from coverage-checks.ts). No fact is created, altered
  // or removed: an incomplete takeoff must SAY it is incomplete.
  const coverage = coverageWarningsFor(transcripts, out, reconciled);
  // Confidence is assessed LAST, from the final facts' own signals
  // (provenance coverage, withheld questions, and the coverage warnings
  // appended above) — never the constant the reconciler was handed.
  // See confidence.ts.
  return withConfidence(appendCoverageWarnings({
    ...reconciled,
    warnings: [...reconciled.warnings, ...coverage],
  }));
}
