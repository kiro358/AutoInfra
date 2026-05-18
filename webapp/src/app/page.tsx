'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { ExtractionResult } from '@/lib/types';

type AppState = 'upload' | 'processing' | 'results';

interface ProcessResponse {
  projectId: string;
  extraction: ExtractionResult;
  xlsxBase64: string;
  quoteBase64: string;
  status: string;
  error?: string;
}

interface ScoreboardRow {
  project: string;
  mhStructures: string;
  mhCatchbasins: string;
  sewers: string;
  watermain: string;
  overall: number;
  totalCells: number;
  matchingCells: number;
}

interface ScoreboardData {
  success: boolean;
  source: string;
  date: string;
  overallScore: number;
  overallAccuracy: number;
  totalCells: number;
  matchingCells: number;
  categoryAverages: {
    mhStructures: number;
    mhCatchbasins: number;
    sewers: number;
    watermain: number;
  };
  projectsCount: number;
  rows: ScoreboardRow[];
}

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

export default function HomePage() {
  const [state, setState] = useState<AppState>('upload');
  const [projectName, setProjectName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [activeTab, setActiveTab] = useState<'manholes' | 'sewers' | 'watermain'>('sewers');
  const [flywheelStatus, setFlywheelStatus] = useState<'idle' | 'local' | 'cloud'>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Scoreboard states
  const [scoreboard, setScoreboard] = useState<ScoreboardData | null>(null);
  const [isLoadingScoreboard, setIsLoadingScoreboard] = useState(true);
  const [scoreboardError, setScoreboardError] = useState<string | null>(null);
  const [showProjectsBreakdown, setShowProjectsBreakdown] = useState(false);

  const fetchScoreboard = useCallback(async () => {
    setIsLoadingScoreboard(true);
    setScoreboardError(null);
    try {
      const res = await fetch('/api/scoreboard');
      if (!res.ok) {
        throw new Error(`Failed to fetch scoreboard (HTTP ${res.status})`);
      }
      const data = await res.json();
      if (data.success) {
        setScoreboard(data);
      } else {
        throw new Error(data.error || 'Failed to load scoreboard');
      }
    } catch (err) {
      console.error('Error fetching scoreboard:', err);
      setScoreboardError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingScoreboard(false);
    }
  }, []);

  useEffect(() => {
    fetchScoreboard();
  }, [fetchScoreboard]);

  const handleFlywheel = async (mode: 'local' | 'cloud') => {
    if (!confirm(`Are you sure you want to run the optimization loop in ${mode} mode? This may consume resources and update models.`)) return;
    
    setFlywheelStatus(mode);
    try {
      const res = await fetch('/api/flywheel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to trigger flywheel');
      alert(data.message);
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setFlywheelStatus('idle');
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') {
      setSelectedFile(file);
      setProjectName(file.name.replace('.pdf', '').replace(/[-_]/g, ' '));
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setProjectName(file.name.replace('.pdf', '').replace(/[-_]/g, ' '));
    }
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
      {/* Header with Flywheel Controls */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 40, padding: '16px 0', borderBottom: '1px solid var(--gray-800)' }}>
        <div style={{ fontWeight: 700, fontSize: 20, color: 'var(--white)' }}>
          AutoInfra <span style={{ fontSize: 12, padding: '4px 8px', background: 'var(--primary-900)', color: 'var(--primary-300)', borderRadius: 12, marginLeft: 8 }}>Beta</span>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--gray-400)' }}>AI Optimization Flywheel:</span>
          <button 
            className="btn btn-secondary"
            style={{ padding: '6px 12px', fontSize: 13 }}
            onClick={() => handleFlywheel('local')}
            disabled={flywheelStatus !== 'idle'}
          >
            {flywheelStatus === 'local' ? 'Running...' : 'Run Local'}
          </button>
          <button 
            className="btn btn-primary"
            style={{ padding: '6px 12px', fontSize: 13 }}
            onClick={() => handleFlywheel('cloud')}
            disabled={flywheelStatus !== 'idle'}
          >
            {flywheelStatus === 'cloud' ? 'Starting...' : 'Run in Cloud'}
          </button>
        </div>
      </header>

      {/* Hero Section */}
      {state === 'upload' && (
        <div className="animate-in">
          <section className="hero">
            <div className="hero-badge">⚡ AI-Powered Estimation</div>
            <h1>Civil Drawings to<br />Cost Estimates in Seconds</h1>
            <p>Upload your site servicing PDF drawings and get fully populated estimation spreadsheets with manholes, sewers, and watermain data — powered by AI.</p>
          </section>

          {/* Upload Zone */}
          <div
            className={`upload-zone ${dragOver ? 'drag-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              className="upload-input"
              onChange={handleFileSelect}
            />
            <div className="upload-icon">📄</div>
            <div className="upload-text">
              {selectedFile ? selectedFile.name : 'Drop your Civil PDF here'}
            </div>
            <div className="upload-subtext">
              {selectedFile
                ? `${(selectedFile.size / 1024 / 1024).toFixed(1)} MB — Ready to process`
                : 'Supports civil engineering drawings (grading, servicing, profiles)'}
            </div>
          </div>

          {/* Project Name + Process Button */}
          {selectedFile && (
            <div style={{ marginTop: 24, display: 'flex', gap: 12, justifyContent: 'center', alignItems: 'center' }}>
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="Project name..."
                className="setting-input"
                style={{ width: 300, textAlign: 'left' }}
              />
              <button className="btn btn-primary btn-lg" onClick={handleProcess}>
                🚀 Process Drawing
              </button>
            </div>
          )}

          {error && (
            <div className="card" style={{ marginTop: 20, borderColor: 'var(--danger-500)' }}>
              <p style={{ color: 'var(--danger-400)' }}>❌ {error}</p>
            </div>
          )}

          {/* Latest AI Accuracy Scoreboard */}
          <div style={{ marginTop: 50, marginBottom: 30 }}>
            {isLoadingScoreboard ? (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px', gap: '16px' }}>
                <div className="spinner" style={{ margin: 0 }} />
                <div style={{ color: 'var(--gray-400)', fontSize: '14px' }}>Syncing evaluation scoreboard...</div>
              </div>
            ) : scoreboardError ? (
              <div className="card" style={{ borderColor: 'rgba(239, 68, 68, 0.2)', padding: '20px', textAlign: 'center' }}>
                <p style={{ color: 'var(--danger-400)', marginBottom: '12px', fontSize: '14px' }}>⚠️ Could not load latest evaluation scores: {scoreboardError}</p>
                <button className="btn btn-secondary btn-sm" onClick={fetchScoreboard}>
                  🔄 Try Reloading
                </button>
              </div>
            ) : scoreboard ? (
              <div className="card" style={{
                position: 'relative',
                overflow: 'hidden',
                border: '1px solid rgba(59, 130, 246, 0.2)',
                boxShadow: scoreboard.overallAccuracy >= 80 ? '0 0 30px rgba(52, 211, 153, 0.08)' : '0 0 30px rgba(59, 130, 246, 0.08)'
              }}>
                {/* Visual Glow Header Indicator */}
                <div style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: '4px',
                  background: scoreboard.overallAccuracy >= 80 
                    ? 'linear-gradient(90deg, var(--success-500), var(--primary-500))'
                    : 'linear-gradient(90deg, var(--warning-500), var(--primary-500))'
                }} />

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--white)', display: 'flex', alignItems: 'center', gap: 8 }}>
                      📈 System Accuracy Scoreboard
                    </h2>
                    <p style={{ fontSize: 13, color: 'var(--gray-400)', marginTop: 2 }}>
                      Performance across <strong>{scoreboard.projectsCount}</strong> system validation drawing sheets
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{
                      fontSize: 11,
                      padding: '4px 10px',
                      background: 'rgba(59, 130, 246, 0.1)',
                      color: 'var(--primary-300)',
                      borderRadius: 100,
                      fontWeight: 500,
                      border: '1px solid rgba(59, 130, 246, 0.2)'
                    }}>
                      📅 Run: {scoreboard.date}
                    </span>
                    <span style={{
                      fontSize: 11,
                      padding: '4px 10px',
                      background: scoreboard.source === 'gcs' ? 'rgba(52, 211, 153, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                      color: scoreboard.source === 'gcs' ? 'var(--success-400)' : 'var(--warning-400)',
                      borderRadius: 100,
                      fontWeight: 500,
                      border: scoreboard.source === 'gcs' ? '1px solid rgba(52, 211, 153, 0.2)' : '1px solid rgba(245, 158, 11, 0.2)'
                    }}>
                      {scoreboard.source === 'gcs' ? '☁️ GCS Cloud Sync' : '💾 Local Fallback'}
                    </span>
                    <button
                      className="btn btn-secondary"
                      onClick={fetchScoreboard}
                      style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: '50%', border: 'none', cursor: 'pointer' }}
                      title="Refresh scoreboard data"
                    >
                      🔄
                    </button>
                  </div>
                </div>

                {/* Scoreboard Metrics Dashboard Layout */}
                <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 2fr', gap: 30, marginBottom: 24, borderBottom: '1px solid var(--glass-border)', paddingBottom: 24 }}>
                  
                  {/* Left Column: Overall Dial */}
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(255, 255, 255, 0.02)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '24px',
                    border: '1px solid rgba(255, 255, 255, 0.03)',
                    textAlign: 'center'
                  }}>
                    <div style={{ position: 'relative', width: 140, height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
                      {/* Breathtaking Glowing Circle Ring */}
                      <svg style={{ transform: 'rotate(-90deg)', width: '100%', height: '100%' }} viewBox="0 0 100 100">
                        <circle
                          cx="50"
                          cy="50"
                          r="42"
                          fill="transparent"
                          stroke="var(--surface-3)"
                          strokeWidth="6"
                        />
                        <circle
                          cx="50"
                          cy="50"
                          r="42"
                          fill="transparent"
                          stroke={scoreboard.overallAccuracy >= 80 ? 'var(--success-400)' : 'var(--primary-400)'}
                          strokeWidth="6"
                          strokeDasharray={2 * Math.PI * 42}
                          strokeDashoffset={2 * Math.PI * 42 * (1 - scoreboard.overallAccuracy / 100)}
                          strokeLinecap="round"
                          style={{ transition: 'stroke-dashoffset 1s ease-in-out' }}
                        />
                      </svg>
                      {/* Inside Ring Text */}
                      <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <span style={{ fontSize: 28, fontWeight: 800, color: 'var(--white)', letterSpacing: '-0.02em' }}>
                          {scoreboard.overallAccuracy}%
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
                          Accuracy
                        </span>
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--gray-300)', fontWeight: 500 }}>
                      System-Wide Average
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--gray-500)', marginTop: 4 }}>
                      {scoreboard.matchingCells} of {scoreboard.totalCells} data fields correctly populated
                    </div>
                  </div>

                  {/* Right Column: Category-specific Progress bars */}
                  <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 16 }}>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                        <span style={{ color: 'var(--gray-300)', fontWeight: 500 }}>📁 Manholes Structures</span>
                        <span style={{ color: 'var(--primary-300)', fontWeight: 700 }}>{scoreboard.categoryAverages.mhStructures}%</span>
                      </div>
                      <div className="confidence-bar" style={{ height: 6 }}>
                        <div className="confidence-fill high" style={{ width: `${scoreboard.categoryAverages.mhStructures}%`, background: 'linear-gradient(90deg, var(--primary-600), var(--primary-400))' }} />
                      </div>
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                        <span style={{ color: 'var(--gray-300)', fontWeight: 500 }}>🕳️ Manholes Catchbasins</span>
                        <span style={{ color: 'var(--accent-400)', fontWeight: 700 }}>{scoreboard.categoryAverages.mhCatchbasins}%</span>
                      </div>
                      <div className="confidence-bar" style={{ height: 6 }}>
                        <div className="confidence-fill medium" style={{ width: `${scoreboard.categoryAverages.mhCatchbasins}%`, background: 'linear-gradient(90deg, var(--accent-500), var(--accent-400))' }} />
                      </div>
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                        <span style={{ color: 'var(--gray-300)', fontWeight: 500 }}>🌊 Sewer Networks</span>
                        <span style={{ color: 'var(--success-400)', fontWeight: 700 }}>{scoreboard.categoryAverages.sewers}%</span>
                      </div>
                      <div className="confidence-bar" style={{ height: 6 }}>
                        <div className="confidence-fill high" style={{ width: `${scoreboard.categoryAverages.sewers}%`, background: 'linear-gradient(90deg, var(--success-600), var(--success-400))' }} />
                      </div>
                    </div>

                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12 }}>
                        <span style={{ color: 'var(--gray-300)', fontWeight: 500 }}>🚰 Watermain Infrastructure</span>
                        <span style={{ color: 'var(--primary-400)', fontWeight: 700 }}>{scoreboard.categoryAverages.watermain}%</span>
                      </div>
                      <div className="confidence-bar" style={{ height: 6 }}>
                        <div className="confidence-fill high" style={{ width: `${scoreboard.categoryAverages.watermain}%`, background: 'linear-gradient(90deg, var(--primary-500), var(--primary-300))' }} />
                      </div>
                    </div>
                  </div>

                </div>

                {/* Collapsible Detailed List Accordion Button */}
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setShowProjectsBreakdown(!showProjectsBreakdown)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid var(--glass-border)',
                      padding: '8px 24px',
                      borderRadius: '100px'
                    }}
                  >
                    <span>{showProjectsBreakdown ? 'Collapse Detailed List' : 'View Detailed Project Breakdown'}</span>
                    <span style={{ transform: showProjectsBreakdown ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', fontSize: 12 }}>
                      ▼
                    </span>
                  </button>
                </div>

                {/* Collapsible Content */}
                {showProjectsBreakdown && (
                  <div className="animate-in" style={{ marginTop: 20, borderTop: '1px solid var(--glass-border)', paddingTop: 20 }}>
                    <div className="data-table-wrapper" style={{ maxHeight: '350px', overflowY: 'auto' }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Drawing/Project</th>
                            <th style={{ textAlign: 'center' }}>MH Structures</th>
                            <th style={{ textAlign: 'center' }}>MH Catchbasins</th>
                            <th style={{ textAlign: 'center' }}>Sewers</th>
                            <th style={{ textAlign: 'center' }}>Watermain</th>
                            <th style={{ textAlign: 'center' }}>Accuracy</th>
                            <th style={{ textAlign: 'right' }}>Cells Matched</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scoreboard.rows.map((row, i) => (
                            <tr key={i}>
                              <td style={{ fontWeight: 600, color: 'var(--gray-100)' }}>📁 {row.project}</td>
                              <td style={{ textAlign: 'center' }}>
                                <span style={{
                                  fontSize: 12,
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  background: row.mhStructures === 'N/A' ? 'transparent' : 'rgba(255,255,255,0.03)',
                                  color: row.mhStructures === 'N/A' ? 'var(--gray-600)' : parseFloat(row.mhStructures) >= 80 ? 'var(--success-400)' : 'var(--gray-300)'
                                }}>
                                  {row.mhStructures === 'N/A' ? 'N/A' : `${row.mhStructures}%`}
                                </span>
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <span style={{
                                  fontSize: 12,
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  background: row.mhCatchbasins === 'N/A' ? 'transparent' : 'rgba(255,255,255,0.03)',
                                  color: row.mhCatchbasins === 'N/A' ? 'var(--gray-600)' : parseFloat(row.mhCatchbasins) >= 80 ? 'var(--success-400)' : 'var(--gray-300)'
                                }}>
                                  {row.mhCatchbasins === 'N/A' ? 'N/A' : `${row.mhCatchbasins}%`}
                                </span>
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <span style={{
                                  fontSize: 12,
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  background: row.sewers === 'N/A' ? 'transparent' : 'rgba(255,255,255,0.03)',
                                  color: row.sewers === 'N/A' ? 'var(--gray-600)' : parseFloat(row.sewers) >= 80 ? 'var(--success-400)' : 'var(--gray-300)'
                                }}>
                                  {row.sewers === 'N/A' ? 'N/A' : `${row.sewers}%`}
                                </span>
                              </td>
                              <td style={{ textAlign: 'center' }}>
                                <span style={{
                                  fontSize: 12,
                                  padding: '2px 8px',
                                  borderRadius: 4,
                                  background: row.watermain === 'N/A' ? 'transparent' : 'rgba(255,255,255,0.03)',
                                  color: row.watermain === 'N/A' ? 'var(--gray-600)' : parseFloat(row.watermain) >= 80 ? 'var(--success-400)' : 'var(--gray-300)'
                                }}>
                                  {row.watermain === 'N/A' ? 'N/A' : `${row.watermain}%`}
                                </span>
                              </td>
                              <td style={{ textAlign: 'center', fontWeight: 700, color: row.overall >= 80 ? 'var(--success-400)' : 'var(--gray-200)' }}>
                                {row.overall.toFixed(1)}%
                              </td>
                              <td style={{ textAlign: 'right', color: 'var(--gray-400)', fontSize: 12 }}>
                                {row.matchingCells} / {row.totalCells}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {/* How it Works */}
          <div className="steps-grid" style={{ marginTop: 60 }}>
            <div className="card step-card">
              <div className="step-number">1</div>
              <div className="step-title">Upload PDF</div>
              <div className="step-desc">Drop your civil engineering servicing/grading drawings</div>
            </div>
            <div className="card step-card">
              <div className="step-number">2</div>
              <div className="step-title">AI Extraction</div>
              <div className="step-desc">Gemini AI reads pipe runs, manholes, elevations, and dimensions</div>
            </div>
            <div className="card step-card">
              <div className="step-number">3</div>
              <div className="step-title">Get Estimate</div>
              <div className="step-desc">Download populated XLSX spreadsheet and professional quote PDF</div>
            </div>
          </div>
        </div>
      )}

      {/* Processing State */}
      {state === 'processing' && (
        <div className="processing-overlay">
          <div className="card processing-card">
            <div className="spinner" />
            <div className="processing-text">Analyzing Drawing...</div>
            <div className="processing-subtext">
              AI is reading pipe runs, manholes, and elevations from your PDF
            </div>
            <div className="processing-subtext animate-pulse" style={{ marginTop: 12, color: 'var(--primary-300)' }}>
              This may take 30-60 seconds
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {state === 'results' && result && (
        <div className="results-container animate-in">
          <div className="results-header">
            <div>
              <div className="results-title">{result.extraction.projectName}</div>
              <div style={{ color: 'var(--gray-400)', fontSize: 14 }}>
                {result.extraction.jobNumber} • {result.extraction.templateType} Template • {result.extraction.date}
              </div>
            </div>
            <div className="results-actions">
              <button className="btn btn-primary" onClick={handleDownloadXlsx}>
                📊 Download Spreadsheet
              </button>
              <button className="btn btn-accent" onClick={handleDownloadQuote}>
                📄 Download Quote
              </button>
              <button className="btn btn-secondary" onClick={() => { setState('upload'); setSelectedFile(null); setResult(null); }}>
                ↩ New Project
              </button>
            </div>
          </div>

          {/* Stats */}
          <div className="results-grid">
            <div className="card stat-card">
              <div className="stat-icon blue">🔵</div>
              <div>
                <div className="stat-value">{result.extraction.sewers.length}</div>
                <div className="stat-label">Sewer Runs</div>
              </div>
            </div>
            <div className="card stat-card">
              <div className="stat-icon amber">🟡</div>
              <div>
                <div className="stat-value">{result.extraction.manholes.length}</div>
                <div className="stat-label">Manholes / Catchbasins</div>
              </div>
            </div>
            <div className="card stat-card">
              <div className="stat-icon green">🟢</div>
              <div>
                <div className="stat-value">{result.extraction.watermain.length}</div>
                <div className="stat-label">Watermain Runs</div>
              </div>
            </div>
            <div className="card stat-card">
              <div className="stat-icon red">
                {result.extraction.confidence >= 0.8 ? '✅' : result.extraction.confidence >= 0.6 ? '⚠️' : '❌'}
              </div>
              <div>
                <div className="confidence-meter">
                  <div className="confidence-bar">
                    <div
                      className={`confidence-fill ${result.extraction.confidence >= 0.8 ? 'high' : result.extraction.confidence >= 0.6 ? 'medium' : 'low'}`}
                      style={{ width: `${result.extraction.confidence * 100}%` }}
                    />
                  </div>
                  <span className="confidence-value">{Math.round(result.extraction.confidence * 100)}%</span>
                </div>
                <div className="stat-label">AI Confidence</div>
              </div>
            </div>
          </div>

          {/* Warnings */}
          {result.extraction.warnings.length > 0 && (
            <div className="card" style={{ marginBottom: 24, borderColor: 'rgba(245, 158, 11, 0.3)' }}>
              <div className="card-title" style={{ color: 'var(--warning-400)' }}>
                ⚠ Warnings ({result.extraction.warnings.length})
              </div>
              <ul className="warnings-list">
                {result.extraction.warnings.map((w, i) => (
                  <li key={i} className="warning-item">
                    <span className="warning-icon">⚠</span>
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Data Tabs */}
          <div className="card">
            <div className="tabs">
              <button className={`tab ${activeTab === 'sewers' ? 'active' : ''}`} onClick={() => setActiveTab('sewers')}>
                Sewers ({result.extraction.sewers.length})
              </button>
              <button className={`tab ${activeTab === 'manholes' ? 'active' : ''}`} onClick={() => setActiveTab('manholes')}>
                Manholes ({result.extraction.manholes.length})
              </button>
              <button className={`tab ${activeTab === 'watermain' ? 'active' : ''}`} onClick={() => setActiveTab('watermain')}>
                Watermain ({result.extraction.watermain.length})
              </button>
            </div>

            {activeTab === 'sewers' && (
              <div className="data-table-wrapper">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Run</th>
                      <th>Length (m)</th>
                      <th>Diameter (mm)</th>
                      <th>Type</th>
                      <th>Slope</th>
                      <th>Depth (m)</th>
                      <th>Add Mtrls $</th>
                      <th>Add L&E $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.extraction.sewers.map((s) => (
                      <tr key={s.item}>
                        <td>{s.item}</td>
                        <td>{s.runLabel}</td>
                        <td>{s.length}</td>
                        <td>{s.pipeDiameter}</td>
                        <td>{s.typeClass}</td>
                        <td>{s.slope}</td>
                        <td>{s.depth}</td>
                        <td>{s.addMaterials || '-'}</td>
                        <td>{s.addLE || '-'}</td>
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
                      <th>#</th>
                      <th>Description</th>
                      <th>Top El.</th>
                      <th>Low Inv.</th>
                      <th>Hi Inv.</th>
                      <th>Pipe Out (mm)</th>
                      <th>Type</th>
                      <th>Add Mtrls $</th>
                      <th>Add L&E $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.extraction.manholes.map((m) => (
                      <tr key={m.item}>
                        <td>{m.item}</td>
                        <td>{m.description}</td>
                        <td>{m.topElevation}</td>
                        <td>{m.lowInvert}</td>
                        <td>{m.highInvert || '-'}</td>
                        <td>{m.pipeOutDiameter}</td>
                        <td>{Number(m.structureType) === 1 ? 'STD' : 'LRG'}</td>
                        <td>{m.addMaterials || '-'}</td>
                        <td>{m.addLE || '-'}</td>
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
                      <th>#</th>
                      <th>Size & Type</th>
                      <th>Length (m)</th>
                      <th>Diameter (mm)</th>
                      <th>OC/SC</th>
                      <th>Avg Cover (m)</th>
                      <th>Add Mtrls $</th>
                      <th>Add L&E $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.extraction.watermain.map((w) => (
                      <tr key={w.item}>
                        <td>{w.item}</td>
                        <td>{w.sizeAndType}</td>
                        <td>{w.length}</td>
                        <td>{w.pipeDiameter}</td>
                        <td>{w.ocSc}</td>
                        <td>{w.avgCover}</td>
                        <td>{w.addMaterials || '-'}</td>
                        <td>{w.addLE || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Specials & Valves */}
                {result.extraction.watermainSpecials.length > 0 && (
                  <>
                    <div className="card-title" style={{ padding: '16px 14px 8px', fontSize: 14 }}>
                      Fittings & Specials
                    </div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Special</th><th>Qty</th><th>$/Each</th>
                          <th>TB</th><th>Anode $</th><th>Labor $</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.extraction.watermainSpecials.map((sp) => (
                          <tr key={sp.item}>
                            <td>{sp.item}</td><td>{sp.specialName}</td><td>{sp.quantity}</td>
                            <td>{sp.costEach}</td><td>{sp.thrustBlock ? 'Y' : 'N'}</td>
                            <td>{sp.anodeCost}</td><td>{sp.laborEach}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {result.extraction.watermainValves.length > 0 && (
                  <>
                    <div className="card-title" style={{ padding: '16px 14px 8px', fontSize: 14 }}>
                      Valves
                    </div>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th><th>Size</th><th>Qty</th><th>$/Valve</th>
                          <th>$/Box</th><th>Anode $</th><th>Labor/V $</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.extraction.watermainValves.map((v) => (
                          <tr key={v.item}>
                            <td>{v.item}</td><td>{v.valveSize}</td><td>{v.quantity}</td>
                            <td>{v.valveCost}</td><td>{v.boxCost}</td>
                            <td>{v.anodeCost}</td><td>{v.laborPerValve}</td>
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
