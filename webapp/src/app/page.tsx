'use client';

import React, { useState, useCallback, useEffect } from 'react';
import type { ProcessResponse } from '@/lib/types';
import type { PerformanceSummary } from '@/lib/perf-summary';
import { DropZone } from '@/components/upload';
import { ProcessingStages } from '@/components/processing';
import { BenchmarkDashboard } from '@/components/benchmark';
import { TakeoffStudio } from '@/components/results';

type AppState = 'upload' | 'processing' | 'results';

interface PerformanceApiResponse {
  success: boolean;
  source: 'offline-rescore' | 'eval-run';
  generatedAt: string;
  summary: PerformanceSummary;
  error?: string;
}

export default function AutoInfraApp() {
  const [appState, setAppState] = useState<AppState>('upload');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<{ name: string; size: number } | null>(null);
  const [activeMode, setActiveMode] = useState<string>('default');

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
    setAppState('processing');

    const formData = new FormData();
    formData.append('pdf', file);
    formData.append('extractionMode', mode);

    try {
      const res = await fetch('/api/process', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Processing failed with status ${res.status}`);
      }

      const data: ProcessResponse = await res.json();
      setProcessResult(data);
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

  return (
    <div className="app-container">
      {appState === 'upload' && (
        <div className="upload-view animate-in">
          <section className="hero-section text-center mb-8">
            <h1 className="text-3xl font-bold tracking-tight text-primary mb-2">
              Ontario Municipal Site Servicing Takeoff
            </h1>
            <p className="text-secondary max-w-2xl mx-auto text-sm">
              Upload civil engineering servicing drawings (PDF) to instantly extract storm,
              sanitary, watermain linework, elevations, structures, and generate populated Excel &amp; Quote files.
            </p>
          </section>

          <DropZone
            onProcess={handleProcessFile}
            error={uploadError}
          />

          <BenchmarkDashboard
            summary={perfSummary}
            error={perfError}
            isLoading={isPerfLoading}
            onRefresh={() => loadBenchmarkMetrics('live')}
          />
        </div>
      )}

      {appState === 'processing' && activeFile && (
        <div className="processing-view animate-in">
          <ProcessingStages
            fileName={activeFile.name}
            fileSize={activeFile.size}
            extractionMode={activeMode}
          />
        </div>
      )}

      {appState === 'results' && processResult && (
        <TakeoffStudio
          result={processResult}
          onReset={handleReset}
        />
      )}
    </div>
  );
}
