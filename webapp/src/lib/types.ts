// ============ Extraction Types ============

export interface Manhole {
  item: number;
  description: string;
  topElevation: number | null;
  lowInvert: number | null;
  highInvert: number | null;
  pipeOutDiameter: number | null;
  structureType: string | null;
  addMaterials: number;
  addLE: number;
  depth: number | null;
  drop: number | null;
  diameter: number | null;
  /** Carried through from the originating fact, when it recorded one. */
  source?: FactSource;
}

export interface CatchbasinGroup {
  type: 'SINGLE_CB' | 'DOUBLE_CB' | 'DITCH_INLET_CB' | 'DOUBLE_DITCH_INLET_CB';
  quantity: number;
  wallThickness: number;
  depth: number;
  grateEach: number;
  addMaterials: number;
  source?: FactSource;
}

export interface CatchbasinSummary {
  groups: CatchbasinGroup[];
  laborRates: {
    scbLabor: number;
    dcbLabor: number;
    dicbFC: number;
    ddicbFC: number;
  };
}

export interface SewerRun {
  item: number;
  runLabel: string;
  length: number | null;
  pipeDiameter: number | null;
  typeClass: number | null;
  slope: number | null;
  depth: number | null;
  addMaterials: number;
  addLE: number;
  isLineItem: boolean;
  lineItemType?: string;
  source?: FactSource;
}

export interface WatermainRun {
  item: number;
  sizeAndType: string;
  length: number;
  pipeDiameter: number;
  ocSc: number; // 1.1, 1.2, 2.1, 2.2
  addMaterials: number;
  addLE: number;
  avgCover: number;
  source?: FactSource;
}

export interface WatermainSpecial {
  item: number;
  specialName: string;
  quantity: number;
  costEach: number;
  thrustBlock: number; // 1=yes
  anodeCost: number;
  laborEach: number;
}

export interface WatermainValve {
  item: number;
  valveSize: string;
  quantity: number;
  valveCost: number;
  boxCost: number;
  anodeCost: number;
  laborPerValve: number;
}

export interface ExtractionResult {
  projectName: string;
  jobNumber: string;
  date: string;
  templateType: 'SHORT' | 'LONG';
  manholes: Manhole[];
  catchbasins: CatchbasinSummary;
  sewers: SewerRun[];
  watermain: WatermainRun[];
  watermainSpecials: WatermainSpecial[];
  watermainValves: WatermainValve[];
  confidence: number;
  /** The named deductions behind `confidence` (signal-based, see confidence.ts). */
  confidenceFactors?: ConfidenceFactor[];
  warnings: string[];
  /** Carried from the facts and extended at pricing with every default /
   *  derivation actually applied — rendered on the workbook's AUDIT sheet. */
  withheld?: WithheldItem[];
  locatorIndex?: { manholePages: number[]; sewerPages: number[]; watermainPages: number[] } | null;
  /** Carried from the facts (see ExtractionDiagnostics) — rendered as a
   *  summary on the workbook's AUDIT sheet. */
  diagnostics?: ExtractionDiagnostics;
}

// ============ Takeoff Facts (Extraction Stage output) ============
// Facts that are physically present on the drawings. The LLM is ONLY asked for
// these — never for dollar amounts, labor rates, or fees. Pricing/judgment is
// applied deterministically afterwards by priceTakeoff() (see costing-rules.ts).

/**
 * Per-fact provenance: where a fact was read from. Attached at creation by the
 * assembly paths that know the answer (text layer knows its page, the
 * transcript assembler knows its tile, the schedule harvester knows its row).
 * OPTIONAL everywhere: facts from legacy / single-pass paths carry none and
 * remain valid — absence means "origin not recorded", never an error.
 */
export interface FactSource {
  method: 'text-layer' | 'transcript' | 'schedule' | 'vector' | 'single-pass' | 'derived' | 'convention-default';
  /** 1-based drawing page, when the producing path knows it (text layer). */
  page?: number;
  /** Transcript tile number, when the producing path knows it (transcript). */
  tile?: number;
  /** The raw callout / line / schedule-row text the fact was read from. */
  evidence?: string;
  /** PR47 Phase 0: the producing module's registry id — 'generalist' for
   *  the default pipeline, or a specialist id (see the registry in
   *  specialists.ts) when a convention-family module produced the fact.
   *  Stamped from `method` at diagnostics time (attachDiagnostics) unless
   *  the creation site set it. Absent = not recorded. */
  producer?: string;
  /** PR47 Phase 0: the convention family that owns this fact's convention,
   *  when determinable — the producing page's primary CLAIMED family tag
   *  (see PageClassification). Absent when the page claimed no family or
   *  the fact's page is unknown (transcript facts carry a tile, not a
   *  page, so their family is recorded only in the diagnostics ledger
   *  when a page mapping exists — today it does not). */
  family?: string;
}

/**
 * A value the estimator needs that was NOT read off the drawings — the
 * withheld-as-questions record. `kind` separates the three cases:
 *  - 'withheld':  absent, nothing applied (left blank) — a pure question.
 *  - 'defaulted': absent, but a convention default was applied at pricing so
 *                 the estimate could proceed — the question AND the value used.
 *  - 'derived':   computed at pricing from values that WERE read (e.g. a
 *                 manhole diameter snapped from the largest connected pipe).
 * Rendered on the workbook's AUDIT sheet (see spreadsheet.ts). Nothing in
 * here changes any number — it makes visible what used to be silent.
 */
export interface WithheldItem {
  /** Human label of the entity the value belongs to (structure, run, CB group, watermain size). */
  entity: string;
  /** The fact/pricing field in question ('wallThickness', 'ocSc', 'diameter', …). */
  field: string;
  kind: 'withheld' | 'defaulted' | 'derived';
  /** The question (or derivation note) shown to the estimator. */
  question: string;
  /** The value actually used in pricing, and where it came from — null when left blank. */
  defaultApplied?: { value: number | string; source: string } | null;
}

/**
 * One named deduction behind a signal-based confidence score (see
 * confidence.ts). The score is the product of the applied factors; each line
 * names the signal, how many units it fired on, and the multiplier it
 * applied — the breakdown travels with the number so a low score explains
 * itself instead of arriving as a bare float.
 */
export interface ConfidenceFactor {
  /** Stable machine id of the signal ('defaulted-values', 'coverage-warnings', …). */
  signal: string;
  /** Human-readable reason, shown anywhere the score is surfaced. */
  label: string;
  /** Units the signal fired on (facts, withheld items, warnings). */
  count: number;
  /** Denominator the count is a share of (0 when the signal is not a share). */
  total: number;
  /** Multiplier this signal applied to the score (1 = reported, no deduction). */
  factor: number;
}

export interface StructureFact {
  description: string;
  topElevation: number | null;
  lowInvert: number | null;
  highInvert: number | null;
  pipeOutDiameter: number | null;
  structureType: string | null;
  depth: number | null;
  /** Structure size as stated on the drawing ("MH 2 (1800mmØ)"), in mm. When present it
   *  beats the size inferred from connected pipes. */
  diameter?: number | null;
  source?: FactSource;
}

export interface CatchbasinGroupFact {
  type: 'SINGLE_CB' | 'DOUBLE_CB' | 'DITCH_INLET_CB' | 'DOUBLE_DITCH_INLET_CB';
  quantity: number;
  wallThickness: number | null;
  depth: number | null;
  source?: FactSource;
}

export interface SewerFact {
  runLabel: string;
  isLineItem: boolean;
  lineItemType?: string;
  length: number | null;
  pipeDiameter: number | null;
  typeClass: number | null;
  slope: number | null;
  depth: number | null;
  source?: FactSource;
}

export interface WatermainFact {
  sizeAndType: string;
  length: number;
  pipeDiameter: number;
  /**
   * Estimator conventions (overburden / average cover). Null when unstated:
   * the extraction never observed them on the drawing, and the truth reader
   * must not invent them either. The estimator defaults (1.1 / 1.8) are
   * applied where they belong — at pricing time in costing-rules.
   */
  ocSc: number | null;
  avgCover: number | null;
  source?: FactSource;
}

export interface WatermainSpecialFact {
  specialName: string;
  quantity: number;
}

export interface WatermainValveFact {
  valveSize: string;
  quantity: number;
}

/**
 * Per-sheet scale calibration record (vector path) — scale as *calibration*,
 * not silent detection. Produced by site-network.ts when a sheet's vector
 * results are built and carried on TakeoffFacts.calibrations.
 *
 * The discipline (OpenTakeoff pattern): detection is only a suggestion.
 * A single unambiguous scale note is adopted as 'detected'; verification
 * against stated dimensions on the same sheet promotes it to 'stated'.
 * Anything else — conflicting notes ('ambiguous') or no note at all
 * ('absent') — yields scalePtPerM: null, which downstream consumers must
 * read as "cannot measure drawn geometry on this sheet", NEVER as licence
 * to substitute a default. (The pre-PR-12 behaviour silently fell back to
 * 5.0 pt/m, inventing every drawn length on the sheet.)
 */
export interface SheetCalibration {
  /** pt per metre, or null when the sheet's scale could not be determined
   *  unambiguously. Null = drawn geometry on this sheet is unmeasurable. */
  scalePtPerM: number | null;
  /** How the scale was established:
   *  - 'stated':    scale note read AND verified against stated dimensions
   *                 on the same sheet (residual within tolerance).
   *  - 'detected':  single unambiguous scale note read; unverified.
   *  - 'explicit':  supplied by the caller (an act of adoption, e.g. tests).
   *  - 'ambiguous': multiple conflicting scale notes — no suggestion adopted.
   *  - 'absent':    no scale note found on the sheet. */
  source: 'stated' | 'detected' | 'explicit' | 'ambiguous' | 'absent';
  /** 1-based drawing page this calibration belongs to, when known. */
  page?: number;
  /** The raw scale-note text the value was read from (e.g. "SCALE 1:200"). */
  detectedText?: string;
  /** Every distinct scale denominator found on the sheet — evidence,
   *  including the conflicts when source is 'ambiguous'. */
  candidates?: number[];
  /** Relative residual of the verification check (|implied − adopted| /
   *  adopted, median across stated-dimension samples); null when the check
   *  did not run (too few samples) or no scale was adopted. */
  residual?: number | null;
}

/** Page-kind taxonomy (PR47 Phase 0; pdf_schedule_conventions.md §1a):
 *  P1 vector-text clean / texty · P2 vector-text annotation-form · P3
 *  vector-text PARTIAL layer · P4 vector-text sparse / fragmented (SHX,
 *  outlined, covers) · P5 non-texty text-bearing (details / notes / spec)
 *  · P6 raster-scan (no text layer). */
export type PageKind = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';

/** A convention-family tag on a page, with the classifier's confidence.
 *  'claimed' = the family's full conjunctive signature was measured on
 *  the page; 'suspect' = a partial signature — recorded so the taxonomy
 *  learns from live traffic, but dispatching NOTHING (a missed
 *  specialist costs today's behaviour; a wrong one invents a failure
 *  mode — see pdf_schedule_conventions.md §2.2). */
export interface FamilyTag {
  tag: string;
  tier: 'claimed' | 'suspect';
}

/** The routing-time signal values the page classifier consumed for one
 *  page. Null = the run never measured that signal for this page —
 *  never estimated, never back-filled (the diagnostics discipline). */
export interface PageClassificationSignals {
  items: number | null;
  chars: number | null;
  texty: boolean | null;
  annotationForm: boolean | null;
  soloYield: number | null;
  soloRunYield: number | null;
  elevationItems: number | null;
  keywordHits: number | null;
  pathOps: number | null;
  imageOps: number | null;
  symbolFontItems: number | null;
}

/** One located page's recorded classification (PR47 Phase 0). RECORDED
 *  ONLY: no routing, parsing, merging or workbook behaviour reads it. */
export interface PageClassification {
  page: number;
  kind: PageKind;
  /** Confidence in the kind assignment: 'claimed' when the kind's full
   *  signature was measured; 'suspect' when a deciding signal was
   *  unmeasured or the page sits on a kind boundary. */
  kindTier: 'claimed' | 'suspect';
  families: FamilyTag[];
  signals: PageClassificationSignals;
}

/** Per-fact provenance ledger entry (PR47 Phase 0): who produced one
 *  fact of the final takeoff, on what basis, and which convention
 *  family owns it — derived deterministically from the fact's FactSource
 *  and the producing page's classification, at diagnostics time. */
export interface FactProvenance {
  kind: 'structure' | 'sewer' | 'watermain' | 'catchbasin';
  /** The fact's identity (structure description / run label / WM size / CB type). */
  label: string;
  /** Registry id of the producer: 'generalist', a specialist id, or
   *  'unrecorded' when the fact carries no FactSource. */
  producer: string;
  /** 'stated' = read off the drawing; 'derived' = computed or defaulted
   *  from stated values (FactSource method 'derived' or
   *  'convention-default'). */
  basis: 'stated' | 'derived';
  /** CLAIMED family tags of the producing page; null when the fact's
   *  page is unknown or the page claimed no family. */
  family: string[] | null;
  /** The fact's FactSource method, verbatim; null when unrecorded. */
  method: FactSource['method'] | null;
  page?: number;
  tile?: number;
}

/** Entity counts by kind — the assembly section of ExtractionDiagnostics. */
export interface EntityCounts {
  structures: number;
  sewers: number;
  watermain: number;
  catchbasins: number;
}

/** Per-located-page diagnostics: how the page was routed and what the
 *  pipeline genuinely computed for it. Fields the pipeline never computed
 *  for a page are null — never estimated, never back-filled. */
export interface PageDiagnostics {
  page: number;
  route: 'text' | 'vision' | 'vector';
  /** Characters in the page's text layer, when this run actually extracted
   *  that layer for the page (hybrid routing, locator union); else null. */
  textChars: number | null;
  /** Entities the text assembler read from this page alone — recorded only
   *  where the pipeline computes it (hybrid texty pages, in the zero-yield
   *  fallback check); else null. */
  textYield: number | null;
  /** Geometry-derived tiles this page needs (tilesNeededPerPage), for
   *  vision-routed pages only; null for text/vector pages. */
  tilesPlanned: number | null;
  /** Tiles the renderer emitted for this page, DERIVED from render order
   *  and the per-page/total caps (the renderer reports only a flat list).
   *  Null when the derivation does not reconcile with the actual rendered
   *  total — then only the totals in TileDiagnostics are trustworthy. */
  tilesRendered: number | null;
  /** A texty page that yielded zero entities and was re-routed to vision
   *  (the PR #41 fallback). */
  zeroYieldFallback?: boolean;
  /** A texty page that yielded entities but ZERO pipe runs (sewers +
   *  watermain) — any runs it carries exist only as drawing strokes — and
   *  was ALSO vision-transcribed with its text facts kept (the PR24
   *  zero-run-yield fallback; route 'vision', text+vision in effect). */
  zeroRunYieldFallback?: boolean;
  /** A texty page that yielded entities WITH pipe runs but whose text
   *  layer provably carries only part of the annotation set (zero
   *  elevation items at full callout density over a dense vector drawing)
   *  and was ALSO vision-transcribed with its text facts kept (the PR46
   *  dual-read trigger; route 'vision', text+vision in effect). */
  dualReadTrigger?: boolean;
  /** The routing-time signal values behind a dual-read firing. */
  dualReadSignals?: { elevationItems: number; keywordHits: number; pathOps: number };
  /** A raster page the S2 vision hook (PR49) issued a targeted
   *  watermain-table read on: its general transcript carried the
   *  table's fragment (scope headers + number pairs) but its text layer
   *  is glyph garbage, so no text channel could read the table itself. */
  wmTableHook?: boolean;
  /** The candidate-signal values behind an S2 vision-hook firing. */
  wmTableHookSignals?: { tile: number; scopeHeaders: number; pairs: number; items: number; singleCharFraction: number };
}

/** Tile-pipeline totals for one run. "Planned" sums tilesNeededPerPage over
 *  the pages actually sent to the tile renderer (vision-routed pages);
 *  text-routed pages are never tiled, so they are not in the plan. */
export interface TileDiagnostics {
  planned: number | null;
  rendered: number | null;
  uploaded: number | null;
  /** Tiles present in the returned transcript (transcribe/hybrid paths). */
  transcribed: number | null;
  /** Tiles absent from the transcript after every recovery rung (the
   *  batch re-issue and the capped single-tile attempts). */
  missingAfterRetry: number | null;
  /** Tiles returned but finally discarded as degenerate repetition after
   *  their single-tile re-issue also looped (blocks emptied). */
  degenerateDiscarded: number | null;
  /** Tiles the batch re-issue saved: absent from the primary response,
   *  returned usable by the re-issued batch call. */
  recoveredAfterRetry?: number | null;
  /** Tiles the single-tile rung saved: still absent after the batch
   *  re-issue, returned usable by a one-tile call. */
  recoveredAsSingle?: number | null;
  /** Degenerate tiles saved by their single-tile re-issue: the re-issue
   *  returned a usable read instead of looping again. */
  degenerateRecovered?: number | null;
  /** Total transcript blocks across all transcribed tiles. */
  blocks: number | null;
  /** Tile rendering itself failed (the run fell back / recorded a call
   *  failure) — rendered is then 0 for a non-cap reason, and no truncation
   *  warning is derived from it. */
  renderFailed?: boolean;
}

/**
 * Per-run pipeline diagnostics (PR18): where content was lost, stage by
 * stage — locator → routing → tiles → assembly — recorded on the facts so
 * a prod run on a real project attributes its own losses instead of leaving
 * them in server console logs (the silent-cap audit's classes 6a/6c were
 * console-only). Diagnostics never feed back into extraction: the record
 * is written after the facts are final and changes nothing upstream.
 */
export interface ExtractionDiagnostics {
  version: 1;
  mode: string;
  durationMs: number;
  locator: {
    /** The locator step ran (LLM or memoized). False when skipped (tiny
     *  sets / disabled), where the located set is all pages by rule. */
    ran: boolean;
    /** Page numbers the locator returned, verbatim (empty when it returned
     *  nothing, failed, or was skipped). */
    rawPicks: number[];
    /** Pages the locator union (PR #42) added, with the admission reason. */
    unionAdded: { page: number; reason: string }[];
    /** The located set every downstream stage consumed. */
    finalPages: number[];
    /** The empty-set fallback fired: locator produced nothing usable, so
     *  all pages were tiled. */
    tileAllFallback: boolean;
  };
  pages: PageDiagnostics[];
  tiles: TileDiagnostics;
  /** PR34: model-unavailability fallbacks that tripped during this run —
   *  the configured model 404'd on Vertex and the role family finished
   *  the job on the fallback model. Absent when no fallback fired. */
  /** PR40: `source: 'probe'` marks a trip by the job-start availability probe (absent = mid-job trip). */
  modelFallback?: { role: string; from: string; to: string; source?: string }[];
  assembly: {
    /** Entity counts from each source path that ran, before merging. */
    sources: { path: 'text' | 'transcript' | 'vector' | 'single-pass'; counts: EntityCounts }[];
    /** Entity counts of the final merged facts. */
    final: EntityCounts;
  };
  /** PR47 Phase 0: recorded page classification — kind + family tags
   *  per located page, from routing-time signals only. Observational:
   *  nothing routes, parses or merges on it. Absent when the run never
   *  extracted page texts for its located pages. */
  classification?: PageClassification[];
  /** PR47 Phase 0: per-fact provenance ledger for the final takeoff
   *  (producer / basis / family per fact — see FactProvenance). */
  provenance?: FactProvenance[];
  /** PR47 Phase 1: per-specialist firing records, keyed by registry id
   *  (see specialists.ts). A specialist is listed when the run could
   *  observe its activity — transcript assembly always reports its
   *  three; routing specialists are listed when they fired. */
  specialists?: Record<string, SpecialistFiring>;
}

/** One specialist's firing record for a run (PR47 Phase 1). */
export interface SpecialistFiring {
  /** Times the specialist's mechanisms changed an outcome: adopted a
   *  value, excluded a label, clamped a group, decoded an item,
   *  admitted or re-routed a page. */
  fired: number;
  /** Pages involved, when the firing is page-attributable. */
  pages?: number[];
  /** Per-mechanism firing counts (mechanism id → count), when the
   *  specialist has distinguishable mechanisms. */
  detail?: Record<string, number>;
}

/** Token usage for ONE model within a job (PR30: jobs are mixed-model, so
 *  cost telemetry buckets usage per model id and prices each bucket at that
 *  model's rate). outputTokens counts candidates only; thoughtsTokens are
 *  billed at the output rate. */
export interface ModelUsageBucket {
  model: string;
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  totalTokens: number;
  llmCalls: number;
}

export interface TakeoffFacts {
  projectName: string;
  jobNumber: string;
  date: string;
  structures: StructureFact[];
  catchbasins: CatchbasinGroupFact[];
  sewers: SewerFact[];
  watermain: WatermainFact[];
  watermainSpecials: WatermainSpecialFact[];
  watermainValves: WatermainValveFact[];
  confidence: number;
  /** The named deductions behind `confidence` (signal-based, see confidence.ts). */
  confidenceFactors?: ConfidenceFactor[];
  warnings: string[];
  /** Values not read off the drawings that pricing had to default, derive, or
   *  leave blank — see WithheldItem. Optional: legacy facts carry none. */
  withheld?: WithheldItem[];
  /** Per-sheet scale calibration records (vector path) — see SheetCalibration.
   *  Optional: text/transcript/single-pass facts carry none (those paths read
   *  stated values and never measure drawn geometry). */
  calibrations?: SheetCalibration[];
  locatorIndex?: { manholePages: number[]; sewerPages: number[]; watermainPages: number[] } | null;
  // Cost telemetry for a single extraction (all LLM calls summed): lets the eval
  // report tokens/tiles per project so cost changes (DPI, tile budget) are measurable.
  cost?: {
    promptTokens: number; outputTokens: number;
    /** Thinking tokens across all calls (billed at each model's output rate).
     *  Optional: pre-PR30 facts recorded none (their estimates underprice). */
    thoughtsTokens?: number;
    totalTokens: number; llmCalls: number; tiles: number; dpi: number;
    /** Per-model usage buckets (PR30). Optional: legacy facts carry none and
     *  are priced on the aggregate at the fallback rate card. */
    byModel?: Record<string, ModelUsageBucket>;
  };
  // Verbatim per-tile callout transcription (vision-as-transcriber path). Optional —
  // populated when EXTRACTION_MODE=transcribe|hybrid; persisted via predicted_facts.json.
  transcript?: TileTranscript[];
  /** Per-run pipeline diagnostics (see ExtractionDiagnostics). Optional:
   *  legacy facts carry none. Persisted wherever the facts are persisted. */
  diagnostics?: ExtractionDiagnostics;
}

/** Verbatim per-tile callout transcription (vision path). A block is a group of
 *  lines that visually belong together on the drawing (a structure label with its
 *  T/G + INV lines, or one pipe callout possibly split across lines). */
export interface TileTranscript {
  tile: number; // 1-indexed across the whole extraction (not per-batch)
  blocks: string[][];
}

// ============ Global Parameters ============

export interface GlobalParams {
  manholes: {
    truckingPerCM: number;
    concretePerCM: number;
    discount: number;
    marginFactor: number;
    metric: boolean;
    fstFactor: number;
    pstFactor: number;
    modPerM: number;
    mhFC: number;
    cbFC: number;
    laborPerHr: number;
    frameCoverM: number;
  };
  sewers: {
    minTrenchWidth: number;
    pipeCover: number;
    mFinGrade: number;
    dayCostPerDay: number;
    extraPerDay: number;
    productionMPerDay: number;
    stoneImpT: number;
    stoneMt: number;
    granImpTn: number;
    granMt: number;
    truckingPerCM: number;
    efficiency: number;
    metric: boolean;
    marginFactor: number;
    openCutFactor: number;
    dualTrSep: number;
    trenchClear: number;
    concPipePct: number;
    provTax: number;
    fedTax: number;
  };
  watermain: {
    minTrenchWidth: number;
    pipeCover: number;
    mFinGrade: number;
    dayCostPerDay: number;
    extraPerDay: number;
    productionMPerDay: number;
    stoneImpTon: number;
    stoneMtne: number;
    granImpTon: number;
    granMtne: number;
    truckingPerCM: number;
    efficiency: number;
    metric: boolean;
    marginFactor: number;
    openCutFactor: number;
    dualTrSep: number;
    trenchClear: number;
    peelRegionCover: number;
    precastPct: number;
    provTax: number;
    fedTax: number;
    modulocPerM: number;
    c900_100: number;
    c900_150: number;
    c900_200: number;
    c900_250: number;
    c900_300: number;
    concPerCM: number;
  };
}

// ============ Project Types ============

export interface ProjectRecord {
  id: string;
  name: string;
  jobNumber: string;
  createdAt: string;
  status: 'processing' | 'review' | 'completed' | 'error';
  pdfFileName: string;
  pdfStoragePath: string;
  xlsxStoragePath?: string;
  quoteStoragePath?: string;
  extractionResult?: ExtractionResult;
  userEdits?: Partial<ExtractionResult>;
  globalParams: GlobalParams;
}

// ============ API Response Types ============

export interface ProcessResponse {
  projectId: string;
  extraction: ExtractionResult;
  /** Extraction run telemetry (tokens, tiles, LLM calls) for the Telemetry tab. */
  cost?: TakeoffFacts['cost'];
  /** ISO time the takeoff finished on the server. */
  processedAt?: string;
  xlsxBase64: string;
  quoteBase64: string;
  status: string;
  error?: string;
}

// ============ Heuristic Types ============

export interface HeuristicRule {
  id: string;
  category: 'manholes' | 'sewers' | 'watermain' | 'general';
  name: string;
  description: string;
  data: Record<string, unknown>;
  confidence: number;
  sourceProjects: string[];
  updatedAt: string;
}
