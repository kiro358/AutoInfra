import { describe, expect, it } from 'vitest';
import {
  callWithRetryBudget,
  isRetryBudgetError,
  RetryBudgetError,
  retryBudgetConfigFromEnv,
} from './execution-budget';

function rateLimitError(): Error & { status: number } {
  return Object.assign(new Error('429 RESOURCE_EXHAUSTED'), { status: 429 });
}

describe('callWithRetryBudget', () => {
  it('kills a never-returning attempt at the aggregate deadline', async () => {
    let calls = 0;
    const started = Date.now();
    const promise = callWithRetryBudget(
      () => {
        calls++;
        return new Promise<string>(() => undefined);
      },
      { budgetMs: 25, initialDelayMs: 1 },
    );

    await expect(promise).rejects.toMatchObject({
      name: 'RetryBudgetError',
      code: 'RETRY_BUDGET_EXHAUSTED',
      attempts: 1,
      budgetMs: 25,
      elapsedMs: 25,
    });
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('stops a retry storm before a sleep would cross the budget', async () => {
    let now = 0;
    const sleeps: number[] = [];
    let calls = 0;
    const promise = callWithRetryBudget(
      async () => {
        calls++;
        throw rateLimitError();
      },
      {
        budgetMs: 100,
        initialDelayMs: 60,
        now: () => now,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );

    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(RetryBudgetError);
    expect(isRetryBudgetError(err)).toBe(true);
    expect(err.attempts).toBe(2);
    // First sleep is 60 ms. The second calculated sleep is 120 ms;
    // starting it at t=60 would cross t=100, so it is never taken.
    expect(sleeps).toEqual([60]);
    expect(calls).toBe(2);
  });

  it('preserves success after retryable failures inside the budget', async () => {
    let now = 0;
    let calls = 0;
    const result = await callWithRetryBudget(
      async () => {
        calls++;
        if (calls < 3) throw rateLimitError();
        return 'ok';
      },
      {
        budgetMs: 1_000,
        initialDelayMs: 1,
        now: () => now,
        random: () => 0,
        sleep: async (ms) => { now += ms; },
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does not disguise a non-retryable error as a budget failure', async () => {
    const original = new Error('bad request');
    await expect(callWithRetryBudget(async () => { throw original; }, { budgetMs: 1_000 }))
      .rejects.toBe(original);
  });

  it('with the budget disabled, the historic attempt cap still returns the original error', async () => {
    let now = 0;
    let calls = 0;
    const promise = callWithRetryBudget(
      async () => {
        calls++;
        throw rateLimitError();
      },
      {
        budgetMs: Number.POSITIVE_INFINITY,
        maxRetries: 3,
        initialDelayMs: 1,
        now: () => now,
        random: () => 0,
        sleep: async (ms) => { now += ms; },
      },
    );
    const err = await promise.catch((e) => e);
    expect(err).not.toBeInstanceOf(RetryBudgetError);
    expect(err.message).toContain('429');
    expect(calls).toBe(3);
  });
});

describe('retryBudgetConfigFromEnv', () => {
  it('defaults to ten minutes and honours tuning and the kill switch', () => {
    expect(retryBudgetConfigFromEnv({})).toEqual({ budgetMs: 600_000, disabled: false });
    expect(retryBudgetConfigFromEnv({ MODEL_RETRY_BUDGET_MINUTES: '12.5' }))
      .toEqual({ budgetMs: 750_000, disabled: false });
    expect(retryBudgetConfigFromEnv({ DISABLE_MODEL_RETRY_BUDGET: '1' }))
      .toEqual({ budgetMs: Number.POSITIVE_INFINITY, disabled: true });
    expect(retryBudgetConfigFromEnv({ DISABLE_MODEL_RETRY_BUDGET: 'false' }).disabled).toBe(false);
    expect(retryBudgetConfigFromEnv({ MODEL_RETRY_BUDGET_MINUTES: 'not-a-number' }).budgetMs).toBe(600_000);
  });
});
