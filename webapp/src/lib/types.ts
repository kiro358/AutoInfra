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
  locatorIndex?: { manholePages: number[]; sewerPages: number[]; watermainPages: number[] } | null;
  // Cost telemetry for a single extraction (all LLM calls summed): lets the eval
  // report tokens/tiles per project so cost changes (DPI, tile budget) are measurable.
  cost?: { promptTokens: number; outputTokens: number; totalTokens: number; llmCalls: number; tiles: number; dpi: number };
  // Verbatim per-tile callout transcription (vision-as-transcriber path). Optional —
  // populated when EXTRACTION_MODE=transcribe|hybrid; persisted via predicted_facts.json.
  transcript?: TileTranscript[];
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
