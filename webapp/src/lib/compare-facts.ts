/**
 * Facts-level extraction metric (the redesigned evaluation).
 *
 * The old eval compared the *priced* spreadsheet cell-by-cell, which conflated
 * what the model controls (reading facts off the drawing) with what the costing
 * rules control (dollars). This module scores ONLY the extraction stage:
 *
 *   1. Entity detection — did we find the right structures / pipe runs / mains?
 *      Reported as precision / recall / F1 against ground-truth facts.
 *   2. Field accuracy — on entities matched to ground truth, are the physical
 *      values right? (exact for diameter/class, tolerance for length/slope/depth)
 *
 * Pure and dependency-free, so it is unit-tested with synthetic fixtures and
 * needs none of the (gitignored) project data to validate.
 */
import { TakeoffFacts, StructureFact, SewerFact, WatermainFact } from './types';

export interface EntityScore {
  kind: string;
  truthCount: number;
  predCount: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface FieldScore {
  field: string;
  matched: number;
  total: number;
  accuracy: number;
}

export interface FactsComparison {
  entities: EntityScore[];
  fields: FieldScore[];
  /** Mean F1 across entity kinds. */
  detectionF1: number;
  /** Field accuracy across all compared fields on matched entities. */
  fieldAccuracy: number;
}

// ---- normalization & value matching ----

/** Normalize a structure label for comparison: strip parens, spaces, punctuation. */
export function normalizeLabel(label: string): string {
  return (label || '')
    .toUpperCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

/** Order-insensitive endpoint signature for a pipe run label ("A-B" == "B-A"). */
export function runSignature(label: string): string {
  const cleaned = (label || '')
    .toUpperCase()
    .replace(/\bTO\b/gi, '-')
    .replace(/\/INS/g, '')
    .replace(/CONN/g, '')
    .replace(/\s+/g, '');
  const tokens = cleaned.split('-').map((t) => t.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  return tokens.sort().join('|');
}

function numClose(a: number | null, b: number | null, relTol = 0.05): boolean {
  if (a == null || b == null) return false;
  if (a === b) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return true;
  return Math.abs(a - b) / denom <= relTol;
}

function exactNum(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  return a === b;
}

// ---- generic greedy matcher ----

function matchByKey<T>(pred: T[], truth: T[], key: (t: T) => string) {
  const predByKey = new Map<string, T[]>();
  for (const p of pred) {
    const k = key(p);
    if (!k) continue;
    const bucket = predByKey.get(k);
    if (bucket) bucket.push(p);
    else predByKey.set(k, [p]);
  }
  const pairs: { p: T; t: T }[] = [];
  let matched = 0;
  for (const t of truth) {
    const k = key(t);
    const bucket = predByKey.get(k);
    if (bucket && bucket.length > 0) {
      const p = bucket.shift()!;
      pairs.push({ p, t });
      matched++;
    }
  }
  return { matched, pairs };
}

function prf(matched: number, predCount: number, truthCount: number): EntityScore {
  const precision = predCount > 0 ? matched / predCount : truthCount === 0 ? 1 : 0;
  const recall = truthCount > 0 ? matched / truthCount : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { kind: '', truthCount, predCount, matched, precision, recall, f1 };
}

// ---- field scorers ----

function scoreFields<T>(
  pairs: { p: T; t: T }[],
  specs: { field: string; ok: (p: T, t: T) => boolean; present: (t: T) => boolean }[]
): FieldScore[] {
  return specs.map(({ field, ok, present }) => {
    let matched = 0;
    let total = 0;
    for (const { p, t } of pairs) {
      if (!present(t)) continue;
      total++;
      if (ok(p, t)) matched++;
    }
    return { field, matched, total, accuracy: total > 0 ? matched / total : 1 };
  });
}

export function compareFacts(pred: TakeoffFacts, truth: TakeoffFacts): FactsComparison {
  const entities: EntityScore[] = [];
  const fields: FieldScore[] = [];

  // Structures — match by normalized label
  {
    const m = matchByKey<StructureFact>(pred.structures, truth.structures, (s) => normalizeLabel(s.description));
    entities.push({ ...prf(m.matched, pred.structures.length, truth.structures.length), kind: 'structures' });
    fields.push(
      ...scoreFields(m.pairs, [
        { field: 'structure.topElevation', present: (t) => t.topElevation != null, ok: (p, t) => numClose(p.topElevation, t.topElevation) },
        { field: 'structure.lowInvert', present: (t) => t.lowInvert != null, ok: (p, t) => numClose(p.lowInvert, t.lowInvert) },
        { field: 'structure.pipeOutDiameter', present: (t) => t.pipeOutDiameter != null, ok: (p, t) => exactNum(p.pipeOutDiameter, t.pipeOutDiameter) },
      ])
    );
  }

  // Sewer pipe runs — match by endpoint signature (line-item fee rows excluded)
  {
    const predRuns = pred.sewers.filter((s) => !s.isLineItem);
    const truthRuns = truth.sewers.filter((s) => !s.isLineItem);
    const m = matchByKey<SewerFact>(predRuns, truthRuns, (s) => runSignature(s.runLabel));
    entities.push({ ...prf(m.matched, predRuns.length, truthRuns.length), kind: 'sewerRuns' });
    fields.push(
      ...scoreFields(m.pairs, [
        { field: 'sewer.length', present: (t) => t.length != null, ok: (p, t) => numClose(p.length, t.length) },
        { field: 'sewer.pipeDiameter', present: (t) => t.pipeDiameter != null, ok: (p, t) => exactNum(p.pipeDiameter, t.pipeDiameter) },
        { field: 'sewer.typeClass', present: (t) => t.typeClass != null, ok: (p, t) => numClose(p.typeClass, t.typeClass, 0.02) },
        { field: 'sewer.slope', present: (t) => t.slope != null, ok: (p, t) => numClose(p.slope, t.slope) },
        { field: 'sewer.depth', present: (t) => t.depth != null, ok: (p, t) => numClose(p.depth, t.depth, 0.1) },
      ])
    );
  }

  // Watermain runs — match by normalized size/type
  {
    const m = matchByKey<WatermainFact>(pred.watermain, truth.watermain, (w) => normalizeLabel(w.sizeAndType));
    entities.push({ ...prf(m.matched, pred.watermain.length, truth.watermain.length), kind: 'watermainRuns' });
    fields.push(
      ...scoreFields(m.pairs, [
        { field: 'watermain.length', present: (t) => t.length != null, ok: (p, t) => numClose(p.length, t.length) },
        { field: 'watermain.pipeDiameter', present: (t) => t.pipeDiameter != null, ok: (p, t) => exactNum(p.pipeDiameter, t.pipeDiameter) },
      ])
    );
  }

  const detectionF1 = entities.length > 0 ? entities.reduce((s, e) => s + e.f1, 0) / entities.length : 0;
  const totalFields = fields.reduce((s, f) => s + f.total, 0);
  const matchedFields = fields.reduce((s, f) => s + f.matched, 0);
  const fieldAccuracy = totalFields > 0 ? matchedFields / totalFields : 1;

  return { entities, fields, detectionF1, fieldAccuracy };
}

export function formatFactsComparison(c: FactsComparison): string {
  let out = '\n📐 EXTRACTION FACTS METRIC\n' + '='.repeat(60) + '\n';
  for (const e of c.entities) {
    out += `  ${e.kind.padEnd(16)} P=${(e.precision * 100).toFixed(0)}% R=${(e.recall * 100).toFixed(0)}% F1=${(e.f1 * 100).toFixed(0)}%  (${e.matched}/${e.truthCount} truth, ${e.predCount} pred)\n`;
  }
  out += '  ' + '-'.repeat(56) + '\n';
  for (const f of c.fields) {
    if (f.total === 0) continue;
    out += `  ${f.field.padEnd(28)} ${(f.accuracy * 100).toFixed(0)}%  (${f.matched}/${f.total})\n`;
  }
  out += '  ' + '-'.repeat(56) + '\n';
  out += `  Detection F1: ${(c.detectionF1 * 100).toFixed(1)}%   Field accuracy: ${(c.fieldAccuracy * 100).toFixed(1)}%\n`;
  return out;
}
