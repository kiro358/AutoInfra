/**
 * perf-summary.ts — pure aggregation of golden-set results into the model the
 * accuracy dashboard renders.
 *
 * The canonical accuracy metric is the FACTS metric (compare-facts.ts): detection
 * F1 over entity kinds, plus field accuracy on matched entities. The legacy
 * cell-accuracy scoreboard (compare-sheets.ts / scoreboards/*.csv) is NOT this and
 * must not be presented as the system's accuracy — see CLAUDE.md.
 *
 * Input rows come from `golden-results.json` (written by evaluate-golden.ts) or
 * `golden-results-offline.json` (written by score-offline.ts — same shape plus a
 * per-entity breakdown). Both are keyed by project folder.
 *
 * Everything here is pure so it can be unit tested without the dataset.
 */

/** One project's persisted result. Superset of evaluate-golden.ts's Summary. */
export interface GoldenRow {
  folder: string;
  label: string;
  repeats?: number;
  detF1: number | null;
  detF1Lo?: number | null;
  detF1Hi?: number | null;
  asDrawnF1?: number | null;
  conventionF1?: number | null;
  structM: number;
  structT: number;
  runM: number;
  runT: number;
  fieldM: number;
  fieldT: number;
  cellAcc?: number | null;
  /** Richer per-entity breakdown — present in offline-scored rows. */
  entities?: EntityRow[];
  /** 'empty' = extraction produced no entities at all (a transport/run failure, not a model miss). */
  status?: ProjectStatus;
  /** Total tokens for the extraction, when the run recorded cost. */
  totalTokens?: number | null;
}

export interface EntityRow {
  kind: string;
  matched: number;
  truthCount: number;
  predCount: number;
}

export type ProjectStatus = 'ok' | 'empty' | 'missing';

export interface EntityAggregate {
  kind: string;
  label: string;
  matched: number;
  truth: number;
  pred: number;
  /** Fraction of truth entities found. */
  recall: number;
  /** Fraction of predicted entities that were real. */
  precision: number;
  f1: number;
  /** Predicted entities that matched nothing in truth. */
  spurious: number;
  /** Truth entities never found. */
  missed: number;
}

export interface ProjectSummary {
  folder: string;
  label: string;
  /** Short display name — the estimator's project name without the job code. */
  name: string;
  jobCode: string;
  detF1: number;
  detF1Lo: number | null;
  detF1Hi: number | null;
  asDrawnF1?: number | null;
  conventionF1?: number | null;
  fieldAcc: number | null;
  status: ProjectStatus;
  /** Truth entity count — the drawing's size. Drives the scale-vs-accuracy read. */
  truthSize: number;
  structM: number;
  structT: number;
  runM: number;
  runT: number;
  repeats: number;
}

export interface PerformanceSummary {
  /** Mean detF1 over projects that produced a non-empty extraction. The headline. */
  meanDetF1: number;
  /** Mean detF1 counting failed/empty extractions as zero. The pessimistic read. */
  meanDetF1WithFailures: number;
  meanFieldAcc: number;
  meanAsDrawnF1?: number | null;
  meanConventionF1?: number | null;
  projectsTotal: number;
  projectsScored: number;
  projectsFailed: number;
  entities: EntityAggregate[];
  projects: ProjectSummary[];
  /** Correlation-style read: mean detF1 for small vs large drawings. */
  scaleSplit: { smallMean: number; largeMean: number; threshold: number } | null;
}

const ENTITY_LABELS: Record<string, string> = {
  structures: 'Manholes',
  sewerRuns: 'Sewer runs',
  catchbasins: 'Catchbasins',
  watermainRuns: 'Watermain',
};

/** Display order — the order an estimator reads a takeoff, not alphabetical. */
const ENTITY_ORDER = ['sewerRuns', 'structures', 'catchbasins', 'watermainRuns'];

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const ratio = (n: number, d: number) => (d > 0 ? n / d : 0);

/** "2026-025 INDUSTRIAL DEVELOPMENT-ULTIMATE DRIVE" -> code + readable name. */
export function splitFolder(folder: string, label: string): { jobCode: string; name: string } {
  const m = folder.match(/^(\d{4}-\d{3})\s+(.*)$/);
  const jobCode = m ? m[1] : '';
  // Prefer the curated label, minus its "(matched/total)" suffix.
  const name = label.replace(/\s*\([^)]*\)\s*$/, '').trim() || (m ? m[2] : folder);
  return { jobCode, name };
}

/**
 * A row counts as a failed extraction when it found nothing at all across every
 * entity kind while truth had entities — that is a run/transport failure, and
 * averaging it in as "0% accurate" misattributes infrastructure to the model.
 */
export function classifyRow(row: GoldenRow): ProjectStatus {
  if (row.status) return row.status;
  const truthTotal = row.structT + row.runT;
  const foundTotal = row.structM + row.runM;
  if (truthTotal > 0 && foundTotal === 0 && (row.detF1 ?? 0) === 0) return 'empty';
  return 'ok';
}

export function summarizePerformance(rows: GoldenRow[]): PerformanceSummary {
  const projects: ProjectSummary[] = rows.map((r) => {
    const status = classifyRow(r);
    const { jobCode, name } = splitFolder(r.folder, r.label);
    const truthFromEntities = r.entities?.reduce((s, e) => s + e.truthCount, 0);
    return {
      folder: r.folder,
      label: r.label,
      name,
      jobCode,
      detF1: r.detF1 ?? 0,
      detF1Lo: r.detF1Lo ?? null,
      detF1Hi: r.detF1Hi ?? null,
      asDrawnF1: r.asDrawnF1 ?? null,
      conventionF1: r.conventionF1 ?? null,
      fieldAcc: r.fieldT > 0 ? ratio(r.fieldM, r.fieldT) : null,
      status,
      truthSize: truthFromEntities ?? r.structT + r.runT,
      structM: r.structM,
      structT: r.structT,
      runM: r.runM,
      runT: r.runT,
      repeats: r.repeats ?? 1,
    };
  });

  const scored = projects.filter((p) => p.status === 'ok');

  // Entity aggregate — only from rows carrying a breakdown. Rows without one
  // (older evaluate-golden output) still contribute to the headline means.
  const byKind = new Map<string, EntityAggregate>();
  for (const r of rows) {
    if (classifyRow(r) !== 'ok') continue;
    for (const e of r.entities ?? []) {
      const agg = byKind.get(e.kind) ?? {
        kind: e.kind,
        label: ENTITY_LABELS[e.kind] ?? e.kind,
        matched: 0, truth: 0, pred: 0,
        recall: 0, precision: 0, f1: 0, spurious: 0, missed: 0,
      };
      agg.matched += e.matched;
      agg.truth += e.truthCount;
      agg.pred += e.predCount;
      byKind.set(e.kind, agg);
    }
  }
  const entities = [...byKind.values()]
    .map((a) => {
      const recall = ratio(a.matched, a.truth);
      const precision = ratio(a.matched, a.pred);
      return {
        ...a,
        recall,
        precision,
        f1: recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0,
        missed: Math.max(0, a.truth - a.matched),
        spurious: Math.max(0, a.pred - a.matched),
      };
    })
    .sort((x, y) => ENTITY_ORDER.indexOf(x.kind) - ENTITY_ORDER.indexOf(y.kind));

  // Scale split: does accuracy fall off on big drawings? Split scored projects at
  // the median truth size so the comparison is balanced regardless of set shape.
  let scaleSplit: PerformanceSummary['scaleSplit'] = null;
  const sizable = scored.filter((p) => p.truthSize > 0);
  if (sizable.length >= 4) {
    const sizes = sizable.map((p) => p.truthSize).sort((a, b) => a - b);
    const threshold = sizes[Math.floor(sizes.length / 2)];
    const small = sizable.filter((p) => p.truthSize < threshold);
    const large = sizable.filter((p) => p.truthSize >= threshold);
    if (small.length && large.length) {
      scaleSplit = {
        smallMean: mean(small.map((p) => p.detF1)),
        largeMean: mean(large.map((p) => p.detF1)),
        threshold,
      };
    }
  }

  const fieldAccs = scored.map((p) => p.fieldAcc).filter((x): x is number => x != null);
  const asDrawnF1s = scored.map((p) => p.asDrawnF1).filter((x): x is number => x != null);
  const convF1s = scored.map((p) => p.conventionF1).filter((x): x is number => x != null);

  return {
    meanDetF1: mean(scored.map((p) => p.detF1)),
    meanDetF1WithFailures: mean(projects.map((p) => p.detF1)),
    meanFieldAcc: mean(fieldAccs),
    meanAsDrawnF1: asDrawnF1s.length > 0 ? mean(asDrawnF1s) : null,
    meanConventionF1: convF1s.length > 0 ? mean(convF1s) : null,
    projectsTotal: projects.length,
    projectsScored: scored.length,
    projectsFailed: projects.filter((p) => p.status !== 'ok').length,
    entities,
    projects: projects.sort((a, b) => b.detF1 - a.detF1),
    scaleSplit,
  };
}
