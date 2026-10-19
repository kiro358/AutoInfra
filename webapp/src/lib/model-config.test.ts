import { describe, expect, it } from 'vitest';
import { ThinkingLevel } from '@google/genai';
import {
  ROLE_DEFAULT_LOCATION,
  ROLE_DEFAULT_MODEL,
  createModelFallbackState,
  effectiveModelFor,
  isModelUnavailableError,
  modelFallbackFamily,
  modelFallbackWarning,
  resolveFallbackModel,
  resolveRoleLocation,
  resolveRoleLocations,
  resolveRoleModel,
  resolveRoleModels,
  roleThinkingConfig,
  thinkingConfigFor,
  tripModelFallback,
  usesThinkingLevels,
} from './model-config';

// PR30 — role-based model assignment (Option B). Each call site in
// extraction.ts resolves its model through resolveRoleModel and its thinking
// config through roleThinkingConfig/thinkingConfigFor, so pinning those two
// functions pins every call site. Precedence per role:
//   role env var  >  EXTRACTION_MODEL  >  built-in role default.

const ROLES = ['locator', 'recheck', 'verify', 'transcription', 'single', 'watermain'] as const;

describe('resolveRoleModel — no env (built-in defaults)', () => {
  // PR34: Kiro directed "move to the latest" — every role defaults to the
  // flagship gemini-3.8-flash (the 2.5 family retires on Vertex 2026-10-20
  // and the 3.x models are only served from global/us/eu locations).
  it('assigns gemini-3.8-flash to EVERY role', () => {
    for (const role of ROLES) expect(resolveRoleModel(role, {})).toBe('gemini-3.8-flash');
  });

  it('resolveRoleModels covers every role with its default', () => {
    expect(resolveRoleModels({})).toEqual(ROLE_DEFAULT_MODEL);
  });
});

describe('resolveRoleModel — EXTRACTION_MODEL set (global fallback beats role defaults)', () => {
  const env = { EXTRACTION_MODEL: 'gemini-2.5-pro' };

  it('routes EVERY role to EXTRACTION_MODEL, preserving legacy A/B behaviour', () => {
    for (const role of ROLES) expect(resolveRoleModel(role, env)).toBe('gemini-2.5-pro');
  });
});

describe('resolveRoleModel — a role var set (beats EXTRACTION_MODEL for that role only)', () => {
  it('TRANSCRIPTION_MODEL also drives the single-pass role (same family)', () => {
    const env = { EXTRACTION_MODEL: 'gemini-2.5-pro', TRANSCRIPTION_MODEL: 'gemini-3.8-flash' };
    expect(resolveRoleModel('transcription', env)).toBe('gemini-3.8-flash');
    expect(resolveRoleModel('single', env)).toBe('gemini-3.8-flash');
    // Untouched roles still follow EXTRACTION_MODEL.
    expect(resolveRoleModel('locator', env)).toBe('gemini-2.5-pro');
    expect(resolveRoleModel('watermain', env)).toBe('gemini-2.5-pro');
  });

  it('each role var wins on its own role without env fallback present', () => {
    expect(resolveRoleModel('locator', { LOCATOR_MODEL: 'gemini-2.5-flash' })).toBe('gemini-2.5-flash');
    expect(resolveRoleModel('recheck', { RECHECK_MODEL: 'gemini-2.5-flash' })).toBe('gemini-2.5-flash');
    expect(resolveRoleModel('verify', { VERIFY_MODEL: 'gemini-2.5-flash' })).toBe('gemini-2.5-flash');
    expect(resolveRoleModel('watermain', { WM_MODEL: 'gemini-2.5-flash-lite' })).toBe('gemini-2.5-flash-lite');
  });

  it('an empty role var is ignored, not treated as a model id', () => {
    expect(resolveRoleModel('locator', { LOCATOR_MODEL: '' })).toBe('gemini-3.8-flash');
    expect(resolveRoleModel('locator', { LOCATOR_MODEL: '', EXTRACTION_MODEL: 'gemini-2.5-pro' })).toBe('gemini-2.5-pro');
  });
});

describe('usesThinkingLevels', () => {
  it('is true for Gemini 3.x and later, false for the 2.5 family', () => {
    expect(usesThinkingLevels('gemini-3.1-flash-lite')).toBe(true);
    expect(usesThinkingLevels('gemini-3.5-flash-lite')).toBe(true);
    expect(usesThinkingLevels('gemini-3.8-flash')).toBe(true);
    expect(usesThinkingLevels('gemini-4-argon')).toBe(true);
    expect(usesThinkingLevels('gemini-2.5-flash')).toBe(false);
    expect(usesThinkingLevels('gemini-2.5-flash-lite')).toBe(false);
    expect(usesThinkingLevels('gemini-2.5-pro')).toBe(false);
  });
});

describe('thinkingConfigFor — 2.5-era models keep the numeric budget', () => {
  it('passes the budget through untouched, including 0 (thinking off)', () => {
    expect(thinkingConfigFor('gemini-2.5-flash', 1024)).toEqual({ thinkingBudget: 1024 });
    expect(thinkingConfigFor('gemini-2.5-flash-lite', 0)).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfigFor('gemini-2.5-pro', 8192)).toEqual({ thinkingBudget: 8192 });
  });
});

describe('thinkingConfigFor — Gemini 3.x maps budgets to levels, never both fields', () => {
  const M = 'gemini-3.1-flash-lite';

  it('maps 0 to MINIMAL (thinking cannot be fully disabled on 3.x)', () => {
    expect(thinkingConfigFor(M, 0)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
  });

  it("maps prod's THINKING_BUDGET=1024 to LOW", () => {
    expect(thinkingConfigFor(M, 1)).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(thinkingConfigFor(M, 1024)).toEqual({ thinkingLevel: ThinkingLevel.LOW });
  });

  it('maps the code-default 8192 to MEDIUM and anything above to HIGH', () => {
    expect(thinkingConfigFor(M, 1025)).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
    expect(thinkingConfigFor(M, 8192)).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
    expect(thinkingConfigFor(M, 8193)).toEqual({ thinkingLevel: ThinkingLevel.HIGH });
    expect(thinkingConfigFor(M, 24576)).toEqual({ thinkingLevel: ThinkingLevel.HIGH });
  });

  it('never emits thinkingBudget alongside thinkingLevel (Vertex rejects both)', () => {
    for (const budget of [0, 512, 1024, 8192, 32768]) {
      const cfg = thinkingConfigFor(M, budget) as Record<string, unknown>;
      expect('thinkingBudget' in cfg).toBe(false);
      expect('thinkingLevel' in cfg).toBe(true);
    }
  });

  it('pins gemini-3.5-flash-lite (a 3.x id, selectable via TRANSCRIPTION_MODEL) at the boundary budgets', () => {
    const M35 = 'gemini-3.5-flash-lite';
    expect(thinkingConfigFor(M35, 0)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(thinkingConfigFor(M35, 1024)).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(thinkingConfigFor(M35, 8192)).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
  });

  it('pins gemini-3.8-flash (the PR34 default for every role) at the boundary budgets', () => {
    const M38 = 'gemini-3.8-flash';
    expect(thinkingConfigFor(M38, 0)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(thinkingConfigFor(M38, 1024)).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(thinkingConfigFor(M38, 8192)).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
    expect(thinkingConfigFor(M38, 8193)).toEqual({ thinkingLevel: ThinkingLevel.HIGH });
  });
});

describe('roleThinkingConfig — per-role thinking under the three env conditions', () => {
  it('(a) no env: every role is on gemini-3.8-flash (3.x) — no-thinking roles map 0 to MINIMAL, the rest map the budget to a level', () => {
    const models = resolveRoleModels({});
    // Prod pins THINKING_BUDGET=1024; code default is 8192. Both are pinned here.
    expect(roleThinkingConfig('locator', models.locator, 1024)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(roleThinkingConfig('recheck', models.recheck, 1024)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(roleThinkingConfig('verify', models.verify, 1024)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    // PR34: transcription/single/watermain default to gemini-3.8-flash →
    // 1024 (prod) maps to LOW, the code-default 8192 maps to MEDIUM.
    expect(roleThinkingConfig('transcription', models.transcription, 1024)).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(roleThinkingConfig('transcription', models.transcription, 8192)).toEqual({ thinkingLevel: ThinkingLevel.MEDIUM });
    expect(roleThinkingConfig('single', models.single, 1024)).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(roleThinkingConfig('watermain', models.watermain, 1024)).toEqual({ thinkingLevel: ThinkingLevel.LOW });
  });

  it('(b) EXTRACTION_MODEL=gemini-2.5-flash: every role is back on numeric budgets', () => {
    const models = resolveRoleModels({ EXTRACTION_MODEL: 'gemini-2.5-flash' });
    expect(roleThinkingConfig('transcription', models.transcription, 1024)).toEqual({ thinkingBudget: 1024 });
    expect(roleThinkingConfig('locator', models.locator, 1024)).toEqual({ thinkingBudget: 0 });
  });

  it('(c) role var points a no-thinking role at a 3.x model: 0 maps to MINIMAL, not a numeric budget', () => {
    const models = resolveRoleModels({ LOCATOR_MODEL: 'gemini-3.1-flash-lite' });
    expect(roleThinkingConfig('locator', models.locator, 1024)).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
  });
});

// PR34 — per-role Vertex locations. Precedence per role:
//   <ROLE>_LOCATION  >  GCP_LOCATION  >  built-in default ('us').
// The 3.x models are served only from global/us/eu, never us-central1 —
// the location is part of a role's assignment, like its model.
describe('resolveRoleLocation — PR34 per-role locations', () => {
  it("defaults EVERY role to 'us' (where the 3.x models are served)", () => {
    for (const role of ROLES) expect(resolveRoleLocation(role, {})).toBe('us');
    expect(resolveRoleLocations({})).toEqual(ROLE_DEFAULT_LOCATION);
  });

  it('GCP_LOCATION beats the built-in default for every role', () => {
    for (const role of ROLES) expect(resolveRoleLocation(role, { GCP_LOCATION: 'global' })).toBe('global');
  });

  it('a role var beats GCP_LOCATION for that role only', () => {
    const env = { GCP_LOCATION: 'us-central1', TRANSCRIPTION_LOCATION: 'global' };
    expect(resolveRoleLocation('transcription', env)).toBe('global');
    // TRANSCRIPTION_LOCATION also drives single (same family, like the model var).
    expect(resolveRoleLocation('single', env)).toBe('global');
    expect(resolveRoleLocation('locator', env)).toBe('us-central1');
    expect(resolveRoleLocation('watermain', env)).toBe('us-central1');
  });

  it('each role var wins on its own role', () => {
    expect(resolveRoleLocation('locator', { LOCATOR_LOCATION: 'eu' })).toBe('eu');
    expect(resolveRoleLocation('recheck', { RECHECK_LOCATION: 'eu' })).toBe('eu');
    expect(resolveRoleLocation('verify', { VERIFY_LOCATION: 'eu' })).toBe('eu');
    expect(resolveRoleLocation('watermain', { WM_LOCATION: 'eu' })).toBe('eu');
  });

  it('an empty role var is ignored, not treated as a location', () => {
    expect(resolveRoleLocation('locator', { LOCATOR_LOCATION: '' })).toBe('us');
    expect(resolveRoleLocation('locator', { LOCATOR_LOCATION: '', GCP_LOCATION: 'europe-west1' })).toBe('europe-west1');
  });
});

describe('resolveFallbackModel — PR34 fallback target', () => {
  it('defaults to gemini-3.5-flash-lite', () => {
    expect(resolveFallbackModel({})).toBe('gemini-3.5-flash-lite');
  });

  it('TRANSCRIPTION_FALLBACK_MODEL overrides; an empty value is ignored', () => {
    expect(resolveFallbackModel({ TRANSCRIPTION_FALLBACK_MODEL: 'gemini-3.1-flash-lite' })).toBe('gemini-3.1-flash-lite');
    expect(resolveFallbackModel({ TRANSCRIPTION_FALLBACK_MODEL: '' })).toBe('gemini-3.5-flash-lite');
  });
});

describe('isModelUnavailableError — only the Vertex 404 shape trips the fallback', () => {
  const notFound = Object.assign(
    new Error('Publisher model `projects/x/locations/us-central1/publishers/google/models/gemini-3.8-flash` was not found or your project does not have access to it'),
    { status: 404 },
  );

  it('matches HTTP 404 and the NOT_FOUND message shapes', () => {
    expect(isModelUnavailableError(notFound)).toBe(true);
    expect(isModelUnavailableError(Object.assign(new Error('boom'), { status: 404 }))).toBe(true);
    expect(isModelUnavailableError(new Error('NOT_FOUND: model missing'))).toBe(true);
    expect(isModelUnavailableError(new Error('the model was not found'))).toBe(true);
  });

  it('does NOT match transient or unrelated errors (429 / 5xx / 400 / transport / null)', () => {
    expect(isModelUnavailableError(Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429 }))).toBe(false);
    expect(isModelUnavailableError(Object.assign(new Error('500 Internal error'), { status: 500 }))).toBe(false);
    expect(isModelUnavailableError(Object.assign(new Error('INVALID_ARGUMENT'), { status: 400 }))).toBe(false);
    expect(isModelUnavailableError(new Error('fetch failed'))).toBe(false);
    expect(isModelUnavailableError(null)).toBe(false);
    expect(isModelUnavailableError(undefined)).toBe(false);
    expect(isModelUnavailableError('a string')).toBe(false);
  });
});

describe('model fallback state machine — PR34', () => {
  const CONFIGURED = 'gemini-3.8-flash';
  const FALLBACK = 'gemini-3.5-flash-lite';
  const err404 = () => Object.assign(new Error('model was not found'), { status: 404 });

  it('families: transcription+single share one trip; watermain is its own; other roles never trip', () => {
    expect(modelFallbackFamily('transcription')).toBe('transcription');
    expect(modelFallbackFamily('single')).toBe('transcription');
    expect(modelFallbackFamily('watermain')).toBe('watermain');
    expect(modelFallbackFamily('locator')).toBeNull();
    expect(modelFallbackFamily('recheck')).toBeNull();
    expect(modelFallbackFamily('verify')).toBeNull();
  });

  it('before any trip, the effective model is the configured one', () => {
    const s = createModelFallbackState(FALLBACK);
    expect(effectiveModelFor(s, 'transcription', CONFIGURED)).toBe(CONFIGURED);
    expect(effectiveModelFor(s, 'single', CONFIGURED)).toBe(CONFIGURED);
    expect(effectiveModelFor(s, 'watermain', CONFIGURED)).toBe(CONFIGURED);
    expect(s.trips).toEqual([]);
  });

  it('a 404 trips ONCE: returns the fallback, records the trip, and sticks for the whole family', () => {
    const s = createModelFallbackState(FALLBACK);
    expect(tripModelFallback(s, 'transcription', CONFIGURED, err404())).toBe(FALLBACK);
    expect(s.trips).toEqual([{ role: 'transcription', from: CONFIGURED, to: FALLBACK }]);
    expect(s.firstError).toContain('was not found');
    // Sticks: both family roles now resolve to the fallback...
    expect(effectiveModelFor(s, 'transcription', CONFIGURED)).toBe(FALLBACK);
    expect(effectiveModelFor(s, 'single', CONFIGURED)).toBe(FALLBACK);
    // ...the other family is untouched...
    expect(effectiveModelFor(s, 'watermain', CONFIGURED)).toBe(CONFIGURED);
    // ...and a second availability error does not trip again (no double retry).
    expect(tripModelFallback(s, 'single', CONFIGURED, err404())).toBeNull();
    expect(s.trips).toHaveLength(1);
  });

  it('a watermain trip is independent of the transcription family', () => {
    const s = createModelFallbackState(FALLBACK);
    expect(tripModelFallback(s, 'watermain', CONFIGURED, err404())).toBe(FALLBACK);
    expect(effectiveModelFor(s, 'watermain', CONFIGURED)).toBe(FALLBACK);
    expect(effectiveModelFor(s, 'transcription', CONFIGURED)).toBe(CONFIGURED);
  });

  it('429 and 500 errors never trip and record nothing', () => {
    const s = createModelFallbackState(FALLBACK);
    expect(tripModelFallback(s, 'transcription', CONFIGURED, Object.assign(new Error('429'), { status: 429 }))).toBeNull();
    expect(tripModelFallback(s, 'transcription', CONFIGURED, Object.assign(new Error('503'), { status: 503 }))).toBeNull();
    expect(s.trips).toEqual([]);
    expect(effectiveModelFor(s, 'transcription', CONFIGURED)).toBe(CONFIGURED);
  });

  it('no trip when the fallback IS the configured model (nowhere to fall)', () => {
    const s = createModelFallbackState(CONFIGURED);
    expect(tripModelFallback(s, 'transcription', CONFIGURED, err404())).toBeNull();
    expect(s.trips).toEqual([]);
  });

  it('the warning names both models and the family', () => {
    expect(modelFallbackWarning({ role: 'transcription', from: CONFIGURED, to: FALLBACK }))
      .toBe(`Transcription model ${CONFIGURED} unavailable (404) — fell back to ${FALLBACK} for the rest of this job.`);
    expect(modelFallbackWarning({ role: 'watermain', from: CONFIGURED, to: FALLBACK }))
      .toBe(`Watermain model ${CONFIGURED} unavailable (404) — fell back to ${FALLBACK} for the rest of this job.`);
  });
});
