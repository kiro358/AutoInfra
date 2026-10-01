/**
 * End-to-end smoke test of the upload → job → result flow with ZERO LLM calls:
 * a one-page synthetic CAD PDF skips the page locator, and vector mode never
 * calls the model. Exercises validation, extraction, pricing, the xlsx template
 * and the quote PDF exactly as production does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createSyntheticCadPdf } from '@/lib/test-fixtures/synthetic-cad-pdf';
import { applyCallFailures } from '@/lib/extraction';
import type { ProcessResponse, TakeoffFacts } from '@/lib/types';

beforeAll(() => {
  // The Gemini client is constructed eagerly; vector mode never uses it.
  process.env.GEMINI_API_KEY ||= 'test-key-not-used';
  process.env.ENABLE_EVAL_CACHE = 'false';
});

function upload(fields: Record<string, string | Blob>): NextRequest {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new NextRequest('http://localhost/api/process', { method: 'POST', body: form });
}

async function waitForJob(id: string) {
  const { GET } = await import('../jobs/[id]/route');
  for (let i = 0; i < 300; i++) {
    const res = await GET(new Request('http://localhost'), { params: Promise.resolve({ id }) });
    const body = await res.json();
    if (body.status === 'completed' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
}

describe('POST /api/process', () => {
  it('processes a drawing end to end in vector mode', async () => {
    const { POST } = await import('./route');
    const pdf = new Blob([Buffer.from(await createSyntheticCadPdf())], { type: 'application/pdf' });
    const res = await POST(
      upload({
        pdf: new File([pdf], 'synthetic.pdf', { type: 'application/pdf' }),
        extractionMode: 'vector',
        params: JSON.stringify({ manholes: { laborPerHr: 120 } }),
      })
    );
    expect(res.status).toBe(202);
    const { jobId } = await res.json();
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    const job = await waitForJob(jobId);
    expect(job.error).toBeUndefined();
    expect(job.status).toBe('completed');
    const result = job.result as ProcessResponse;
    expect(result.projectId).toBe(jobId);
    expect(result.extraction.sewers.length).toBeGreaterThan(0);
    expect(result.extraction.manholes.length).toBeGreaterThan(0);
    expect(result.cost?.llmCalls).toBe(0);
    expect(Buffer.from(result.xlsxBase64, 'base64').subarray(0, 2).toString()).toBe('PK');
    expect(Buffer.from(result.quoteBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
  }, 60_000);

  it('rejects bad uploads before starting a job', async () => {
    const { POST } = await import('./route');
    expect((await POST(upload({}))).status).toBe(400);
    const notPdf = new File([Buffer.from('hello')], 'x.pdf', { type: 'application/pdf' });
    const res = await POST(upload({ pdf: notPdf }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not a PDF/);
    const okPdf = new File([Buffer.from('%PDF-1.7')], 'x.pdf');
    expect((await POST(upload({ pdf: okPdf, extractionMode: 'turbo' }))).status).toBe(400);
    expect((await POST(upload({ pdf: okPdf, params: '{bad' }))).status).toBe(400);
  });

  it('404s for an unknown job', async () => {
    const { GET } = await import('../jobs/[id]/route');
    const res = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('applyCallFailures', () => {
  const facts = (n: number) =>
    ({
      structures: Array.from({ length: n }, () => ({})),
      sewers: [],
      watermain: [],
      catchbasins: [],
      warnings: [],
    }) as unknown as TakeoffFacts;

  it('passes clean runs through untouched', () => {
    expect(applyCallFailures(facts(2), []).warnings).toEqual([]);
  });
  it('warns when some calls failed but entities came back', () => {
    const out = applyCallFailures(facts(2), ['Extraction batch 2/3: 503']);
    expect(out.warnings[0]).toMatch(/1 AI call\(s\) failed.*503/);
  });
  it('throws instead of returning an empty "successful" takeoff', () => {
    expect(() => applyCallFailures(facts(0), ['Transcription batch 1/1: quota'])).toThrow(/quota/);
  });
});
