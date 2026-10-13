/**
 * Partial-miss surfacing: completeness checks over ASSEMBLED TakeoffFacts.
 *
 * The pipeline's dominant failure direction is under-extraction — whole sheets
 * or networks never read — and until now a partial takeoff was
 * indistinguishable from a complete one: the facts simply ended early, in
 * silence. These checks make incompleteness explicit on the takeoff itself,
 * as warnings (the channel every consumer already reads). They NEVER alter a
 * fact, a quantity or a score; they only report what the assembly itself
 * shows to be missing.
 *
 * Facts-level rule (this module): a pipe run whose label names two endpoint
 * structures, where an endpoint is absent from the takeoff, is a dangling
 * reference — the run was read but the structure it connects to was not.
 * Endpoints pointing at EXISTING structures (EX …) or at the connection
 * sentinel (CONN) are complete by design and never reported: the takeoff
 * intentionally excludes existing infrastructure. Catchbasin endpoints are
 * satisfied by a non-empty catchbasin group of the matching type (individual
 * CBs live in the grouped count block, not the structure list).
 *
 * The assembly-level companions (labels mentioned in transcripts but never
 * assembled; a transcription that assembled to nothing) live in
 * transcript-takeoff.ts, which owns the transcript context they need.
 */
import { TakeoffFacts } from './types';
import { normalizeLabel } from './compare-facts';
import { getEndpointSignature } from './reconcile';

/** Catchbasin kinds an endpoint token can name, mapped to their group type. */
const CB_TOKEN_TYPES: Record<string, TakeoffFacts['catchbasins'][number]['type']> = {
  CB: 'SINGLE_CB',
  DCB: 'DOUBLE_CB',
  DICB: 'DITCH_INLET_CB',
  DDICB: 'DOUBLE_DITCH_INLET_CB',
};

/** (kind)(number)(suffix) — the shape getEndpointSignature's tokens already carry. */
const TOKEN_PARTS = /^([A-Z]+)(\d+)([A-Z]*)$/;

interface EndpointRef {
  token: string;
  kind: string;
  suffix: string;
}

/** Every distinct structure endpoint the takeoff's pipe runs name. */
export function runEndpointRefs(facts: TakeoffFacts): EndpointRef[] {
  const refs = new Map<string, EndpointRef>();
  for (const run of facts.sewers ?? []) {
    if (run.isLineItem) continue;
    const sig = getEndpointSignature(run.runLabel);
    if (!sig) continue;
    for (const token of sig.split('|')) {
      if (token === 'CONN') continue; // connection to existing main — complete by design
      if (/^EX(?=[A-Z]+\d)/.test(token)) continue; // existing structure — intentionally excluded
      const m = TOKEN_PARTS.exec(token);
      if (!m) continue;
      if (!refs.has(token)) refs.set(token, { token, kind: m[1], suffix: m[3] });
    }
  }
  return [...refs.values()];
}

const list = (items: string[], cap = 8): string =>
  items.slice(0, cap).join(', ') + (items.length > cap ? `, … (+${items.length - cap} more)` : '');

/**
 * Warnings for run endpoints whose structures are absent from the takeoff.
 * When EVERY referenced member of a (kind, suffix) family is absent — two or
 * more runs leading to e.g. "MH 10N", "MH 11N" while no N-suffixed structure
 * exists at all — the warning names the family: an entire network appears to
 * be missing, which is a different (larger) problem than a stray endpoint.
 */
export function partialMissWarnings(facts: TakeoffFacts): string[] {
  const refs = runEndpointRefs(facts);
  if (refs.length === 0) return [];

  const structureLabels = new Set(
    (facts.structures ?? []).map((s) => normalizeLabel(s.description)).filter(Boolean)
  );
  const cbQuantity = new Map(
    (facts.catchbasins ?? []).map((g) => [g.type, g.quantity || 0])
  );

  const isPresent = (ref: EndpointRef): boolean => {
    if (structureLabels.has(ref.token)) return true;
    const cbType = CB_TOKEN_TYPES[ref.kind];
    if (cbType && (cbQuantity.get(cbType) ?? 0) > 0) return true;
    return false;
  };

  const dangling = refs.filter((r) => !isPresent(r));
  if (dangling.length === 0) return [];

  // Families (kind + suffix) with at least one member actually in the takeoff.
  const presentFamilies = new Set<string>();
  for (const label of structureLabels) {
    const m = TOKEN_PARTS.exec(label);
    if (m) presentFamilies.add(`${m[1]}|${m[3]}`);
  }
  for (const ref of refs) {
    if (isPresent(ref)) presentFamilies.add(`${ref.kind}|${ref.suffix}`);
  }

  const warnings: string[] = [];
  const byFamily = new Map<string, EndpointRef[]>();
  for (const ref of dangling) {
    const key = `${ref.kind}|${ref.suffix}`;
    (byFamily.get(key) ?? byFamily.set(key, []).get(key)!).push(ref);
  }
  const stray: EndpointRef[] = [];
  for (const [family, members] of byFamily) {
    if (members.length >= 2 && !presentFamilies.has(family)) {
      const [kind, suffix] = family.split('|');
      warnings.push(
        `Coverage: no ${kind}${suffix ? ` (${suffix}-suffixed)` : ''} structures are in this takeoff, ` +
          `but ${members.length} pipe run endpoint(s) lead to them (${list(members.map((r) => r.token))}) — ` +
          `an entire network appears to be missing. Check that every servicing sheet was read before relying on this takeoff.`
      );
    } else {
      stray.push(...members);
    }
  }
  if (stray.length > 0) {
    warnings.push(
      `Coverage: ${stray.length} pipe run endpoint(s) lead to structures that are not in this takeoff ` +
        `(${list(stray.map((r) => r.token))}) — the sheets carrying them may not have been read. Verify coverage against the drawings.`
    );
  }
  return warnings;
}

/**
 * Append the partial-miss warnings to a takeoff's warnings, skipping any
 * already present verbatim (the checks are pure, so re-running them over
 * re-reconciled or merged facts must not duplicate the note).
 */
export function appendCoverageWarnings(facts: TakeoffFacts): TakeoffFacts {
  const existing = new Set(facts.warnings ?? []);
  const fresh = partialMissWarnings(facts).filter((w) => !existing.has(w));
  if (fresh.length === 0) return facts;
  return { ...facts, warnings: [...(facts.warnings ?? []), ...fresh] };
}
