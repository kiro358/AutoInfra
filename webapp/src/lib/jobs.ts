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

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

/** Coarse server-side stages, in order. The UI maps these onto its timeline. */
export const JOB_STAGES = ['queued', 'extracting', 'pricing', 'documents', 'done'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export interface Job<R = unknown> {
  id: string;
  status: JobStatus;
  stage: JobStage;
  fileName: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  result?: R;
}

/** Public view: never leaks the result until it is complete. */
export interface JobView<R = unknown> {
  id: string;
  status: JobStatus;
  stage: JobStage;
  fileName: string;
  elapsedMs: number;
  error?: string;
  result?: R;
}

export class JobStore<R = unknown> {
  private readonly jobs = new Map<string, Job<R>>();
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
      if (finished && job.updatedAt < cutoff) this.jobs.delete(id);
    }
  }

  get(id: string): JobView<R> | undefined {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      fileName: job.fileName,
      elapsedMs: job.updatedAt - job.createdAt,
      error: job.error,
      result: job.status === 'completed' ? job.result : undefined,
    };
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

    const setStage = (stage: JobStage) => {
      job.stage = stage;
      job.updatedAt = this.now();
    };

    void this.acquire()
      .then(async () => {
        job.status = 'running';
        setStage('extracting');
        try {
          job.result = await work(setStage, job.id);
          job.status = 'completed';
          setStage('done');
        } catch (err) {
          job.status = 'failed';
          job.error = describeError(err);
          job.updatedAt = this.now();
          console.error(`[jobs] ${job.id} (${fileName}) failed:`, err);
        } finally {
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
  }));
