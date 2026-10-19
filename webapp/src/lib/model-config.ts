// model-config.ts — per-role model assignment + thinking-config mapping (PR30).
//
// Until PR30 every LLM call in extraction.ts used the single EXTRACTION_MODEL
// (gemini-2.5-flash in prod). The call sites do very different work though:
// the locator/recheck/vector-verify calls return tiny JSON verdicts where
// reasoning is pure waste, while tile transcription produces ≥95% of the
// output tokens and is where reading quality lives. Option B (see
// model_optimisation.md §4) assigns a model per ROLE:
//
//   locator       LOCATOR_MODEL        default gemini-2.5-flash-lite, thinking OFF
//   recheck       RECHECK_MODEL        default gemini-2.5-flash-lite, thinking OFF
//   verify        VERIFY_MODEL         default gemini-2.5-flash-lite, thinking OFF
//   transcription TRANSCRIPTION_MODEL  default gemini-3.5-flash-lite, thinking = THINKING_BUDGET
//   single        TRANSCRIPTION_MODEL  (same role family as transcription)
//   watermain     WM_MODEL             default gemini-2.5-flash (unchanged), thinking = THINKING_BUDGET
//
// PR31 — transcription default REVERTED from gemini-3.1-flash-lite to
// gemini-2.5-flash: 3.1-flash-lite is GA on the Developer API but is NOT
// served on Vertex AI in us-central1 for this project — the first prod smoke
// job on the PR30 build (2026-10-19) got 404 NOT_FOUND on all 66
// transcription calls and lost 36/36 tiles, while the 2.5-flash-lite locator
// call succeeded. Next candidate to smoke-test on Vertex:
// gemini-3.5-flash-lite. TRANSCRIPTION_MODEL can still select 3.1-flash-lite
// (or any model) wherever it is available.
//
// PR32 — transcription default now TRIES gemini-3.5-flash-lite, per Kiro's
// direction (2026-10-19) after 3.1-flash-lite's Vertex 404 above. It is a
// generation newer than gemini-2.5-flash at the same $0.30/$2.50 headline
// price (independent document benchmark 92.0%), so the prize is reading
// quality, not cost. It may hit the same Vertex wall as 3.1 — the
// post-deploy smoke job decides. If it also 404s on Vertex, the default
// returns to gemini-2.5-flash. As a 3.x id it steers thinking via
// thinkingLevel (thinkingConfigFor): prod THINKING_BUDGET=1024 → LOW.
//
// PRECEDENCE (per role): role env var  >  EXTRACTION_MODEL  >  built-in role
// default. EXTRACTION_MODEL deliberately beats the role DEFAULTS: existing
// A/B workflows set EXTRACTION_MODEL=<model> to run the whole pipeline on one
// model, and that must keep working exactly as before. Only an explicitly set
// role var overrides it, for that one role.

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
  locator: 'gemini-2.5-flash-lite',
  recheck: 'gemini-2.5-flash-lite',
  verify: 'gemini-2.5-flash-lite',
  transcription: 'gemini-3.5-flash-lite',
  single: 'gemini-3.5-flash-lite',
  watermain: 'gemini-2.5-flash',
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
