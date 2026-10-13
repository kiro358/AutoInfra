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
  WithheldItem,
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
  // Withheld/derived bookkeeping: carried in from the facts (values the
  // assembly never read) and extended below with every default or derivation
  // THIS function applies, so the workbook's AUDIT sheet can show the
  // estimator every number that was not read off the drawings. Recording
  // never changes a value — the defaults below are exactly the ones that
  // were always applied; they just stop being silent.
  const withheld: WithheldItem[] = [...(facts.withheld ?? [])];

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
      source: s.source,
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
      if (calc > 0) {
        depth = calc;
        withheld.push({
          entity: st.description,
          field: 'depth',
          kind: 'derived',
          question: `Depth not stated as such; computed from the read rim and invert elevations (top − low invert).`,
          defaultApplied: { value: calc, source: 'derived: topElevation − lowInvert' },
        });
      }
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

    // An unstated diameter is never a read value: record how it was arrived
    // at (convention for DCBMH, derivation from the connected pipes, or the
    // bare fallback invention) so the AUDIT sheet can show it.
    if (!isChamber && !stated && diameter !== null) {
      if (desc.includes('DCBMH')) {
        withheld.push({
          entity: st.description,
          field: 'diameter',
          kind: 'defaulted',
          question: `Structure size not stated on the drawing — priced as a 1500mm DCBMH by convention. Confirm the size.`,
          defaultApplied: { value: diameter, source: 'costing convention: unstated DCBMH = 1500mm' },
        });
      } else if (effectivePipeOutDia > 0) {
        withheld.push({
          entity: st.description,
          field: 'diameter',
          kind: 'derived',
          question: `Structure size not stated on the drawing; sized from the largest connected pipe (${effectivePipeOutDia}mm).`,
          defaultApplied: { value: diameter, source: 'derived: snapToMHSize(largest connected pipe)' },
        });
      } else {
        withheld.push({
          entity: st.description,
          field: 'diameter',
          kind: 'defaulted',
          question: `Structure size not stated on the drawing and no connected pipe was read — priced as 1200mm. Confirm the size.`,
          defaultApplied: { value: diameter, source: 'snapToMHSize fallback (no size evidence)' },
        });
      }
    }

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
      source: st.source,
    };
  });

  // --- Catchbasins ---
  const catchbasins: CatchbasinSummary = {
    groups: facts.catchbasins
      .filter((g) => g.quantity > 0)
      .map((g) => {
        const entity = `Catchbasins ${g.type} ×${g.quantity}`;
        if (g.wallThickness == null) {
          withheld.push({
            entity,
            field: 'wallThickness',
            kind: 'defaulted',
            question: `Catchbasin wall thickness not read off the drawings — the standard ${rules.catchbasin.defaultWallThickness} was priced. Confirm.`,
            defaultApplied: { value: rules.catchbasin.defaultWallThickness, source: 'estimator default (costing-rules catchbasin.defaultWallThickness)' },
          });
        }
        if (g.depth == null) {
          withheld.push({
            entity,
            field: 'depth',
            kind: 'defaulted',
            question: `Catchbasin depth not read off the drawings — the standard ${rules.catchbasin.defaultDepth}m was priced. Confirm.`,
            defaultApplied: { value: rules.catchbasin.defaultDepth, source: 'estimator default (costing-rules catchbasin.defaultDepth)' },
          });
        }
        return {
          type: g.type,
          quantity: g.quantity,
          wallThickness: g.wallThickness ?? rules.catchbasin.defaultWallThickness,
          depth: g.depth ?? rules.catchbasin.defaultDepth,
          grateEach: 0,
          addMaterials: rules.catchbasin.defaultAddMaterials,
          source: g.source,
        };
      }),
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
  const watermain: WatermainRun[] = facts.watermain.map((w, i) => {
    // Facts carry null when the drawing/truth never stated these; the
    // estimator defaults live HERE, at pricing, where they always belonged —
    // and from now on each application is recorded as a withheld item.
    if (w.ocSc == null) {
      withheld.push({
        entity: w.sizeAndType,
        field: 'ocSc',
        kind: 'defaulted',
        question: `Overburden class (OC/SC) for the ${w.sizeAndType} watermain was not stated — the standard 1.1 was priced. Confirm.`,
        defaultApplied: { value: 1.1, source: 'estimator default (costing-rules)' },
      });
    }
    if (w.avgCover == null) {
      withheld.push({
        entity: w.sizeAndType,
        field: 'avgCover',
        kind: 'defaulted',
        question: `Average cover for the ${w.sizeAndType} watermain was not stated — the standard 1.8m was priced. Confirm.`,
        defaultApplied: { value: 1.8, source: 'estimator default (costing-rules)' },
      });
    }
    return {
      item: i + 1,
      sizeAndType: w.sizeAndType,
      length: w.length,
      pipeDiameter: w.pipeDiameter,
      ocSc: w.ocSc ?? 1.1,
      addMaterials: 0,
      addLE: 0,
      avgCover: w.avgCover ?? 1.8,
      source: w.source,
    };
  });

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
    withheld: dedupeWithheld(withheld),
    locatorIndex: facts.locatorIndex ?? null,
  };
}

/**
 * Collapse repeated withheld items before they reach the workbook. Assembly
 * records one item per unmeasured callout, but pricing aggregates (watermain
 * is summed by diameter), and a repetitive plan can carry hundreds of
 * identical unmeasured labels for what becomes one priced row — the AUDIT
 * sheet should ask the question once, with the count, not 600 times.
 */
function dedupeWithheld(items: WithheldItem[]): WithheldItem[] {
  const seen = new Map<string, { item: WithheldItem; count: number }>();
  for (const item of items) {
    const key = [
      item.entity, item.field, item.kind, item.question,
      item.defaultApplied ? `${item.defaultApplied.value}|${item.defaultApplied.source}` : '',
    ].join('|');
    const ex = seen.get(key);
    if (ex) ex.count++;
    else seen.set(key, { item, count: 1 });
  }
  return [...seen.values()].map(({ item, count }) =>
    count > 1 ? { ...item, question: `${item.question} [${count} callouts]` } : item
  );
}
