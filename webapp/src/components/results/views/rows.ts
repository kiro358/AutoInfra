/**
 * Row view-models for the results tables.
 *
 * `ExtractionResult` (types.ts) is the *priced* takeoff shaped for the xlsx
 * template — it carries no display-ready "from / to structure", no material
 * name, and no per-row unit price (the template's base price is a spreadsheet
 * formula, not a field). The tables need all three, so each domain view takes a
 * flat row type that the caller builds with the `to*Rows` adapters below.
 *
 * Rows are declared as type ALIASES, not interfaces, on purpose: `DataTable<T>`
 * constrains `T extends Record<string, any>` and interfaces have no implicit
 * index signature, so an interface row would not satisfy the constraint.
 *
 * Everything here is pure — no JSX, no React — so it is unit-testable and safe
 * to import from a server component.
 */
import type {
  Manhole,
  SewerRun,
  TakeoffFacts,
  WatermainRun,
  WatermainValve,
} from '@/lib/types';

// ============ Row types ============

/** One sewer run (storm or sanitary) as rendered in a table. */
export type SewerRunRow = {
  item?: number;
  runLabel: string;
  /** Upstream structure label, parsed off `runLabel` unless supplied. */
  fromStructure?: string | null;
  /** Downstream structure label, parsed off `runLabel` unless supplied. */
  toStructure?: string | null;
  length: number | null;
  pipeDiameter: number | null;
  /** Display material ("CONC", "PVC", "DR 35"); derived from typeClass if absent. */
  material?: string | null;
  typeClass?: number | null;
  /** Slope as a PERCENT value (1.1 means 1.1%), matching `SewerRun.slope`. */
  slope: number | null;
  depth: number | null;
  /** Dollars per linear metre. Derived from `totalCost / length` when absent. */
  unitCost?: number | null;
  totalCost?: number | null;
  /** Non-physical rows (LAYOUT, VIDEO, AS BUILT) have no from/to and no length. */
  isLineItem?: boolean;
  lineItemType?: string;
};

/** One structure — manhole, catchbasin, inlet — as rendered in a table. */
export type ManholeRow = {
  item?: number;
  description: string;
  /** Raw estimator structure type token, e.g. "MH", "CBMH", "BENCH". */
  structureType?: string | null;
  diameter: number | null;
  topElevation: number | null;
  lowInvert: number | null;
  highInvert?: number | null;
  depth: number | null;
  /** Benching note, when the estimator recorded one. */
  benching?: string | null;
  unitCost?: number | null;
  totalCost?: number | null;
};

/** One watermain pipe run. */
export type WatermainPipeRow = {
  item?: number;
  sizeAndType: string;
  pipeDiameter: number | null;
  material?: string | null;
  length: number | null;
  avgCover?: number | null;
  unitCost?: number | null;
  totalCost?: number | null;
};

/** One valve / hydrant / fitting group. */
export type WatermainValveRow = {
  item?: number;
  /** Display name for the appurtenance; falls back to the valve size. */
  itemName?: string | null;
  valveSize: string;
  quantity: number;
  valveCost: number;
  boxCost: number;
  anodeCost: number;
  laborPerValve: number;
  totalCost?: number | null;
};

/** Extraction runtime telemetry, kept in lockstep with `TakeoffFacts['cost']`. */
export type FactsCostTelemetry = NonNullable<TakeoffFacts['cost']>;

// ============ Label parsing ============

export type SewerSystem = 'STORM' | 'SAN' | 'UNKNOWN';

const SAN_RE = /\bSAN(?:ITARY)?\b/i;
const STORM_RE = /\b(?:STM|STORM)\b/i;

/**
 * Which system a run belongs to, read off its label. Storm is NOT the default:
 * an unqualified label ("CB 3-DCBMH 2") returns UNKNOWN so the caller decides
 * where to put it rather than silently inflating the storm table.
 */
export function classifySewerSystem(runLabel: string | null | undefined): SewerSystem {
  if (!runLabel) return 'UNKNOWN';
  if (SAN_RE.test(runLabel)) return 'SAN';
  if (STORM_RE.test(runLabel)) return 'STORM';
  return 'UNKNOWN';
}

/** Spaced separator wins over a bare hyphen so "MH 6-3-1 - MH 7" splits correctly. */
const SPACED_SPLIT = /^(.*?)\s+(?:-|–|—|to)\s+(.+)$/i;
const TIGHT_SPLIT = /^(.*?)\s*[-–—]\s*(.+)$/;

/**
 * "CB 3-DCBMH 2" -> { from: "CB 3", to: "DCBMH 2" }.
 * A label with no separator is the upstream end with no downstream end.
 */
export function splitRunLabel(runLabel: string | null | undefined): {
  from: string | null;
  to: string | null;
} {
  const cleaned = (runLabel ?? '').trim();
  if (!cleaned) return { from: null, to: null };

  const match = SPACED_SPLIT.exec(cleaned) ?? TIGHT_SPLIT.exec(cleaned);
  if (!match) return { from: cleaned, to: null };

  const from = match[1].trim();
  const to = match[2].trim();
  if (!from || !to) return { from: cleaned, to: null };
  return { from, to };
}

/**
 * Display material for a sewer run. The estimator records material as a numeric
 * `typeClass` (2.35 = concrete, 1.3 = PVC, an integer = the DR series), so the
 * name has to be reconstructed when the drawing text isn't carried through.
 */
export function materialLabel(
  material: string | null | undefined,
  typeClass: number | null | undefined
): string | null {
  if (material && material.trim()) return material.trim().toUpperCase();
  if (typeClass == null || isNaN(typeClass)) return null;
  if (Math.abs(typeClass - 2.35) < 0.005) return 'CONC';
  if (Math.abs(typeClass - 1.3) < 0.005) return 'PVC';
  if (Number.isInteger(typeClass) && typeClass >= 8) return `DR ${typeClass}`;
  return `CL ${typeClass}`;
}

/**
 * Metres at a caller-chosen precision.
 *
 * `formatMeters` in `@/lib/formatters` is fixed at 1 decimal, which is right for
 * pipe lengths but wrong for surveyed rim/invert elevations — those are given to
 * 2 decimals on the drawing, and rounding 180.53 to 180.5 in a takeoff table
 * silently drops a centimetre of real data. Kept local rather than widening the
 * shared formatter, which other views depend on.
 */
export function formatMetersAt(value: number | null | undefined, decimals = 1): string {
  if (value == null || isNaN(value)) return '— m';
  return `${Number(value).toFixed(decimals)} m`;
}

/** Slope is stored as a percent VALUE (1.1 === 1.1%), so it must not be ×100'd. */
export function formatSlopePct(slope: number | null | undefined, decimals = 2): string {
  if (slope == null || isNaN(slope)) return '—%';
  return `${Number(slope).toFixed(decimals)}%`;
}

// ============ Structure classification ============

export type StructureKind =
  | 'MH'
  | 'CBMH'
  | 'DCBMH'
  | 'CB'
  | 'DCB'
  | 'DICB'
  | 'DDICB'
  | 'ITEM'
  | 'OTHER';

/** Badge tone per structure family — chambers draw structures, inlets draw storm. */
export type StructureTone = 'structures' | 'storm' | 'muted';

const KIND_PATTERNS: ReadonlyArray<[StructureKind, RegExp]> = [
  ['DDICB', /\bDDICB\b/i],
  ['DCBMH', /\bDCBMH\b/i],
  ['DICB', /\bDICB\b/i],
  ['CBMH', /\bCBMH\b/i],
  ['DCB', /\bDCB\b/i],
  ['CB', /\bCB\b/i],
  ['MH', /\b(?:MH|STMH|SANMH)\b/i],
];

/**
 * Classify a structure row. Rows with no depth and no recognisable structure
 * code are estimator LINE ITEMS ("CONSULTING FEE", "SAW CUT"), not structures —
 * calling them "OTHER" structures would double-count them in the structure total.
 */
export function structureKind(row: {
  description?: string | null;
  depth?: number | null;
}): StructureKind {
  const description = row.description ?? '';
  for (const [kind, re] of KIND_PATTERNS) {
    if (re.test(description)) return kind;
  }
  return row.depth == null ? 'ITEM' : 'OTHER';
}

export function structureTone(kind: StructureKind): StructureTone {
  if (kind === 'MH' || kind === 'CBMH' || kind === 'DCBMH') return 'structures';
  if (kind === 'CB' || kind === 'DCB' || kind === 'DICB' || kind === 'DDICB') return 'storm';
  return 'muted';
}

/** True for rows that represent a physical structure rather than a fee/allowance. */
export function isPhysicalStructure(row: { description?: string | null; depth?: number | null }): boolean {
  return structureKind(row) !== 'ITEM';
}

// ============ Cost derivation ============

/**
 * The only dollars present on a priced sewer/structure row are the estimator's
 * material + labor/equipment ADD-ONS (`addMaterials` / `addLE`). The template's
 * base price is a spreadsheet formula and never lands in `ExtractionResult`, so
 * that is what these tables show. A caller holding richer pricing can pass
 * `unitCost` / `totalCost` explicitly and this derivation is skipped.
 */
export function addOnCost(source: { addMaterials?: number | null; addLE?: number | null }): number {
  return (source.addMaterials ?? 0) + (source.addLE ?? 0);
}

/** $/m for a run, guarding a zero or missing length. */
export function unitCostPerMetre(
  totalCost: number | null | undefined,
  length: number | null | undefined
): number | null {
  if (totalCost == null || length == null || !isFinite(length) || length <= 0) return null;
  return totalCost / length;
}

/** All-in cost of a valve group: quantity × (valve + box + anode + labor). */
export function valveGroupCost(valve: {
  quantity?: number | null;
  valveCost?: number | null;
  boxCost?: number | null;
  anodeCost?: number | null;
  laborPerValve?: number | null;
}): number {
  const each =
    (valve.valveCost ?? 0) + (valve.boxCost ?? 0) + (valve.anodeCost ?? 0) + (valve.laborPerValve ?? 0);
  return (valve.quantity ?? 0) * each;
}

// ============ Adapters: ExtractionResult -> rows ============

export function toSewerRunRows(runs: SewerRun[] | null | undefined): SewerRunRow[] {
  return (runs ?? []).map((run) => {
    const totalCost = addOnCost(run);
    const ends = run.isLineItem ? { from: null, to: null } : splitRunLabel(run.runLabel);
    return {
      item: run.item,
      runLabel: run.runLabel,
      fromStructure: ends.from,
      toStructure: ends.to,
      length: run.length,
      pipeDiameter: run.pipeDiameter,
      material: materialLabel(null, run.typeClass),
      typeClass: run.typeClass,
      slope: run.slope,
      depth: run.depth,
      unitCost: unitCostPerMetre(totalCost, run.length),
      totalCost,
      isLineItem: run.isLineItem,
      lineItemType: run.lineItemType,
    };
  });
}

export function toManholeRows(manholes: Manhole[] | null | undefined): ManholeRow[] {
  return (manholes ?? []).map((mh) => ({
    item: mh.item,
    description: mh.description,
    structureType: mh.structureType,
    diameter: mh.diameter,
    topElevation: mh.topElevation,
    lowInvert: mh.lowInvert,
    highInvert: mh.highInvert,
    depth: mh.depth,
    benching: mh.drop != null ? `Drop ${mh.drop.toFixed(2)} m` : null,
    unitCost: mh.addMaterials ?? null,
    totalCost: addOnCost(mh),
  }));
}

export function toWatermainPipeRows(runs: WatermainRun[] | null | undefined): WatermainPipeRow[] {
  return (runs ?? []).map((run) => {
    const totalCost = addOnCost(run);
    return {
      item: run.item,
      sizeAndType: run.sizeAndType,
      pipeDiameter: run.pipeDiameter ?? null,
      material: watermainMaterial(run.sizeAndType),
      length: run.length ?? null,
      avgCover: run.avgCover ?? null,
      unitCost: unitCostPerMetre(totalCost, run.length),
      totalCost,
    };
  });
}

const WM_MATERIAL_RE = /\b(PVC|HDPE|DI|CI|CONC|C900|CPP)\b/i;

/** Pulls the material out of a free-text size/type string ("200mm PVC C900"). */
export function watermainMaterial(sizeAndType: string | null | undefined): string | null {
  const match = WM_MATERIAL_RE.exec(sizeAndType ?? '');
  return match ? match[1].toUpperCase() : null;
}

export function toWatermainValveRows(
  valves: WatermainValve[] | null | undefined
): WatermainValveRow[] {
  return (valves ?? []).map((valve) => ({
    item: valve.item,
    itemName: valve.valveSize,
    valveSize: valve.valveSize,
    quantity: valve.quantity,
    valveCost: valve.valveCost,
    boxCost: valve.boxCost,
    anodeCost: valve.anodeCost,
    laborPerValve: valve.laborPerValve,
    totalCost: valveGroupCost(valve),
  }));
}

// ============ Aggregation ============

export function sumLength(rows: ReadonlyArray<{ length?: number | null }>): number {
  return rows.reduce((acc, row) => acc + (row.length ?? 0), 0);
}

export function sumCost(rows: ReadonlyArray<{ totalCost?: number | null }>): number {
  return rows.reduce((acc, row) => acc + (row.totalCost ?? 0), 0);
}

export function sumQuantity(rows: ReadonlyArray<{ quantity?: number | null }>): number {
  return rows.reduce((acc, row) => acc + (row.quantity ?? 0), 0);
}

/** Share of a total, clamped to [0,1] and 0 when the total is zero/invalid. */
export function shareOfTotal(value: number, total: number): number {
  if (!isFinite(total) || total <= 0 || !isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / total);
}
