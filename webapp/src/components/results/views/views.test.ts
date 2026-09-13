import { describe, it, expect } from 'vitest';
import type {
  ExtractionResult,
  Manhole,
  SewerRun,
  WatermainRun,
  WatermainValve,
} from '@/lib/types';
import {
  addOnCost,
  classifySewerSystem,
  formatMetersAt,
  formatSlopePct,
  isPhysicalStructure,
  materialLabel,
  shareOfTotal,
  splitRunLabel,
  structureKind,
  structureTone,
  sumCost,
  sumLength,
  sumQuantity,
  toManholeRows,
  toSewerRunRows,
  toWatermainPipeRows,
  toWatermainValveRows,
  unitCostPerMetre,
  valveGroupCost,
  watermainMaterial,
} from './rows';
import { toneClass } from './ViewSummary';
import { sewerColumns, sewerSummaryFigures, sewerTotals } from './SewerRunTable';
import { countStructures, structureDepth, structuresColumns } from './StructuresView';
import { valveUnitCost, watermainPipeColumns, watermainValveColumns } from './WatermainView';
import {
  TRADE_ORDER,
  buildLedgerLines,
  catchbasinLaborRate,
  grandTotal,
  ledgerColumns,
  tradeTotals,
} from './CostLedgerView';
import {
  DEFAULT_TOKEN_RATES,
  estimateUsdCost,
  formatUsd,
  highlightJson,
  serializeFacts,
  telemetryFigures,
} from './TelemetryView';

// ---------- fixtures ----------

function sewerRun(over: Partial<SewerRun> = {}): SewerRun {
  return {
    item: 1,
    runLabel: 'STM MH 1 - STM MH 2',
    length: 42.5,
    pipeDiameter: 300,
    typeClass: 2.35,
    slope: 1.1,
    depth: 2.6,
    addMaterials: 400,
    addLE: 100,
    isLineItem: false,
    ...over,
  };
}

function manhole(over: Partial<Manhole> = {}): Manhole {
  return {
    item: 1,
    description: 'STMH 1',
    topElevation: 180.5,
    lowInvert: 177.2,
    highInvert: 177.4,
    pipeOutDiameter: 300,
    structureType: 'MH',
    addMaterials: 2400,
    addLE: 600,
    depth: null,
    drop: null,
    diameter: 1200,
    ...over,
  };
}

function watermainRun(over: Partial<WatermainRun> = {}): WatermainRun {
  return {
    item: 1,
    sizeAndType: '200mm PVC C900',
    length: 120,
    pipeDiameter: 200,
    ocSc: 0,
    addMaterials: 1200,
    addLE: 600,
    avgCover: 1.7,
    ...over,
  };
}

function valve(over: Partial<WatermainValve> = {}): WatermainValve {
  return {
    item: 1,
    valveSize: '150mm',
    quantity: 4,
    valveCost: 900,
    boxCost: 150,
    anodeCost: 50,
    laborPerValve: 400,
    ...over,
  };
}

function extraction(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    projectName: 'White Oak',
    jobNumber: '24-114',
    date: '2026-01-01',
    templateType: 'LONG',
    manholes: [manhole()],
    catchbasins: {
      groups: [
        {
          type: 'SINGLE_CB',
          quantity: 6,
          wallThickness: 150,
          depth: 1.8,
          grateEach: 500,
          addMaterials: 300,
        },
      ],
      laborRates: { scbLabor: 700, dcbLabor: 900, dicbFC: 800, ddicbFC: 1000 },
    },
    sewers: [sewerRun(), sewerRun({ item: 2, runLabel: 'SAN MH 4 - SAN MH 5', addMaterials: 900, addLE: 100 })],
    watermain: [watermainRun()],
    watermainSpecials: [
      { item: 1, specialName: 'Hydrant', quantity: 2, costEach: 3000, thrustBlock: 0, anodeCost: 60, laborEach: 900 },
    ],
    watermainValves: [valve()],
    confidence: 0.82,
    warnings: [],
    ...over,
  };
}

// ---------- rows.ts ----------

describe('classifySewerSystem', () => {
  it('reads the system off the run label', () => {
    expect(classifySewerSystem('SAN MH 4 - SAN MH 5')).toBe('SAN');
    expect(classifySewerSystem('sanitary mh 1')).toBe('SAN');
    expect(classifySewerSystem('STM MH 1 - STM MH 2')).toBe('STORM');
    expect(classifySewerSystem('STORM MH 1')).toBe('STORM');
  });

  it('will not guess storm for an unqualified or missing label', () => {
    expect(classifySewerSystem('CB 3-DCBMH 2')).toBe('UNKNOWN');
    expect(classifySewerSystem('')).toBe('UNKNOWN');
    expect(classifySewerSystem(null)).toBe('UNKNOWN');
  });

  it('prefers sanitary when a label somehow names both', () => {
    expect(classifySewerSystem('SAN crossing STM')).toBe('SAN');
  });
});

describe('splitRunLabel', () => {
  it('splits on a spaced separator before a bare hyphen, keeping hyphenated IDs intact', () => {
    expect(splitRunLabel('MH 6-3-1 - MH 7')).toEqual({ from: 'MH 6-3-1', to: 'MH 7' });
    expect(splitRunLabel('CB 3-DCBMH 2')).toEqual({ from: 'CB 3', to: 'DCBMH 2' });
    expect(splitRunLabel('MH 1 to MH 2')).toEqual({ from: 'MH 1', to: 'MH 2' });
  });

  it('treats a separator-less label as an upstream end only', () => {
    expect(splitRunLabel('OUTFALL')).toEqual({ from: 'OUTFALL', to: null });
    expect(splitRunLabel('  ')).toEqual({ from: null, to: null });
    expect(splitRunLabel(undefined)).toEqual({ from: null, to: null });
  });
});

describe('materialLabel', () => {
  it('reconstructs the material from the numeric type class', () => {
    expect(materialLabel(null, 2.35)).toBe('CONC');
    expect(materialLabel(null, 1.3)).toBe('PVC');
    expect(materialLabel(null, 35)).toBe('DR 35');
  });

  it('prefers an explicit material over the derived one', () => {
    expect(materialLabel('hdpe', 2.35)).toBe('HDPE');
    expect(materialLabel('  ', 1.3)).toBe('PVC');
  });

  it('returns null when there is nothing to name', () => {
    expect(materialLabel(null, null)).toBeNull();
    expect(materialLabel(undefined, Number.NaN)).toBeNull();
  });
});

describe('formatSlopePct', () => {
  it('renders slope as-is because it is already a percent value', () => {
    expect(formatSlopePct(1.1)).toBe('1.10%');
    expect(formatSlopePct(0.5, 1)).toBe('0.5%');
    expect(formatSlopePct(null)).toBe('—%');
  });
});

describe('formatMetersAt', () => {
  it('keeps survey precision for elevations instead of rounding to one decimal', () => {
    expect(formatMetersAt(180.53, 2)).toBe('180.53 m');
    expect(formatMetersAt(42.5)).toBe('42.5 m');
    expect(formatMetersAt(null, 2)).toBe('— m');
    expect(formatMetersAt(Number.NaN)).toBe('— m');
  });
});

describe('structureKind', () => {
  it('picks the most specific structure code in the description', () => {
    expect(structureKind({ description: 'STMH 1', depth: 3 })).toBe('MH');
    expect(structureKind({ description: 'CBMH 2', depth: 3 })).toBe('CBMH');
    expect(structureKind({ description: 'DCBMH 2', depth: 3 })).toBe('DCBMH');
    expect(structureKind({ description: 'DCB 4', depth: 2 })).toBe('DCB');
    expect(structureKind({ description: 'CB 5', depth: 2 })).toBe('CB');
    expect(structureKind({ description: 'DICB 6', depth: 2 })).toBe('DICB');
    expect(structureKind({ description: 'DDICB 7', depth: 2 })).toBe('DDICB');
  });

  it('calls a depthless unrecognised row a line item, not a structure', () => {
    expect(structureKind({ description: 'CONSULTING FEE', depth: null })).toBe('ITEM');
    expect(isPhysicalStructure({ description: 'CONSULTING FEE', depth: null })).toBe(false);
    expect(structureKind({ description: 'PRECAST CHAMBER', depth: 4.2 })).toBe('OTHER');
    expect(isPhysicalStructure({ description: 'PRECAST CHAMBER', depth: 4.2 })).toBe(true);
  });
});

describe('structureTone', () => {
  it('accents chambers as structures and inlets as storm', () => {
    expect(structureTone('MH')).toBe('structures');
    expect(structureTone('CBMH')).toBe('structures');
    expect(structureTone('CB')).toBe('storm');
    expect(structureTone('DDICB')).toBe('storm');
    expect(structureTone('ITEM')).toBe('muted');
  });
});

describe('addOnCost / unitCostPerMetre', () => {
  it('sums the estimator add-ons, tolerating missing halves', () => {
    expect(addOnCost({ addMaterials: 400, addLE: 100 })).toBe(500);
    expect(addOnCost({ addMaterials: 400 })).toBe(400);
    expect(addOnCost({})).toBe(0);
  });

  it('divides cost by length, and refuses to divide by a zero or missing length', () => {
    expect(unitCostPerMetre(500, 50)).toBe(10);
    expect(unitCostPerMetre(500, 0)).toBeNull();
    expect(unitCostPerMetre(500, null)).toBeNull();
    expect(unitCostPerMetre(null, 50)).toBeNull();
  });
});

describe('valveGroupCost / valveUnitCost', () => {
  it('extends the per-unit cost by quantity', () => {
    expect(valveUnitCost(valve())).toBe(1500);
    expect(valveGroupCost(valve())).toBe(6000);
    expect(valveGroupCost(valve({ quantity: 0 }))).toBe(0);
  });
});

describe('watermainMaterial', () => {
  it('pulls the material token out of a free-text size and type', () => {
    expect(watermainMaterial('200mm PVC C900')).toBe('PVC');
    expect(watermainMaterial('300mm DI')).toBe('DI');
    expect(watermainMaterial('150mm')).toBeNull();
  });
});

describe('row adapters', () => {
  it('derives ends, material and unit cost for a sewer run', () => {
    const [row] = toSewerRunRows([sewerRun()]);
    expect(row.fromStructure).toBe('STM MH 1');
    expect(row.toStructure).toBe('STM MH 2');
    expect(row.material).toBe('CONC');
    expect(row.totalCost).toBe(500);
    expect(row.unitCost).toBeCloseTo(500 / 42.5);
  });

  it('gives a line-item run no from/to, because it spans no pipe', () => {
    const [row] = toSewerRunRows([
      sewerRun({ runLabel: 'AS BUILT', isLineItem: true, lineItemType: 'AS_BUILT', length: null }),
    ]);
    expect(row.fromStructure).toBeNull();
    expect(row.toStructure).toBeNull();
    expect(row.unitCost).toBeNull();
  });

  it('maps a drop manhole into a benching note', () => {
    expect(toManholeRows([manhole({ drop: 1.25 })])[0].benching).toBe('Drop 1.25 m');
    expect(toManholeRows([manhole()])[0].benching).toBeNull();
    expect(toManholeRows([manhole()])[0].totalCost).toBe(3000);
  });

  it('maps watermain pipes and valves', () => {
    const [pipe] = toWatermainPipeRows([watermainRun()]);
    expect(pipe.material).toBe('PVC');
    expect(pipe.totalCost).toBe(1800);
    expect(pipe.unitCost).toBeCloseTo(15);

    const [v] = toWatermainValveRows([valve()]);
    expect(v.itemName).toBe('150mm');
    expect(v.totalCost).toBe(6000);
  });

  it('returns an empty list rather than throwing on missing input', () => {
    expect(toSewerRunRows(null)).toEqual([]);
    expect(toManholeRows(undefined)).toEqual([]);
    expect(toWatermainPipeRows(null)).toEqual([]);
    expect(toWatermainValveRows(undefined)).toEqual([]);
  });
});

describe('aggregation helpers', () => {
  it('sums lengths, costs and quantities over nullable fields', () => {
    expect(sumLength([{ length: 10 }, { length: null }, { length: 5 }])).toBe(15);
    expect(sumCost([{ totalCost: 100 }, {}, { totalCost: 50 }])).toBe(150);
    expect(sumQuantity([{ quantity: 2 }, { quantity: null }, { quantity: 3 }])).toBe(5);
    expect(sumLength([])).toBe(0);
  });
});

describe('shareOfTotal', () => {
  it('is a 0..1 share, clamped, and zero when the total is not positive', () => {
    expect(shareOfTotal(25, 100)).toBe(0.25);
    expect(shareOfTotal(150, 100)).toBe(1);
    expect(shareOfTotal(25, 0)).toBe(0);
    expect(shareOfTotal(-5, 100)).toBe(0);
    expect(shareOfTotal(25, Number.NaN)).toBe(0);
  });
});

// ---------- ViewSummary ----------

describe('toneClass', () => {
  it('adds an accent modifier only for a real trade tone', () => {
    expect(toneClass('storm')).toBe('is-storm');
    expect(toneClass('water')).toBe('is-water');
    expect(toneClass('neutral')).toBe('');
    expect(toneClass(undefined)).toBe('');
  });
});

// ---------- SewerRunTable ----------

describe('sewerTotals', () => {
  it('counts only physical runs but totals every priced row', () => {
    const rows = toSewerRunRows([
      sewerRun(),
      sewerRun({ item: 2, length: 10, addMaterials: 100, addLE: 0 }),
      sewerRun({ item: 3, runLabel: 'VIDEO', isLineItem: true, length: null, addMaterials: 250, addLE: 0 }),
    ]);
    const totals = sewerTotals(rows);
    expect(totals.runCount).toBe(2);
    expect(totals.totalLength).toBeCloseTo(52.5);
    expect(totals.totalCost).toBe(850);
  });
});

describe('sewerColumns', () => {
  it('exposes the ten takeoff columns in reading order', () => {
    expect(sewerColumns('storm').map((c) => c.key)).toEqual([
      'runLabel',
      'from',
      'to',
      'pipeDiameter',
      'material',
      'length',
      'slope',
      'depth',
      'unitCost',
      'totalCost',
    ]);
  });

  it('right-aligns every numeric column with the mono numeric class', () => {
    const numeric = ['pipeDiameter', 'length', 'slope', 'depth', 'unitCost', 'totalCost'];
    for (const column of sewerColumns('sanitary')) {
      if (numeric.includes(column.key as string)) {
        expect(column.align).toBe('right');
        expect(column.className).toContain('numeric');
      }
    }
  });
});

describe('sewerSummaryFigures', () => {
  it('names the trade and carries the caller-supplied totals', () => {
    const rows = toSewerRunRows([sewerRun()]);
    const storm = sewerSummaryFigures('storm', rows, 12345, 210.4);
    expect(storm.map((f) => f.key)).toEqual(['runs', 'length', 'cost']);
    expect(storm[0].label).toBe('Storm runs');
    expect(storm[1].value).toBe('210.4 m');
    expect(storm[2].value).toBe('$12,345');
    expect(storm.every((f) => f.tone === 'storm')).toBe(true);

    const sanitary = sewerSummaryFigures('sanitary', rows, 1, 1);
    expect(sanitary[0].label).toBe('Sanitary runs');
    expect(sanitary.every((f) => f.tone === 'sanitary')).toBe(true);
  });
});

// ---------- StructuresView ----------

describe('structureDepth', () => {
  it('prefers the recorded depth over a derived one', () => {
    expect(structureDepth({ depth: 3.4, topElevation: 100, lowInvert: 90 })).toBe(3.4);
  });

  it('derives rim minus invert only when both elevations exist', () => {
    expect(structureDepth({ depth: null, topElevation: 180.5, lowInvert: 177.2 })).toBeCloseTo(3.3);
    expect(structureDepth({ depth: null, topElevation: null, lowInvert: 177.2 })).toBeNull();
    expect(structureDepth({ depth: null, topElevation: 180.5, lowInvert: null })).toBeNull();
  });
});

describe('countStructures', () => {
  it('excludes fee and allowance rows from the structure count', () => {
    const rows = toManholeRows([
      manhole({ description: 'STMH 1' }),
      manhole({ item: 2, description: 'CB 4', depth: 1.8 }),
      manhole({ item: 3, description: 'CONSULTING FEE', depth: null, topElevation: null, lowInvert: null }),
    ]);
    expect(rows).toHaveLength(3);
    expect(countStructures(rows)).toBe(2);
  });
});

describe('structuresColumns', () => {
  it('exposes the nine structure columns in reading order', () => {
    expect(structuresColumns().map((c) => c.key)).toEqual([
      'description',
      'type',
      'diameter',
      'topElevation',
      'lowInvert',
      'depth',
      'benching',
      'unitCost',
      'totalCost',
    ]);
  });
});

// ---------- WatermainView ----------

describe('watermain columns', () => {
  it('keeps pipe (per metre) and valves (per unit) as separate tables', () => {
    expect(watermainPipeColumns().map((c) => c.key)).toEqual([
      'sizeAndType',
      'pipeDiameter',
      'material',
      'length',
      'avgCover',
      'unitCost',
      'totalCost',
    ]);
    expect(watermainValveColumns().map((c) => c.key)).toEqual([
      'itemName',
      'valveSize',
      'quantity',
      'valveCost',
      'boxCost',
      'anodeCost',
      'laborPerValve',
      'totalCost',
    ]);
  });
});

// ---------- CostLedgerView ----------

describe('catchbasinLaborRate', () => {
  it('maps each catchbasin family to its own labour rate', () => {
    const rates = { scbLabor: 700, dcbLabor: 900, dicbFC: 800, ddicbFC: 1000 };
    expect(catchbasinLaborRate('SINGLE_CB', rates)).toBe(700);
    expect(catchbasinLaborRate('DOUBLE_CB', rates)).toBe(900);
    expect(catchbasinLaborRate('DITCH_INLET_CB', rates)).toBe(800);
    expect(catchbasinLaborRate('DOUBLE_DITCH_INLET_CB', rates)).toBe(1000);
    expect(catchbasinLaborRate('SINGLE_CB', undefined)).toBe(0);
    expect(catchbasinLaborRate('MYSTERY', rates)).toBe(0);
  });
});

describe('buildLedgerLines', () => {
  const lines = buildLedgerLines(extraction());

  it('assigns each sewer run to storm or sanitary by its label', () => {
    const sewers = lines.filter((l) => l.trade === 'storm' || l.trade === 'sanitary');
    expect(sewers.map((l) => l.trade)).toEqual(['storm', 'sanitary']);
  });

  it('puts manholes and catchbasins together under structures', () => {
    const structures = lines.filter((l) => l.trade === 'structures');
    expect(structures.map((l) => l.description)).toEqual(['STMH 1', 'Single catchbasin']);
    // 6 × ($500 grate + $700 labour) + $300 materials
    expect(structures[1].cost).toBe(7500);
  });

  it('separates watermain pipe from valves and specials', () => {
    expect(lines.filter((l) => l.trade === 'watermain').map((l) => l.cost)).toEqual([1800]);
    const appurtenances = lines.filter((l) => l.trade === 'appurtenances');
    expect(appurtenances.map((l) => l.description)).toEqual(['150mm valve', 'Hydrant']);
    expect(appurtenances[0].cost).toBe(6000);
    // 2 × ($3000 each + $60 anode + $900 labour)
    expect(appurtenances[1].cost).toBe(7920);
  });

  it('survives a takeoff with nothing in it', () => {
    const empty = buildLedgerLines(
      extraction({
        sewers: [],
        manholes: [],
        catchbasins: { groups: [], laborRates: { scbLabor: 0, dcbLabor: 0, dicbFC: 0, ddicbFC: 0 } },
        watermain: [],
        watermainValves: [],
        watermainSpecials: [],
      })
    );
    expect(empty).toEqual([]);
    expect(grandTotal(empty)).toBe(0);
    expect(tradeTotals(empty).every((t) => t.cost === 0 && t.itemCount === 0)).toBe(true);
  });
});

describe('tradeTotals', () => {
  const lines = buildLedgerLines(extraction());
  const totals = tradeTotals(lines);

  it('always returns all five trades in a fixed order so the cards never reshuffle', () => {
    expect(totals.map((t) => t.key)).toEqual(TRADE_ORDER);
    expect(totals.map((t) => t.key)).toEqual([
      'storm',
      'sanitary',
      'structures',
      'watermain',
      'appurtenances',
    ]);
  });

  it('reconciles the trade subtotals against the grand total', () => {
    expect(totals.reduce((acc, t) => acc + t.cost, 0)).toBe(grandTotal(lines));
    expect(grandTotal(lines)).toBe(500 + 1000 + 3000 + 7500 + 1800 + 6000 + 7920);
  });

  it('gives each trade its own accent', () => {
    expect(totals.map((t) => t.tone)).toEqual([
      'storm',
      'sanitary',
      'structures',
      'water',
      'muted',
    ]);
  });
});

describe('ledgerColumns', () => {
  it('shows trade, item, quantity and cost', () => {
    expect(ledgerColumns().map((c) => c.key)).toEqual(['trade', 'description', 'quantity', 'cost']);
  });
});

// ---------- TelemetryView ----------

describe('estimateUsdCost', () => {
  it('prices input and output tokens at their separate rates', () => {
    const cost = estimateUsdCost({
      promptTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 2_000_000,
      llmCalls: 4,
      tiles: 12,
      dpi: 200,
    });
    expect(cost).toBeCloseTo(DEFAULT_TOKEN_RATES.inputPerMillion + DEFAULT_TOKEN_RATES.outputPerMillion);
  });

  it('honours an overridden rate card', () => {
    const cost = estimateUsdCost(
      { promptTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, llmCalls: 1, tiles: 1, dpi: 200 },
      { inputPerMillion: 10, outputPerMillion: 0 }
    );
    expect(cost).toBeCloseTo(10);
  });

  it('returns null — not $0 — when there is no telemetry to price', () => {
    expect(estimateUsdCost(undefined)).toBeNull();
    expect(estimateUsdCost(null)).toBeNull();
    expect(
      estimateUsdCost({ promptTokens: 0, outputTokens: 0, totalTokens: 0, llmCalls: 0, tiles: 0, dpi: 0 })
    ).toBeNull();
  });
});

describe('formatUsd', () => {
  it('keeps four decimals because a run often costs under a cent', () => {
    expect(formatUsd(0.00123)).toBe('$0.0012');
    expect(formatUsd(1.5)).toBe('$1.5000');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('telemetryFigures', () => {
  const cost = {
    promptTokens: 120_000,
    outputTokens: 8_000,
    totalTokens: 128_000,
    llmCalls: 6,
    tiles: 14,
    dpi: 200,
  };

  it('surfaces calls, tokens, tiles, DPI and the USD estimate', () => {
    const figures = telemetryFigures(cost);
    expect(figures.map((f) => f.key)).toEqual(['llmCalls', 'tokens', 'tiles', 'dpi', 'usd']);
    expect(figures[0].value).toBe('6');
    expect(figures[1].value).toBe('128000');
    expect(figures[2].value).toBe('14');
    expect(figures[3].value).toBe('200');
  });

  it('shows em dashes rather than zeros when a run recorded no telemetry', () => {
    const figures = telemetryFigures(undefined);
    expect(figures.slice(0, 4).map((f) => f.value)).toEqual(['—', '—', '—', '—']);
    expect(figures[4].value).toBe('—');
  });
});

describe('highlightJson', () => {
  it('distinguishes keys from string values', () => {
    const tokens = highlightJson('{"name":"White Oak"}');
    expect(tokens.filter((t) => t.type === 'key').map((t) => t.text)).toEqual(['"name"']);
    expect(tokens.filter((t) => t.type === 'string').map((t) => t.text)).toEqual(['"White Oak"']);
  });

  it('tags numbers, booleans and null separately', () => {
    const tokens = highlightJson('{"a":1.5,"b":-2e3,"c":true,"d":null}');
    expect(tokens.filter((t) => t.type === 'number').map((t) => t.text)).toEqual(['1.5', '-2e3']);
    expect(tokens.filter((t) => t.type === 'boolean').map((t) => t.text)).toEqual(['true']);
    expect(tokens.filter((t) => t.type === 'null').map((t) => t.text)).toEqual(['null']);
  });

  it('does not highlight literals that merely appear inside a string', () => {
    const tokens = highlightJson('{"note":"true 42 null"}');
    expect(tokens.some((t) => t.type === 'number' || t.type === 'boolean' || t.type === 'null')).toBe(false);
  });

  it('is lossless — concatenating the tokens rebuilds the input exactly', () => {
    const json = serializeFacts(extraction());
    expect(highlightJson(json).map((t) => t.text).join('')).toBe(json);
    expect(highlightJson('').map((t) => t.text).join('')).toBe('');
  });
});

describe('serializeFacts', () => {
  it('pretty-prints with stable two-space indentation', () => {
    const json = serializeFacts(extraction());
    expect(json.split('\n')[1].startsWith('  "')).toBe(true);
    expect(JSON.parse(json).jobNumber).toBe('24-114');
  });
});
