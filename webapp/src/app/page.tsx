'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { ExtractionResult } from '@/lib/types';
import type { PerformanceSummary, EntityAggregate, ProjectSummary } from '@/lib/perf-summary';

type AppState = 'upload' | 'processing' | 'results';

interface ProcessResponse {
  projectId: string;
  extraction: ExtractionResult;
  xlsxBase64: string;
  quoteBase64: string;
  status: string;
  error?: string;
}

interface PerformanceResponse {
  success: boolean;
  source: 'offline-rescore' | 'eval-run';
  generatedAt: string;
  summary: PerformanceSummary;
  error?: string;
}

const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}`;

/** Trigger a browser download from a base64 string */
function downloadBase64(base64: string, filename: string, mime: string) {
  const byteChars = atob(base64);
  const byteArray = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteArray[i] = byteChars.charCodeAt(i);
  }
  const blob = new Blob([byteArray], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Coverage strip — one row per entity class.
 *
 * The rail is scaled so the solid track represents everything actually on the
 * drawings and the dashed overhang represents predictions with nothing behind
 * them. Fill = found, hatch = missed, overhang = invented. Reading precision and
 * recall off one mark is the point; a single percentage hides which is failing.
 */
function CoverageRow({ entity }: { entity: EntityAggregate }) {
  const denom = entity.truth + entity.spurious;
  // Cap the overhang so a wildly over-extracting class can't squash the track.
  const overPct = denom > 0 ? Math.min(55, (entity.spurious / denom) * 100) : 0;

  return (
    <div className="cov" data-kind={entity.kind}>
      <div className="cov-name">
        <span className="cov-swatch" aria-hidden="true" />
        {entity.label}
      </div>
      <div className="cov-rail">
        <div
          className="cov-track"
          role="img"
          aria-label={`${entity.label}: ${entity.matched} of ${entity.truth} found, ${entity.spurious} not on the drawings`}
        >
          <div className="cov-read" style={{ width: `${entity.recall * 100}%` }} />
        </div>
        {overPct > 0 && <div className="cov-over" style={{ width: `${overPct}%` }} />}
      </div>
      <div className="cov-figs">
        <b>{entity.matched}</b>/{entity.truth} found
        {entity.spurious > 0 && <span> · {entity.spurious} invented</span>}
      </div>
    </div>
  );
}

function ProjectLedger({ projects }: { projects: ProjectSummary[] }) {
  const grade = (p: ProjectSummary) =>
    p.status !== 'ok' ? 'is-fail' : p.detF1 >= 0.5 ? 'is-strong' : p.detF1 >= 0.3 ? '' : 'is-weak';

  return (
    <div className="data-table-wrapper">
      <table className="data-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Job no.</th>
            <th style={{ textAlign: 'right' }}>Entities on sheet</th>
            <th style={{ width: '26%' }}>Detection F1</th>
            <th style={{ textAlign: 'right' }}>Manholes</th>
            <th style={{ textAlign: 'right' }}>Sewer runs</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.folder}>
              <td style={{ fontWeight: 500 }}>{p.name}</td>
              <td className="t-id">{p.jobCode || '—'}</td>
              <td className="t-num">{p.truthSize}</td>
              <td>
                {p.status !== 'ok' ? (
                  <span className="tag is-alarm">Run failed</span>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      className={`ledger-bar ${grade(p)}`}
                      style={{ width: `${Math.max(2, p.detF1 * 100)}%` }}
                    />
                    <span className="num" style={{ fontSize: 12 }}>{pct(p.detF1, 1)}%</span>
                  </div>
                )}
              </td>
              <td className="t-num">{p.structM}/{p.structT}</td>
              <td className="t-num">{p.runM}/{p.runT}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BenchmarkPlate({
  data,
  error,
  loading,
  onRetry,
}: {
  data: PerformanceResponse | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}) {
  const [showLedger, setShowLedger] = useState(false);

  if (loading) {
    return (
      <div className="plate">
        <div className="plate-body" style={{ display: 'grid', placeItems: 'center', gap: 14, padding: 48 }}>
          <div className="spinner" />
          <div className="eyebrow">Loading benchmark</div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="plate">
        <div className="plate-body">
          <div className="notice is-caution">
            <span className="notice-title">No benchmark results on disk</span>
            {error}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onRetry} style={{ marginTop: 14 }}>
            Check again
          </button>
        </div>
      </div>
    );
  }

  const s = data.summary;
  const parsed = Date.parse(data.generatedAt);
  const runDate = Number.isNaN(parsed) ? 'Date unknown' : new Date(parsed).toISOString().slice(0, 10);
  const watermain = s.entities.find((e) => e.kind === 'watermainRuns');

  return (
    <div className="plate">
      <div className="plate-head">
        <div>
          <div className="eyebrow">Benchmark</div>
          <h2 className="plate-title" style={{ marginTop: 3 }}>
            How much of a drawing this reads
          </h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="tag">{runDate}</span>
          <span className="tag">
            {data.source === 'offline-rescore' ? 'Re-scored from cache' : 'Eval run'}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={onRetry}>Refresh</button>
        </div>
      </div>

      <div className="plate-body" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div className="figure-row">
          <div className="figure">
            <div className="figure-value">
              {pct(s.meanDetF1, 1)}<small>%</small>
            </div>
            <div className="figure-label">Detection F1</div>
            <div className="figure-note">
              Mean across {s.projectsScored} drawing sets that returned a takeoff.
            </div>
          </div>
          <div className="figure">
            <div className="figure-value">
              {pct(s.meanFieldAcc, 1)}<small>%</small>
            </div>
            <div className="figure-label">Field accuracy</div>
            <div className="figure-note">
              Lengths, diameters and depths, on entities it found.
            </div>
          </div>
          <div className="figure">
            <div className="figure-value">
              {pct(s.meanDetF1WithFailures, 1)}<small>%</small>
            </div>
            <div className="figure-label">Including failed runs</div>
            <div className="figure-note">
              All {s.projectsTotal} sets, counting a failed extraction as zero.
            </div>
          </div>
          <div className={`figure ${s.projectsFailed > 0 ? 'is-alarm' : ''}`}>
            <div className="figure-value">{s.projectsFailed}</div>
            <div className="figure-label">Failed runs</div>
            <div className="figure-note">
              Returned nothing at all — a transport failure, not a bad read.
            </div>
          </div>
        </div>

        {s.entities.length > 0 && (
          <div>
            <div className="eyebrow" style={{ marginBottom: 4 }}>Coverage by class</div>
            <div className="cov-list">
              {s.entities.map((e) => <CoverageRow key={e.kind} entity={e} />)}
            </div>
            <div className="cov-legend">
              <i className="is-read">Found</i>
              <i className="is-missed">Missed</i>
              <i className="is-over">Not on the drawings</i>
            </div>
          </div>
        )}

        {watermain && watermain.recall === 0 && watermain.truth > 0 && (
          <div className="notice is-alarm">
            <span className="notice-title">Watermain is not being read at all</span>
            {watermain.truth} watermain runs across the set, none matched. Every watermain
            line still has to be taken off by hand.
          </div>
        )}

        {s.scaleSplit && (
          <div className="notice">
            <span className="notice-title">Accuracy falls off as drawings get bigger</span>
            Sets under {s.scaleSplit.threshold} entities score {pct(s.scaleSplit.smallMean, 1)}%.
            At {s.scaleSplit.threshold} or more, {pct(s.scaleSplit.largeMean, 1)}%.
          </div>
        )}

        <div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setShowLedger(!showLedger)}
            aria-expanded={showLedger}
          >
            {showLedger ? 'Hide per-project results' : `Show all ${s.projectsTotal} projects`}
          </button>
          {showLedger && (
            <div className="animate-in" style={{ marginTop: 16 }}>
              <ProjectLedger projects={s.projects} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const [state, setState] = useState<AppState>('upload');
  const [projectName, setProjectName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState<'manholes' | 'sewers' | 'watermain'>('sewers');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [perf, setPerf] = useState<PerformanceResponse | null>(null);
  const [perfLoading, setPerfLoading] = useState(true);
  const [perfError, setPerfError] = useState<string | null>(null);

  // No synchronous setState here — this runs from a mount effect, and setting
  // state before the first await cascades an extra render.
  const loadPerformance = useCallback(async () => {
    try {
      const res = await fetch('/api/performance');
      const data: PerformanceResponse = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `Request failed (${res.status})`);
      setPerf(data);
      setPerfError(null);
    } catch (err) {
      setPerfError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPerfLoading(false);
    }
  }, []);

  const refreshPerformance = useCallback(() => {
    setPerfLoading(true);
    setPerfError(null);
    loadPerformance();
  }, [loadPerformance]);

  useEffect(() => { loadPerformance(); }, [loadPerformance]);

  const acceptFile = useCallback((file: File) => {
    setSelectedFile(file);
    setProjectName(file.name.replace(/\.pdf$/i, '').replace(/[-_]/g, ' '));
    setError(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') acceptFile(file);
    else if (file) setError('That file is not a PDF. Drop a PDF drawing set.');
  }, [acceptFile]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) acceptFile(file);
  };

  const handleProcess = async () => {
    if (!selectedFile) return;
    setState('processing');
    setError(null);

    try {
      const formData = new FormData();
      formData.append('pdf', selectedFile);
      formData.append('projectName', projectName);

      const res = await fetch('/api/process', { method: 'POST', body: formData });
      const data: ProcessResponse = await res.json();

      if (!res.ok) throw new Error(data.error || 'Processing failed');

      setResult(data);
      setState('results');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setState('upload');
    }
  };

  const handleDownloadXlsx = () => {
    if (!result) return;
    const safeName = (result.extraction.projectName || 'estimate').replace(/[^a-zA-Z0-9-_ ]/g, '');
    downloadBase64(
      result.xlsxBase64,
      `${safeName}.xlsx`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  };

  const handleDownloadQuote = () => {
    if (!result) return;
    const safeName = (result.extraction.projectName || 'quote').replace(/[^a-zA-Z0-9-_ ]/g, '');
    downloadBase64(result.quoteBase64, `${safeName}-quote.pdf`, 'application/pdf');
  };

  return (
    <div className="app-container">
      {state === 'upload' && (
        <div className="animate-in stack">
          <section className="hero">
            <div className="eyebrow">Site servicing takeoff</div>
            <h1>Read the drawing. Price the takeoff.</h1>
            <div className="hero-rule" />
            <p>
              Drop a servicing drawing set. AutoInfra reads pipe runs, manholes, catchbasins
              and watermain off the sheets, then prices them against your rate table and
              fills the estimating workbook.
            </p>
          </section>

          <div>
            <div
              className={`upload-zone ${dragOver ? 'drag-over' : ''} ${selectedFile ? 'has-file' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                className="upload-input"
                onChange={handleFileSelect}
                aria-label="Drawing set PDF"
              />
              <div className="upload-mark">{selectedFile ? 'Sheet loaded' : 'Drawing area'}</div>
              <div className="upload-text">
                {selectedFile ? selectedFile.name : 'Drop a drawing set'}
              </div>
              <div className="upload-subtext">
                {selectedFile
                  ? `${(selectedFile.size / 1024 / 1024).toFixed(1)} MB · ready to run`
                  : 'PDF — servicing, grading, or plan-and-profile sheets'}
              </div>
            </div>

            {selectedFile && (
              <div
                className="animate-in"
                style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}
              >
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="Project name"
                  className="setting-input"
                  aria-label="Project name"
                  style={{ flex: '1 1 260px' }}
                />
                <button className="btn btn-primary btn-lg" onClick={handleProcess}>
                  Run takeoff
                </button>
                <button
                  className="btn btn-secondary btn-lg"
                  onClick={() => { setSelectedFile(null); setProjectName(''); }}
                >
                  Clear
                </button>
              </div>
            )}

            {error && (
              <div className="notice is-alarm animate-in" style={{ marginTop: 14 }}>
                <span className="notice-title">The takeoff did not run</span>
                {error}
              </div>
            )}
          </div>

          <BenchmarkPlate
            data={perf}
            error={perfError}
            loading={perfLoading}
            onRetry={refreshPerformance}
          />

          <div className="steps-grid">
            <div className="step-card">
              <div className="step-number">STEP 1</div>
              <div className="step-title">Locate the sheets</div>
              <div className="step-desc">
                Finds the servicing sheets in the set and rasterises only those.
              </div>
            </div>
            <div className="step-card">
              <div className="step-number">STEP 2</div>
              <div className="step-title">Read the callouts</div>
              <div className="step-desc">
                Pulls lengths, diameters, slopes, inverts and structure IDs off the drawing —
                facts only, no pricing.
              </div>
            </div>
            <div className="step-card">
              <div className="step-number">STEP 3</div>
              <div className="step-title">Price and populate</div>
              <div className="step-desc">
                Applies your rate table, then writes the workbook and the quote.
              </div>
            </div>
          </div>
        </div>
      )}

      {state === 'processing' && (
        <div className="processing-overlay">
          <div className="card processing-card">
            <div className="spinner" />
            <div className="processing-text">Reading the drawing</div>
            <div className="processing-subtext">
              Locating servicing sheets, then transcribing pipe runs, structures and elevations.
            </div>
            <div className="processing-subtext animate-pulse" style={{ marginTop: 12 }}>
              Usually 30–60 seconds
            </div>
          </div>
        </div>
      )}

      {state === 'results' && result && (
        <div className="results-container animate-in">
          <div className="results-header">
            <div>
              <div className="eyebrow">Takeoff</div>
              <div className="results-title">{result.extraction.projectName}</div>
            </div>
            <div className="results-actions">
              <button className="btn btn-primary" onClick={handleDownloadXlsx}>
                Download workbook
              </button>
              <button className="btn btn-accent" onClick={handleDownloadQuote}>
                Download quote
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => { setState('upload'); setSelectedFile(null); setResult(null); }}
              >
                New takeoff
              </button>
            </div>
          </div>

          <div className="title-block" style={{ marginBottom: 22 }}>
            <div>
              <dt>Job no.</dt>
              <dd>{result.extraction.jobNumber || '—'}</dd>
            </div>
            <div>
              <dt>Template</dt>
              <dd>{result.extraction.templateType}</dd>
            </div>
            <div>
              <dt>Date</dt>
              <dd>{result.extraction.date || '—'}</dd>
            </div>
            <div>
              <dt>Sheets read</dt>
              <dd>{result.extraction.warnings.length ? 'With warnings' : 'Clean'}</dd>
            </div>
          </div>

          <div className="results-grid">
            <div className="stat-card">
              <div className="stat-value">{result.extraction.sewers.length}</div>
              <div className="stat-label">Sewer runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{result.extraction.manholes.length}</div>
              <div className="stat-label">Manholes / catchbasins</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{result.extraction.watermain.length}</div>
              <div className="stat-label">Watermain runs</div>
            </div>
            <div className="stat-card">
              <div className="confidence-meter" style={{ marginBottom: 6 }}>
                <div className="confidence-bar">
                  <div
                    className={`confidence-fill ${
                      result.extraction.confidence >= 0.8 ? 'high'
                        : result.extraction.confidence >= 0.6 ? 'medium' : 'low'
                    }`}
                    style={{ width: `${result.extraction.confidence * 100}%` }}
                  />
                </div>
                <span className="confidence-value">
                  {Math.round(result.extraction.confidence * 100)}%
                </span>
              </div>
              <div className="stat-label">Model confidence</div>
            </div>
          </div>

          <div className="notice is-caution" style={{ marginBottom: 22 }}>
            <span className="notice-title">Check this against the sheets before you quote</span>
            On the benchmark set this reads about {perf ? pct(perf.summary.meanDetF1, 0) : '44'}% of
            the entities on a drawing, and watermain is not read at all. Treat the workbook as a
            first pass, not a finished takeoff.
          </div>

          {result.extraction.warnings.length > 0 && (
            <div className="card" style={{ marginBottom: 22 }}>
              <div className="card-title">Warnings ({result.extraction.warnings.length})</div>
              <ul className="warnings-list">
                {result.extraction.warnings.map((w, i) => (
                  <li key={i} className="warning-item">
                    <span className="warning-icon">!</span>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="plate">
            <div className="tabs">
              <button
                className={`tab ${activeTab === 'sewers' ? 'active' : ''}`}
                onClick={() => setActiveTab('sewers')}
              >
                Sewers ({result.extraction.sewers.length})
              </button>
              <button
                className={`tab ${activeTab === 'manholes' ? 'active' : ''}`}
                onClick={() => setActiveTab('manholes')}
              >
                Manholes ({result.extraction.manholes.length})
              </button>
              <button
                className={`tab ${activeTab === 'watermain' ? 'active' : ''}`}
                onClick={() => setActiveTab('watermain')}
              >
                Watermain ({result.extraction.watermain.length})
              </button>
            </div>

            {activeTab === 'sewers' && (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Run</th><th>Length m</th><th>Dia. mm</th>
                      <th>Type</th><th>Slope</th><th>Depth m</th>
                      <th>Add. mtrls</th><th>Add. L&amp;E</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.extraction.sewers.map((s) => (
                      <tr key={s.item}>
                        <td className="t-id">{s.item}</td>
                        <td style={{ fontWeight: 500 }}>{s.runLabel}</td>
                        <td className="t-num">{s.length}</td>
                        <td className="t-num">{s.pipeDiameter}</td>
                        <td>{s.typeClass}</td>
                        <td className="t-num">{s.slope}</td>
                        <td className="t-num">{s.depth}</td>
                        <td className="t-num">{s.addMaterials || '—'}</td>
                        <td className="t-num">{s.addLE || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'manholes' && (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Description</th><th>Top el.</th><th>Low inv.</th>
                      <th>Hi inv.</th><th>Pipe out mm</th><th>Type</th>
                      <th>Add. mtrls</th><th>Add. L&amp;E</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.extraction.manholes.map((m) => (
                      <tr key={m.item}>
                        <td className="t-id">{m.item}</td>
                        <td style={{ fontWeight: 500 }}>{m.description}</td>
                        <td className="t-num">{m.topElevation}</td>
                        <td className="t-num">{m.lowInvert}</td>
                        <td className="t-num">{m.highInvert || '—'}</td>
                        <td className="t-num">{m.pipeOutDiameter}</td>
                        <td>{Number(m.structureType) === 1 ? 'STD' : 'LRG'}</td>
                        <td className="t-num">{m.addMaterials || '—'}</td>
                        <td className="t-num">{m.addLE || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'watermain' && (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Size &amp; type</th><th>Length m</th><th>Dia. mm</th>
                      <th>OC/SC</th><th>Avg cover m</th>
                      <th>Add. mtrls</th><th>Add. L&amp;E</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.extraction.watermain.map((w) => (
                      <tr key={w.item}>
                        <td className="t-id">{w.item}</td>
                        <td style={{ fontWeight: 500 }}>{w.sizeAndType}</td>
                        <td className="t-num">{w.length}</td>
                        <td className="t-num">{w.pipeDiameter}</td>
                        <td>{w.ocSc}</td>
                        <td className="t-num">{w.avgCover}</td>
                        <td className="t-num">{w.addMaterials || '—'}</td>
                        <td className="t-num">{w.addLE || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {result.extraction.watermainSpecials.length > 0 && (
                  <>
                    <div className="card-title" style={{ padding: '16px 12px 8px' }}>
                      Fittings and specials
                    </div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Special</th><th>Qty</th><th>$ each</th>
                          <th>TB</th><th>Anode $</th><th>Labour $</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.extraction.watermainSpecials.map((sp) => (
                          <tr key={sp.item}>
                            <td className="t-id">{sp.item}</td>
                            <td style={{ fontWeight: 500 }}>{sp.specialName}</td>
                            <td className="t-num">{sp.quantity}</td>
                            <td className="t-num">{sp.costEach}</td>
                            <td>{sp.thrustBlock ? 'Y' : 'N'}</td>
                            <td className="t-num">{sp.anodeCost}</td>
                            <td className="t-num">{sp.laborEach}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {result.extraction.watermainValves.length > 0 && (
                  <>
                    <div className="card-title" style={{ padding: '16px 12px 8px' }}>Valves</div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Size</th><th>Qty</th><th>$ / valve</th>
                          <th>$ / box</th><th>Anode $</th><th>Labour / valve</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.extraction.watermainValves.map((v) => (
                          <tr key={v.item}>
                            <td className="t-id">{v.item}</td>
                            <td style={{ fontWeight: 500 }}>{v.valveSize}</td>
                            <td className="t-num">{v.quantity}</td>
                            <td className="t-num">{v.valveCost}</td>
                            <td className="t-num">{v.boxCost}</td>
                            <td className="t-num">{v.anodeCost}</td>
                            <td className="t-num">{v.laborPerValve}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
