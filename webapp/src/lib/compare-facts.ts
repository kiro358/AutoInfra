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

/**
 * Normalize a structure label for comparison: drop estimator note suffixes
 * (e.g. "MH 1/O.P.", "MH 8/EXT.DROP", "CBMH 1/RIP RAP" -> the bare ID), parens,
 * spaces, and punctuation.
 */
export function normalizeLabel(label: string): string {
  return (label || '')
    .toUpperCase()
    .replace(/\(.*?\)/g, '')
    .split('/')[0] // drop note suffix after the first slash
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Order-insensitive endpoint signature for a pipe run label ("A-B" == "B-A").
 * Drops note suffixes ("/INS.", "/P.INS.", " / INS.", "c/w …") that would corrupt
 * the endpoint tokens, and maps connection sentinels (CONN/PLUG/OUTLET) to a
 * single stable token so "MH 8-CONN." keeps its second endpoint instead of
 * collapsing to a single node (which caused false matches).
 */
export function runSignature(label: string): string {
  let s = (label || '').toUpperCase();
  s = s.replace(/\bC\/W.*$/, '');   // "c/w ROD.GRATE ..." note
  s = s.replace(/\/.*$/, '');        // anything after the first slash (/INS., /P.INS., /O.P., ...)
  s = s.replace(/\bTO\b/g, '-');
  s = s.replace(/\s+/g, '');
  const tokens = s
    .split('-')
    .map((t) => t.replace(/[^A-Z0-9]/g, ''))
    .filter(Boolean)
    .map((t) => (/^(CONN|PLUG|OUTLET)/.test(t) ? 'CONN' : t));
  return Array.from(new Set(tokens)).sort().join('|');
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

// A sewer run is a physical pipe. Many drawings label runs only by a dimension
// callout ("45.0m-250mm PVC STM @0.5%"), not by FROM-TO structures, so endpoint-label
// matching misses them even when the pipe itself is captured correctly. As a fallback
// we match an unmatched pred/truth run pair by physical attributes: same diameter,
// close length, and (when both present) close slope.
function sewerAttrMatch(p: SewerFact, t: SewerFact): boolean {
  if (p.pipeDiameter == null || t.pipeDiameter == null || p.pipeDiameter !== t.pipeDiameter) return false;
  if (p.length == null || t.length == null) return false;
  if (Math.abs(p.length - t.length) > Math.max(1.0, 0.05 * t.length)) return false;
  if (p.slope != null && t.slope != null && Math.abs(p.slope - t.slope) > 0.15) return false;
  return true;
}

// Endpoint structure tokens of a run label, for partial matching (drop /notes and the
// CONN/PLUG/WYE sentinels, which are ends the drawing abstracts rather than named structures).
function runEndpoints(label: string): string[] {
  return String(label).split(/[-–]/)
    .map((p) => normalizeLabel(p.split('/')[0]))
    .filter((x) => x && x !== 'CONN' && x !== 'PLUG' && x !== 'WYE');
}

// The same physical run where truth names an endpoint the drawing abstracted (truth
// "MH 2-CONN." vs pred "MH 2-MH 1") shares one endpoint + the diameter. Require a close-ish
// length too so two different pipes out of the same structure can't false-match.
function sewerSharedEndpointMatch(p: SewerFact, t: SewerFact): boolean {
  if (p.pipeDiameter == null || t.pipeDiameter == null || p.pipeDiameter !== t.pipeDiameter) return false;
  if (p.length == null || t.length == null || Math.abs(p.length - t.length) > Math.max(3, 0.25 * t.length)) return false;
  const te = runEndpoints(t.runLabel);
  return te.length > 0 && runEndpoints(p.runLabel).some((x) => te.includes(x));
}

export function matchSewerRuns(pred: SewerFact[], truth: SewerFact[]) {
  // Phase 1: endpoint-label signature (strict, preferred).
  const first = matchByKey<SewerFact>(pred, truth, (s) => runSignature(s.runLabel));
  const usedPred = new Set(first.pairs.map((x) => x.p));
  const usedTruth = new Set(first.pairs.map((x) => x.t));
  const pairs = [...first.pairs];
  // Phase 2: attribute fallback on the leftovers (greedy, one pred per truth).
  for (const t of truth) {
    if (usedTruth.has(t)) continue;
    const p = pred.find((q) => !usedPred.has(q) && sewerAttrMatch(q, t));
    if (p) { usedPred.add(p); usedTruth.add(t); pairs.push({ p, t }); }
  }
  // Phase 3: shared endpoint + same diameter + close-ish length.
  for (const t of truth) {
    if (usedTruth.has(t)) continue;
    const p = pred.find((q) => !usedPred.has(q) && sewerSharedEndpointMatch(q, t));
    if (p) { usedPred.add(p); usedTruth.add(t); pairs.push({ p, t }); }
  }
  return { matched: pairs.length, pairs };
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
    const m = matchSewerRuns(predRuns, truthRuns);
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

  // Catchbasins — counted by type; compare per-type quantities (recall/precision on units)
  {
    const cbTypes = ['SINGLE_CB', 'DOUBLE_CB', 'DITCH_INLET_CB', 'DOUBLE_DITCH_INLET_CB'] as const;
    const qty = (list: typeof pred.catchbasins, ty: string) =>
      list.filter((c) => c.type === ty).reduce((s, c) => s + (c.quantity || 0), 0);
    let cbM = 0, cbT = 0, cbP = 0;
    for (const ty of cbTypes) {
      const tq = qty(truth.catchbasins, ty), pq = qty(pred.catchbasins, ty);
      cbM += Math.min(tq, pq); cbT += tq; cbP += pq;
    }
    if (cbT > 0 || cbP > 0) entities.push({ ...prf(cbM, cbP, cbT), kind: 'catchbasins' });
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

  // Only average over entity kinds that actually have something to measure (truth
  // present or something predicted). A kind with 0 truth AND 0 predictions is
  // vacuous — counting its F1=1 inflates the score (e.g. no-watermain jobs).
  const active = entities.filter((e) => e.truthCount > 0 || e.predCount > 0);
  const detectionF1 = active.length > 0 ? active.reduce((s, e) => s + e.f1, 0) / active.length : 1;
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
