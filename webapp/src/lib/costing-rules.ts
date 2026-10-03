/**
 * Costing stage (deterministic).
 *
 * The extraction stage (extraction.ts) returns only physical facts read off the
 * drawings. Every dollar amount, labor rate, and standard fee is applied here,
 * from one explicit, versioned, unit-tested rule table — never guessed by the LLM.
 *
 * priceTakeoff(facts, rules) is a pure function: TakeoffFacts -> ExtractionResult.
 */
import {
  TakeoffFacts,
  ExtractionResult,
  Manhole,
  CatchbasinSummary,
  SewerRun,
  WatermainRun,
  WatermainSpecial,
  WatermainValve,
} from './types';
import { snapToMHSize } from './geometry';
import { TEMPLATE_LAYOUT, blockCapacity, MH_DIAMETERS } from './constants';

export interface CostingRules {
  /** Per-structure material/labor surcharges, matched by token in the description. */
  structureSurcharge: {
    token: string;
    addMaterials: number;
    addLE: number;
  }[];
  catchbasin: {
    defaultWallThickness: number;
    defaultDepth: number;
    defaultAddMaterials: number;
  };
  laborRates: {
    scbLabor: number;
    dcbLabor: number;
    dicbFC: number;
    ddicbFC: number;
  };
  pipeAddOns: {
    insulation: { mtrlPerM: number; lePerM: number };
    connection: { mtrl: number; le: number };
    wye: { mtrl: number };
  };
  standardFees: {
    videoPerM: number;
    layout: number;
    asBuilt: number;
  };
  watermain: {
    specialAnodeCost: number;
    valveBoxCost: number;
    valveAnodeCost: number;
    valveLaborPerValve: number;
  };
}

/**
 * Default costing rules — ported verbatim from the magic numbers that previously
 * lived inside extraction.ts (parseRawExtraction + applyDeterministicHeuristics).
 * These are estimator defaults and SHOULD be tuned per client / from a price book.
 * The order of structureSurcharge matters: first matching token wins.
 */
export const DEFAULT_COSTING: CostingRules = {
  structureSurcharge: [
    { token: 'DCBMH', addMaterials: 1800, addLE: 0 },
    { token: 'CBMH', addMaterials: 900, addLE: 0 },
    { token: 'EXT.DROP', addMaterials: 3000, addLE: 3000 },
    { token: 'DROP', addMaterials: 3000, addLE: 3000 },
    { token: 'VALVE CHAMBER', addMaterials: 3000, addLE: 3000 },
    { token: 'DCVC', addMaterials: 3000, addLE: 3000 },
  ],
  catchbasin: {
    defaultWallThickness: 4,
    defaultDepth: 2.2,
    defaultAddMaterials: 900,
  },
  laborRates: {
    scbLabor: 200,
    dcbLabor: 250,
    dicbFC: 465,
    ddicbFC: 715,
  },
  pipeAddOns: {
    insulation: { mtrlPerM: 80, lePerM: 40 },
    connection: { mtrl: 500, le: 250 },
    wye: { mtrl: 880 },
  },
  standardFees: {
    videoPerM: 25,
    layout: 5000,
    asBuilt: 5000,
  },
  watermain: {
    specialAnodeCost: 100,
    valveBoxCost: 285,
    valveAnodeCost: 150,
    valveLaborPerValve: 150,
  },
};

/** The standard per-project sewer fees, in the order they are appended. */
export const STANDARD_FEE_KINDS = ['VIDEO', 'LAYOUT', 'AS BUILT'] as const;
export type StandardFeeKind = (typeof STANDARD_FEE_KINDS)[number];

/** Which standard fee (if any) a sewer row label names. */
export function standardFeeKind(runLabel: string | null | undefined): StandardFeeKind | null {
  const upper = (runLabel || '').toUpperCase();
  return STANDARD_FEE_KINDS.find((k) => upper.includes(k)) ?? null;
}

/**
 * SHORT vs LONG template selection. SHORT is used only when EVERYTHING fits its
 * fixed rows (see constants.ts::TEMPLATE_LAYOUT) — otherwise rows would be dropped.
 *
 * @param sewerRows  sewer rows that need their own run row, i.e. EXCLUDING the
 *                   standard VIDEO/LAYOUT/AS BUILT fees (SHORT has dedicated rows for those)
 */
export function determineTemplateType(
  sewerRows: number,
  structures = 0,
  watermainRuns = 0
): 'SHORT' | 'LONG' {
  const short = TEMPLATE_LAYOUT.SHORT;
  const fits =
    sewerRows <= blockCapacity(short.sewers) &&
    structures <= blockCapacity(short.manholes) &&
    watermainRuns <= blockCapacity(short.watermainRuns);
  return fits ? 'SHORT' : 'LONG';
}

/** Normalize a structure/run label into comparable manhole tokens. */
function getCleanMHTokens(label: string): string[] {
  if (!label || typeof label !== 'string') return [];
  const upper = label.toUpperCase();
  const withHyphen = upper.replace(/\bTO\b/gi, '-');
  const withoutSpaces = withHyphen.replace(/\s+/g, '');
  const cleanLabel = withoutSpaces.replace(/\/INS/g, '').replace(/CONN/g, '');
  return cleanLabel.split('-').filter(Boolean);
}

/**
 * Apply costing rules and deterministic geometry derivation to raw facts,
 * producing a fully-priced ExtractionResult ready for the spreadsheet template.
 */
export function priceTakeoff(
  facts: TakeoffFacts,
  rules: CostingRules = DEFAULT_COSTING
): ExtractionResult {
  // --- Sewers first (manhole diameters depend on connected pipe sizes) ---
  const sewers: SewerRun[] = facts.sewers.map((s, i) => {
    let addMaterials = 0;
    let addLE = 0;
    if (s.length && !s.isLineItem) {
      const label = (s.runLabel || '').toUpperCase();
      if (label.includes('/INS')) {
        addMaterials = s.length * rules.pipeAddOns.insulation.mtrlPerM;
        addLE = s.length * rules.pipeAddOns.insulation.lePerM;
      } else if (label.includes('CONN')) {
        addMaterials = rules.pipeAddOns.connection.mtrl;
        addLE = rules.pipeAddOns.connection.le;
      } else if (label.includes('WYE')) {
        addMaterials = rules.pipeAddOns.wye.mtrl;
      }
    }
    return {
      item: i + 1,
      runLabel: s.runLabel,
      length: s.length,
      pipeDiameter: s.pipeDiameter,
      typeClass: s.typeClass,
      slope: s.slope,
      depth: s.depth,
      addMaterials,
      addLE,
      isLineItem: s.isLineItem,
      lineItemType: s.lineItemType,
    };
  });

  const connectedSewerDiameters = (mhDesc: string): number[] => {
    const normalizedMH = (mhDesc || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!normalizedMH) return [];
    const out: number[] = [];
    for (const sw of sewers) {
      if (sw.isLineItem || !sw.runLabel || !sw.pipeDiameter) continue;
      if (getCleanMHTokens(sw.runLabel).includes(normalizedMH)) {
        out.push(sw.pipeDiameter);
      }
    }
    return out;
  };

  // --- Manholes / structures ---
  const sizeWarnings: string[] = [];
  const manholes: Manhole[] = facts.structures.map((st, i) => {
    const inv =
      st.lowInvert !== null && st.highInvert !== null
        ? Math.min(st.lowInvert, st.highInvert)
        : st.lowInvert !== null
        ? st.lowInvert
        : st.highInvert;

    let depth = st.depth;
    if (st.topElevation !== null && inv !== null && inv !== undefined) {
      const calc = Math.round((st.topElevation - inv) * 100) / 100;
      if (calc > 0) depth = calc;
    }

    const connected = connectedSewerDiameters(st.description);
    const maxPipe = connected.length > 0 ? Math.max(...connected) : 0;
    const effectivePipeOutDia = Math.max(st.pipeOutDiameter || 0, maxPipe);

    const desc = (st.description || '').toUpperCase();
    // A chamber system (Cultec, StormTech) is not a precast manhole: giving it a diameter
    // makes the template price it as one. It is priced by hand (see chamberWarning).
    const isChamber = st.structureType === 'CHAMBER';
    // The size stated on the drawing ("MH 2 (1800mmØ)") wins; inferring from connected
    // pipes is the fallback, and it can only ever under-size (a 300mm pipe says 1200).
    // Only a real manhole size counts as stated: a misread "(180mmØ)" for 1800 would price a
    // size the template has no row for (#N/A), so fall back to the pipe-inferred size.
    const stated = st.diameter && MH_DIAMETERS.includes(st.diameter) ? st.diameter : null;
    if (st.diameter && !stated) {
      sizeWarnings.push(`${st.description}: stated size ${st.diameter}mm is not a manhole size — sized from connected pipes instead; check the drawing.`);
    }
    const diameter = isChamber
      ? null
      : stated
      ? stated
      : desc.includes('DCBMH') ? 1500 : snapToMHSize(effectivePipeOutDia);

    let addMaterials = 0;
    let addLE = 0;
    for (const rule of rules.structureSurcharge) {
      if (desc.includes(rule.token)) {
        addMaterials = rule.addMaterials;
        addLE = rule.addLE;
        break;
      }
    }

    return {
      item: i + 1,
      description: st.description,
      topElevation: st.topElevation,
      lowInvert: st.lowInvert,
      highInvert: st.highInvert,
      pipeOutDiameter: effectivePipeOutDia || st.pipeOutDiameter,
      structureType: st.structureType,
      addMaterials,
      addLE,
      depth,
      drop: null,
      diameter,
    };
  });

  // --- Catchbasins ---
  const catchbasins: CatchbasinSummary = {
    groups: facts.catchbasins
      .filter((g) => g.quantity > 0)
      .map((g) => ({
        type: g.type,
        quantity: g.quantity,
        wallThickness: g.wallThickness ?? rules.catchbasin.defaultWallThickness,
        depth: g.depth ?? rules.catchbasin.defaultDepth,
        grateEach: 0,
        addMaterials: rules.catchbasin.defaultAddMaterials,
      })),
    laborRates: { ...rules.laborRates },
  };

  // --- Standard sewer fees (once per project, only if there are sewers) ---
  // A fee row the drawing already lists (e.g. an extracted "VIDEO" line item) is priced
  // in place rather than duplicated; missing ones are appended.
  if (sewers.length > 0) {
    const totalSewerLength = sewers.reduce(
      (sum, s) => (!s.isLineItem && s.length ? sum + s.length : sum),
      0
    );
    const feeAmount: Record<StandardFeeKind, number> = {
      VIDEO: totalSewerLength * rules.standardFees.videoPerM,
      LAYOUT: rules.standardFees.layout,
      'AS BUILT': rules.standardFees.asBuilt,
    };
    const feeLabel: Record<StandardFeeKind, string> = {
      VIDEO: `VIDEO ($${rules.standardFees.videoPerM}/m)`,
      LAYOUT: 'LAYOUT',
      'AS BUILT': 'AS BUILT',
    };
    const present = new Set<StandardFeeKind>();
    for (const s of sewers) {
      const kind = s.isLineItem ? standardFeeKind(s.runLabel) : null;
      if (!kind) continue;
      present.add(kind);
      s.addMaterials = feeAmount[kind];
      s.addLE = 0;
    }
    for (const kind of STANDARD_FEE_KINDS) {
      if (present.has(kind)) continue;
      sewers.push({
        item: sewers.length + 1,
        runLabel: feeLabel[kind],
        isLineItem: true,
        lineItemType: undefined,
        length: null,
        pipeDiameter: null,
        typeClass: null,
        slope: null,
        depth: null,
        addMaterials: feeAmount[kind],
        addLE: 0,
      });
    }
  }

  // Never mutate the caller's facts.warnings — priced output gets its own copy.
  const warnings = [...(facts.warnings || []), ...sizeWarnings];

  // --- Watermain ---
  for (const w of facts.watermain) {
    if (!(w.length > 0)) {
      warnings.push(
        `Watermain "${w.sizeAndType}": length not found on the drawing — left blank in the workbook and NOT priced on the quote (length TBD; scale it off the plan).`
      );
    }
  }
  const watermain: WatermainRun[] = facts.watermain.map((w, i) => ({
    item: i + 1,
    sizeAndType: w.sizeAndType,
    length: w.length,
    pipeDiameter: w.pipeDiameter,
    ocSc: w.ocSc,
    addMaterials: 0,
    addLE: 0,
    avgCover: w.avgCover,
  }));

  const watermainSpecials: WatermainSpecial[] = facts.watermainSpecials.map((sp, i) => ({
    item: i + 1,
    specialName: sp.specialName,
    quantity: sp.quantity,
    costEach: 0,
    thrustBlock: 0,
    anodeCost: rules.watermain.specialAnodeCost,
    laborEach: 0,
  }));

  const watermainValves: WatermainValve[] = facts.watermainValves.map((v, i) => ({
    item: i + 1,
    valveSize: v.valveSize,
    quantity: v.quantity,
    valveCost: 0,
    boxCost: rules.watermain.valveBoxCost,
    anodeCost: rules.watermain.valveAnodeCost,
    laborPerValve: rules.watermain.valveLaborPerValve,
  }));

  return {
    projectName: facts.projectName,
    jobNumber: facts.jobNumber,
    date: facts.date,
    templateType: determineTemplateType(
      sewers.filter((s) => !(s.isLineItem && standardFeeKind(s.runLabel))).length,
      manholes.length,
      watermain.length
    ),
    manholes,
    catchbasins,
    sewers,
    watermain,
    watermainSpecials,
    watermainValves,
    confidence: facts.confidence,
    warnings,
    locatorIndex: facts.locatorIndex ?? null,
  };
}
