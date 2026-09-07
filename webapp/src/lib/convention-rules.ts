/**
 * Estimator Convention Calibration & Rule Engine.
 *
 * Reconciles as-drawn CAD facts with estimator workbook conventions
 * (segment aggregation, structure center-to-center offsets, length rounding,
 * catchbasin lead grouping, and label style preferences).
 *
 * Rules are stored as explicit, declarative, versioned parameter tables
 * (modeled after costing-rules.ts::DEFAULT_COSTING) — pure functions, zero LLM calls.
 */
import {
  CatchbasinGroupFact,
  SewerFact,
  StructureFact,
  TakeoffFacts,
  WatermainFact,
} from './types';

export interface EstimatorConventions {
  version: string;
  name: string;
  aggregateConnectedRuns: boolean;
  lengthRounding: 'none' | 'round' | 'ceil' | 'center-offset';
  structureCenterOffsetM: number; // e.g. 0.0 - 1.5m
  groupCbLeads: boolean;
  normalizeLabels: boolean;
  aggregateWatermainByDiameter: boolean;
  defaultPipeCoverMeters: number;
}

export const DEFAULT_CONVENTIONS: EstimatorConventions = {
  version: '2026-09-01',
  name: 'Ontario Municipal Default Conventions',
  aggregateConnectedRuns: true,
  lengthRounding: 'none',
  structureCenterOffsetM: 0.0,
  groupCbLeads: true,
  normalizeLabels: true,
  aggregateWatermainByDiameter: true,
  defaultPipeCoverMeters: 2.0,
};

/**
 * Normalizes structure label (e.g. "MH01" -> "MH 1", "STMH 02" -> "STMH 2").
 */
export function normalizeStructureLabel(label: string): string {
  const trimmed = label.trim().toUpperCase();
  // Match prefix + leading zeros + number, e.g. "MH01", "STMH 003"
  const m = trimmed.match(/^([A-Z\s.-]+?)0*(\d+)([A-Z]?)$/i);
  if (m) {
    const prefix = m[1].replace(/\s+/g, ' ').trim();
    const num = m[2];
    const suffix = m[3] ? m[3].toUpperCase() : '';
    return `${prefix} ${num}${suffix}`.trim();
  }
  return trimmed;
}

/**
 * Aggregates watermain runs by diameter into summary line items.
 */
export function aggregateWatermain(runs: WatermainFact[]): WatermainFact[] {
  const byDiameter = new Map<number, { length: number; mat: string; ocSc: number; avgCover: number }>();

  for (const r of runs) {
    const dia = r.pipeDiameter || 150;
    const existing = byDiameter.get(dia);
    if (existing) {
      existing.length += r.length;
    } else {
      const mat = r.sizeAndType.includes('PVC') ? 'PVC' : r.sizeAndType.includes('HDPE') ? 'HDPE' : 'PVC';
      byDiameter.set(dia, {
        length: r.length,
        mat,
        ocSc: r.ocSc || 1.1,
        avgCover: r.avgCover || 1.8,
      });
    }
  }

  const aggregated: WatermainFact[] = [];
  for (const [dia, data] of byDiameter) {
    aggregated.push({
      sizeAndType: `${dia}mm ${data.mat} WATERMAIN`,
      length: Math.round(data.length * 10) / 10,
      pipeDiameter: dia,
      ocSc: data.ocSc,
      avgCover: data.avgCover,
    });
  }

  return aggregated;
}

/**
 * Applies estimator conventions to convert as-drawn CAD facts into workbook-aligned facts.
 */
export function applyEstimatorConventions(
  asDrawn: TakeoffFacts,
  conventions: EstimatorConventions = DEFAULT_CONVENTIONS
): TakeoffFacts {
  // 1. Structure labels & depths
  const structures: StructureFact[] = asDrawn.structures.map((s) => {
    let desc = s.description;
    if (conventions.normalizeLabels) {
      desc = normalizeStructureLabel(desc);
    }
    return {
      ...s,
      description: desc,
    };
  });

  // 2. Sewer runs: label normalization, length rounding / center offsets
  const sewers: SewerFact[] = asDrawn.sewers.map((s) => {
    let len = s.length;
    if (len != null) {
      if (conventions.lengthRounding === 'round') {
        len = Math.round(len);
      } else if (conventions.lengthRounding === 'ceil') {
        len = Math.ceil(len);
      } else if (conventions.lengthRounding === 'center-offset') {
        len = len + conventions.structureCenterOffsetM;
      }
    }

    let runLabel = s.runLabel;
    if (conventions.normalizeLabels) {
      const parts = runLabel.split('-');
      if (parts.length === 2) {
        runLabel = `${normalizeStructureLabel(parts[0])}-${normalizeStructureLabel(parts[1])}`;
      }
    }

    return {
      ...s,
      runLabel,
      length: len != null ? Math.round(len * 10) / 10 : null,
    };
  });

  // 3. Catchbasins: ensure structured group formatting
  const catchbasins: CatchbasinGroupFact[] = asDrawn.catchbasins.map((cb) => ({
    ...cb,
    depth: cb.depth != null ? Math.round(cb.depth * 10) / 10 : 1.8,
  }));

  // 4. Watermain aggregation
  let watermain: WatermainFact[] = asDrawn.watermain;
  if (conventions.aggregateWatermainByDiameter) {
    watermain = aggregateWatermain(asDrawn.watermain);
  }

  return {
    ...asDrawn,
    structures,
    sewers,
    catchbasins,
    watermain,
  };
}
