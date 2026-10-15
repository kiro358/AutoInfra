/**
 * Storm / sanitary classification for workbook generation.
 *
 * The estimator's workbooks keep the two sewer systems in headed sections —
 * storm first, sanitary second — inside both the MANHOLES and SEWERS sheets
 * (see the corpus census in the PR21 evidence). populateTemplate therefore
 * needs every structure and sewer run classed STORM, SAN, or UNKNOWN before
 * it can lay the sheets out.
 *
 * Classification is evidence-only, in a fixed order, and NEVER guesses:
 *   1. label    — the fact's own label names the system. The deterministic
 *                 assemblers encode it directly (run labels carry a trailing
 *                 " STM" / " SAN" token; sanitary structures keep a leading
 *                 "SAN " qualifier — see callout-parser.structureDescription —
 *                 and STMH/SANMH kinds stay fused in the label). A compact
 *                 ST/SA prefix counts only when fused directly onto a
 *                 structure code + number (compare-facts' SYS_PREFIX rule),
 *                 so a schedule run id like "ST 1" is not a system claim.
 *   2. evidence — structures only: the raw callout line the fact was read
 *                 from, re-parsed with callout-parser, when the rebuilt
 *                 label dropped a bare qualifier ("STM MH 1" -> "MH 1").
 *                 Accepted only when the parsed label IS this structure.
 *   3. endpoints— a run whose endpoint structures are classed (label or
 *                 evidence) and AGREE inherits their system.
 *   4. runs     — a structure touched only by classed runs (steps 1-3) that
 *                 AGREE inherits theirs.
 * Anything else stays UNKNOWN. Generation lists UNKNOWN entities under their
 * own UNSPECIFIED heading (spreadsheet.ts) with a warning — an unclassed
 * entity is visible, never silently filed under a system it may not belong
 * to. A label token shared by two structures of different systems (storm and
 * sanitary networks number independently, so "MH 1" can exist twice) is
 * ambiguous and never used for derivation.
 */
import { normalizeLabel } from './compare-facts';
import { parseStructureLabel } from './callout-parser';

export type SystemClass = 'STORM' | 'SAN' | 'UNKNOWN';
export type ClassificationVia = 'label' | 'evidence' | 'endpoints' | 'runs' | 'none';

export interface ClassifiableStructure {
  description: string;
  source?: { evidence?: string } | null;
}
export interface ClassifiableRun {
  runLabel: string;
  isLineItem?: boolean;
}

const SAN_WORD = /\b(SAN|SANITARY)\b/;
const STM_WORD = /\b(STM|STORM)\b/;
// Compact system prefix fused onto a structure code ("SANMH1", "STMH2",
// "STCBMH2", "SADCBMH3") — mirrors compare-facts SYS_PREFIX: the prefix only
// counts when a structure code + digit follows immediately.
const COMPACT_SYS = /^(SAN|STM|ST|SA)(?=(?:DDICB|DCBMH|CBMH|DICB|DCB|CB|MH|HS|HW|OS)\d)/;

/** The system a label names outright, or UNKNOWN when it names none. */
export function labelSystem(label: string): SystemClass {
  const u = (label || '').toUpperCase();
  const flat = u.replace(/[^A-Z0-9]/g, '');
  const compact = COMPACT_SYS.exec(flat);
  if (compact) return compact[1] === 'SAN' || compact[1] === 'SA' ? 'SAN' : 'STORM';
  if (SAN_WORD.test(u)) return 'SAN';
  if (STM_WORD.test(u)) return 'STORM';
  return 'UNKNOWN';
}

/**
 * Endpoint structure tokens of a run label ("STMH 1-MH 2/INS." -> ["MH1","MH2"]),
 * normalized the same way structure labels are (compare-facts normalizeLabel:
 * system prefix stripped, numbers compared numerically). Empty for labels
 * that are not endpoint pairs (dimension callouts, line items, sentinels).
 */
export function runEndpointTokens(runLabel: string): string[] {
  let s = (runLabel || '').toUpperCase();
  s = s.replace(/\bC\/W.*$/, '');
  s = s.replace(/\/.*$/, '');
  s = s.replace(/\bTO\b/g, '-');
  const parts = s.split('-').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const tokens = parts
    .map((p) => normalizeLabel(p))
    .filter((t) => /^[A-Z]+\d/.test(t) && !/^(CONN|PLUG|OUTLET)/.test(t));
  return Array.from(new Set(tokens));
}

export interface SystemClassification {
  structureSystems: SystemClass[];
  sewerSystems: SystemClass[];
  structureVia: ClassificationVia[];
  sewerVia: ClassificationVia[];
}

/**
 * Class every structure and run. Pure and deterministic: same facts in, same
 * classes out, independent of caller. Line-item runs are never classed by
 * derivation (they are not network runs) and keep their label class only.
 */
export function classifySystems(
  structures: readonly ClassifiableStructure[],
  sewers: readonly ClassifiableRun[]
): SystemClassification {
  const structureSystems: SystemClass[] = structures.map((s) => labelSystem(s.description));
  const structureVia: ClassificationVia[] = structureSystems.map((c) => (c === 'UNKNOWN' ? 'none' : 'label'));
  const sewerSystems: SystemClass[] = sewers.map((s) => labelSystem(s.runLabel));
  const sewerVia: ClassificationVia[] = sewerSystems.map((c) => (c === 'UNKNOWN' ? 'none' : 'label'));

  // (2) evidence: recover a qualifier the rebuilt label dropped.
  structures.forEach((s, i) => {
    if (structureSystems[i] !== 'UNKNOWN') return;
    const evidence = s.source?.evidence;
    if (!evidence) return;
    const parsed = parseStructureLabel(evidence);
    if (!parsed?.system) return;
    if (normalizeLabel(parsed.label) !== normalizeLabel(s.description)) return;
    structureSystems[i] = parsed.system === 'SAN' ? 'SAN' : 'STORM';
    structureVia[i] = 'evidence';
  });

  // Token -> class, from explicitly classed structures only. A token claimed
  // by both systems is ambiguous and excluded from derivation entirely.
  const tokenClass = new Map<string, SystemClass>();
  const ambiguousTokens = new Set<string>();
  structures.forEach((s, i) => {
    const cls = structureSystems[i];
    if (cls === 'UNKNOWN') return;
    const token = normalizeLabel(s.description);
    if (!token) return;
    const existing = tokenClass.get(token);
    if (existing && existing !== cls) {
      tokenClass.delete(token);
      ambiguousTokens.add(token);
    } else if (!ambiguousTokens.has(token)) {
      tokenClass.set(token, cls);
    }
  });

  const endpoints = sewers.map((s) => (s.isLineItem ? [] : runEndpointTokens(s.runLabel)));

  // (3) runs inherit from endpoint structures that agree.
  sewers.forEach((s, j) => {
    if (sewerSystems[j] !== 'UNKNOWN' || s.isLineItem) return;
    const classes = new Set<SystemClass>();
    for (const t of endpoints[j]) {
      const c = tokenClass.get(t);
      if (c) classes.add(c);
    }
    if (classes.size === 1) {
      sewerSystems[j] = [...classes][0];
      sewerVia[j] = 'endpoints';
    }
  });

  // (4) structures inherit from connected classed runs that agree.
  structures.forEach((s, i) => {
    if (structureSystems[i] !== 'UNKNOWN') return;
    const token = normalizeLabel(s.description);
    if (!token || ambiguousTokens.has(token)) return;
    const classes = new Set<SystemClass>();
    sewers.forEach((sw, j) => {
      if (sewerSystems[j] === 'UNKNOWN' || sw.isLineItem) return;
      if (endpoints[j].includes(token)) classes.add(sewerSystems[j]);
    });
    if (classes.size === 1) {
      structureSystems[i] = [...classes][0];
      structureVia[i] = 'runs';
    }
  });

  return { structureSystems, sewerSystems, structureVia, sewerVia };
}

/** Stable partition into the workbook's section order: storm, sanitary, unspecified. */
export function groupBySystem<T>(
  items: readonly T[],
  systems: readonly SystemClass[]
): { storm: T[]; sanitary: T[]; unspecified: T[] } {
  const out = { storm: [] as T[], sanitary: [] as T[], unspecified: [] as T[] };
  items.forEach((item, i) => {
    const cls = systems[i] ?? 'UNKNOWN';
    if (cls === 'STORM') out.storm.push(item);
    else if (cls === 'SAN') out.sanitary.push(item);
    else out.unspecified.push(item);
  });
  return out;
}

/** How many of the three sections are non-empty for a set of classes. */
export function nonEmptySectionCount(systems: readonly SystemClass[]): number {
  let n = 0;
  if (systems.some((c) => c === 'STORM')) n++;
  if (systems.some((c) => c === 'SAN')) n++;
  if (systems.some((c) => c === 'UNKNOWN')) n++;
  return n;
}
