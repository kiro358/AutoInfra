import { describe, it, expect } from 'vitest';
import { JobStore, type Job } from './jobs';
import {
  JobPersistence,
  GcsJobObjectStore,
  identityResultCodec,
  processResponseCodec,
  createJobPersistenceFromEnv,
  isJobPersistenceDisabled,
  isJobPersistenceEnabled,
  resolveJobsBucket,
  INTERRUPTED_JOB_ERROR,
  type JobObjectStore,
  type PersistedJobRecord,
} from './job-persistence';
import type { ProcessResponse } from './types';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** In-memory JobObjectStore with a put log and failure injection. */
class FakeJobObjectStore implements JobObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly puts: Array<{ name: string; body: string }> = [];
  failPuts = false;

  async put(name: string, body: Buffer): Promise<void> {
    if (this.failPuts) throw new Error('fake storage is down');
    this.objects.set(name, Buffer.from(body));
    this.puts.push({ name, body: body.toString('utf8') });
  }

  async get(name: string): Promise<Buffer | undefined> {
    const hit = this.objects.get(name);
    return hit ? Buffer.from(hit) : undefined;
  }

  async list(): Promise<string[]> {
    return [...this.objects.keys()];
  }

  recordHistory(id: string): PersistedJobRecord[] {
    return this.puts
      .filter((p) => p.name === `${id}/record.json`)
      .map((p) => JSON.parse(p.body) as PersistedJobRecord);
  }

  storedRecord(id: string): PersistedJobRecord | undefined {
    const raw = this.objects.get(`${id}/record.json`);
    return raw ? (JSON.parse(raw.toString('utf8')) as PersistedJobRecord) : undefined;
  }
}

function fakeProcessResponse(id: string): ProcessResponse {
  return {
    projectId: id,
    extraction: { marker: 'facts' } as unknown as ProcessResponse['extraction'],
    xlsxBase64: Buffer.from('fake-xlsx-bytes').toString('base64'),
    quoteBase64: Buffer.from('fake-docx-bytes').toString('base64'),
    status: 'completed',
    processedAt: '2026-10-27T00:00:00.000Z',
  };
}

describe('JobPersistence write-through (via JobStore)', () => {
  it('persists every transition in order: queued → running stages → completed', async () => {
    const fake = new FakeJobObjectStore();
    const persistence = new JobPersistence<string>(fake, identityResultCodec());
    const store = new JobStore<string>({ maxConcurrent: 1, maxActive: 5, ttlMs: 60_000, persistence });
    const id = store.start('a.pdf', async (setStage) => {
      setStage('pricing');
      return 'done!';
    });
    await tick();
    await tick();
    await persistence.flush();

    const history = fake.recordHistory(id);
    expect(history.map((r) => r.status)).toEqual(['queued', 'running', 'running', 'completed']);
    expect(history.map((r) => r.stage)).toEqual(['queued', 'extracting', 'pricing', 'done']);
    const final = fake.storedRecord(id);
    expect(final).toMatchObject({ status: 'completed', hasResult: true, resultBlobs: [] });
    // The result itself round-trips through result.json.
    const resultRaw = fake.objects.get(`${id}/result.json`);
    expect(resultRaw && JSON.parse(resultRaw.toString('utf8'))).toBe('done!');
  });

  it('persists failures with their kind, and a watchdog kill stays killed', async () => {
    const fake = new FakeJobObjectStore();
    const persistence = new JobPersistence<string>(fake, identityResultCodec());
    const store = new JobStore<string>({
      maxConcurrent: 1,
      maxActive: 5,
      ttlMs: 60_000,
      deadlineMs: 20,
      persistence,
    });
    let resolveLate!: (v: string) => void;
    const hung = new Promise<string>((res) => (resolveLate = res));
    const id = store.start('slow.pdf', () => hung);
    await new Promise((r) => setTimeout(r, 50));
    await persistence.flush();
    expect(fake.storedRecord(id)).toMatchObject({ status: 'failed', failureKind: 'watchdog-timeout' });

    // Detached late work resolves: the in-memory guard blocks mutation, so
    // no further transition is notified and the stored record stays failed.
    const putsBefore = fake.puts.length;
    resolveLate('too late');
    await tick();
    await persistence.flush();
    expect(fake.puts.length).toBe(putsBefore);
    expect(fake.storedRecord(id)).toMatchObject({ status: 'failed', failureKind: 'watchdog-timeout' });
  });
});

describe('JobPersistence terminal guard', () => {
  const baseJob: Job<string> = {
    id: 'job-guard',
    status: 'queued',
    stage: 'queued',
    fileName: 'g.pdf',
    createdAt: 1_000,
    updatedAt: 1_000,
  };

  it('refuses to overwrite a terminal record with a live or different terminal state', async () => {
    const fake = new FakeJobObjectStore();
    const persistence = new JobPersistence<string>(fake, identityResultCodec());
    persistence.onTransition({ ...baseJob, status: 'completed', stage: 'done', result: 'R', updatedAt: 2_000 });
    await persistence.flush();
    expect(fake.storedRecord('job-guard')).toMatchObject({ status: 'completed' });

    persistence.onTransition({ ...baseJob, status: 'running', stage: 'extracting', updatedAt: 3_000 });
    persistence.onTransition({ ...baseJob, status: 'failed', failureKind: 'execution-error', error: 'x', updatedAt: 4_000 });
    await persistence.flush();
    // Still the original completed record, untouched.
    expect(fake.storedRecord('job-guard')).toMatchObject({ status: 'completed', updatedAt: 2_000 });
  });
});

describe('ProcessResponse codec + blob round-trip', () => {
  it('splits base64 documents into blobs and rejoins them byte-identically on load', async () => {
    const fake = new FakeJobObjectStore();
    const persistence = new JobPersistence<ProcessResponse>(fake, processResponseCodec);
    const result = fakeProcessResponse('job-blobs');
    persistence.onTransition({
      id: 'job-blobs',
      status: 'completed',
      stage: 'done',
      fileName: 'b.pdf',
      createdAt: 10,
      updatedAt: 20,
      result,
    });
    await persistence.flush();

    // Blobs are the decoded bytes; result.json carries no base64 fields.
    expect(fake.objects.get('job-blobs/workbook.xlsx')?.toString()).toBe('fake-xlsx-bytes');
    expect(fake.objects.get('job-blobs/quote.docx')?.toString()).toBe('fake-docx-bytes');
    const resultJson = JSON.parse(fake.objects.get('job-blobs/result.json')!.toString('utf8'));
    expect(resultJson).not.toHaveProperty('xlsxBase64');
    expect(resultJson).not.toHaveProperty('quoteBase64');
    expect(resultJson.projectId).toBe('job-blobs');
    expect(fake.storedRecord('job-blobs')).toMatchObject({
      hasResult: true,
      resultBlobs: ['workbook.xlsx', 'quote.docx'],
    });

    const loaded = await persistence.load('job-blobs');
    expect(loaded?.status).toBe('completed');
    expect(loaded?.result).toEqual(result);
  });

  it('treats a completed record with missing result parts as unknown, never as done-without-result', async () => {
    const fake = new FakeJobObjectStore();
    const persistence = new JobPersistence<ProcessResponse>(fake, processResponseCodec);
    persistence.onTransition({
      id: 'job-partial',
      status: 'completed',
      stage: 'done',
      fileName: 'p.pdf',
      createdAt: 1,
      updatedAt: 2,
      result: fakeProcessResponse('job-partial'),
    });
    await persistence.flush();
    fake.objects.delete('job-partial/workbook.xlsx');
    expect(await persistence.load('job-partial')).toBeUndefined();
    expect(await persistence.load('never-existed')).toBeUndefined();
  });
});

describe('restart simulation', () => {
  it('a fresh store reads a completed job (and its result) back from the shared store', async () => {
    const fake = new FakeJobObjectStore();
    const codec = processResponseCodec;
    const persistence1 = new JobPersistence<ProcessResponse>(fake, codec);
    const store1 = new JobStore<ProcessResponse>({
      maxConcurrent: 1,
      maxActive: 5,
      ttlMs: 60_000,
      persistence: persistence1,
    });
    const id = store1.start('restart.pdf', async () => fakeProcessResponse('placeholder'));
    await tick();
    await tick();
    await persistence1.flush();
    // The work returns a response whose projectId is the job id in prod;
    // here the result's identity is what matters, not the placeholder field.
    const expected = store1.get(id)?.result;
    expect(expected).toBeDefined();

    // Instance restarts: brand-new store + adapter over the same bucket.
    const persistence2 = new JobPersistence<ProcessResponse>(fake, codec);
    const store2 = new JobStore<ProcessResponse>({
      maxConcurrent: 1,
      maxActive: 5,
      ttlMs: 60_000,
      persistence: persistence2,
    });
    expect(store2.get(id)).toBeUndefined(); // memory really is empty
    const view = await store2.getAsync(id);
    expect(view).toMatchObject({ status: 'completed', stage: 'done', fileName: 'restart.pdf' });
    expect(view?.result).toEqual(expected);
    // Hydrated: the sync hot path serves it now.
    expect(store2.get(id)?.status).toBe('completed');
  });

  it('without persistence, getAsync is exactly get (no read-back)', async () => {
    const store = new JobStore<string>({ maxConcurrent: 1, maxActive: 5, ttlMs: 60_000 });
    expect(await store.getAsync('nope')).toBeUndefined();
  });

});

describe('degradation: storage failure never breaks the job', () => {
  it('a store whose puts always fail still lets jobs complete in memory', async () => {
    const fake = new FakeJobObjectStore();
    fake.failPuts = true;
    const logs: string[] = [];
    const persistence = new JobPersistence<string>(fake, identityResultCodec(), {
      log: (m) => logs.push(m),
    });
    const store = new JobStore<string>({ maxConcurrent: 1, maxActive: 5, ttlMs: 60_000, persistence });
    const id = store.start('a.pdf', async () => 'survived');
    await tick();
    await tick();
    await persistence.flush(); // must resolve, not reject
    expect(store.get(id)).toMatchObject({ status: 'completed', result: 'survived' });
    expect(logs.some((l) => /write-through failed/.test(l))).toBe(true);
    expect(fake.objects.size).toBe(0);
  });
});

describe('boot reconciliation', () => {
  function seedRecord(fake: FakeJobObjectStore, record: PersistedJobRecord): string {
    const body = JSON.stringify(record);
    fake.objects.set(`${record.id}/record.json`, Buffer.from(body));
    return body;
  }
  const base: Omit<PersistedJobRecord, 'id' | 'status'> = {
    schema: 1,
    stage: 'extracting',
    fileName: 'seed.pdf',
    createdAt: 100,
    updatedAt: 200,
    hasResult: false,
    resultBlobs: [],
  };

  it('marks orphaned running jobs interrupted and never touches terminal records', async () => {
    const fake = new FakeJobObjectStore();
    const persistence = new JobPersistence<string>(fake, identityResultCodec(), { now: () => 999 });
    seedRecord(fake, { ...base, id: 'orphan', status: 'running' });
    const completedBody = seedRecord(fake, { ...base, id: 'done-job', status: 'completed', hasResult: true });
    seedRecord(fake, { ...base, id: 'queued-job', status: 'queued', stage: 'queued' });

    const outcome = await persistence.reconcileOrphans();
    expect(outcome).toEqual({ scanned: 3, interrupted: 2 });

    const orphan = fake.storedRecord('orphan');
    expect(orphan).toMatchObject({ status: 'failed', failureKind: 'interrupted', updatedAt: 999 });
    expect(orphan?.error).toBe(INTERRUPTED_JOB_ERROR);
    expect(orphan?.diagnostic).toMatch(/interrupted: worker restarted before completion/);
    expect(fake.storedRecord('queued-job')).toMatchObject({ status: 'failed', failureKind: 'interrupted' });
    // Terminal record byte-identical.
    expect(fake.objects.get('done-job/record.json')?.toString('utf8')).toBe(completedBody);

    // The interrupted job loads back as an honest failure, not a result.
    const loaded = await persistence.load('orphan');
    expect(loaded).toMatchObject({ status: 'failed', failureKind: 'interrupted' });
    expect(loaded?.result).toBeUndefined();
  });
});

describe('op timeout: a hung store degrades, never hangs', () => {
  it('load rejects fast on a never-resolving store, and getAsync turns that into an honest miss', async () => {
    const hanging: JobObjectStore = {
      put: () => new Promise<void>(() => {}),
      get: () => new Promise<Buffer | undefined>(() => {}),
      list: () => new Promise<string[]>(() => {}),
    };
    const logs: string[] = [];
    const persistence = new JobPersistence<string>(hanging, identityResultCodec(), {
      opTimeoutMs: 30,
      log: (m) => logs.push(m),
    });
    await expect(persistence.load('x')).rejects.toThrow(/timed out after 30 ms/);

    const store = new JobStore<string>({ maxConcurrent: 1, maxActive: 5, ttlMs: 60_000, persistence });
    const started = Date.now();
    expect(await store.getAsync('x')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);

    // Write-through against the hung store: the job still completes.
    const id = store.start('a.pdf', async () => 'fine');
    await tick();
    await tick();
    expect(store.get(id)).toMatchObject({ status: 'completed', result: 'fine' });
    await persistence.flush(); // resolves via per-op timeouts, not forever
    expect(logs.some((l) => /write-through failed/.test(l))).toBe(true);
  });
});

describe('enablement (PR 59: inert by default)', () => {
  it('requires ENABLE_JOB_PERSISTENCE and honours the kill switch', () => {
    expect(isJobPersistenceEnabled({})).toBe(false);
    expect(isJobPersistenceEnabled({ ENABLE_JOB_PERSISTENCE: '1' })).toBe(true);
    expect(isJobPersistenceEnabled({ ENABLE_JOB_PERSISTENCE: 'true' })).toBe(true);
    expect(isJobPersistenceEnabled({ ENABLE_JOB_PERSISTENCE: 'false' })).toBe(false);
    expect(isJobPersistenceEnabled({ ENABLE_JOB_PERSISTENCE: '0' })).toBe(false);
    expect(
      isJobPersistenceEnabled({ ENABLE_JOB_PERSISTENCE: '1', DISABLE_JOB_PERSISTENCE: '1' })
    ).toBe(false);
    expect(
      isJobPersistenceEnabled({ ENABLE_JOB_PERSISTENCE: '1', DISABLE_JOB_PERSISTENCE: 'false' })
    ).toBe(true);
    expect(isJobPersistenceDisabled({ DISABLE_JOB_PERSISTENCE: 'yes' })).toBe(true);
    expect(isJobPersistenceDisabled({})).toBe(false);
  });

  it('factory returns undefined when not enabled — flag off means zero storage construction', () => {
    expect(createJobPersistenceFromEnv({})).toBeUndefined();
    expect(createJobPersistenceFromEnv({ DISABLE_JOB_PERSISTENCE: '1' })).toBeUndefined();
  });

  it('bucket resolution prefers JOBS_BUCKET, then GCS_BUCKET, then the eval-data default', () => {
    expect(resolveJobsBucket({})).toBe('autoinfra-ai-eval-data');
    expect(resolveJobsBucket({ GCS_BUCKET: 'tiles' })).toBe('tiles');
    expect(resolveJobsBucket({ GCS_BUCKET: 'tiles', JOBS_BUCKET: 'jobs' })).toBe('jobs');
  });

  it('GCS store constructs lazily (no client work until first use)', () => {
    expect(() => new GcsJobObjectStore('any-bucket')).not.toThrow();
  });
});
