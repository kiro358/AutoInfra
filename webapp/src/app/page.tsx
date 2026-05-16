'use client';

import { useState, useCallback, useRef } from 'react';
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
                        <td>{m.structureType === 1 ? 'STD' : 'LRG'}</td>
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
