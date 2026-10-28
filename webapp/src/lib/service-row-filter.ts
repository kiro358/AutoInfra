/**
 * Service-row filter (PR 64) — drops sewer "rows" whose only content is a
 * billable-service label read off a printed schedule.
 *
 * Evidence: on 2026-073 (Shoppers Drug Mart, PR 61) the servicing sheet's
 * printed fee schedule — `VIDEO ($25/m)`, `LAYOUT`, `AS BUILT` — was read
 * into the takeoff as sewer rows carrying no pipe quantities at all. They
 * are not pipe: no length, no diameter, no slope, no depth, no structures.
 * Left in the facts they masquerade as extracted runs (inflating run
 * counts and the withheld/quantity machinery downstream); priced, they
 * are the standard per-project fees, which costing-rules.ts owns — it
 * prices an extracted fee row in place or appends the canonical fee when
 * none was extracted (see STANDARD_FEE_KINDS). Dropping the extracted
 * rows therefore changes no workbook amount: the fees still price via
 * the canonical path. What changes is provenance — the takeoff no longer
 * claims the drawing stated them as runs.
 *
 * Fail-closed conjunction — a row is dropped only when ALL hold:
 *   1. its label names a standard-fee service (standardFeeKind: VIDEO /
 *      LAYOUT / AS BUILT — the same family definition pricing uses);
 *   2. every physical quantity is null (length, pipeDiameter, typeClass,
 *      slope, depth);
 *   3. the label carries no pipe dimension (no mm size, no Ø/DIA text) —
 *      a dimensioned label is a run that happens to mention a service;
 *   4. the label carries no structure token (MH/CB/CBMH/…) and is not a
 *      length-led run label ("12m-150mm …") — a structure-bearing label
 *      is a run, whatever else it mentions.
 * Anything else survives untouched. With no drops the SAME facts object
 * is returned (identity), so non-firing projects are byte-identical by
 * construction. Cached-corpus census (PR 64): 0 matching rows across
 * the 26 golden projects — the live 073 rows are the firing evidence.
 *
 * Kill switch: DISABLE_SERVICE_ROW_FILTER (disable-when-set, the
 * DISABLE_JOB_WATCHDOG semantics).
 */
import { standardFeeKind } from './costing-rules';
import type { SewerFact, TakeoffFacts } from './types';

export interface ServiceRowDrop {
  count: number;
  /** The dropped rows' labels, in formation order. */
  labels: string[];
  /** Drops per standard-fee kind (VIDEO / LAYOUT / AS BUILT) — the shape
   *  diagnostics' firing detail carries. */
  byKind: Record<string, number>;
}

const NO_DROP: ServiceRowDrop = { count: 0, labels: [], byKind: {} };

/** A pipe dimension stated inside a label: an mm size or a diameter mark. */
const DIMENSION_IN_LABEL = /\d+(?:\.\d+)?\s*mm\b|ø|dia\b/i;

/** Structure tokens: a label naming structures is a run label. */
const STRUCTURE_IN_LABEL =
  /\b(MH|CBMH|DCBMH|CB|DICB|DCB|HS|INS|CONN|STUB|HEADWALL|INLET|OUTLET)\b/i;

/** A length-led run label ("12m-150mm STM", "7.47m …"). */
const RUN_LED_LABEL = /^\s*\d+(?:\.\d+)?\s*m\s*[-–—]/i;

export function isServiceOnlyRow(s: SewerFact): boolean {
  if (!standardFeeKind(s.runLabel)) return false;
  if (
    s.length != null ||
    s.pipeDiameter != null ||
    s.typeClass != null ||
    s.slope != null ||
    s.depth != null
  ) {
    return false;
  }
  const label = s.runLabel || '';
  if (DIMENSION_IN_LABEL.test(label)) return false;
  if (STRUCTURE_IN_LABEL.test(label)) return false;
  if (RUN_LED_LABEL.test(label)) return false;
  return true;
}

/**
 * Remove service-only rows from assembled facts. Returns the input
 * object unchanged (same reference) when nothing matches.
 */
export function dropServiceOnlyRows(facts: TakeoffFacts): {
  facts: TakeoffFacts;
  dropped: ServiceRowDrop;
} {
  const labels: string[] = [];
  const byKind: Record<string, number> = {};
  const kept: SewerFact[] = [];
  for (const s of facts.sewers) {
    if (isServiceOnlyRow(s)) {
      labels.push(s.runLabel);
      const kind = standardFeeKind(s.runLabel);
      if (kind) byKind[kind] = (byKind[kind] ?? 0) + 1;
    } else kept.push(s);
  }
  if (labels.length === 0) return { facts, dropped: NO_DROP };
  return {
    facts: { ...facts, sewers: kept },
    dropped: { count: labels.length, labels, byKind },
  };
}

const FALSEY_ENV_VALUES = new Set(['', 'false', '0', 'no', 'off']);

export function isServiceRowFilterDisabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env.DISABLE_SERVICE_ROW_FILTER;
  if (raw === undefined) return false;
  return !FALSEY_ENV_VALUES.has(raw.trim().toLowerCase());
}
