'use client';

import { useState } from 'react';
import { DEFAULT_PARAMS } from '@/lib/constants';

export default function SettingsPage() {
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [saved, setSaved] = useState(false);

  const updateParam = (section: string, key: string, value: number) => {
    setParams((prev) => ({
      ...prev,
      [section]: { ...prev[section as keyof typeof prev], [key]: value },
    }));
    setSaved(false);
  };

  const handleSave = () => {
    localStorage.setItem('autoinfra_params', JSON.stringify(params));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleReset = () => {
    setParams(DEFAULT_PARAMS);
    localStorage.removeItem('autoinfra_params');
    setSaved(false);
  };

  return (
    <div className="app-container" style={{ padding: '40px 24px 80px' }}>
      <div className="results-header">
        <div>
          <div className="results-title">Global Parameters</div>
          <div style={{ color: 'var(--gray-400)', fontSize: 14 }}>
            Default estimation parameters — these can be overridden per project
          </div>
        </div>
        <div className="results-actions">
          <button className="btn btn-secondary" onClick={handleReset}>↺ Reset Defaults</button>
          <button className="btn btn-primary" onClick={handleSave}>
            {saved ? '✓ Saved!' : '💾 Save Settings'}
          </button>
        </div>
      </div>

      <div className="settings-grid">
        {/* MANHOLES */}
        <div className="card setting-group">
          <div className="setting-group-title">🔵 Manhole Parameters</div>
          {renderSettings(params.manholes, 'manholes', updateParam, {
            truckingPerCM: '$/CM Trucking',
            concretePerCM: '$/CM Concrete',
            discount: '% Discount',
            marginFactor: 'Margin Factor',
            fstFactor: 'FST Factor',
            pstFactor: 'PST Factor',
            modPerM: 'Mod $/m',
            mhFC: 'MH F&C $',
            cbFC: 'CB F&C $',
            laborPerHr: 'Labor $/Hr',
            frameCoverM: 'Fr+Cvr (m)',
          })}
        </div>

        {/* SEWERS */}
        <div className="card setting-group">
          <div className="setting-group-title">🟠 Sewer Parameters</div>
          {renderSettings(params.sewers, 'sewers', updateParam, {
            minTrenchWidth: 'Min Trench Width (m)',
            pipeCover: 'Pipe Cover (m)',
            mFinGrade: 'M-Fin Grade',
            dayCostPerDay: 'Day Cost ($/day)',
            extraPerDay: 'Extra ($/day)',
            productionMPerDay: 'Production (m/day)',
            stoneImpT: '$/ImpT Stone',
            stoneMt: '$/Mt Stone',
            granImpTn: '$/ImpTn Gran',
            granMt: '$/Mt Gran',
            truckingPerCM: '$/CM Trucking',
            efficiency: '% Efficiency',
            marginFactor: 'Margin Factor',
            openCutFactor: 'Open Cut Factor',
            dualTrSep: 'Dual Tr Sep (m)',
            trenchClear: 'Trench Clear (m)',
            concPipePct: 'Conc Pipe %',
          })}
        </div>

        {/* WATERMAIN */}
        <div className="card setting-group">
          <div className="setting-group-title">🟢 Watermain Parameters</div>
          {renderSettings(params.watermain, 'watermain', updateParam, {
            minTrenchWidth: 'Min Trench Width (m)',
            pipeCover: 'Pipe Cover (m)',
            mFinGrade: 'M-Fin Grade',
            dayCostPerDay: 'Day Cost ($/day)',
            extraPerDay: 'Extra ($/day)',
            productionMPerDay: 'Production (m/day)',
            stoneImpTon: '$/ImpTon Stone',
            stoneMtne: '$/Mtne Stone',
            granImpTon: '$/ImpTon Gran',
            granMtne: '$/Mtne Gran',
            truckingPerCM: '$/CM Trucking',
            efficiency: '% Efficiency',
            marginFactor: 'Margin Factor',
            openCutFactor: 'Open Cut Factor',
            precastPct: 'Precast %',
            modulocPerM: '$/m Moduloc',
            c900_100: '100mm C900 $/m',
            c900_150: '150mm C900 $/m',
            c900_200: '200mm C900 $/m',
            c900_250: '250mm C900 $/m',
            c900_300: '300mm C900 $/m',
            concPerCM: 'Conc $/CM',
          })}
        </div>
      </div>
    </div>
  );
}

function renderSettings(
  section: Record<string, unknown>,
  sectionName: string,
  updateParam: (section: string, key: string, value: number) => void,
  labels: Record<string, string>
) {
  return Object.entries(labels).map(([key, label]) => {
    const value = section[key];
    if (typeof value === 'boolean') return null;
    return (
      <div key={key} className="setting-row">
        <span className="setting-label">{label}</span>
        <input
          type="number"
          className="setting-input"
          value={Number(value) || 0}
          step={Number(value) < 10 ? 0.01 : 1}
          onChange={(e) => updateParam(sectionName, key, parseFloat(e.target.value) || 0)}
        />
      </div>
    );
  });
}
