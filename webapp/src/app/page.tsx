'use client';

import React, { useState, useCallback, useEffect } from 'react';
import type { ProcessResponse } from '@/lib/types';
import type { PerformanceSummary } from '@/lib/perf-summary';
import { DropZone } from '@/components/upload';
import { ProcessingStages } from '@/components/processing';
import { BenchmarkDashboard } from '@/components/benchmark';
import { TakeoffStudio } from '@/components/results';
import {
  FileSpreadsheetIcon,
  ManholeIcon,
  PipeIcon,
  SparklesIcon,
  UploadIcon,
  WaterIcon,
} from '@/components/ui/Icons';

type AppState = 'upload' | 'processing' | 'results';

interface PerformanceApiResponse {
  success: boolean;
  source: 'offline-rescore' | 'eval-run';
  generatedAt: string;
  summary: PerformanceSummary;
  error?: string;
}

const STEPS = [
  {
    icon: <UploadIcon size={18} />,
    title: 'Upload the drawing set',
    body: 'Drop in the municipal servicing plan PDF — vector or scanned.',
  },
  {
    icon: <SparklesIcon size={18} />,
    title: 'We read the linework',
    body: 'Runs, structures, inverts, rims and callouts are extracted as facts.',
  },
  {
    icon: <FileSpreadsheetIcon size={18} />,
    title: 'Get a priced takeoff',
    body: 'Review quantities in the studio, then export Excel and a PDF quote.',
  },
];

const TRADES = [
  {
    tone: 'storm',
    icon: <PipeIcon size={18} />,
    title: 'Storm sewers',
    body: 'Run lengths, diameters, material, slope and depth bands.',
  },
  {
    tone: 'sanitary',
    icon: <PipeIcon size={18} />,
    title: 'Sanitary sewers',
    body: 'Mains and laterals priced from the sanitary rate tables.',
  },
  {
    tone: 'water',
    icon: <WaterIcon size={18} />,
    title: 'Watermain',
    body: 'Pipe by size and type, valves, hydrants and specials.',
  },
  {
    tone: 'structures',
    icon: <ManholeIcon size={18} />,
    title: 'Structures',
    body: 'Maintenance holes and catchbasins with rim and invert depths.',
  },
] as const;

/** Unit rates saved on the Settings page (validated again on the server). */
function readSavedRates(): string | null {
  try {
    return window.localStorage.getItem('autoinfra_params');
  } catch {
    return null; // storage blocked (private mode / policy) — server uses defaults
  }
}

const POLL_MS = 2500;
const MAX_WAIT_MS = 45 * 60_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 8;

/**
 * Poll GET /api/jobs/[id] until the takeoff finishes. Transient network errors
 * are retried (a laptop sleeping or a proxy blip must not kill a 5-minute job);
 * a job the server no longer knows about, or a failed job, ends the wait.
 */
async function pollJob(
  jobId: string,
  onStage: (stage: string) => void
): Promise<ProcessResponse> {
  const started = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res: Response;
    try {
      res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    } catch {
      if (++consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        throw new Error('Lost contact with the server. Check your connection and try again.');
      }
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) {
      throw new Error(body.error || 'The server lost track of this takeoff. Please try again.');
    }
    if (!res.ok) {
      if (++consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        throw new Error(body.error || `Status check failed (${res.status})`);
      }
      continue;
    }
    consecutiveErrors = 0;
    if (body.stage) onStage(body.stage);
    if (body.status === 'completed' && body.result) return body.result as ProcessResponse;
    if (body.status === 'failed') throw new Error(body.error || 'Processing failed');
  }
  throw new Error('This takeoff is taking unusually long. Please try again with fewer sheets.');
}

export default function AutoInfraApp() {
  const [appState, setAppState] = useState<AppState>('upload');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<{ name: string; size: number } | null>(null);
  const [activeMode, setActiveMode] = useState<string>('default');
  const [jobStage, setJobStage] = useState<string>('queued');

  // Benchmark metrics state
  const [perfSummary, setPerfSummary] = useState<PerformanceSummary | null>(null);
  const [perfError, setPerfError] = useState<string | null>(null);
  const [isPerfLoading, setIsPerfLoading] = useState(false);

  // Takeoff process result state
  const [processResult, setProcessResult] = useState<ProcessResponse | null>(null);

  const loadBenchmarkMetrics = useCallback(async (source?: 'live') => {
    setIsPerfLoading(true);
    setPerfError(null);
    try {
      const url = source === 'live' ? '/api/performance?source=live' : '/api/performance';
      const res = await fetch(url);
      // 404 = no golden-set results on this deployment. That is the normal state
      // in production, not an error — the benchmark panel simply stays hidden.
      if (res.status === 404) {
        setPerfSummary(null);
        return;
      }
      const data: PerformanceApiResponse = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Performance request failed (${res.status})`);
      }
      setPerfSummary(data.summary);
    } catch (err) {
      setPerfError(err instanceof Error ? err.message : 'Failed to load benchmark metrics');
    } finally {
      setIsPerfLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBenchmarkMetrics();
  }, [loadBenchmarkMetrics]);

  const handleProcessFile = useCallback(async (file: File, mode: string) => {
    setUploadError(null);
    setActiveFile({ name: file.name, size: file.size });
    setActiveMode(mode);
    setJobStage('queued');
    setAppState('processing');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const formData = new FormData();
    formData.append('pdf', file);
    if (mode !== 'default') formData.append('extractionMode', mode);
    const savedRates = readSavedRates();
    if (savedRates) formData.append('params', savedRates);

    try {
      const res = await fetch('/api/process', { method: 'POST', body: formData });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.jobId) {
        throw new Error(body.error || `Upload failed (${res.status})`);
      }
      const result = await pollJob(body.jobId, setJobStage);
      setProcessResult(result);
      setAppState('results');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Processing failed');
      setAppState('upload');
    }
  }, []);

  const handleReset = useCallback(() => {
    setAppState('upload');
    setProcessResult(null);
    setActiveFile(null);
    setUploadError(null);
  }, []);

  const showBenchmark = isPerfLoading || !!perfSummary || !!perfError;

  return (
    <>
      {appState === 'upload' && <div className="hero-grid" aria-hidden="true" />}

      <div className="app-container relative">
        {/* Kept mounted (just hidden) while processing so a failed run returns
            to the same file and engine choice — one click to retry. */}
        <div className={appState === 'upload' ? 'animate-in' : 'hidden'} aria-hidden={appState !== 'upload'}>
            <section className="mx-auto max-w-3xl text-center pt-6 pb-10">
              <span className="badge badge-accent mb-5">
                <span className="badge-dot" />
                Built for Ontario OPSS / OPSD servicing plans
              </span>
              <h1 className="text-[34px] sm:text-[44px] leading-[1.08] font-semibold tracking-[-0.03em] text-primary">
                Servicing drawings in.
                <br />
                <span className="text-muted">Priced takeoff out.</span>
              </h1>
              <p className="mt-5 text-[15.5px] leading-relaxed text-secondary max-w-xl mx-auto">
                Upload a civil site servicing PDF and AutoInfra extracts storm, sanitary and
                watermain quantities, prices them against your unit rates, and builds the Excel
                takeoff and quote for you.
              </p>
            </section>

            <div className="mx-auto max-w-3xl">
              <DropZone
                onProcess={handleProcessFile}
                onFileSelected={() => setUploadError(null)}
                error={uploadError}
              />
            </div>

            <section className="mx-auto max-w-5xl mt-16" aria-label="How it works">
              <ol className="grid gap-4 md:grid-cols-3">
                {STEPS.map((step, i) => (
                  <li key={step.title} className="flex gap-3.5">
                    <span className="grid place-items-center size-9 shrink-0 rounded-[10px] border border-line bg-surface text-secondary shadow-[var(--shadow-xs)]">
                      {step.icon}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-semibold text-primary">
                        <span className="font-mono text-muted mr-1.5">{i + 1}.</span>
                        {step.title}
                      </div>
                      <p className="mt-1 text-[13px] leading-relaxed text-secondary">{step.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="mx-auto max-w-5xl mt-14" aria-label="What gets extracted">
              <h2 className="text-[13px] font-semibold text-muted mb-4">What gets extracted</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {TRADES.map((t) => (
                  <div
                    key={t.title}
                    className="rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-xs)]"
                  >
                    <span
                      className="grid place-items-center size-8 rounded-[8px] mb-3"
                      style={{
                        color: `var(--${t.tone})`,
                        background: `var(--${t.tone}-bg)`,
                      }}
                    >
                      {t.icon}
                    </span>
                    <div className="text-[13.5px] font-semibold text-primary">{t.title}</div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-secondary">{t.body}</p>
                  </div>
                ))}
              </div>
            </section>

            {showBenchmark && (
              <section className="mx-auto max-w-5xl mt-14" aria-label="Model accuracy">
                <BenchmarkDashboard
                  summary={perfSummary}
                  error={perfError}
                  isLoading={isPerfLoading}
                  onRefresh={() => loadBenchmarkMetrics('live')}
                  defaultCollapsed
                />
              </section>
            )}
        </div>

        {appState === 'processing' && activeFile && (
          <div className="mx-auto max-w-3xl animate-in">
            <ProcessingStages
              fileName={activeFile.name}
              fileSize={activeFile.size}
              extractionMode={activeMode}
              serverStage={jobStage}
            />
            <p className="mt-4 text-center text-[12.5px] text-muted">
              Large drawing sets can take a few minutes. Keep this tab open.
            </p>
          </div>
        )}

        {appState === 'results' && processResult && (
          <TakeoffStudio result={processResult} onReset={handleReset} />
        )}
      </div>
    </>
  );
}
