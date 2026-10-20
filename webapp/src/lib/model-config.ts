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
// TRANSCRIPTION THINKING FLOOR (PR37, 2026-10-19): three independent 3.x
// prod runs on Uxbridge (gemini-3.8-flash ×2, gemini-3.5-flash-lite ×1)
// ALL landed at sewer-run recall 35% (8/23) and detF1 74.6–77.9, vs
// 79.6–80.7 on the 2.5-flash builds — while field accuracy IMPROVED to
// 62.8. The shared 3.x factor across those runs: transcription thinking
// maps prod's THINKING_BUDGET=1024 to ThinkingLevel LOW (the PR30
// mapping in thinkingConfigFor below), where 2.5-flash consumed a
// numeric budget. Suspected cause: LOW under-thinks the tiles and
// transcribes tersely, skipping run callouts. roleThinkingConfig
// therefore floors the transcription and single roles at MEDIUM on
// level-based (3.x) models — MINIMAL/LOW rise to MEDIUM, MEDIUM/HIGH
// pass through. 2.x numeric-budget behaviour is completely unchanged,
// and locator/recheck/verify/watermain are untouched (locator stays
// MINIMAL at budget 0). The floor is a hypothesis under test: it is
// panel-judged like every model change, and reverts if it buys nothing.

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
): string | null {
  const fam = modelFallbackFamily(role);
  if (!fam) return null;
  if (!isModelUnavailableError(err)) return null;
  if (state.effectiveByFamily[fam]) return null;
  if (state.fallbackModel === configured) return null;
  state.effectiveByFamily[fam] = state.fallbackModel;
  state.trips.push({ role: fam, from: configured, to: state.fallbackModel });
  if (!state.firstError) state.firstError = String((err as { message?: unknown })?.message ?? err);
  return state.fallbackModel;
}

/** The facts warning recorded when a family trips — one per trip. */
export function modelFallbackWarning(trip: ModelFallbackTrip): string {
  const label = trip.role === 'transcription' ? 'Transcription' : 'Watermain';
  return `${label} model ${trip.from} unavailable (404) — fell back to ${trip.to} for the rest of this job.`;
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

/**
 * Roles floored at MEDIUM thinking on level-based (3.x) models (PR37 — see
 * the header note). Only the tile-reading roles: transcription and its
 * single-pass sibling. The floor applies wherever a role's config is
 * derived, including the fallback path — a tripped 3.x fallback model gets
 * the same floor, because extraction.ts re-derives through this function.
 */
const TRANSCRIPTION_THINKING_FLOOR_ROLES: ReadonlySet<ModelRole> = new Set(['transcription', 'single']);

/**
 * Thinking config for one role: NO_THINKING_ROLES pin budget 0, the rest use
 * THINKING_BUDGET. PR37: on level-based models the transcription/single
 * roles are floored at MEDIUM (MINIMAL/LOW → MEDIUM); numeric-budget
 * models and all other roles pass through untouched.
 */
export function roleThinkingConfig(
  role: ModelRole,
  model: string,
  thinkingBudget: number,
): RoleThinkingConfig {
  const cfg = thinkingConfigFor(model, NO_THINKING_ROLES.has(role) ? 0 : thinkingBudget);
  if (
    TRANSCRIPTION_THINKING_FLOOR_ROLES.has(role) &&
    'thinkingLevel' in cfg &&
    (cfg.thinkingLevel === ThinkingLevel.MINIMAL || cfg.thinkingLevel === ThinkingLevel.LOW)
  ) {
    return { thinkingLevel: ThinkingLevel.MEDIUM };
  }
  return cfg;
}
