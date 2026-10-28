import { describe, it, expect } from 'vitest';
import {
  JobStore,
  JobCapacityError,
  describeError,
  isJobWatchdogDisabled,
  type Job,
  type JobPersistencePort,
} from './jobs';

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

describe('JobStore persistent re-check of hydrated records (PR 63)', () => {
  const runningJob: Job<string> = {
    id: 'job-hydrated',
    status: 'running',
    stage: 'extracting',
    fileName: 'x.pdf',
    createdAt: 1_000,
    updatedAt: 1_500,
  };

  /** A JobPersistencePort double: `stored` is what load() reads back;
   *  tests mutate it to simulate the store moving under a hydrated copy. */
  function fakePort(initial: Job<string> | undefined) {
    const port: JobPersistencePort<string> & {
      stored: Job<string> | undefined;
      loads: number;
      transitions: number;
      failLoads: boolean;
    } = {
      stored: initial,
      loads: 0,
      transitions: 0,
      failLoads: false,
      onTransition() {
        port.transitions++;
      },
      async load() {
        port.loads++;
        if (port.failLoads) throw new Error('store is down');
        return port.stored ? { ...port.stored } : undefined;
      },
    };
    return port;
  }

  function storeWith(port: JobPersistencePort<string>) {
    // Fixed clock: the fixture timestamps (1_000–9_000) must sit inside
    // the TTL window, or sweep() would evict terminal records mid-test.
    return new JobStore<string>({
      maxConcurrent: 1,
      maxActive: 5,
      ttlMs: 60_000,
      persistence: port,
      now: () => 10_000,
    });
  }

  it('(a) serves the reconciled interrupted state over a stale hydrated running snapshot', async () => {
    const port = fakePort({ ...runningJob });
    const store = storeWith(port);
    // First poll after the restart: memory miss → hydrate the running record.
    expect(await store.getAsync('job-hydrated')).toMatchObject({ status: 'running', stage: 'extracting' });
    expect(port.loads).toBe(1);

    // Boot reconciliation lands in the store: the record is now interrupted.
    port.stored = {
      ...runningJob,
      status: 'failed',
      stage: 'extracting',
      failureKind: 'interrupted',
      error: 'This takeoff was interrupted — the server restarted before it finished.',
      updatedAt: 2_000,
    };
    const view = await store.getAsync('job-hydrated');
    expect(view).toMatchObject({ status: 'failed', failureKind: 'interrupted' });
    expect(view?.error).toMatch(/interrupted/);
    expect(port.loads).toBe(2);

    // Terminal now: the record left the re-check set — later polls are
    // pure memory hits with no further store reads.
    expect(await store.getAsync('job-hydrated')).toMatchObject({ status: 'failed', failureKind: 'interrupted' });
    expect(port.loads).toBe(2);
  });

  it('(b) serves a still-running store record refreshed, never regressed', async () => {
    const port = fakePort({ ...runningJob });
    const store = storeWith(port);
    expect(await store.getAsync('job-hydrated')).toMatchObject({ status: 'running', elapsedMs: 500 });

    // The store's snapshot moved on (a stage write landed before the
    // worker died): the poll must show the fresher stage/elapsed.
    port.stored = { ...runningJob, stage: 'pricing', updatedAt: 9_000 };
    const view = await store.getAsync('job-hydrated');
    expect(view).toMatchObject({ status: 'running', stage: 'pricing', elapsedMs: 8_000 });
  });

  it('(c) a same-instance job never triggers a store read on the poll path', async () => {
    const port = fakePort(undefined);
    const store = storeWith(port);
    const d = deferred<string>();
    const id = store.start('own.pdf', async () => d.promise);
    await tick();
    expect(await store.getAsync(id)).toMatchObject({ status: 'running' });
    expect(await store.getAsync(id)).toMatchObject({ status: 'running' });
    d.resolve('done');
    await tick();
    expect(await store.getAsync(id)).toMatchObject({ status: 'completed', result: 'done' });
    // Write-through fired (the port saw transitions) but load() was
    // never called: owned jobs are served purely from memory.
    expect(port.transitions).toBeGreaterThan(0);
    expect(port.loads).toBe(0);
  });

  it('a failing re-check serves the in-memory view instead of throwing', async () => {
    const port = fakePort({ ...runningJob });
    const store = storeWith(port);
    expect(await store.getAsync('job-hydrated')).toMatchObject({ status: 'running' });
    port.failLoads = true;
    expect(await store.getAsync('job-hydrated')).toMatchObject({ status: 'running', stage: 'extracting' });
  });

  it('without persistence, getAsync stays exactly get()', async () => {
    const store = new JobStore<string>({ maxConcurrent: 1, maxActive: 5, ttlMs: 60_000 });
    expect(await store.getAsync('nope')).toBeUndefined();
    const id = store.start('a.pdf', async () => 'r');
    await tick();
    expect(await store.getAsync(id)).toMatchObject({ status: 'completed', result: 'r' });
  });
});

describe('PR 65 observability: watchdog-armed + recheck freeze logs', () => {
  function captureConsoleError() {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    };
    return { lines, restore: () => (console.error = original) };
  }

  it('logs the armed watchdog (job id + deadline minutes) when a job starts', async () => {
    const cap = captureConsoleError();
    try {
      const store = new JobStore<string>({
        maxConcurrent: 1,
        maxActive: 5,
        ttlMs: 60_000,
        deadlineMs: 30 * 60_000,
      });
      const d = deferred<string>();
      const id = store.start('armed.pdf', () => d.promise);
      await tick();
      await tick();
      const armed = cap.lines.filter((l) => /watchdog armed/.test(l));
      expect(armed).toHaveLength(1);
      expect(armed[0]).toContain(id);
      expect(armed[0]).toContain('30');
      d.resolve('done');
      await tick();
    } finally {
      cap.restore();
    }
  });

  it('logs the watchdog as disabled (not silently unarmed) when the kill switch is on', async () => {
    const cap = captureConsoleError();
    try {
      const store = new JobStore<string>({
        maxConcurrent: 1,
        maxActive: 5,
        ttlMs: 60_000,
        deadlineMs: 30 * 60_000,
        watchdogDisabled: true,
      });
      const d = deferred<string>();
      const id = store.start('disarmed.pdf', () => d.promise);
      await tick();
      await tick();
      const lines = cap.lines.filter((l) => /watchdog/.test(l) && l.includes(id));
      expect(lines.some((l) => /disabled/.test(l))).toBe(true);
      d.resolve('done');
      await tick();
    } finally {
      cap.restore();
    }
  });

  // Same fake-port pattern as the PR 63 describe above: `stored` is the
  // store's truth; the fixed clock (10_000) sits the fixture ages where
  // the test wants them relative to the 5_000 ms deadline.
  function freezePort(initial: Job<string>): JobPersistencePort<string> {
    const port: JobPersistencePort<string> & { stored: Job<string> } = {
      stored: initial,
      onTransition() {},
      async load() {
        return port.stored ? { ...port.stored } : undefined;
      },
    };
    return port;
  }
  const frozenRunning: Job<string> = {
    id: 'job-frozen',
    status: 'running',
    stage: 'extracting',
    fileName: 'frozen.pdf',
    createdAt: 1_000,
    updatedAt: 1_500, // age at now=10_000 is 8_500 ms — past the 5_000 deadline
  };

  it('logs the frozen-job signature once per record when the re-check serves an over-deadline hydrated record', async () => {
    const cap = captureConsoleError();
    try {
      const port = freezePort({ ...frozenRunning });
      const store = new JobStore<string>({
        maxConcurrent: 1,
        maxActive: 5,
        ttlMs: 60_000,
        deadlineMs: 5_000,
        persistence: port,
        now: () => 10_000,
      });
      // First poll hydrates (memory miss — no re-check, no log yet).
      expect(await store.getAsync('job-frozen')).toMatchObject({ status: 'running' });
      // Subsequent polls re-check and serve the still-running store record:
      // the freeze names itself — once.
      expect(await store.getAsync('job-frozen')).toMatchObject({ status: 'running' });
      expect(await store.getAsync('job-frozen')).toMatchObject({ status: 'running' });
      const hits = cap.lines.filter((l) => /still non-terminal/.test(l));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('job-frozen');
      expect(hits[0]).toContain('8500');
    } finally {
      cap.restore();
    }
  });

  it('does not log the freeze signature for a fresh (within-deadline) hydrated record', async () => {
    const cap = captureConsoleError();
    try {
      const port = freezePort({ ...frozenRunning, updatedAt: 9_000 }); // age 1_000 < 5_000
      const store = new JobStore<string>({
        maxConcurrent: 1,
        maxActive: 5,
        ttlMs: 60_000,
        deadlineMs: 5_000,
        persistence: port,
        now: () => 10_000,
      });
      expect(await store.getAsync('job-frozen')).toMatchObject({ status: 'running' });
      expect(await store.getAsync('job-frozen')).toMatchObject({ status: 'running' });
      expect(cap.lines.filter((l) => /still non-terminal/.test(l))).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });
});
