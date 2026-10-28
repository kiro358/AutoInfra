/**
 * Persistent job storage — GCS write-through behind the JobStore surface.
 *
 * Design brief: ~/workspace/autoinfra-analysis/persistent_storage_brief.md
 * (Option B, approved 2026-10-27). Jobs otherwise live in an in-memory Map
 * (see jobs.ts) and die with the Cloud Run instance: three accepted jobs
 * were lost that way (2026-10-14 deploy kill; 2026-10-26 jobs 676659a8 and
 * 147f664e, 404 on every poll after instance churn).
 *
 * Layout in the bucket (prefix `jobs/`):
 *   jobs/<id>/record.json   — the small job fields + status (the commit point)
 *   jobs/<id>/result.json   — the result JSON with big base64 fields removed
 *   jobs/<id>/workbook.xlsx — the workbook blob (from ProcessResponse.xlsxBase64)
 *   jobs/<id>/quote.docx    — the quote blob (from ProcessResponse.quoteBase64)
 *
 * The in-memory JobStore remains the scheduler and the hot poll cache; this
 * adapter hooks the transitions the store already owns (create, stage
 * change, terminal) and writes them through. Reads are memory-first; on a
 * memory miss the record is loaded back from GCS (see JobStore.getAsync).
 *
 * Terminal writes are one-way: the adapter refuses to overwrite a persisted
 * terminal record with a non-terminal state or a different terminal state,
 * mirroring the watchdog guard in jobs.ts (detached late work must never
 * resurrect a finished job — in memory or in the store).
 *
 * Persistence is best-effort by design: a storage failure is logged and the
 * job continues in memory. Losing the write-through must never lose the job
 * itself — that would recreate the failure this module exists to remove,
 * one layer down.
 *
 * Explicit boundary: persistence of records ≠ resumable computation. A job
 * whose worker dies mid-extraction is NOT resumed; boot reconciliation
 * (reconcileOrphans) marks it `interrupted` and the user re-uploads (D1).
 * That inference is sound only because the deploy pins --max-instances 1:
 * a record still queued/running at boot belongs to a dead instance by
 * construction.
 *
 * Retention (D2: 7 days) is enforced by a lifecycle rule on the bucket,
 * not by this code — see docs/job-storage.md for the rule and the gsutil
 * command that applies it. The uploaded PDF is never stored (D4).
 *
 * Kill switch: DISABLE_JOB_PERSISTENCE (see createJobPersistenceFromEnv).
 */
import { Storage } from '@google-cloud/storage';
import type { Job, JobFailureKind, JobPersistencePort, JobStage, JobStatus } from './jobs';
import type { ProcessResponse } from './types';

export const PERSISTED_JOB_SCHEMA = 1 as const;

/** The job record as stored in record.json — Job's small fields, no result. */
export interface PersistedJobRecord {
  schema: typeof PERSISTED_JOB_SCHEMA;
  id: string;
  status: JobStatus;
  stage: JobStage;
  fileName: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  failureKind?: JobFailureKind;
  diagnostic?: string;
  /** True when result.json (+ any blobs) were written for a completed job. */
  hasResult: boolean;
  /** Blob file names under jobs/<id>/ that the result codec split out. */
  resultBlobs: string[];
}

/** User-facing text for a job orphaned by a worker restart (D1). */
export const INTERRUPTED_JOB_ERROR =
  'This takeoff was interrupted — the server restarted before it finished. ' +
  'Please upload the drawing set again.';

const TERMINAL: ReadonlySet<JobStatus> = new Set(['completed', 'failed']);

// ---------------------------------------------------------------------------
// Object store seam. GCS in prod; an in-memory fake in tests.
// ---------------------------------------------------------------------------

export interface JobObjectStore {
  put(name: string, body: Buffer, contentType: string): Promise<void>;
  /** Resolves undefined when the object does not exist. */
  get(name: string): Promise<Buffer | undefined>;
  /** All object names under the store's prefix, prefix-relative. */
  list(): Promise<string[]>;
}

export class GcsJobObjectStore implements JobObjectStore {
  private handle?: ReturnType<Storage['bucket']>;

  constructor(
    private readonly bucketName: string,
    private readonly prefix = 'jobs'
  ) {}

  // Lazy: constructing Storage() at import time would run in every test and
  // dev process that touches jobs.ts, credentialed or not.
  private bucket(): ReturnType<Storage['bucket']> {
    if (!this.handle) {
      this.handle = new Storage().bucket(this.bucketName);
    }
    return this.handle;
  }

  private key(name: string): string {
    return `${this.prefix}/${name}`;
  }

  async put(name: string, body: Buffer, contentType: string): Promise<void> {
    await this.bucket().file(this.key(name)).save(body, { contentType, resumable: false });
  }

  async get(name: string): Promise<Buffer | undefined> {
    const file = this.bucket().file(this.key(name));
    const [exists] = await file.exists();
    if (!exists) return undefined;
    const [data] = await file.download();
    return data;
  }

  async list(): Promise<string[]> {
    const [files] = await this.bucket().getFiles({ prefix: `${this.prefix}/` });
    const cut = this.prefix.length + 1;
    return files.map((f) => f.name.slice(cut));
  }
}

// ---------------------------------------------------------------------------
// Result codecs. The record stays small by splitting the result: a JSON part
// plus named binary blobs. The ProcessResponse codec splits the two base64
// document fields (the bulk of the ~112–489 KB result payloads).
// ---------------------------------------------------------------------------

export interface SplitResult {
  json: unknown;
  blobs: Record<string, { body: Buffer; contentType: string }>;
}

export interface ResultCodec<R> {
  split(result: R): SplitResult;
  join(json: unknown, blobs: Record<string, Buffer>): R;
}

export function identityResultCodec<R>(): ResultCodec<R> {
  return {
    split: (result) => ({ json: result ?? null, blobs: {} }),
    join: (json) => json as R,
  };
}

export const WORKBOOK_BLOB = 'workbook.xlsx';
export const QUOTE_BLOB = 'quote.docx';
const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const processResponseCodec: ResultCodec<ProcessResponse> = {
  split(result) {
    const { xlsxBase64, quoteBase64, ...rest } = result;
    return {
      json: rest,
      blobs: {
        [WORKBOOK_BLOB]: { body: Buffer.from(xlsxBase64, 'base64'), contentType: XLSX_CONTENT_TYPE },
        [QUOTE_BLOB]: { body: Buffer.from(quoteBase64, 'base64'), contentType: DOCX_CONTENT_TYPE },
      },
    };
  },
  join(json, blobs) {
    const rest = json as Omit<ProcessResponse, 'xlsxBase64' | 'quoteBase64'>;
    return {
      ...rest,
      xlsxBase64: blobs[WORKBOOK_BLOB].toString('base64'),
      quoteBase64: blobs[QUOTE_BLOB].toString('base64'),
    };
  },
};

// ---------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------

const recordName = (id: string) => `${id}/record.json`;
const resultName = (id: string) => `${id}/result.json`;
const blobName = (id: string, blob: string) => `${id}/${blob}`;

function parseRecord(raw: Buffer): PersistedJobRecord | undefined {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as PersistedJobRecord;
    if (parsed?.schema !== PERSISTED_JOB_SCHEMA) return undefined;
    if (typeof parsed.id !== 'string' || typeof parsed.status !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Storage operations are individually capped. A healthy GCS read/write is
 * milliseconds; the cap only fires when storage or auth is broken, where
 * failing fast (the job continues in memory; the next poll retries the
 * read-back) beats hanging a request — or a test — on a dead metadata
 * server.
 */
const DEFAULT_OP_TIMEOUT_MS = 3_000;

export class JobPersistence<R = unknown> implements JobPersistencePort<R> {
  /** Per-job serialized write chains: transitions land in order. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(
    private readonly store: JobObjectStore,
    private readonly codec: ResultCodec<R>,
    private readonly opts: {
      now?: () => number;
      log?: (message: string, err?: unknown) => void;
      opTimeoutMs?: number;
    } = {}
  ) {}

  /** Race one storage operation against the op timeout. */
  private async op<T>(label: string, run: () => Promise<T>): Promise<T> {
    const ms = this.opts.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`storage ${label} timed out after ${ms} ms`)),
            ms
          );
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private log(message: string, err?: unknown): void {
    if (this.opts.log) this.opts.log(message, err);
    else if (err !== undefined) console.error(`[job-persistence] ${message}`, err);
    else console.error(`[job-persistence] ${message}`);
  }

  /**
   * JobStore transition hook. Snapshots the job synchronously (the caller
   * keeps mutating the live object) and enqueues the write-through behind
   * any earlier transition for the same job. Never throws.
   */
  onTransition(job: Readonly<Job<R>>): void {
    const snapshot: Job<R> = {
      id: job.id,
      status: job.status,
      stage: job.stage,
      fileName: job.fileName,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error: job.error,
      failureKind: job.failureKind,
      diagnostic: job.diagnostic,
      result: job.result,
    };
    const prev = this.chains.get(snapshot.id) ?? Promise.resolve();
    const next = prev.then(() =>
      this.writeSnapshot(snapshot).catch((err) =>
        this.log(`write-through failed for job ${snapshot.id}; continuing in memory`, err)
      )
    );
    this.chains.set(snapshot.id, next);
  }

  /** Test/drain helper: resolves when every queued write-through has settled. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  private async writeSnapshot(job: Job<R>): Promise<void> {
    const existingRaw = await this.op('read record', () => this.store.get(recordName(job.id)));
    const existing = existingRaw ? parseRecord(existingRaw) : undefined;
    if (existing && TERMINAL.has(existing.status)) {
      if (!TERMINAL.has(job.status)) {
        this.log(
          `refused to overwrite terminal record for job ${job.id} (${existing.status}) with ${job.status}`
        );
        return;
      }
      if (existing.status !== job.status) {
        this.log(
          `refused to overwrite terminal record for job ${job.id} (${existing.status}) with a different terminal state (${job.status})`
        );
        return;
      }
      // Same terminal state: an idempotent rewrite (e.g. a duplicate
      // terminal notification) — allowed through.
    }

    let resultBlobs: string[] = [];
    if (job.status === 'completed' && job.result !== undefined) {
      // Blobs and result.json land BEFORE record.json: the record is the
      // commit point and must never claim a result that is not there yet.
      const split = this.codec.split(job.result);
      resultBlobs = Object.keys(split.blobs);
      for (const [name, blob] of Object.entries(split.blobs)) {
        await this.op('write blob', () =>
          this.store.put(blobName(job.id, name), blob.body, blob.contentType)
        );
      }
      await this.op('write result', () =>
        this.store.put(resultName(job.id), Buffer.from(JSON.stringify(split.json)), 'application/json')
      );
    }

    const record: PersistedJobRecord = {
      schema: PERSISTED_JOB_SCHEMA,
      id: job.id,
      status: job.status,
      stage: job.stage,
      fileName: job.fileName,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      error: job.error,
      failureKind: job.failureKind,
      diagnostic: job.diagnostic,
      hasResult: job.status === 'completed' && job.result !== undefined,
      resultBlobs,
    };
    await this.op('write record', () =>
      this.store.put(recordName(job.id), Buffer.from(JSON.stringify(record)), 'application/json')
    );
  }

  /**
   * Read a job back from the store (the post-restart path). Resolves
   * undefined when the job is unknown — or when a completed record's
   * result parts are missing/corrupt, in which case presenting the job
   * at all would recreate the "completed but gone" lie; the miss is
   * logged loudly instead.
   */
  async load(id: string): Promise<Job<R> | undefined> {
    const raw = await this.op('read record', () => this.store.get(recordName(id)));
    if (!raw) return undefined;
    const record = parseRecord(raw);
    if (!record) {
      this.log(`stored record for job ${id} is unreadable; treating as unknown`);
      return undefined;
    }
    const job: Job<R> = {
      id: record.id,
      status: record.status,
      stage: record.stage,
      fileName: record.fileName,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      error: record.error,
      failureKind: record.failureKind,
      diagnostic: record.diagnostic,
    };
    if (record.status === 'completed') {
      if (!record.hasResult) {
        this.log(`completed record for job ${id} has no result; treating as unknown`);
        return undefined;
      }
      const resultRaw = await this.op('read result', () => this.store.get(resultName(id)));
      if (!resultRaw) {
        this.log(`result.json missing for completed job ${id}; treating as unknown`);
        return undefined;
      }
      const blobs: Record<string, Buffer> = {};
      for (const name of record.resultBlobs) {
        const blob = await this.op('read blob', () => this.store.get(blobName(id, name)));
        if (!blob) {
          this.log(`blob ${name} missing for completed job ${id}; treating as unknown`);
          return undefined;
        }
        blobs[name] = blob;
      }
      job.result = this.codec.join(JSON.parse(resultRaw.toString('utf8')), blobs);
    }
    return job;
  }

  /**
   * Boot reconciliation (D1): any persisted job still queued/running at
   * boot is orphaned by construction (deploy pins --max-instances 1) and
   * becomes failed/interrupted. Terminal records are never touched.
   * Invoked by createJobPersistenceFromEnv on Cloud Run boot (PR 60).
   *
   * PR 65 hardening (from the 09546d5b freeze investigation): every record
   * is reconciled in isolation — one record's load or write rejecting is
   * logged with its job id, counted as failed, and skipped; the rest of
   * the scan still completes. A list() failure remains scan-fatal (there
   * is nothing to scan), but it is logged loudly here before it throws,
   * not left to whatever the caller does with the rejection. Exactly one
   * outcome line is logged per scan — including zero-orphan scans, whose
   * silence previously made "reconciled, nothing to do" indistinguishable
   * from "reconciliation never ran".
   */
  async reconcileOrphans(): Promise<{ scanned: number; interrupted: number }> {
    let names: string[];
    try {
      names = (await this.op('list records', () => this.store.list())).filter((n) =>
        n.endsWith('/record.json')
      );
    } catch (err) {
      this.log('boot reconciliation failed: could not list persisted job records; scan aborted', err);
      throw err;
    }
    let interrupted = 0;
    const failedIds: string[] = [];
    for (const name of names) {
      const id = name.slice(0, -'/record.json'.length);
      try {
        const raw = await this.op('read record', () => this.store.get(name));
        if (!raw) {
          this.log(`reconciliation failed for ${name} (job ${id}): record vanished before it could be read; skipping it`);
          failedIds.push(id);
          continue;
        }
        const record = parseRecord(raw);
        if (!record) {
          this.log(`reconciliation failed for ${name} (job ${id}): stored record is unreadable; skipping it`);
          failedIds.push(id);
          continue;
        }
        if (record.status !== 'queued' && record.status !== 'running') continue;
        const now = this.now();
        const updated: PersistedJobRecord = {
          ...record,
          status: 'failed',
          failureKind: 'interrupted',
          error: INTERRUPTED_JOB_ERROR,
          diagnostic:
            `interrupted: worker restarted before completion; orphaned record ` +
            `reconciled at boot (${new Date(now).toISOString()}). The extraction ` +
            'was not resumed and no result was produced.',
          updatedAt: now,
          hasResult: false,
          resultBlobs: [],
        };
        await this.op('write reconciled record', () =>
          this.store.put(name, Buffer.from(JSON.stringify(updated)), 'application/json')
        );
        interrupted++;
      } catch (err) {
        this.log(`reconciliation failed for ${name} (job ${id}); leaving the record as-is`, err);
        failedIds.push(id);
      }
    }
    this.log(
      `boot reconciliation outcome: scanned=${names.length} interrupted=${interrupted} failed=${failedIds.length}` +
        (failedIds.length > 0 ? ` failedIds=${failedIds.join(',')}` : '')
    );
    return { scanned: names.length, interrupted };
  }
}

// ---------------------------------------------------------------------------
// Env wiring. Kill switch: DISABLE_JOB_PERSISTENCE (disable-when-set, the
// same semantics as DISABLE_JOB_WATCHDOG in jobs.ts).
// ---------------------------------------------------------------------------

const FALSEY_ENV_VALUES = new Set(['', 'false', '0', 'no', 'off']);

function envFlagSet(raw: string | undefined): boolean {
  return raw !== undefined && !FALSEY_ENV_VALUES.has(raw.trim().toLowerCase());
}

export function isJobPersistenceDisabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return envFlagSet(env.DISABLE_JOB_PERSISTENCE);
}

/**
 * PR 60 enablement: persistence is ON by default; the kill switch
 * (DISABLE_JOB_PERSISTENCE) is the only opt-out. (PR 59 shipped this
 * default-off behind ENABLE_JOB_PERSISTENCE; this flip is PR 60's core
 * semantics change.)
 */
export function isJobPersistenceEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return !isJobPersistenceDisabled(env);
}

export function resolveJobsBucket(
  env: Record<string, string | undefined> = process.env
): string {
  return env.JOBS_BUCKET || env.GCS_BUCKET || 'autoinfra-ai-eval-data';
}

/**
 * Build the singleton's persistence adapter from the environment, or
 * undefined when the kill switch is set (pure in-memory store — the
 * pre-persistence behaviour).
 *
 * Boot reconciliation fires here, but only on Cloud Run (K_SERVICE is
 * set by the platform on every revision): the singleton is constructed
 * at module import in tests and dev too, and reconciliation's orphan
 * inference is only sound for the serving instance at boot. Failures
 * are logged, never fatal — a broken store must not take the service
 * down with it.
 */
export function createJobPersistenceFromEnv(
  env: Record<string, string | undefined> = process.env
): JobPersistence<ProcessResponse> | undefined {
  if (!isJobPersistenceEnabled(env)) return undefined;
  const persistence = new JobPersistence<ProcessResponse>(
    new GcsJobObjectStore(resolveJobsBucket(env)),
    processResponseCodec
  );
  if (env.K_SERVICE) {
    // PR 65: reconcileOrphans logs its own outcome line on every scan
    // (zero-interrupted included) and logs a list() failure before
    // throwing; this catch remains only as the rejection guard, so a
    // fatal scan failure logs at both layers — loudly, by design.
    void persistence
      .reconcileOrphans()
      .catch((err) => console.error('[job-persistence] boot reconciliation failed', err));
  }
  return persistence;
}
