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
}

export interface CatchbasinGroup {
  type: 'SINGLE_CB' | 'DOUBLE_CB' | 'DITCH_INLET_CB' | 'DOUBLE_DITCH_INLET_CB';
  quantity: number;
  wallThickness: number;
  depth: number;
  grateEach: number;
  addMaterials: number;
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
  warnings: string[];
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
