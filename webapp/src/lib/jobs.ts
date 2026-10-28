/**
 * Background takeoff jobs.
 *
 * A takeoff takes minutes (page location + LLM transcription of dozens of tiles).
 * Doing it inside one HTTP request made every non-trivial drawing set die with a
 * 504 at the proxy/Cloud Run timeout. Instead, POST /api/process validates the
 * upload, registers a job here and returns its id at once; the work runs in the
 * background and the browser polls GET /api/jobs/[id].
 *
 * The store is in-memory, which is correct only while ONE instance serves both
 * the POST and the polls and keeps CPU between requests. The Cloud Run deploy
 * pins that (`--max-instances=1 --no-cpu-throttling`, see deploy.yml). If that
 * ever needs to scale out, swap `JobStore` for a GCS/Firestore-backed one — the
 * routes only talk to the interface.
 */
import { randomUUID } from 'crypto';
import { createJobPersistenceFromEnv } from './job-persistence';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

/** Coarse server-side stages, in order. The UI maps these onto its timeline. */
export const JOB_STAGES = ['queued', 'extracting', 'pricing', 'documents', 'done'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export type JobFailureKind = 'watchdog-timeout' | 'execution-error' | 'interrupted';

export interface Job<R = unknown> {
  id: string;
  status: JobStatus;
  stage: JobStage;
  fileName: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  failureKind?: JobFailureKind;
  /** Machine-/operator-readable detail behind a failure. In particular, a
   * watchdog kill says so here while the public error remains concise. */
  diagnostic?: string;
  result?: R;
}

/**
 * The persistence port (see job-persistence.ts). The store notifies every
 * state transition and can read a job back after a restart. Implemented by
 * the GCS write-through adapter; absent = pure in-memory store (the
 * pre-persistence behaviour, byte for byte).
 */
export interface JobPersistencePort<R = unknown> {
  /** Fire-and-forget transition hook; must never throw. */
  onTransition(job: Readonly<Job<R>>): void;
  /** Read a job back from the persistent store, if it exists there. */
  load(id: string): Promise<Job<R> | undefined>;
}

/** Public view: never leaks the result until it is complete. */
export interface JobView<R = unknown> {
  id: string;
  status: JobStatus;
  stage: JobStage;
  fileName: string;
  elapsedMs: number;
  error?: string;
  failureKind?: JobFailureKind;
  diagnostic?: string;
  result?: R;
}

export class JobStore<R = unknown> {
  private readonly jobs = new Map<string, Job<R>>();
  /**
   * Ids whose in-memory record entered via persistent read-back (getAsync
   * hydration) rather than this instance's start(). The distinction is the
   * provenance the wart fix (PR 63) keys on: a hydrated record's worker is
   * another (dead) instance, so its non-terminal snapshot can be stale in
   * a way an owned record's never is — see getAsync.
   */
  private readonly hydrated = new Set<string>();
  /**
   * Ids for which the frozen-job signature (PR 65) has already been
   * logged on this instance: the re-check serves a hydrated record on
   * every poll, and the log must name the freeze once, not per poll.
   */
  private readonly recheckFreezeLogged = new Set<string>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly opts: {
      /** Jobs allowed to run at once; the rest wait (memory-bound work). */
      maxConcurrent: number;
      /** Queued + running jobs beyond which new uploads are refused. */
      maxActive: number;
      /** How long finished jobs (and their results) are kept for polling. */
      ttlMs: number;
      /**
       * Wall-clock watchdog for one running job. Past it the job is failed
       * with a watchdog diagnostic and its concurrency slot is released
       * immediately. JavaScript cannot forcibly cancel the underlying
       * promise, so detached work may finish in the background, but its
       * late result is discarded.
       */
      deadlineMs?: number;
      /** Explicit test/config override for DISABLE_JOB_WATCHDOG. */
      watchdogDisabled?: boolean;
      /**
       * Optional write-through persistence. When present, every state
       * transition is notified and getAsync can read jobs back after a
       * restart. When absent, the store is exactly the pre-persistence
       * in-memory store.
       */
      persistence?: JobPersistencePort<R>;
      now?: () => number;
    }
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get activeCount(): number {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') n++;
    }
    return n;
  }

  /** Drop finished jobs older than the TTL. Called on every create/get. */
  sweep(): void {
    const cutoff = this.now() - this.opts.ttlMs;
    for (const [id, job] of this.jobs) {
      const finished = job.status === 'completed' || job.status === 'failed';
      if (finished && job.updatedAt < cutoff) {
        this.jobs.delete(id);
        this.hydrated.delete(id);
        this.recheckFreezeLogged.delete(id);
      }
    }
  }

  private view(job: Job<R>): JobView<R> {
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      fileName: job.fileName,
      elapsedMs: job.updatedAt - job.createdAt,
      error: job.error,
      failureKind: job.failureKind,
      diagnostic: job.diagnostic,
      result: job.status === 'completed' ? job.result : undefined,
    };
  }

  get(id: string): JobView<R> | undefined {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return this.view(job);
  }

  /**
   * Memory-first read with persistent read-back. The sync get() stays the
   * hot path; only on a memory miss (the post-restart case) is the store
   * consulted, and a found job is hydrated into memory so later polls are
   * fast again. Without persistence configured this is exactly get().
   *
   * PR 63 (the #81 wart): a hydrated NON-TERMINAL record is not trusted
   * blindly. Its worker belonged to a dead instance, and this instance's
   * boot reconciliation may already have marked the record interrupted in
   * the store — but a poll that hydrated the record before that write (or
   * on an instance whose reconciliation raced it) would otherwise serve
   * the frozen `running` snapshot until the instance turns over. So a
   * non-terminal record this instance did NOT create is re-checked
   * against the store on each poll. The bound: owned jobs (start() on
   * this instance) never pay a store read on the hit path, and a hydrated
   * record leaves the re-check set the moment the store shows it
   * terminal — in practice the re-check fires for the few polls between
   * hydration and reconciliation landing, then never again.
   */
  async getAsync(id: string): Promise<JobView<R> | undefined> {
    const hit = this.get(id);
    const persistence = this.opts.persistence;
    if (hit) {
      if (
        persistence &&
        this.hydrated.has(id) &&
        hit.status !== 'completed' &&
        hit.status !== 'failed'
      ) {
        return this.recheckHydrated(id, persistence, hit);
      }
      return hit;
    }
    if (!persistence) return undefined;
    let job: Job<R> | undefined;
    try {
      job = await persistence.load(id);
    } catch (err) {
      // A broken store must not turn an honest 404 into a 500.
      console.error(`[jobs] persistent read-back failed for ${id}:`, err);
      return undefined;
    }
    if (!job) return undefined;
    if (!this.jobs.has(id)) {
      this.jobs.set(id, job);
      this.hydrated.add(id);
    }
    return this.view(job);
  }

  /**
   * Re-read a hydrated non-terminal record from the persistent store and
   * serve the store's truth: a terminal record replaces the stale
   * snapshot (and leaves the re-check set); a still-live record refreshes
   * the snapshot when it has moved. A store failure or disappearance
   * serves the in-memory view — a poll must never become a 500 or a
   * false 404 because the re-check could not run.
   */
  private async recheckHydrated(
    id: string,
    persistence: JobPersistencePort<R>,
    current: JobView<R>
  ): Promise<JobView<R>> {
    let fresh: Job<R> | undefined;
    try {
      fresh = await persistence.load(id);
    } catch (err) {
      console.error(`[jobs] persistent re-check failed for ${id}:`, err);
      return current;
    }
    if (!fresh) return current;
    const terminal = fresh.status === 'completed' || fresh.status === 'failed';
    if (terminal) {
      this.jobs.set(id, fresh);
      this.hydrated.delete(id);
      this.recheckFreezeLogged.delete(id);
      return this.view(fresh);
    }
    this.noteFrozenHydrated(id, fresh);
    const held = this.jobs.get(id);
    if (
      !held ||
      fresh.status !== held.status ||
      fresh.stage !== held.stage ||
      fresh.updatedAt !== held.updatedAt
    ) {
      this.jobs.set(id, fresh);
      return this.view(fresh);
    }
    return current;
  }

  /**
   * PR 65 self-announcing freeze: a hydrated record that is still
   * non-terminal in the store when its last update is older than the job
   * deadline is the 09546d5b signature — its worker is gone and boot
   * reconciliation has not marked it interrupted (or never landed). A
   * live owned job can legitimately sit in one long stage past the
   * deadline only until its watchdog fires; a hydrated one has no
   * watchdog anywhere, so serving it past the deadline should name
   * itself in the logs. Once per record per instance.
   */
  private noteFrozenHydrated(id: string, fresh: Job<R>): void {
    if (this.opts.watchdogDisabled) return;
    const deadlineMs = this.opts.deadlineMs;
    if (!deadlineMs) return;
    const ageMs = this.now() - fresh.updatedAt;
    if (ageMs <= deadlineMs) return;
    if (this.recheckFreezeLogged.has(id)) return;
    this.recheckFreezeLogged.add(id);
    console.error(
      `[jobs] persistent re-check: hydrated job ${id} is still non-terminal in the store ` +
        `(${fresh.status}/${fresh.stage}) ${ageMs} ms after its last update — older than the ` +
        `${deadlineMs} ms job deadline; this is the frozen-job signature (its worker is gone ` +
        'and reconciliation has not marked it interrupted)'
    );
  }

  /**
   * Notify the persistence adapter of a state transition. The adapter is
   * fire-and-forget and must never throw; this guard keeps even a broken
   * adapter from breaking the job itself.
   */
  private notify(job: Job<R>): void {
    const persistence = this.opts.persistence;
    if (!persistence) return;
    try {
      persistence.onTransition(job);
    } catch (err) {
      console.error(`[jobs] persistence hook failed for ${job.id}:`, err);
    }
  }

  /**
   * Register a job and start `work` in the background. Returns the id
   * immediately; throws `JobCapacityError` when the server is saturated.
   */
  start(
    fileName: string,
    work: (setStage: (stage: JobStage) => void, jobId: string) => Promise<R>
  ): string {
    this.sweep();
    if (this.activeCount >= this.opts.maxActive) {
      throw new JobCapacityError();
    }
    const t = this.now();
    const job: Job<R> = {
      id: randomUUID(),
      status: 'queued',
      stage: 'queued',
      fileName,
      createdAt: t,
      updatedAt: t,
    };
    this.jobs.set(job.id, job);
    this.notify(job);

    let watchdogFired = false;
    const setStage = (stage: JobStage) => {
      // A watchdog-killed job is terminal. Detached work may keep calling
      // this callback, but it must not mutate the record or make the
      // partial run look alive again.
      if (watchdogFired) return;
      job.stage = stage;
      job.updatedAt = this.now();
      this.notify(job);
    };

    void this.acquire()
      .then(async () => {
        job.status = 'running';
        setStage('extracting');
        const watchdogMs = this.opts.watchdogDisabled ? undefined : this.opts.deadlineMs;
        // PR 65: one line per job start settles the watchdog question
        // from the logs alone — armed (with its deadline) or explicitly
        // disabled. The 09546d5b investigation could not tell an unarmed
        // watchdog from a hung one without this line.
        if (this.opts.watchdogDisabled) {
          console.error(
            `[jobs] watchdog disabled for job ${job.id} (DISABLE_JOB_WATCHDOG); no deadline will be enforced`
          );
        } else if (watchdogMs) {
          console.error(
            `[jobs] watchdog armed for job ${job.id}: deadline ${watchdogMs} ms (${watchdogMs / 60_000} minutes)`
          );
        }
        let timer: ReturnType<typeof setTimeout> | null = null;
        const watchdogPromise = watchdogMs
          ? new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                watchdogFired = true;
                reject(new JobWatchdogError(watchdogMs));
              }, watchdogMs);
            })
          : null;

        // Promise.resolve().then also turns a synchronous throw from work
        // into the same handled rejection path as an async failure.
        const workPromise = Promise.resolve().then(() => work(setStage, job.id));
        try {
          const result = watchdogPromise
            ? await Promise.race([workPromise, watchdogPromise])
            : await workPromise;
          if (job.status === 'running') {
            job.result = result;
            job.status = 'completed';
            setStage('done');
          }
        } catch (err) {
          if (job.status === 'running') {
            job.status = 'failed';
            job.updatedAt = this.now();
            if (err instanceof JobWatchdogError) {
              job.failureKind = 'watchdog-timeout';
              job.error = err.userMessage;
              job.diagnostic = err.diagnostic;
            } else {
              job.failureKind = 'execution-error';
              job.error = describeError(err);
              const code = (err as { code?: unknown } | null)?.code;
              if (typeof code === 'string' && code) {
                job.diagnostic = `${code}: ${err instanceof Error ? err.message : String(err)}`;
              }
            }
            this.notify(job);
          }
          console.error(`[jobs] ${job.id} (${fileName}) failed:`, err);
        } finally {
          if (timer) clearTimeout(timer);
          // Release is tied to the race, not to the underlying work
          // promise. A hung promise therefore cannot retain the worker.
          this.release();
        }
      });

    return job.id;
  }

  private acquire(): Promise<void> {
    if (this.running < this.opts.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

export class JobWatchdogError extends Error {
  readonly code = 'JOB_WATCHDOG_TIMEOUT';
  readonly deadlineMs: number;
  readonly userMessage: string;
  readonly diagnostic: string;

  constructor(deadlineMs: number) {
    const duration = deadlineMs >= 60_000
      ? `${Math.round(deadlineMs / 60_000)} minutes`
      : `${deadlineMs} milliseconds`;
    super(`Job watchdog timeout after ${deadlineMs} ms.`);
    this.name = 'JobWatchdogError';
    this.deadlineMs = deadlineMs;
    this.userMessage =
      `This takeoff took longer than ${duration} and was stopped. ` +
      'Try again, or upload only the servicing sheets.';
    this.diagnostic =
      `watchdog-timeout: job exceeded ${deadlineMs} ms; concurrency slot released; ` +
      'late work, if any, is detached and its result will be discarded, never presented as completed.';
  }
}

export class JobCapacityError extends Error {
  constructor() {
    super('The server is busy with other takeoffs. Try again in a few minutes.');
    this.name = 'JobCapacityError';
  }
}

/**
 * User-facing failure text. Known infrastructure failures get an actionable
 * message; anything else keeps its own message (no stack traces).
 */
export function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Retry budget exhausted/i.test(msg)) {
    return msg;
  }
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
    return 'The AI service is rate-limited right now. Wait a minute and try again.';
  }
  if (/UND_ERR|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(msg)) {
    return 'Lost the connection to the AI service mid-extraction. Please try again.';
  }
  if (/Invalid PDF|Failed to parse PDF|No PDF header/i.test(msg)) {
    return 'That PDF could not be read — it may be corrupted or password-protected.';
  }
  return msg || 'Processing failed.';
}

const FALSEY_ENV_VALUES = new Set(['', 'false', '0', 'no', 'off']);

export function isJobWatchdogDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.DISABLE_JOB_WATCHDOG;
  if (raw === undefined) return false;
  return !FALSEY_ENV_VALUES.has(raw.trim().toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// One store per server process. `globalThis` keeps it across Next dev HMR reloads.
const g = globalThis as { __autoinfraJobs?: JobStore };
export const jobStore: JobStore =
  g.__autoinfraJobs ??
  (g.__autoinfraJobs = new JobStore({
    maxConcurrent: envInt('MAX_CONCURRENT_JOBS', 1), // ~0.75 GB peak per job
    maxActive: envInt('MAX_ACTIVE_JOBS', 10),
    ttlMs: envInt('JOB_TTL_MINUTES', 60) * 60_000,
    deadlineMs: isJobWatchdogDisabled() ? undefined : envInt('JOB_DEADLINE_MINUTES', 30) * 60_000,
    persistence: createJobPersistenceFromEnv(),
  }));
