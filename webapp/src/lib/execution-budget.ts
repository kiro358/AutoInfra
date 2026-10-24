/**
 * execution-budget.ts — aggregate wall-clock budget for retrying one
 * logical external call.
 *
 * extraction.ts historically retried a call up to seven attempts.  With
 * the model client's five-minute attempt timeout and the exponential
 * sleeps, a nominal worst case was roughly 37 minutes for ONE logical
 * call, before any higher-level work was considered.  This module keeps
 * the established retry classification and backoff, but puts all of the
 * attempts and sleeps under one deadline.  When that deadline is hit,
 * the caller receives a distinct RetryBudgetError instead of another
 * attempt.
 *
 * The budget races an in-flight attempt against the remaining time.
 * JavaScript cannot forcibly cancel an arbitrary promise returned by a
 * vendor SDK, so the underlying attempt may finish in the background;
 * the logical caller is nevertheless released at the budget boundary
 * and the late value is ignored.
 */

export const RETRY_BUDGET_CODE = 'RETRY_BUDGET_EXHAUSTED';
export const DEFAULT_RETRY_BUDGET_MS = 10 * 60_000;

const FALSEY_ENV_VALUES = new Set(['', 'false', '0', 'no', 'off']);

export class RetryBudgetError extends Error {
  readonly code = RETRY_BUDGET_CODE;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly budgetMs: number;
  readonly lastError?: unknown;

  constructor(attempts: number, elapsedMs: number, budgetMs: number, lastError?: unknown) {
    super(
      `Retry budget exhausted after ${attempts} attempt${attempts === 1 ? '' : 's'} ` +
      `and ${(elapsedMs / 60_000).toFixed(1)} minutes (budget ${(budgetMs / 60_000).toFixed(1)} minutes).`
    );
    this.name = 'RetryBudgetError';
    this.attempts = attempts;
    this.elapsedMs = elapsedMs;
    this.budgetMs = budgetMs;
    this.lastError = lastError;
    if (lastError !== undefined) this.cause = lastError;
  }
}

export interface RetryBudgetConfig {
  budgetMs: number;
  disabled: boolean;
}

export interface CallWithRetryBudgetOptions {
  /** Total attempts, including the first call. Matches the historic
   *  callWithRetry parameter name/semantics. */
  maxRetries?: number;
  initialDelayMs?: number;
  /** Aggregate attempts + retry-sleep budget. Infinity disables the
   *  deadline while retaining the attempt-count limit. */
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: {
    attempt: number;
    errorType: string;
    error: unknown;
    delayMs: number;
    elapsedMs: number;
    budgetMs: number;
  }) => void;
}

function envFlagDisabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return !FALSEY_ENV_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Resolve the production retry budget from the environment.
 *
 * - MODEL_RETRY_BUDGET_MINUTES: positive finite number, default 10.
 * - DISABLE_MODEL_RETRY_BUDGET: disable-when-set, following the
 *   codebase convention that false/0/no/off never disable.
 */
export function retryBudgetConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): RetryBudgetConfig {
  if (envFlagDisabled(env.DISABLE_MODEL_RETRY_BUDGET)) {
    return { budgetMs: Number.POSITIVE_INFINITY, disabled: true };
  }
  const rawMinutes = env.MODEL_RETRY_BUDGET_MINUTES;
  const minutes = rawMinutes === undefined || rawMinutes.trim() === ''
    ? DEFAULT_RETRY_BUDGET_MS / 60_000
    : Number(rawMinutes);
  return {
    budgetMs: Number.isFinite(minutes) && minutes > 0
      ? minutes * 60_000
      : DEFAULT_RETRY_BUDGET_MS,
    disabled: false,
  };
}

export function isRetryBudgetError(err: unknown): err is RetryBudgetError {
  return (
    err instanceof RetryBudgetError ||
    (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === RETRY_BUDGET_CODE)
  );
}

const ATTEMPT_DEADLINE = Symbol('retry-budget-attempt-deadline');

async function raceAttempt<T>(
  fn: () => Promise<T>,
  remainingMs: number,
): Promise<T> {
  if (!Number.isFinite(remainingMs)) return fn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(ATTEMPT_DEADLINE), Math.max(0, remainingMs));
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function retryClassification(err: any): { retryable: boolean; errorType: string } {
  const msg = String(err?.message || '').toLowerCase();
  const isRateLimit = err?.status === 429 || msg.includes('429') || msg.includes('resource exhausted');
  const isAbort = err?.name === 'AbortError' || err?.message === 'This operation was aborted' || msg.includes('abort');
  const isServerError = err?.status >= 500 && err?.status <= 599;
  const isCancelled = err?.status === 499 || msg.includes('499') || msg.includes('cancel');
  // Transient transport failures (undici): these previously fell through and
  // zeroed a whole project. They're almost always retryable.
  const isNetwork =
    err?.name === 'TypeError' && msg.includes('fetch failed') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('terminated') ||
    (err?.cause && String(err.cause.code || err.cause).toLowerCase().match(/econn|etimedout|und_err|enotfound|socket/) != null);

  let errorType = 'Timeout/Abort';
  if (isRateLimit) errorType = '429 Rate Limit';
  else if (isCancelled) errorType = '499 Cancelled';
  else if (isServerError) errorType = `${err?.status || '5xx'} Server Error`;
  else if (isNetwork) errorType = 'Network/Transport';

  return {
    retryable: isRateLimit || isAbort || isServerError || isCancelled || isNetwork,
    errorType,
  };
}

/**
 * Call `fn` with the historic retry classes/backoff, bounded in total.
 * A retry sleep is never started if it would cross the budget.
 */
export async function callWithRetryBudget<T>(
  fn: () => Promise<T>,
  options: CallWithRetryBudgetOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 7;
  const initialDelayMs = options.initialDelayMs ?? 6_000;
  const budgetMs = options.budgetMs ?? DEFAULT_RETRY_BUDGET_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const startedAt = now();
  let attempts = 0;
  let lastError: unknown;

  while (true) {
    const elapsedBeforeAttempt = now() - startedAt;
    if (attempts > 0 && elapsedBeforeAttempt >= budgetMs) {
      throw new RetryBudgetError(attempts, elapsedBeforeAttempt, budgetMs, lastError);
    }

    attempts++;
    try {
      return await raceAttempt(fn, budgetMs - elapsedBeforeAttempt);
    } catch (err) {
      if (err === ATTEMPT_DEADLINE) {
        throw new RetryBudgetError(attempts, budgetMs, budgetMs, lastError);
      }
      lastError = err;
      const elapsed = now() - startedAt;
      if (elapsed >= budgetMs) {
        throw new RetryBudgetError(attempts, elapsed, budgetMs, err);
      }

      const { retryable, errorType } = retryClassification(err);
      if (attempts >= maxRetries || !retryable) throw err;

      // Cap the backoff so a failing call doesn't burn minutes of dead sleep.
      const delay = Math.min(30_000, initialDelayMs * Math.pow(2, attempts - 1)) + random() * 2_000;
      if (elapsed + delay >= budgetMs) {
        throw new RetryBudgetError(attempts, elapsed, budgetMs, err);
      }
      options.onRetry?.({
        attempt: attempts,
        errorType,
        error: err,
        delayMs: delay,
        elapsedMs: elapsed,
        budgetMs,
      });
      await sleep(delay);
      const elapsedAfterSleep = now() - startedAt;
      if (elapsedAfterSleep >= budgetMs) {
        throw new RetryBudgetError(attempts, elapsedAfterSleep, budgetMs, err);
      }
    }
  }
}
