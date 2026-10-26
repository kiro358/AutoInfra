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
  parseScheduleRunRow, parseComponentStructures,
  structureDescription, chamberWarning, HASH_STRUCTURE_HEADER_RE,
  isDanglingRunHead, isRunContinuation, isLengthOnlyRunHead, parseColFragJoin,
  ParsedStructure, ParsedRun, ParsedElevation,
} from './callout-parser';
import { reconcileTakeoff } from './reconcile';
import { isSpecialistDisabled } from './specialists';
import { withConfidence } from './confidence';
import { appendCoverageWarnings } from './coverage-checks';
import { appendPhysicsWarnings } from './physics-checks';
import { normalizeLabel } from './compare-facts';
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact, CatchbasinGroupFact, TileTranscript, FactSource, SpecialistFiring, WithheldItem } from './types';

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
  /** PR23: site-wide enumeration scope analysis (see analyzeEnumerationScope). */
  scope: EnumerationScope;
  /** Raw descriptions of structures skipped as enumeration-only, for the warning. */
  demotedStructures: string[];
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
  /**
   * PR42: invert lines read inside catchbasin-GROUP blocks. A group block's
   * geometry is discarded by design (groups carry counts, not elevations),
   * but the values are real reads from the drawing — kept here so the
   * fail-closed orphan adoption at the end of assembly can attribute one to
   * a structure whose own reads leave its invert null.
   */
  orphanInverts: { page: number; tile: number; line: string; value: number }[];
  /**
   * PR42: the assembler's page segmentation of the transcript stream (tile
   * numbers reset per page, so a non-increasing tile starts a new page) and
   * the page each sink structure read arrived on. Tile numbers repeat
   * across pages, so tile-scoped reasoning (the orphan adoption) must key
   * on (page, tile) — processLines records the page through currentPage,
   * and the assembly loop stamps each new read with it.
   */
  currentPage: number;
  readPages: Map<StructureFact, number>;
  /**
   * PR42: line sets handed to processLines that produced no structure read
   * at all (first line + tile kept), for the mis-transcribed-label rescue at
   * the end of assembly.
   */
  droppedStructureBlocks: { tile: number; lines: string[] }[];
  /**
   * PR47 Phase 1: specialist firing counters, composed into the
   * diagnostics record by assembleTranscriptTakeoff (see specialists.ts).
   * Counting only — no counter feeds a decision.
   */
  stats: {
    /** Detached adoptions of the value-first forms (S10's dialect). */
    valueFirstAdoptions: number;
    /** Detached adoptions of bare directional inverts (S6's M1). */
    directionalAdoptions: number;
    /** Hyphenated system-prefix reads kept as corroboration (S6's M2). */
    hyphenCorroborated: number;
    /** Length-only-head joins committed under the S4 conjunction (PR58). */
    colFragJoins: number;
  };
}

/**
 * PR23 — site-wide enumeration scope guards.
 *
 * A development-wide sheet (grading plan, site plan, structure/CB schedule)
 * enumerates EVERY numbered asset on the site; the estimator's takeoff scopes
 * one servicing contract inside it. Label-counting assembly cannot tell the
 * two apart by label alone — Panattoni's transcripts carry a hyphenated
 * catchbasin enumeration `CB-1`…`CB-805` next to the plan reads, and two
 * complete CBMH sequences (CBMH1–140 and CBMH1–159, one per drawing vintage)
 * next to the servicing network — and the unions became 806 phantom CB units
 * and ~111 phantom structures. What separates an enumeration from plan reads
 * is its SHAPE, measurable from the transcripts themselves:
 *
 *  - an enumeration is LONG and COMPLETE: dozens of same-kind labels forming
 *    a near-unbroken numeric sequence (the corpus's real ones score 140–805
 *    labels at density 1.00; the largest genuine single-tile plan cluster in
 *    the golden corpus is 32 labels at 0.73, and the largest at density ≥0.9
 *    is 15 — the bar below sits between, at 40 labels / 0.90 density);
 *  - the CB enumeration additionally speaks a different dialect: hyphenated
 *    (`CB-101`) where plan callouts are plain (`CB101`, `CB 101`). Corpus
 *    census: hyphenated CB labels occur on exactly one other project
 *    (Riocan: 4 labels, density 0.36 — scattered plan reads, far under the
 *    bar), so the dialect test alone would be safe, but the guard requires
 *    BOTH the dialect and the enumeration shape before excluding anything.
 *
 * A structure label inside an enumeration cluster is excluded ONLY when no
 * non-enumeration tile reads it — a label the plan sheets also carry keeps
 * its plan read (corroboration). That is what keeps this guard from touching
 * genuine multi-sheet networks (White Oak's two blocks, PropComm's merged
 * workbooks): their labels are read from plan callouts all over the set,
 * while an enumeration-only field is read from the enumeration and nowhere
 * else. Tile→page attribution is not stored on TileTranscript, so sheet class
 * cannot be keyed directly; the enumeration shape + corroboration tests are
 * the signals the assembler actually carries, and every exclusion is warned,
 * never silent.
 */
interface EnumerationScope {
  /** Per CB type: normalized labels forming a hyphenated enumeration. An
   *  occurrence of one of these labels is excluded only when the occurrence
   *  itself is hyphenated (see hyphenatedCbOccurrence). */
  cbLabels: Map<CatchbasinGroupFact['type'], Set<string>>;
  /** Normalized structure descriptions seen only inside enumeration clusters. */
  structureLabels: Set<string>;
}

const ENUMERATION_MIN_LABELS = 40;
const ENUMERATION_MIN_DENSITY = 0.9;
/** Hyphen between the kind token and the number in the RAW text (`CB-101`). */
const HYPHENATED_CB_FORM = /(?:DDICB|DICB|DCB|CB)\s*-\s*(\d+)/i;

function labelSequenceNumber(norm: string): number | null {
  const m = /(\d+)[A-Z]*$/.exec(norm);
  return m ? parseInt(m[1], 10) : null;
}

function sequenceDensity(nums: Iterable<number>): number {
  const set = new Set(nums);
  if (set.size === 0) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of set) {
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  return set.size / (hi - lo + 1);
}

interface LabelOccurrence {
  key: string;
  kind: ParsedStructure['kind'];
  cbType: CatchbasinGroupFact['type'] | null;
  num: number | null;
  hyphenated: boolean;
  tile: number;
}

/**
 * True when THIS occurrence of a CB label is written in the hyphenated form
 * (`CB-101`) — the raw text names this label's own number after a hyphen.
 * Exclusion is occurrence-based, never label-based: a label with both a
 * hyphenated schedule occurrence and a plain plan occurrence still counts
 * (its plan read is real evidence), so every consumer tests the occurrence
 * in front of it, not the label in the abstract.
 */
function hyphenatedCbOccurrence(text: string, parsed: ParsedStructure): boolean {
  const num = labelSequenceNumber(normalizeLabel(parsed.label));
  if (num == null) return false;
  const hm = HYPHENATED_CB_FORM.exec(text);
  return hm != null && parseInt(hm[1], 10) === num;
}

/**
 * Every structure/CB label the assembler will see, with the provenance the
 * scope tests need. Walks exactly the assembler's line stream (usable blocks,
 * joined lines, schedule-row cells minus the "#" header dialect), one
 * occurrence per line/cell. Assembly itself is block-scoped (first structure
 * line wins a block), so this can see a label assembly would not emit — it
 * feeds DETECTION only, and both detection tests err toward keeping.
 */
function collectLabelOccurrences(transcripts: TileTranscript[]): LabelOccurrence[] {
  const occ: LabelOccurrence[] = [];
  const push = (text: string, tile: number) => {
    const parsed = parseStructureLabel(text);
    if (!parsed || parsed.existing) return;
    const cbType = cbKindType(parsed.kind);
    if (cbType) {
      const key = normalizeLabel(parsed.label);
      if (!key) return;
      occ.push({
        key, kind: parsed.kind, cbType, num: labelSequenceNumber(key), tile,
        hyphenated: hyphenatedCbOccurrence(text, parsed),
      });
    } else {
      const key = normalizeLabel(structureDescription(parsed));
      if (!key) return;
      occ.push({ key, kind: parsed.kind, cbType: null, num: labelSequenceNumber(key), hyphenated: false, tile });
    }
  };
  for (const tile of transcripts) {
    for (const block of usableBlocks(tile)) {
      for (const line of joinBlockLines(block)) {
        if (line.includes(' | ')) {
          for (const cell of line.split(' | ').map((c) => c.trim())) {
            if (!HASH_STRUCTURE_HEADER_RE.test(cell)) push(cell, tile.tile);
          }
        } else {
          push(line, tile.tile);
        }
      }
    }
  }
  return occ;
}

function analyzeEnumerationScope(transcripts: TileTranscript[]): EnumerationScope {
  const occ = collectLabelOccurrences(transcripts);
  const cbLabels = new Map<CatchbasinGroupFact['type'], Set<string>>();
  const structureLabels = new Set<string>();

  // (a) CB: hyphenated labels of one type forming a long, near-complete
  // numeric sequence are a site-wide enumeration, not plan reads.
  const hyphByType = new Map<CatchbasinGroupFact['type'], Map<string, number>>();
  for (const o of occ) {
    if (!o.cbType || !o.hyphenated || o.num == null) continue;
    const byKey = hyphByType.get(o.cbType) ?? new Map<string, number>();
    byKey.set(o.key, o.num);
    hyphByType.set(o.cbType, byKey);
  }
  for (const [type, byKey] of hyphByType) {
    if (byKey.size >= ENUMERATION_MIN_LABELS && sequenceDensity(byKey.values()) >= ENUMERATION_MIN_DENSITY) {
      cbLabels.set(type, new Set(byKey.keys()));
    }
  }

  // (b) Structures: a single tile carrying one kind as a long, near-complete
  // numeric sequence is an enumeration table. Its labels are out of scope
  // only when no non-enumeration tile reads them (corroboration).
  const byTileKind = new Map<string, Map<string, number | null>>();
  for (const o of occ) {
    if (o.cbType) continue;
    const k = `${o.tile}|${o.kind}`;
    const labels = byTileKind.get(k) ?? new Map<string, number | null>();
    if (!labels.has(o.key)) labels.set(o.key, o.num);
    byTileKind.set(k, labels);
  }
  const firing = new Set<string>();
  const candidates = new Set<string>();
  for (const [k, labels] of byTileKind) {
    const nums = [...labels.values()].filter((n): n is number => n != null);
    if (nums.length >= ENUMERATION_MIN_LABELS && sequenceDensity(nums) >= ENUMERATION_MIN_DENSITY) {
      firing.add(k);
      for (const [key, num] of labels) if (num != null) candidates.add(key);
    }
  }
  if (candidates.size > 0) {
    const corroborated = new Set<string>();
    for (const o of occ) {
      if (o.cbType || !candidates.has(o.key)) continue;
      if (!firing.has(`${o.tile}|${o.kind}`)) corroborated.add(o.key);
    }
    for (const key of candidates) {
      if (!corroborated.has(key)) structureLabels.add(key);
    }
  }

  return { cbLabels, structureLabels };
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
    // Enumeration occurrences are accounted for by the scope warning, not by
    // the coverage check — they were deliberately not counted, not lost. A
    // plain occurrence of the same label mentions (and counts) as usual.
    if (sink.scope.cbLabels.get(cbType)?.has(norm) && hyphenatedCbOccurrence(line, parsed)) return;
    const byLabel = sink.mentionedCatchbasins.get(cbType) ?? new Map<string, string>();
    if (!byLabel.has(norm)) byLabel.set(norm, parsed.label);
    sink.mentionedCatchbasins.set(cbType, byLabel);
  } else {
    if (sink.scope.structureLabels.has(normalizeLabel(structureDescription(parsed)))) return;
    if (!sink.mentionedStructures.has(norm)) {
      sink.mentionedStructures.set(norm, parsed.label);
    }
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
function joinBlockLines(
  block: string[],
  colFragEnabled = false,
  onColFragJoin?: () => void,
): string[] {
  const lines: string[] = [];
  for (let i = 0; i < block.length; i++) {
    const head = block[i];
    if (isDanglingRunHead(head, { colFrag: colFragEnabled })) {
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
        // S4 COL-FRAG (PR58): a length-only head commits ONLY through
        // parseColFragJoin's fail-closed conjunction (diameter on the
        // first folded line, a complete not-existing parse WITH slope,
        // joined text fully consumed by callout vocabulary). A greedy
        // fold that fails the conjunction leaves every line untouched.
        if (isLengthOnlyRunHead(head) && !parseColFragJoin(head, block[i + 1], bestText)) {
          lines.push(head);
          continue;
        }
        if (isLengthOnlyRunHead(head)) onColFragJoin?.();
        lines.push(bestText);
        i = bestIndex; // consume every line folded into the callout
        continue;
      }
    }
    lines.push(head);
  }
  return lines;
}

// PR39: detached elevation dialects inside a structure block. The 3.x
// transcription models write a callout's geometry VALUE-FIRST — the rim as
// "277.09 T/G" / "276.75T/G", the inverts as bare numbers ("275.64") — where
// the 2.5-era transcripts wrote keyword-first lines ("LID 277.09",
// "N INV. 275.64") that parseElevation reads. parseElevation is whole-line
// keyword-first by design (it is shared with the text layer, where a bare
// number is never an elevation), so those lines orphaned here, the structure
// assembled field-empty, and reconcile's phase-suffix collapse folded it
// into its base (live, Uxbridge: "MH1A → MH1", the structure lost). Inside a
// structure block the contract is already "every non-label line is this
// structure's geometry", so the value-first forms are read HERE, at the
// block seam only — the shared grammar is untouched.
//
// Guards, all fail-closed (an unadopted line warns exactly as before):
//  - OPSD standard-drawing numbers ("701.010", "401.010") are catalogue
//    references, never elevations — the frozen corpus orphans them bare.
//  - Values under 50 are dimensions/chainages ("21.00"), not site grades.
//  - A bare number classifies as the rim only when the block has no rim
//    yet and (it is parenthesised — the "(277.13)" rim convention — or no
//    invert has been read either: every frozen callout reads rim-first);
//    otherwise it is an invert.
const VALUE_FIRST_TG_RE = /^\(?\s*(\d{2,3}(?:\.\d{1,3})?)\s*\)?\s*(?:T\/G|T\.G\.?|TG)\s*$/i;
const BARE_ELEVATION_RE = /^\(?\s*(\d{2,3}\.\d{1,3})\s*\)?$/;
const OPSD_DRAWING_NUMBER_RE = /^\d{3}\.0\d{2}$/;
// PR42: a compass point followed by a bare value and nothing else ("NE
// 258.30") is a directional invert whose INV keyword was dropped in
// transcription. Every directional form in the keyword grammar is an invert
// form — rims are never stated as a bare direction + value (they carry T/G,
// TOP or RIM) — so the classification is safe inside a structure block.
const BARE_DIRECTIONAL_ELEVATION_RE = /^\s*(NE|NW|SE|SW|N|S|E|W)\s+(\d{2,3}\.\d{1,3})\s*$/;

/**
 * Which detached form a line matched (PR47 Phase 1): the value-first
 * forms are S10's dialect; the bare directional form is S6's M1. The
 * two families share this parser as a utility but gate independently —
 * `allow` lets a caller refuse one family's forms while keeping the
 * other's (a kill switch disables its specialist, not the parser).
 */
export type DetachedForm = 'value-first-tg' | 'bare' | 'directional';

function parseDetachedElevation(
  line: string,
  hasRim: boolean,
  hasInvert: boolean,
  allow: { valueFirst?: boolean; directional?: boolean } = {}
): (ParsedElevation & { form: DetachedForm }) | null {
  const t = line.trim();
  const tg = VALUE_FIRST_TG_RE.exec(t);
  if (tg) {
    if (allow.valueFirst === false) return null;
    return { type: 'TG', direction: null, value: parseFloat(tg[1]), form: 'value-first-tg' };
  }
  const dir = BARE_DIRECTIONAL_ELEVATION_RE.exec(t);
  if (dir) {
    if (allow.directional === false) return null;
    if (OPSD_DRAWING_NUMBER_RE.test(dir[2])) return null;
    const dirValue = parseFloat(dir[2]);
    if (dirValue < 50) return null;
    return { type: 'INV', direction: null, value: dirValue, form: 'directional' };
  }
  const bare = BARE_ELEVATION_RE.exec(t);
  if (!bare) return null;
  if (allow.valueFirst === false) return null;
  if (OPSD_DRAWING_NUMBER_RE.test(bare[1])) return null;
  const value = parseFloat(bare[1]);
  if (value < 50) return null;
  const parenthesised = t.startsWith('(');
  if (!hasRim && (parenthesised || !hasInvert)) return { type: 'TG', direction: null, value, form: 'bare' };
  return { type: 'INV', direction: null, value, form: 'bare' };
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
    const cbType = cbKindType(parsed.kind);
    for (const line of lines) {
      if (line === structureLine) continue;
      // The size is often wrapped onto its own line: "PROP STM MH 100 / (2400 mmØ) / ...".
      const size = STANDALONE_SIZE_RE.exec(line);
      if (size) {
        diameterMm ??= parseInt(size[1], 10);
        continue;
      }
      // PR39: a line parseElevation cannot read may still be this block's
      // geometry in the value-first dialect — adopt it before warning.
      // PR47 Phase 1: the detached forms belong to two registered
      // specialists — the value-first forms to S10, the bare directional
      // form to S6 (its M1) — and each family's kill switch refuses its
      // own forms here (see specialists.ts). With both switches unset
      // this is exactly the pre-registry behaviour.
      let e: ParsedElevation | null = parseElevation(line);
      if (!e) {
        const detached = parseDetachedElevation(line, topElevation !== null, inverts.length > 0, {
          valueFirst: !isSpecialistDisabled('S10-value-first'),
          directional: !isSpecialistDisabled('S6-detached-elevation'),
        });
        if (detached) {
          e = detached;
          if (detached.form === 'directional') out.stats.directionalAdoptions++;
          else out.stats.valueFirstAdoptions++;
        }
      }
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
      } else {
        inverts.push(e.value);
        // PR42: a catchbasin-GROUP block's inverts are about to be discarded
        // (the group records only its label). Keep them as tile-scoped
        // orphans — see the adoption pass at the end of assembly.
        if (cbType) out.orphanInverts.push({ page: out.currentPage, tile, line, value: e.value });
      }
    }

    if (cbType) {
      // PR23 scope guard: a hyphenated occurrence of an enumeration label is
      // a schedule read, not a plan read — it is not counted (the exclusion
      // is warned about at the end of assembly). A plain occurrence of the
      // same label still counts: the label was seen on a plan.
      const enumerationOccurrence =
        out.scope.cbLabels.get(cbType)?.has(normalizeLabel(parsed.label)) &&
        hyphenatedCbOccurrence(structureLine, parsed);
      if (!enumerationOccurrence) {
        const labels = out.catchbasinLabels.get(cbType) ?? new Set<string>();
        labels.add(normalizeLabel(parsed.label));
        out.catchbasinLabels.set(cbType, labels);
        if (!out.catchbasinFirstSource.has(cbType)) {
          out.catchbasinFirstSource.set(cbType, { method: 'transcript', tile, evidence: structureLine });
        }
      }
    } else {
      // PR23 scope guard: a structure read only inside a site-wide numbering
      // enumeration (never from a plan callout) is out of takeoff scope.
      const description = structureDescription(parsed);
      if (out.scope.structureLabels.has(normalizeLabel(description))) {
        out.demotedStructures.push(description);
        return true;
      }
      out.structures.push({
        description,
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
    // PR25: component structures named in the host's own callout parentheses
    // ("CBMH33 (OGS3-EF04)") are separate takeoff rows — emit them alongside
    // the host, with the host's callout as their evidence. They carry no
    // elevations of their own: the block's readings belong to the host.
    for (const component of parseComponentStructures(structureLine)) {
      out.structures.push({
        description: structureDescription(component),
        topElevation: null,
        lowInvert: null,
        highInvert: null,
        pipeOutDiameter: null,
        structureType: null,
        depth: null,
        diameter: null,
        source: { method: 'transcript', tile, evidence: structureLine },
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

/**
 * Tile-level sanity: filter out synthetic incrementing repeating sequences
 * (e.g. a tile transcribing 80 repeating CB lines with identical T/G & inverts).
 * Shared by the assembler and the enumeration scope analysis so both see the
 * same blocks.
 */
function usableBlocks(tile: TileTranscript): string[][] {
  const seenElevCount = new Map<string, number>();
  return tile.blocks.filter((block) => {
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
}

/**
 * Reconcile's merge-group key (see mergeStructureGroup in reconcile.ts):
 * the normalized label, SAN-namespaced when the description opens with a
 * sanitary marker. The PR42 passes group reads exactly the way the merge
 * will, so a preference applied here lands on the group it reasons about.
 */
function mergeGroupKey(description: string): string {
  let key = normalizeLabel(description);
  if (/^san( |itary )/.test(description.toLowerCase())) key = `SAN|${key}`;
  return key;
}

/**
 * PR42 L1b — operative-rim preference within a structure's own reads.
 *
 * A structure read once per sheet it appears on can carry CONFLICTING rims:
 * a shared/family sheet states one TOP for a whole structure family (the
 * frozen corpus's Panattoni sheets state TOP=171.25 / 171.48 for every
 * catchbasin manhole on them), while the structure's operative sheets state
 * its own. Reconcile's merge is first-wins per field, so the family value —
 * read first — silently became the structure's rim, and the derived depth
 * inherited the error (Panattoni CBMH 101: rim 171.25, depth 5.28 against a
 * typed 2.89 whose rim is 168.86). The preference fires only when the
 * operative value is UNAMBIGUOUS in the reads themselves:
 *
 *  - the group carries an invert (a derivation is at stake — a rim-only
 *    group's rim is left exactly as read);
 *  - the displaced first rim is a FAMILY value — at least three distinct
 *    structure groups in the assembly state it. A structure-specific
 *    first rim is the structure's own read, however wrong it looks, and
 *    is never displaced;
 *  - the LAST rim value differs from the first by at least 0.8 m (the
 *    corpus's validated family/operative splits are 0.82–2.39 m; every
 *    correct group whose reads merely disagree in transcription noise
 *    disagrees by at most 0.70 m);
 *  - the last value is corroborated — at least two rim-bearing reads state
 *    it. A single late read is indistinguishable from a transcription
 *    stray (the corpus carries correct groups whose lone late read is the
 *    stray), so it never moves a rim.
 *
 * When the preference fires, the first rim-bearing read's rim is rewritten
 * to the corroborated last value before the merge. Nothing else moves:
 * inverts, diameter and type keep first-wins (in the validated cases the
 * truth pairs the operative rim with the FIRST read's invert), and no value
 * is imported from another structure — the winning rim is one of the
 * structure's own reads.
 */
function applyLastRimPreference(out: Sink): number {
  let rewrites = 0;
  const groups = new Map<string, StructureFact[]>();
  for (const s of out.structures) {
    const key = mergeGroupKey(s.description);
    const reads = groups.get(key);
    if (reads) reads.push(s);
    else groups.set(key, [s]);
  }
  // Family values: rim values stated by at least three distinct structure
  // groups anywhere in this assembly — the signature of a shared sheet
  // stating one TOP for a whole family. Only a family value is ever
  // displaced; a structure-specific first rim, however wrong it looks,
  // is the structure's own read and stays.
  const valueGroups = new Map<number, Set<string>>();
  for (const [key, reads] of groups) {
    for (const r of reads) {
      if (r.topElevation === null) continue;
      const set = valueGroups.get(r.topElevation) ?? new Set<string>();
      set.add(key);
      valueGroups.set(r.topElevation, set);
    }
  }
  for (const reads of groups.values()) {
    const rimReads = reads.filter((r) => r.topElevation !== null);
    if (rimReads.length < 2) continue;
    const first = rimReads[0].topElevation!;
    const last = rimReads[rimReads.length - 1].topElevation!;
    if (first === last) continue;
    if ((valueGroups.get(first)?.size ?? 0) < 3) continue;
    if (Math.abs(last - first) < 0.8) continue;
    if (rimReads.filter((r) => r.topElevation === last).length < 2) continue;
    if (!reads.some((r) => r.lowInvert !== null)) continue;
    rimReads[0].topElevation = last;
    rewrites++;
  }
  return rewrites;
}

function compactLabelText(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Levenshtein distance ≤ 1, with the standard row-minimum early exit. */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > 1) return false;
    prev = cur;
  }
  return prev[b.length] <= 1;
}

/**
 * PR42 L1a (rescue) — geometry blocks whose label line is a one-character
 * mis-transcription of a label the assembler read cleanly elsewhere
 * ("CRMH2" for CBMH 2, "MHTA" for MH 1A, "DBMH144" for DCBMH 144) are dropped
 * whole by the block grammar: the label does not parse, so the block's
 * elevations orphan. The rescue attributes such a block to the cleanly-read
 * structure when the attribution is unambiguous:
 *
 *  - the block produced no structure read and its first line does not parse
 *    as any label (existing / catchbasin-group / scope-demoted blocks were
 *    deliberately handled and are never rescued);
 *  - the first line's compact form is within one edit of EXACTLY ONE
 *    cleanly-read label that carries a substantive read (a rim or a
 *    diameter) — when several labels sit within one edit, only a candidate
 *    whose clean reads carry the block's own stated rim survives;
 *  - the block carries at least one parseable elevation and no run or
 *    watermain callout.
 *
 * The recovered read is appended AFTER all clean reads, so reconcile's
 * first-wins merge lets it only fill fields the clean reads leave blank —
 * it can never override a direct read. A warning names the recovery and the
 * mis-transcribed label, and the read's evidence is the garbled line itself,
 * so the attribution stays distinguishable from a direct read downstream.
 */
function rescueGarbledLabelBlocks(out: Sink): string[] {
  const warnings: string[] = [];
  interface KnownLabel {
    description: string; compact: string; rims: Set<number>;
    hasRim: boolean; hasInvert: boolean;
  }
  const known = new Map<string, KnownLabel>();
  for (const s of out.structures) {
    if (s.topElevation === null && s.diameter === null) continue;
    if (!/\d/.test(compactLabelText(s.description))) continue;
    const key = mergeGroupKey(s.description);
    let k = known.get(key);
    if (!k) {
      k = {
        description: s.description, compact: compactLabelText(s.description), rims: new Set(),
        hasRim: false, hasInvert: false,
      };
      known.set(key, k);
    }
    if (s.topElevation !== null) { k.rims.add(s.topElevation); k.hasRim = true; }
    if (s.lowInvert !== null) k.hasInvert = true;
  }
  if (known.size === 0) return warnings;

  for (const block of out.droppedStructureBlocks) {
    const first = block.lines[0]?.trim();
    if (!first) continue;
    if (parseStructureLabel(first)) continue;
    // The garbled label head only: a stated size may ride on the same line
    // ("DBMH144 (1500Ø)") and is not part of the label. The garble itself
    // may have eaten the label's digit ("MH 1A" read as "MHTA"), so no
    // digit is demanded here — the one-edit test against digit-carrying
    // clean labels does the discriminating.
    const compact = compactLabelText(first.split('(')[0].trim() || first);
    if (compact.length < 3) continue;
    let top: number | null = null;
    const inverts: number[] = [];
    let usable = true;
    for (const line of block.lines.slice(1)) {
      if (parseRunCallout(line) || parseWatermainCallout(line)) { usable = false; break; }
      const e: ParsedElevation | null = parseElevation(line) ?? parseDetachedElevation(line, top !== null, inverts.length > 0);
      if (!e) continue;
      if (e.type === 'TG') { if (top === null) top = e.value; }
      else inverts.push(e.value);
    }
    if (!usable) continue;
    if (top === null && inverts.length === 0) continue;
    let candidates = [...known.values()].filter((k) => k.compact !== compact && withinOneEdit(compact, k.compact));
    if (candidates.length > 1) {
      if (top === null) continue;
      candidates = candidates.filter((k) => k.rims.has(top));
    }
    if (candidates.length !== 1) continue;
    const target = candidates[0];
    // Fill-only, in fact as well as in merge order: if the group already
    // carries both components, the garbled block has nothing to give —
    // appending it would only mint a provenance warning for a no-op.
    const fillsGap = (inverts.length > 0 && !target.hasInvert) || (top !== null && !target.hasRim);
    if (!fillsGap) continue;
    if (inverts.length > 0) target.hasInvert = true;
    if (top !== null) target.hasRim = true;
    out.structures.push({
      description: target.description,
      topElevation: top,
      lowInvert: inverts.length ? Math.min(...inverts) : null,
      highInvert: inverts.length >= 2 ? Math.max(...inverts) : null,
      pipeOutDiameter: null,
      structureType: null,
      depth: null,
      diameter: null,
      source: { method: 'transcript', tile: block.tile, evidence: first },
    });
    warnings.push(
      `Recovered geometry for ${target.description} from a mis-transcribed label block ("${first}", tile ${block.tile}): ` +
        `the block's label is one character off the structure's own label, its elevations parse cleanly, and no other ` +
        `cleanly-read label matches — the read is appended after the structure's own reads, so it only fills fields they leave blank.`
    );
  }
  return warnings;
}

/**
 * PR42 L1a (adoption) — an invert stated inside a catchbasin-GROUP callout
 * is discarded with the rest of the group's geometry (groups carry counts,
 * not elevations), even when it is the only invert read anywhere for a
 * structure sharing that tile (the frozen corpus: "INV=284.61" inside a
 * DICB callout on the same page and tile as the label-only read of the CBMH
 * whose invert it is). The adoption is fail-closed — it fires only when
 * EVERY one of these holds:
 *
 *  - the (page, tile) — tile numbers repeat across pages, so the page
 *    segment is part of the key — carries exactly ONE distinct orphan
 *    value, and that value is not already attributed to a structure read
 *    on the same (page, tile);
 *  - exactly ONE structure (by merge group) still has no invert anywhere,
 *    has a read on that (page, tile), and has an assembled rim ABOVE the
 *    orphan value. The rim test is physical, not cosmetic: an invert at or
 *    above the rim cannot belong to the structure, which eliminates
 *    candidates the tile alone cannot (and a rimless group cannot be
 *    completed into a depth at all, so it is never a candidate).
 *
 * The adopted value is appended as a fill-only read whose evidence is the
 * orphan line itself, and a warning names the adoption — cross-block
 * attribution is never indistinguishable from a direct read.
 */
function adoptOrphanInverts(out: Sink): string[] {
  const warnings: string[] = [];
  const byPageTile = new Map<string, { page: number; tile: number; line: string; value: number }[]>();
  for (const o of out.orphanInverts) {
    const key = `${o.page}|${o.tile}`;
    const arr = byPageTile.get(key);
    if (arr) arr.push(o);
    else byPageTile.set(key, [o]);
  }
  // Assembled rim per merge group (the first rim-bearing read states it).
  const groupRim = new Map<string, number | null>();
  for (const s of out.structures) {
    const key = mergeGroupKey(s.description);
    if (!groupRim.has(key)) groupRim.set(key, s.topElevation);
    else if (groupRim.get(key) === null && s.topElevation !== null) groupRim.set(key, s.topElevation);
  }
  const groupsWithInvert = new Set(
    out.structures.filter((s) => s.lowInvert !== null).map((s) => mergeGroupKey(s.description))
  );
  for (const orphans of byPageTile.values()) {
    const { page, tile } = orphans[0];
    const values = [...new Set(orphans.map((o) => o.value))];
    if (values.length !== 1) continue;
    const value = values[0];
    const onPageTile = out.structures.filter(
      (s) => s.source?.tile === tile && out.readPages.get(s) === page
    );
    if (onPageTile.some((s) => s.lowInvert === value || s.highInvert === value)) continue;
    const candidateKeys = [...new Set(
      onPageTile.filter((s) => s.lowInvert === null).map((s) => mergeGroupKey(s.description))
    )].filter((k) => {
      if (groupsWithInvert.has(k)) return false;
      const rim = groupRim.get(k);
      return rim !== null && rim !== undefined && rim > value;
    });
    if (candidateKeys.length !== 1) continue;
    const description = onPageTile.find((s) => mergeGroupKey(s.description) === candidateKeys[0])!.description;
    out.structures.push({
      description,
      topElevation: null,
      lowInvert: value,
      highInvert: null,
      pipeOutDiameter: null,
      structureType: null,
      depth: null,
      diameter: null,
      source: { method: 'transcript', tile, evidence: orphans[0].line },
    });
    warnings.push(
      `Adopted invert ${value} into ${description} from a catchbasin callout on tile ${tile} ("${orphans[0].line}"): ` +
        `group callouts record counts only, so the value was otherwise discarded; ${description} is the only structure ` +
        `read on that page and tile still missing an invert, its rim sits above the value, and no other orphan value competes for it.`
    );
  }
  return warnings;
}

export function assembleTranscriptTakeoff(
  transcripts: TileTranscript[],
  projectName: string,
  statsOut?: { specialists: Record<string, SpecialistFiring> }
): TakeoffFacts {
  // PR47 Phase 1: the registered specialists consult their kill
  // switches once per assembly (see specialists.ts). Unset switches
  // reproduce today's behaviour exactly.
  const s6Disabled = isSpecialistDisabled('S6-detached-elevation');
  const s7Disabled = isSpecialistDisabled('S7-enumeration-scope');
  const s4Disabled = isSpecialistDisabled('S4-col-frag');
  const out: Sink = {
    structures: [],
    catchbasinLabels: new Map(),
    catchbasinFirstSource: new Map(),
    // S7's detector: disabled → an empty scope, so every consumer
    // (occurrence exclusion, mention accounting) keeps everything.
    scope: s7Disabled
      ? { cbLabels: new Map(), structureLabels: new Set() }
      : analyzeEnumerationScope(transcripts),
    demotedStructures: [],
    sewers: [],
    watermain: [],
    withheld: [],
    mentionedStructures: new Map(),
    mentionedCatchbasins: new Map(),
    mentionedExisting: new Set(),
    orphanInverts: [],
    droppedStructureBlocks: [],
    currentPage: 0,
    readPages: new Map(),
    stats: { valueFirstAdoptions: 0, directionalAdoptions: 0, hyphenCorroborated: 0, colFragJoins: 0 },
  };
  const warnings: string[] = [];

  let prevTileNum = -Infinity;
  for (const tile of transcripts) {
    // Page segmentation: transcripts arrive page by page and tile numbers
    // reset per page, so a non-increasing tile number starts a new page.
    if (tile.tile <= prevTileNum) out.currentPage++;
    prevTileNum = tile.tile;
    for (const block of usableBlocks(tile)) {
      const joined = joinBlockLines(block, !s4Disabled, () => { out.stats.colFragJoins++; });

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
          const beforeCells = out.structures.length;
          const matched = processLines(cells, out, warnings, tile.tile);
          for (let i = beforeCells; i < out.structures.length; i++) {
            out.readPages.set(out.structures[i], out.currentPage);
          }
          if (out.structures.length === beforeCells) {
            out.droppedStructureBlocks.push({ tile: tile.tile, lines: cells });
          }
          if (!matched) warnings.push(`Unparseable schedule row: "${line}"`);
        } else {
          remaining.push(line);
        }
      }
      if (remaining.length > 0) {
        const beforeRemaining = out.structures.length;
        processLines(remaining, out, warnings, tile.tile);
        for (let i = beforeRemaining; i < out.structures.length; i++) {
          out.readPages.set(out.structures[i], out.currentPage);
        }
        if (out.structures.length === beforeRemaining) {
          out.droppedStructureBlocks.push({ tile: tile.tile, lines: remaining });
        }
      }
    }
  }

  // PR23: surface the enumeration scope exclusions — neither is silent.
  // PR47 Phase 1: S7's firing count accumulates here (labels the scope
  // analysis excluded: enumeration-only CB labels + demoted structures).
  let enumerationExclusions = 0;
  for (const [type, labels] of out.scope.cbLabels) {
    const counted = out.catchbasinLabels.get(type) ?? new Set<string>();
    const excludedOnly = [...labels].filter((k) => !counted.has(k));
    enumerationExclusions += excludedOnly.length;
    if (excludedOnly.length === 0) continue;
    warnings.push(
      `Scope: ${excludedOnly.length} ${type} label(s) arrive only as a hyphenated site-wide ` +
        `enumeration (the CB-1, CB-2, … form) and were not counted — this takeoff counts ` +
        `plan-evidenced catchbasins only. If this contract covers the enumerated catchbasins, ` +
        `count them from the schedule manually.`
    );
  }
  if (out.demotedStructures.length > 0) {
    const unique = [...new Set(out.demotedStructures)].sort();
    enumerationExclusions += unique.length;
    warnings.push(
      `Scope: ${unique.length} structure(s) appear only inside a complete site-wide numbering ` +
        `enumeration and are not read from any plan callout — excluded as out of takeoff scope: ` +
        `${rawList(unique)}. If this contract covers them, add them manually.`
    );
  }

  // PR42: reads admitted ONLY by the hyphenated system-prefix form
  // ("STM-MH 4" — see callout-parser) are corroborating evidence, not
  // primary reads: they move after every read the established grammar
  // admitted, so at reconcile's first-wins merge they fill the fields the
  // established reads leave blank and never override them. A hyphenated
  // read that is a structure's only read still emits the structure.
  const hyphenSystemRead = (s: StructureFact): boolean =>
    /^(?:EX\.?\s*|(?:NEW|PROP(?:OSED)?|PR)\.?\s+)?(?:SANITARY|SAN|STORM|STM)\s*-/.test(
      (s.source?.evidence ?? '').trim().toUpperCase()
    );
  // PR47 Phase 1: the hyphenated corroboration rule is S6's M2 — with
  // S6 disabled the reads stay in assembly order, exactly as assembled
  // before PR #64 (and hyphen-only structures are emitted again).
  let rimRewrites = 0;
  let garbleRescues = 0;
  let orphanAdoptions = 0;
  if (!s6Disabled) {
    // Corroboration only: a hyphenated read counts toward a structure the
    // established grammar also read (its merge group has a plain-form read).
    // A structure visible ONLY in the hyphenated form is not emitted — on
    // the frozen corpus those are out-of-scope reads (sibling-phase
    // structures the estimator did not take off), the same failure mode the
    // PR23 enumeration guards exclude; the coverage warning at the end of
    // assembly surfaces the labels it leaves behind.
    const plainGroups = new Set(
      out.structures.filter((s) => !hyphenSystemRead(s)).map((s) => mergeGroupKey(s.description))
    );
    out.stats.hyphenCorroborated = out.structures.filter(
      (s) => hyphenSystemRead(s) && plainGroups.has(mergeGroupKey(s.description))
    ).length;
    out.structures = [
      ...out.structures.filter((s) => !hyphenSystemRead(s)),
      ...out.structures.filter((s) => hyphenSystemRead(s) && plainGroups.has(mergeGroupKey(s.description))),
    ];

    // PR42 L1: elevation recovery passes over the sink. Order matters — the
    // rim preference runs on the clean reads only; the garble rescue and the
    // orphan adoption then append fill-only reads after them, so a recovered
    // value can never override a direct read at the merge.
    rimRewrites = applyLastRimPreference(out);
    const rescueWarnings = rescueGarbledLabelBlocks(out);
    garbleRescues = rescueWarnings.length;
    warnings.push(...rescueWarnings);
    const adoptionWarnings = adoptOrphanInverts(out);
    orphanAdoptions = adoptionWarnings.length;
    warnings.push(...adoptionWarnings);
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

  // PR47 Phase 1: compose the specialist firing records for diagnostics
  // (see specialists.ts). Counting only — the records describe this
  // assembly; nothing reads them back into it.
  if (statsOut) {
    const s6Detail: Record<string, number> = {
      M1: out.stats.directionalAdoptions,
      M2: out.stats.hyphenCorroborated,
      M3: garbleRescues,
      M4: orphanAdoptions,
      M5: rimRewrites,
    };
    statsOut.specialists = {
      'S6-detached-elevation': {
        fired: Object.values(s6Detail).reduce((a, b) => a + b, 0),
        detail: s6Detail,
      },
      'S7-enumeration-scope': {
        fired: enumerationExclusions,
        detail: {
          cbEnumerationLabels: [...out.scope.cbLabels.values()].reduce((a, s) => a + s.size, 0),
          structureEnumerationLabels: out.scope.structureLabels.size,
          demotedStructures: new Set(out.demotedStructures).size,
        },
      },
      'S10-value-first': {
        fired: out.stats.valueFirstAdoptions,
        detail: { adoptions: out.stats.valueFirstAdoptions },
      },
      // PR58: S4 is listed only when it fired (the S2 convention) — a
      // silent specialist leaves the record byte-identical.
      ...(out.stats.colFragJoins > 0
        ? {
            'S4-col-frag': {
              fired: out.stats.colFragJoins,
              detail: { joins: out.stats.colFragJoins },
            },
          }
        : {}),
    };
  }

  // Step 6: partial-miss surfacing — purely additive warnings (assembly-level
  // here, facts-level from coverage-checks.ts). No fact is created, altered
  // or removed: an incomplete takeoff must SAY it is incomplete.
  const coverage = coverageWarningsFor(transcripts, out, reconciled);
  // Confidence is assessed from the final facts' own signals (provenance
  // coverage, withheld questions, and the coverage warnings appended
  // above) — never the constant the reconciler was handed. See
  // confidence.ts. Physics notes (physics-checks.ts) are appended after
  // the assessment: they are not confidence signals.
  return appendPhysicsWarnings(withConfidence(appendCoverageWarnings({
    ...reconciled,
    warnings: [...reconciled.warnings, ...coverage],
  })));
}
