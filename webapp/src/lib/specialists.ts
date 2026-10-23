/**
 * specialists.ts — the specialist registry (PR47 Phase 1).
 *
 * The routing design (pdf_schedule_conventions.md §2) splits the
 * pipeline into ONE generalist (the default pipeline) and specialist
 * modules, one per convention family, each with its own detector, kill
 * switch and firing record. Phase 1 does not create new specialists —
 * it FORMALISES the six mechanisms that already behave like specialists
 * behind this registry: each entry records the family it serves, its
 * detector (the gate conditions AS THEY EXIST in code — formalising
 * never retunes a threshold), and its kill switch.
 *
 * Kill-switch semantics follow the codebase's two established env
 * conventions, recorded per entry so the registry is the contract:
 *  - 'disable-when-set' (DISABLE_*): the specialist is ON by default;
 *    it is disabled when the variable is set to a truthy value — and
 *    'false' / '0' / 'no' / '' can never read as "disable" (the
 *    isDualReadTriggerDisabled / isModelProbeDisabled convention).
 *  - 'enable-unless-false' (ENABLE_*): the specialist is ON unless the
 *    variable is exactly 'false' (the image-only locator's shipped
 *    convention — recorded, not normalised, because production may
 *    already rely on its exact reading).
 *
 * Everything here is inert bookkeeping: registry membership changes no
 * behaviour. The mechanisms consult isSpecialistDisabled at their
 * existing seams, with defaults that reproduce today's behaviour
 * exactly (PR47's proof bar: byte-identical cached A/B).
 */

export type SpecialistId =
  | 'S6-detached-elevation'
  | 'S7-enumeration-scope'
  | 'S9-shx-dialect'
  | 'S10-value-first'
  | 'image-only-locator'
  | 'dual-read-trigger';

export interface SpecialistEntry {
  id: SpecialistId;
  /** Human name of the specialist. */
  name: string;
  /** Convention family tag(s) served (page-classifier vocabulary). */
  families: string[];
  /** The mechanism this formalises. */
  origin: string;
  /** The detector: the specialist's gate conditions as they exist in
   *  code today. A future threshold change is a new PR with its own
   *  census — never a registry edit. */
  detector: string;
  /** Kill-switch environment variable. */
  killSwitchEnv: string;
  /** Which of the codebase's two env conventions the switch follows. */
  killSwitchKind: 'disable-when-set' | 'enable-unless-false';
}

export const SPECIALIST_REGISTRY: SpecialistEntry[] = [
  {
    id: 'S6-detached-elevation',
    name: 'Detached-elevation attribution (cross-block L1)',
    families: ['detached-elevation'],
    origin: 'PR #64 (internal 42) — mechanisms M1–M5 in transcript-takeoff.ts',
    detector:
      'Per-mechanism corroboration gates inside transcript assembly: M1 a bare directional-invert ' +
      'line (direction + value >= 50, never an OPSD drawing number) adopted as an invert; M2 a ' +
      'hyphenated system-prefix read ("STM-MH 4") kept only when a plain-form read of the same ' +
      'merge group exists, ordered after it (fill-only); M3 a structure block whose label is ' +
      'within one edit of exactly one substantive clean label (rim-corroborated when several ' +
      'qualify) appended fill-only; M4 a (page, tile) carrying exactly one orphan catchbasin-group ' +
      'invert value and exactly one invert-less structure whose rim sits above it; M5 the ' +
      'operative-rim preference (displaced rim is a family value stated by >= 3 groups, the last ' +
      'rim differs by >= 0.8 m and is corroborated by >= 2 reads, the group carries an invert).',
    killSwitchEnv: 'DISABLE_DETACHED_ELEVATION',
    killSwitchKind: 'disable-when-set',
  },
  {
    id: 'S7-enumeration-scope',
    name: 'Enumeration / scope guard',
    families: ['enumeration-scope'],
    origin: 'PR #48 (internal 23) — analyzeEnumerationScope in transcript-takeoff.ts + the catchbasin ceiling in reconcile.ts',
    detector:
      'Transcript label census: a catchbasin type with >= 40 hyphenated labels forming a numeric ' +
      'sequence of density >= 0.90 is a site-wide enumeration (an occurrence is excluded only ' +
      'when the occurrence itself is hyphenated); a single tile carrying >= 40 same-kind ' +
      'structure labels at density >= 0.90 is an enumeration table (a label is excluded only ' +
      'when no non-enumeration tile reads it). Plus the reconcile ceiling: a catchbasin group ' +
      'quantity above 2x the extracted network size (floor 10) is clamped to the ceiling.',
    killSwitchEnv: 'DISABLE_ENUMERATION_SCOPE',
    killSwitchKind: 'disable-when-set',
  },
  {
    id: 'S9-shx-dialect',
    name: 'SHX / symbol-font dialect decoding',
    families: ['shx-dialect'],
    origin: 'PR #47 (internal 22) — decodeSymbolFontText in pdf-text.ts; decodeShxClusters in shx-decode.ts (vector path)',
    detector:
      'Text layer: an item carrying >= 2 control characters with every character <= U+0060 or in ' +
      'the symbol glyph table is rewritten by the +0x1D shift, and the result must still look ' +
      'like text (a letter survives, no control residue). Vector path: SHX stroke clusters are ' +
      'decoded against the geometric stroke codebook. Both decodings are normalisation only — ' +
      'the decoded string faces the same strict grammar as any other line.',
    killSwitchEnv: 'DISABLE_SHX_DECODE',
    killSwitchKind: 'disable-when-set',
  },
  {
    id: 'S10-value-first',
    name: 'Value-first elevation dialect',
    families: ['value-first'],
    origin: 'PR #62 (internal 39) — parseDetachedElevation in transcript-takeoff.ts',
    detector:
      'Inside a transcript structure block only (where every non-label line is the structure\'s ' +
      'geometry): a value-first rim line ("277.09 T/G") or a bare decimal (parenthesised = the ' +
      'rim convention; unparenthesised = rim when the block has no rim yet, else an invert). ' +
      'OPSD standard-drawing numbers and values < 50 are always refused. The shared keyword-first ' +
      'grammar (parseElevation) is untouched; this dialect is tried only after it refuses.',
    killSwitchEnv: 'DISABLE_VALUE_FIRST_ELEVATIONS',
    killSwitchKind: 'disable-when-set',
  },
  {
    id: 'image-only-locator',
    name: 'Image-only locator re-look',
    families: ['raster-image-only'],
    origin: 'PR #51 (internal 26) — the locator union\'s image-only pass in extraction.ts',
    detector:
      'A page outside the located set with no usable text layer (not texty, no annotation form) ' +
      'whose drawn content passes the drawn gate and whose rendered thumbnail the visual ' +
      're-check confirms as servicing content; admissions are capped per job ' +
      '(MAX_IMAGE_ONLY_ADMISSIONS). The model citizen: own gate, cap, kill switch and a ' +
      'diagnostics reason (\'image-only-locator\' in the locator union record).',
    killSwitchEnv: 'ENABLE_IMAGE_ONLY_LOCATOR',
    killSwitchKind: 'enable-unless-false',
  },
  {
    id: 'dual-read-trigger',
    name: 'Dual-read trigger (router dispatch rule #1)',
    families: ['partial-layer', 'drawn-schedule'],
    origin: 'PR 46, shipped as GitHub PR #65 — assembleHybridTakeoff in extraction.ts',
    detector:
      'A texty page the zero-yield and zero-run-yield fallbacks leave text-only (solo yield ' +
      '>= 1 WITH >= 1 pipe run) whose text layer carries ZERO elevation items, >= 50 ' +
      'callout-keyword hits, and >= 10,000 measured vector path operators. All three signals ' +
      'at routing time; without an injected drawn-content measurer the trigger cannot fire.',
    killSwitchEnv: 'DISABLE_DUAL_READ_TRIGGER',
    killSwitchKind: 'disable-when-set',
  },
];

const BY_ID = new Map(SPECIALIST_REGISTRY.map((e) => [e.id, e]));

export function specialistEntry(id: SpecialistId): SpecialistEntry {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`unknown specialist id: ${id}`);
  return entry;
}

/**
 * True when the specialist's kill switch disables it in `env`. Each
 * entry's own convention decides (see the module header): a DISABLE_*
 * switch reads truthy-but-not-'false'/'0'/'no' as disable; the
 * ENABLE_* switch reads only the exact string 'false' as disable.
 */
export function isSpecialistDisabled(
  id: SpecialistId,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const entry = specialistEntry(id);
  const v = env[entry.killSwitchEnv];
  if (entry.killSwitchKind === 'enable-unless-false') return v === 'false';
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== '' && t !== 'false' && t !== '0' && t !== 'no';
}
