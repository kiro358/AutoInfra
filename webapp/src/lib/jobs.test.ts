import { describe, it, expect } from 'vitest';
import { JobStore, JobCapacityError, describeError, isJobWatchdogDisabled } from './jobs';

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('JobStore', () => {
  it('runs work in the background and exposes the result only when complete', async () => {
    const store = new JobStore<string>({ maxConcurrent: 1, maxActive: 5, ttlMs: 60_000 });
    const d = deferred<string>();
    const id = store.start('a.pdf', async (setStage, jobId) => {
      expect(jobId).toBe(id);
      setStage('pricing');
      return d.promise;
    });
    await tick();
    expect(store.get(id)).toMatchObject({ status: 'running', stage: 'pricing', result: undefined });
    d.resolve('done!');
    await tick();
    expect(store.get(id)).toMatchObject({ status: 'completed', stage: 'done', result: 'done!' });
  });

  it('records failures with a user-facing message', async () => {
    const store = new JobStore({ maxConcurrent: 1, maxActive: 5, ttlMs: 60_000 });
    const id = store.start('a.pdf', async () => {
      throw new Error('boom');
    });
    await tick();
    expect(store.get(id)).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('queues beyond maxConcurrent and refuses beyond maxActive', async () => {
    const store = new JobStore({ maxConcurrent: 1, maxActive: 2, ttlMs: 60_000 });
    const first = deferred<number>();
    const a = store.start('a', () => first.promise);
    const b = store.start('b', async () => 2);
    await tick();
    expect(store.get(a)?.status).toBe('running');
    expect(store.get(b)?.status).toBe('queued');
    expect(() => store.start('c', async () => 3)).toThrow(JobCapacityError);
    first.resolve(1);
    await tick();
    await tick();
    expect(store.get(b)?.status).toBe('completed');
  });

  it('expires finished jobs after the TTL', async () => {
    let now = 1_000;
    const store = new JobStore({ maxConcurrent: 1, maxActive: 5, ttlMs: 100, now: () => now });
    const id = store.start('a', async () => 1);
    await tick();
    expect(store.get(id)?.status).toBe('completed');
    now += 101;
    expect(store.get(id)).toBeUndefined();
  });
});

describe('JobStore deadline', () => {
  it('fails a job that overruns, and ignores its late result', async () => {
    const store = new JobStore<number>({ maxConcurrent: 1, maxActive: 5, ttlMs: 60_000, deadlineMs: 20 });
    const d = deferred<number>();
    const id = store.start('slow.pdf', () => d.promise);
    await new Promise((r) => setTimeout(r, 40));
    expect(store.get(id)).toMatchObject({ status: 'failed' });
    expect(store.get(id)?.error).toMatch(/took longer than/);
    d.resolve(1);
    await tick();
    expect(store.get(id)).toMatchObject({ status: 'failed', result: undefined });
  });

  it('watchdog-kills a never-returning job, records the diagnostic, and releases the only worker', async () => {
    const store = new JobStore<string>({ maxConcurrent: 1, maxActive: 5, ttlMs: 60_000, deadlineMs: 20 });
    const hung = deferred<string>();
    let nextStarted = false;
    const hungId = store.start('hung.pdf', () => hung.promise);
    const nextId = store.start('next.pdf', async () => {
      nextStarted = true;
      return 'next done';
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(store.get(hungId)).toMatchObject({
      status: 'failed',
      failureKind: 'watchdog-timeout',
      result: undefined,
    });
    expect(store.get(hungId)?.diagnostic).toMatch(/watchdog-timeout: job exceeded 20 ms; concurrency slot released/);
    expect(nextStarted).toBe(true);
    expect(store.get(nextId)).toMatchObject({ status: 'completed', result: 'next done' });

    // A late rejection from detached work is handled by the race and
    // cannot resurrect the killed job or poison the completed queue.
    hung.reject(new Error('late background failure'));
    await tick();
    expect(store.get(hungId)).toMatchObject({ status: 'failed', result: undefined });
    expect(store.get(nextId)).toMatchObject({ status: 'completed', result: 'next done' });
  });

  it('watchdog kill switch leaves an over-deadline job running until its work settles', async () => {
    const store = new JobStore<string>({
      maxConcurrent: 1,
      maxActive: 5,
      ttlMs: 60_000,
      deadlineMs: 20,
      watchdogDisabled: true,
    });
    const d = deferred<string>();
    const id = store.start('slow-but-allowed.pdf', () => d.promise);
    await new Promise((r) => setTimeout(r, 40));
    expect(store.get(id)).toMatchObject({ status: 'running', result: undefined });
    d.resolve('finished');
    await tick();
    expect(store.get(id)).toMatchObject({ status: 'completed', result: 'finished' });
  });
});

describe('job watchdog environment switch', () => {
  it('uses disable-when-set semantics', () => {
    expect(isJobWatchdogDisabled({})).toBe(false);
    expect(isJobWatchdogDisabled({ DISABLE_JOB_WATCHDOG: '1' })).toBe(true);
    expect(isJobWatchdogDisabled({ DISABLE_JOB_WATCHDOG: 'false' })).toBe(false);
    expect(isJobWatchdogDisabled({ DISABLE_JOB_WATCHDOG: '0' })).toBe(false);
  });
});

describe('describeError', () => {
  it('turns infrastructure errors into actionable messages', () => {
    expect(describeError(new Error('429 RESOURCE_EXHAUSTED'))).toMatch(/rate-limited/);
    expect(describeError(new Error('UND_ERR_SOCKET other side closed'))).toMatch(/connection/);
    expect(describeError(new Error('Invalid PDF structure'))).toMatch(/could not be read/);
    expect(describeError(new Error('plain'))).toBe('plain');
    expect(describeError(new Error('Retry budget exhausted after 2 attempts and 10.0 minutes (budget 10.0 minutes).')))
      .toContain('Retry budget exhausted after 2 attempts');
  });
});
