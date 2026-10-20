// model-config.ts — per-role model assignment + thinking-config mapping (PR30),
// per-role Vertex locations + the model-unavailability fallback (PR34).
//
// Until PR30 every LLM call in extraction.ts used the single EXTRACTION_MODEL
// (gemini-2.5-flash in prod). The call sites do very different work though:
// the locator/recheck/vector-verify calls return tiny JSON verdicts where
// reasoning is pure waste, while tile transcription produces ≥95% of the
// output tokens and is where reading quality lives. Option B (see
// model_optimisation.md §4) assigns a model per ROLE:
//
//   locator       LOCATOR_MODEL        default gemini-3.5-flash-lite, thinking OFF
//   recheck       RECHECK_MODEL        default gemini-3.5-flash-lite, thinking OFF
//   verify        VERIFY_MODEL         default gemini-3.5-flash-lite, thinking OFF
//   transcription TRANSCRIPTION_MODEL  default gemini-3.5-flash-lite, thinking = THINKING_BUDGET
//   single        TRANSCRIPTION_MODEL  (same role family as transcription)
//   watermain     WM_MODEL             default gemini-3.5-flash-lite, thinking = THINKING_BUDGET
//
// PRECEDENCE (per role): role env var  >  EXTRACTION_MODEL  >  built-in role
// default. EXTRACTION_MODEL deliberately beats the role DEFAULTS: existing
// A/B workflows set EXTRACTION_MODEL=<model> to run the whole pipeline on one
// model, and that must keep working exactly as before. Only an explicitly set
// role var overrides it, for that one role.
//
// PR34 (2026-10-19) — VERTEX LATEST-MODEL MIGRATION. Two facts force it:
//   1. Google retires the whole 2.5 family on Vertex on 2026-10-20
//      (gemini-2.5-flash AND gemini-2.5-flash-lite; earliest enforcement —
//      see model_vertex_availability.md §0). Every role ran on one of them.
//   2. The 3.x Lite models are served on Vertex ONLY via the `global`
//      endpoint and the `us`/`eu` multi-regions — never us-central1. That
//      geography (not project enablement) is why gemini-3.1-flash-lite
//      (PR30) and gemini-3.5-flash-lite (PR32) each 404'd NOT_FOUND on
//      every transcription call from us-central1 while GA on the
//      Developer API.
// So every role resolves a LOCATION alongside its model (default `us`,
// which keeps ML processing in the US multi-region; `global` is one env
// var away). Locations are PER-ROLE so a future model can move
// independently of the others: e.g. TRANSCRIPTION_LOCATION=global moves
// only transcription. Location precedence per role:
//   <ROLE>_LOCATION  >  built-in role default ('us').
// (`single` shares TRANSCRIPTION_LOCATION, like it shares TRANSCRIPTION_MODEL.)
// PR35: GCP_LOCATION is NOT a tier in this chain. PR34 had it between the
// role var and the default, and prod's Cloud Run service carries a legacy
// GCP_LOCATION=us-central1 (deploy.yml doesn't set it; it persists from
// service creation) — on the 2026-10-19 PR34 smoke every call resolved to
// us-central1 and 404'd. The var is no longer consulted for role locations.
//
// WHICH MODEL (PR34): Kiro directed "move to the latest" (2026-10-19),
// superseding the availability memo's gemini-3.5-flash-lite primary
// recommendation, so PR34 defaulted every role to gemini-3.8-flash —
// the latest flagship Flash, GA, $0.75/$3.75 per M in/out (price doubles
// 2027-01-01). gemini-4-argon is newer overall but UNVERIFIED on Vertex
// and 3–5× the price, so it was not chosen; the per-role plumbing lets
// it be armed later with env vars alone (e.g.
// TRANSCRIPTION_MODEL=gemini-4-argon).
//
// SETTLED (PR36, 2026-10-19): 3.8-flash live-proved AVAILABLE at `us`
// but was vetoed on quality — two independent live Uxbridge runs scored
// detF1 74.6 / fieldAcc 62.8 IDENTICALLY vs the 80.7/61.4 (PR52 build)
// and 79.6/61.4 (PR54 build) baselines on 2.5-flash builds, a confirmed
// breach of the −2.0 per-project veto, not run variance. The loss was
// sewer-run recall (35%): the flagship's tile transcripts are terse and
// drop runs. Field accuracy on the content it DID extract rose to 62.8,
// so 3.8-flash remains one TRANSCRIPTION_MODEL env var away if a future
// arm revisits it. Primaries therefore settle on gemini-3.5-flash-lite
// for EVERY role (same 3.x generation, best Lite document benchmark,
// $0.30/$2.50 per M in/out), and the fallback default steps down to
// gemini-3.1-flash-lite ($0.25/$1.50). Telemetry price rows for both
// Lite models already exist (PR30).
//
// MODEL FALLBACK (PR34): if a role family's configured model proves
// unavailable mid-job (Vertex 404), the job degrades the MODEL, not the
// takeoff: the call is retried once on TRANSCRIPTION_FALLBACK_MODEL
// (default gemini-3.1-flash-lite — PR36) at the same location, that model serves
// the family for the rest of the job, and the trip is recorded on the
// facts (warning + diagnostics). This is the fix for the PR30/PR32 failure
// mode, where a 404ing default silently lost every tile in the job.
//
// JOB-START AVAILABILITY PROBE (PR40, 2026-10-19): the PR34 fallback only
// trips when a real call 404s, so a job with an unavailable primary burned
// its first real calls (and on 2026-10-19 three successive prod jobs were
// degraded or gutted before the pattern was understood — the 404s surfaced
// only as warnings on jobs that still "completed"). extractFromPDF now
// probes each distinct configured (model, location) pair ONCE at job start
// with a minimal generateContent call; a model-unavailable verdict trips
// the same PR34 family fallback BEFORE the first real call, recorded with
// source: 'probe' so a probe trip is distinguishable from a mid-job trip
// in diagnostics. Any other probe outcome (429, 5xx, transport, auth) is
// ignored — the probe never fails or blocks a job. Kill switch:
// DISABLE_MODEL_PROBE. See probeModelAvailability below.
//
// TRANSCRIPTION THINKING FLOOR — TRIALLED AND FALSIFIED (PR37, GitHub #60;
// removed PR38): roleThinkingConfig briefly floored transcription/single
// at MEDIUM thinking on 3.x models, on the hypothesis that prod's
// THINKING_BUDGET=1024 mapping to LOW explained the 3.x sewer-run recall
// plateau (35%, 8/23) on Uxbridge. The live test refuted it: the floored
// build consumed 13,265 thinking tokens on Uxbridge and scored
// identically — detF1 77.9 / fieldAcc 62.8, sewer-run recall still
// exactly 35%. Thinking level is exonerated; roleThinkingConfig is back
// to the plain PR36 budget→level passthrough.

import { ThinkingLevel } from '@google/genai';

export type ModelRole = 'locator' | 'recheck' | 'verify' | 'transcription' | 'single' | 'watermain';

/** Roles whose thinking is pinned OFF (budget 0) rather than THINKING_BUDGET. */
export const NO_THINKING_ROLES: ReadonlySet<ModelRole> = new Set(['locator', 'recheck', 'verify']);

const ROLE_ENV_VAR: Record<ModelRole, string> = {
  locator: 'LOCATOR_MODEL',
  recheck: 'RECHECK_MODEL',
  verify: 'VERIFY_MODEL',
  transcription: 'TRANSCRIPTION_MODEL',
  single: 'TRANSCRIPTION_MODEL',
  watermain: 'WM_MODEL',
};

export const ROLE_DEFAULT_MODEL: Record<ModelRole, string> = {
  locator: 'gemini-3.5-flash-lite',
  recheck: 'gemini-3.5-flash-lite',
  verify: 'gemini-3.5-flash-lite',
  transcription: 'gemini-3.5-flash-lite',
  single: 'gemini-3.5-flash-lite',
  watermain: 'gemini-3.5-flash-lite',
};

/** Resolve the model id for one call-site role. `env` is injectable for tests. */
export function resolveRoleModel(role: ModelRole, env: Record<string, string | undefined> = process.env): string {
  const roleVar = env[ROLE_ENV_VAR[role]];
  if (roleVar) return roleVar;
  if (env.EXTRACTION_MODEL) return env.EXTRACTION_MODEL;
  return ROLE_DEFAULT_MODEL[role];
}

/** Resolve every role at once — extraction.ts resolves once at module load. */
export function resolveRoleModels(env: Record<string, string | undefined> = process.env): Record<ModelRole, string> {
  return {
    locator: resolveRoleModel('locator', env),
    recheck: resolveRoleModel('recheck', env),
    verify: resolveRoleModel('verify', env),
    transcription: resolveRoleModel('transcription', env),
    single: resolveRoleModel('single', env),
    watermain: resolveRoleModel('watermain', env),
  };
}

// ---------------------------------------------------------------------------
// Per-role Vertex locations (PR34). A model is only callable where Vertex
// serves it, and the 3.x family is not served from us-central1 at all — so
// the location is part of a role's assignment, resolved with the same
// env-injectable pattern as the model. Precedence per role:
//   <ROLE>_LOCATION  >  built-in role default ('us').
// (PR35: no GCP_LOCATION tier — see the header note.)
// The SDK accepts 'global' and the 'us'/'eu' multi-regions as plain
// location strings (verified in the pinned @google/genai 2.3.0 source);
// tile parts are GCS URIs, which any Vertex location can read, so moving a
// role's location changes nothing about ingestion.
// ---------------------------------------------------------------------------

const ROLE_LOCATION_ENV_VAR: Record<ModelRole, string> = {
  locator: 'LOCATOR_LOCATION',
  recheck: 'RECHECK_LOCATION',
  verify: 'VERIFY_LOCATION',
  transcription: 'TRANSCRIPTION_LOCATION',
  single: 'TRANSCRIPTION_LOCATION',
  watermain: 'WM_LOCATION',
};

export const ROLE_DEFAULT_LOCATION: Record<ModelRole, string> = {
  locator: 'us',
  recheck: 'us',
  verify: 'us',
  transcription: 'us',
  single: 'us',
  watermain: 'us',
};

/** Resolve the Vertex location for one call-site role. `env` is injectable for tests. */
export function resolveRoleLocation(role: ModelRole, env: Record<string, string | undefined> = process.env): string {
  const roleVar = env[ROLE_LOCATION_ENV_VAR[role]];
  if (roleVar) return roleVar;
  return ROLE_DEFAULT_LOCATION[role];
}

/** Resolve every role's location at once — extraction.ts resolves once at module load. */
export function resolveRoleLocations(env: Record<string, string | undefined> = process.env): Record<ModelRole, string> {
  return {
    locator: resolveRoleLocation('locator', env),
    recheck: resolveRoleLocation('recheck', env),
    verify: resolveRoleLocation('verify', env),
    transcription: resolveRoleLocation('transcription', env),
    single: resolveRoleLocation('single', env),
    watermain: resolveRoleLocation('watermain', env),
  };
}

// ---------------------------------------------------------------------------
// Model-unavailability fallback (PR34). Job-scoped state, created per
// extraction run in extraction.ts and threaded to the transcription-family
// call sites (tile transcription, the single-pass loop, the watermain
// second pass). When a call fails with a model-unavailable error the state
// trips ONCE per role family: the failing call is retried on the fallback
// model at the same location and every later call in that family uses the
// fallback directly. Non-availability errors (429, 5xx, parse, transport)
// never trip it — callWithRetry already owns those.
// ---------------------------------------------------------------------------

/** The fallback target when TRANSCRIPTION_FALLBACK_MODEL is unset. */
export const DEFAULT_FALLBACK_MODEL = 'gemini-3.1-flash-lite';

/** Resolve the job-level fallback model id. `env` is injectable for tests. */
export function resolveFallbackModel(env: Record<string, string | undefined> = process.env): string {
  return env.TRANSCRIPTION_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
}

/**
 * True when an error means "this model is not available here" — the Vertex
 * 404 shape (HTTP status 404, or a NOT_FOUND / "was not found" / "does not
 * have access" message). Deliberately narrow: rate limits, server errors
 * and transport failures are transient, not availability verdicts.
 */
export function isModelUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; message?: unknown };
  if (e.status === 404) return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return /NOT_FOUND|was not found|does not have access/i.test(msg);
}

/** Role families that share one fallback trip (single IS transcription). */
export type ModelFallbackFamily = 'transcription' | 'watermain';

export function modelFallbackFamily(role: ModelRole): ModelFallbackFamily | null {
  if (role === 'transcription' || role === 'single') return 'transcription';
  if (role === 'watermain') return 'watermain';
  return null;
}

export interface ModelFallbackTrip {
  /** The role family that tripped ('transcription' covers single-pass). */
  role: ModelFallbackFamily;
  /** The configured model that proved unavailable. */
  from: string;
  /** The fallback model serving the family for the rest of the job. */
  to: string;
  /**
   * PR40: 'probe' when the job-start availability probe tripped the family
   * before any real call. Absent for the original PR34 mid-job trips, so
   * existing records and equality checks are unchanged.
   */
  source?: 'probe';
}

export interface ModelFallbackState {
  fallbackModel: string;
  effectiveByFamily: Partial<Record<ModelFallbackFamily, string>>;
  trips: ModelFallbackTrip[];
  /** Message of the first availability error that tripped a family. */
  firstError?: string;
}

export function createModelFallbackState(fallbackModel: string): ModelFallbackState {
  return { fallbackModel, effectiveByFamily: {}, trips: [] };
}

/** The model a call in `role` should use right now: the fallback once its family has tripped, else the configured model. */
export function effectiveModelFor(state: ModelFallbackState, role: ModelRole, configured: string): string {
  const fam = modelFallbackFamily(role);
  return (fam && state.effectiveByFamily[fam]) || configured;
}

/**
 * Record an availability failure for `role`'s family. Returns the fallback
 * model id when THIS error trips the family (the caller retries the failed
 * call once with it), or null when the error is not an availability error,
 * the family already tripped, or the fallback is the configured model
 * itself (nowhere to fall). The trip mutates the state — subsequent
 * effectiveModelFor calls in the family return the fallback.
 */
export function tripModelFallback(
  state: ModelFallbackState,
  role: ModelRole,
  configured: string,
  err: unknown,
  source?: 'probe',
): string | null {
  const fam = modelFallbackFamily(role);
  if (!fam) return null;
  if (!isModelUnavailableError(err)) return null;
  if (state.effectiveByFamily[fam]) return null;
  if (state.fallbackModel === configured) return null;
  state.effectiveByFamily[fam] = state.fallbackModel;
  state.trips.push({ role: fam, from: configured, to: state.fallbackModel, ...(source ? { source } : {}) });
  if (!state.firstError) state.firstError = String((err as { message?: unknown })?.message ?? err);
  return state.fallbackModel;
}

/** The facts warning recorded when a family trips — one per trip. */
export function modelFallbackWarning(trip: ModelFallbackTrip): string {
  const label = trip.role === 'transcription' ? 'Transcription' : 'Watermain';
  if (trip.source === 'probe') {
    return `${label} model ${trip.from} unavailable (404) — caught by the job-start availability probe, so this job runs those calls on ${trip.to} from the first call.`;
  }
  return `${label} model ${trip.from} unavailable (404) — fell back to ${trip.to} for the rest of this job.`;
}

// ---------------------------------------------------------------------------
// Job-start model availability probe (PR40). extractFromPDF runs this ONCE
// per job, before the first real model call, so a configured model that is
// unavailable on Vertex (the PR30/PR32/PR34 failure mode: 404 NOT_FOUND
// because the model is not served from the role's location) trips the PR34
// fallback up front instead of burning real calls — and instead of the job
// silently completing on the text path with the 404s buried in warnings.
//
// Design rules:
//  - ONE minimal call per DISTINCT (model, location) pair across all roles
//    (in prod today: a single pair — every role shares one model at `us`),
//    plus at most one fallback call per location where a family came to
//    depend on the fallback. The injected `probeCall` performs the actual
//    minimal generateContent; this function owns only the verdict logic.
//  - The availability verdict reuses isModelUnavailableError — the exact
//    classifier the mid-job fallback trips on. No second classifier.
//  - Any other failure (429, 5xx, transport, auth) is NOT an availability
//    verdict: it is recorded in `errors` for the caller's log and otherwise
//    ignored. The probe never throws and never trips on ambiguity.
//  - Roles without a fallback family (locator/recheck/verify) have nothing
//    to trip; their unavailability is reported in `unavailablePrimaries`
//    for the caller's log (those paths already degrade gracefully).
//  - When a family comes to depend on the fallback at a location, the
//    fallback model is probed there too (reusing the primary verdict when
//    the fallback IS one of the probed pairs — never a duplicate call).
//    If it is also unavailable, a loud facts warning is produced: the job
//    still runs — surfacing the dead configuration is the point.
// ---------------------------------------------------------------------------

/** One minimal model call: resolves when the model answers, rejects with the API error otherwise. */
export type ModelProbeCall = (model: string, location: string) => Promise<void>;

export interface ModelProbeTarget {
  model: string;
  location: string;
  /** Every role configured on this pair (canonical role order). */
  roles: ModelRole[];
}

const MODEL_ROLES: readonly ModelRole[] = ['locator', 'recheck', 'verify', 'transcription', 'single', 'watermain'];

/** The distinct (model, location) pairs the configured roles resolve to. */
export function modelProbeTargets(
  models: Record<ModelRole, string>,
  locations: Record<ModelRole, string>,
): ModelProbeTarget[] {
  const byPair = new Map<string, ModelProbeTarget>();
  for (const role of MODEL_ROLES) {
    const model = models[role];
    const location = locations[role];
    const key = `${model} ${location}`;
    const existing = byPair.get(key);
    if (existing) existing.roles.push(role);
    else byPair.set(key, { model, location, roles: [role] });
  }
  return [...byPair.values()];
}

/**
 * Kill switch: DISABLE_MODEL_PROBE set to anything other than an explicit
 * false-y value ('', 'false', '0', 'no', case-insensitive) disables the
 * probe. Default (unset) is ON. Mirrors the codebase's env conventions
 * (ENABLE_PAGE_LOCATOR=false, REUSE_PREP=false) so DISABLE_MODEL_PROBE=false
 * can never read as "disable".
 */
export function isModelProbeDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.DISABLE_MODEL_PROBE;
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== '' && t !== 'false' && t !== '0' && t !== 'no';
}

/** The loud facts warning when the fallback model is ALSO unavailable where a family needs it. */
export function modelProbeFallbackUnavailableWarning(model: string, location: string): string {
  return (
    `Model availability probe: the fallback model ${model} is ALSO unavailable on Vertex AI ` +
    `at location "${location}" (404) — the configured model and its fallback are both down there, ` +
    `so this job's model calls are expected to fail. Check the model configuration.`
  );
}

export interface ModelProbeResult {
  /** Total probe calls issued (primary pairs + fallback pairs). Hard bound: distinct primary pairs + one fallback call per tripped location. */
  calls: number;
  /** Primary pairs that returned a model-unavailable verdict. */
  unavailablePrimaries: { model: string; location: string; roles: ModelRole[] }[];
  /** Probe calls that failed with a NON-availability error — ignored by design, returned for the caller's log. */
  errors: { model: string; location: string; message: string }[];
  /** Locations where the fallback model also probed unavailable after a family came to depend on it. */
  fallbackUnavailable: { model: string; location: string }[];
  /** Loud facts warnings (fallback also unavailable). Trips themselves are recorded on the fallback state, not here. */
  warnings: string[];
}

type ProbeVerdict = 'ok' | 'unavailable' | 'error';

/**
 * Probe every distinct configured (model, location) pair once and trip the
 * fallback state (source: 'probe') for each fallback family whose primary
 * probed unavailable. Never throws: every probeCall failure is classified
 * and absorbed. Sequential by design — at most a handful of calls, and the
 * verdict cache guarantees no pair is ever called twice.
 */
export async function probeModelAvailability(args: {
  state: ModelFallbackState;
  models: Record<ModelRole, string>;
  locations: Record<ModelRole, string>;
  probeCall: ModelProbeCall;
}): Promise<ModelProbeResult> {
  const { state, probeCall } = args;
  const result: ModelProbeResult = { calls: 0, unavailablePrimaries: [], errors: [], fallbackUnavailable: [], warnings: [] };
  const verdicts = new Map<string, ProbeVerdict>();
  const availabilityErrors = new Map<string, unknown>();
  const pairKey = (model: string, location: string) => `${model} ${location}`;

  const probeOnce = async (model: string, location: string): Promise<ProbeVerdict> => {
    const cached = verdicts.get(pairKey(model, location));
    if (cached) return cached;
    result.calls++;
    let verdict: ProbeVerdict;
    try {
      await probeCall(model, location);
      verdict = 'ok';
    } catch (err) {
      if (isModelUnavailableError(err)) {
        verdict = 'unavailable';
        availabilityErrors.set(pairKey(model, location), err);
      } else {
        verdict = 'error';
        result.errors.push({ model, location, message: String((err as { message?: unknown })?.message ?? err) });
      }
    }
    verdicts.set(pairKey(model, location), verdict);
    return verdict;
  };

  // Locations where a fallback family came to depend on the fallback —
  // the fallback gets probed at exactly those locations.
  const fallbackLocations: string[] = [];
  for (const target of modelProbeTargets(args.models, args.locations)) {
    const verdict = await probeOnce(target.model, target.location);
    if (verdict !== 'unavailable') continue;
    result.unavailablePrimaries.push({ model: target.model, location: target.location, roles: target.roles });
    for (const role of target.roles) {
      if (!modelFallbackFamily(role)) continue;
      // The trip re-classifies the probe's real error with the same
      // isModelUnavailableError — it lands exactly like a mid-job trip,
      // only earlier and marked source: 'probe'.
      tripModelFallback(state, role, target.model, availabilityErrors.get(pairKey(target.model, target.location)), 'probe');
      if (!fallbackLocations.includes(target.location)) fallbackLocations.push(target.location);
    }
  }

  for (const location of fallbackLocations) {
    const verdict = await probeOnce(state.fallbackModel, location);
    if (verdict === 'unavailable') {
      result.fallbackUnavailable.push({ model: state.fallbackModel, location });
      result.warnings.push(modelProbeFallbackUnavailableWarning(state.fallbackModel, location));
    }
  }

  return result;
}

/**
 * True for Gemini 3.x and later model ids (gemini-3…, gemini-4…). These steer
 * thinking with `thinkingLevel`; the 2.5-era numeric `thinkingBudget` is NOT
 * supported on them (Google Cloud, Gemini 3 model docs: "the thinking_level
 * parameter replaces thinking_budget for Gemini 3 models"; sending both is an
 * API error). The pinned @google/genai SDK copies thinkingConfig through
 * verbatim, so the mapping has to happen here, not in the SDK.
 */
export function usesThinkingLevels(model: string): boolean {
  const m = /^gemini-(\d+)(?:\.|-)/.exec(model.trim());
  return m !== null && Number(m[1]) >= 3;
}

export type RoleThinkingConfig = { thinkingBudget: number } | { thinkingLevel: ThinkingLevel };

/**
 * The thinkingConfig for a call on `model` whose 2.5-era intent is `budget`
 * thinking tokens (0 = off).
 *
 * - 2.5-era models: the numeric budget passes through untouched (0 turns
 *   thinking off on 2.5 Flash / Flash-Lite — Vertex "Thinking" doc).
 * - Gemini 3+: budgets map to levels, anchored on Google's published level
 *   characterisations: 0 → MINIMAL (the floor; thinking cannot be fully
 *   disabled on 3.x, and MINIMAL is gemini-3.1-flash-lite's own default),
 *   ≤1024 → LOW, ≤8192 → MEDIUM, above → HIGH. Prod's THINKING_BUDGET=1024
 *   therefore lands on LOW; the code default 8192 lands on MEDIUM.
 *   Never returns both fields — Vertex rejects a request carrying both.
 */
export function thinkingConfigFor(model: string, budget: number): RoleThinkingConfig {
  if (!usesThinkingLevels(model)) return { thinkingBudget: budget };
  if (budget <= 0) return { thinkingLevel: ThinkingLevel.MINIMAL };
  if (budget <= 1024) return { thinkingLevel: ThinkingLevel.LOW };
  if (budget <= 8192) return { thinkingLevel: ThinkingLevel.MEDIUM };
  return { thinkingLevel: ThinkingLevel.HIGH };
}

/** Thinking config for one role: NO_THINKING_ROLES pin budget 0, the rest use THINKING_BUDGET. */
export function roleThinkingConfig(
  role: ModelRole,
  model: string,
  thinkingBudget: number,
): RoleThinkingConfig {
  return thinkingConfigFor(model, NO_THINKING_ROLES.has(role) ? 0 : thinkingBudget);
}
