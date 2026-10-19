import { describe, expect, it } from 'vitest';
import { ThinkingLevel } from '@google/genai';
import {
  ROLE_DEFAULT_MODEL,
  resolveRoleModel,
  resolveRoleModels,
  roleThinkingConfig,
  thinkingConfigFor,
  usesThinkingLevels,
} from './model-config';

// PR30 — role-based model assignment (Option B). Each call site in
// extraction.ts resolves its model through resolveRoleModel and its thinking
// config through roleThinkingConfig/thinkingConfigFor, so pinning those two
// functions pins every call site. Precedence per role:
//   role env var  >  EXTRACTION_MODEL  >  built-in role default.

const ROLES = ['locator', 'recheck', 'verify', 'transcription', 'single', 'watermain'] as const;

describe('resolveRoleModel — no env (built-in Option B defaults)', () => {
  it('assigns flash-lite with thinking off to locator/recheck/verify', () => {
    expect(resolveRoleModel('locator', {})).toBe('gemini-2.5-flash-lite');
    expect(resolveRoleModel('recheck', {})).toBe('gemini-2.5-flash-lite');
    expect(resolveRoleModel('verify', {})).toBe('gemini-2.5-flash-lite');
  });

  it('assigns gemini-2.5-flash to transcription and single-pass (PR31: 3.1-flash-lite 404s on Vertex)', () => {
    expect(resolveRoleModel('transcription', {})).toBe('gemini-2.5-flash');
    expect(resolveRoleModel('single', {})).toBe('gemini-2.5-flash');
  });

  it('keeps the watermain second pass on gemini-2.5-flash', () => {
    expect(resolveRoleModel('watermain', {})).toBe('gemini-2.5-flash');
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
    expect(resolveRoleModel('locator', { LOCATOR_MODEL: '' })).toBe('gemini-2.5-flash-lite');
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
});

describe('roleThinkingConfig — per-role thinking under the three env conditions', () => {
  it('(a) no env: locator/recheck/verify think 0 on flash-lite; transcription passes THINKING_BUDGET through (PR31: 2.5-flash); watermain keeps its budget', () => {
    const models = resolveRoleModels({});
    // Prod pins THINKING_BUDGET=1024; code default is 8192. Both are pinned here.
    expect(roleThinkingConfig('locator', models.locator, 1024)).toEqual({ thinkingBudget: 0 });
    expect(roleThinkingConfig('recheck', models.recheck, 1024)).toEqual({ thinkingBudget: 0 });
    expect(roleThinkingConfig('verify', models.verify, 1024)).toEqual({ thinkingBudget: 0 });
    // PR31: transcription/single default to gemini-2.5-flash → numeric passthrough.
    // (The 3.x level mapping itself stays pinned in the thinkingConfigFor block
    // above and in (c), for whenever TRANSCRIPTION_MODEL selects a 3.x model.)
    expect(roleThinkingConfig('transcription', models.transcription, 1024)).toEqual({ thinkingBudget: 1024 });
    expect(roleThinkingConfig('transcription', models.transcription, 8192)).toEqual({ thinkingBudget: 8192 });
    expect(roleThinkingConfig('single', models.single, 1024)).toEqual({ thinkingBudget: 1024 });
    expect(roleThinkingConfig('watermain', models.watermain, 1024)).toEqual({ thinkingBudget: 1024 });
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
