'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { DEFAULT_PARAMS } from '@/lib/constants';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  SettingsIcon,
  CheckIcon,
  RefreshIcon,
  DollarIcon,
  ManholeIcon,
  PipeIcon,
  WaterIcon,
  InfoIcon,
} from '@/components/ui/Icons';

interface ParamField {
  key: string;
  label: string;
  unit: string;
  step?: number;
  description?: string;
}

interface ParamGroup {
  groupTitle: string;
  fields: ParamField[];
}

const MANHOLE_GROUPS: ParamGroup[] = [
  {
    groupTitle: 'Base Concrete & Risers',
    fields: [
      { key: 'concretePerCM', label: 'Concrete per Volume', unit: '$/CM', step: 1, description: 'Precast & cast-in-place concrete base rate' },
      { key: 'truckingPerCM', label: 'Surplus Trucking', unit: '$/CM', step: 1, description: 'Excavation spoil hauling rate' },
      { key: 'modPerM', label: 'Moduloc / Risers', unit: '$/m', step: 1, description: 'Modular riser section unit price' },
    ],
  },
  {
    groupTitle: 'Castings & Frame Covers',
    fields: [
      { key: 'mhFC', label: 'Manhole Frame & Cover', unit: '$/ea', step: 1, description: 'Standard OPSD cast iron manhole cover set' },
      { key: 'cbFC', label: 'Catchbasin Frame & Grate', unit: '$/ea', step: 1, description: 'Standard OPSD catchbasin grate set' },
      { key: 'frameCoverM', label: 'Frame & Cover Allowance', unit: 'm', step: 0.05, description: 'Height allowance above top slab' },
    ],
  },
  {
    groupTitle: 'Crew Labor & Factors',
    fields: [
      { key: 'laborPerHr', label: 'Crew Labor Rate', unit: '$/hr', step: 1, description: 'Blended hourly structure installation crew rate' },
      { key: 'discount', label: 'Discount Multiplier', unit: 'factor', step: 0.01, description: 'Supplier discount applied to modular lists' },
      { key: 'marginFactor', label: 'Margin Multiplier', unit: 'factor', step: 0.01, description: 'Contractor markup margin multiplier' },
      { key: 'fstFactor', label: 'FST Multiplier', unit: 'factor', step: 0.01, description: 'Federal sales tax multiplier' },
      { key: 'pstFactor', label: 'PST Multiplier', unit: 'factor', step: 0.01, description: 'Provincial sales tax multiplier' },
    ],
  },
];

const SEWER_GROUPS: ParamGroup[] = [
  {
    groupTitle: 'Trench Geometry & Bedding',
    fields: [
      { key: 'minTrenchWidth', label: 'Minimum Trench Width', unit: 'm', step: 0.05, description: 'Base trench excavation width' },
      { key: 'pipeCover', label: 'Pipe Cover Depth', unit: 'm', step: 0.05, description: 'Minimum clear cover over pipe crown' },
      { key: 'trenchClear', label: 'Trench Clearance', unit: 'm', step: 0.05, description: 'Side clearance for bedding & compaction' },
      { key: 'dualTrSep', label: 'Dual Trench Separation', unit: 'm', step: 0.05, description: 'Clearance between storm & sanitary twins' },
      { key: 'mFinGrade', label: 'Finished Grade Allowance', unit: 'm', step: 0.05, description: 'Top pavement & subbase offset' },
    ],
  },
  {
    groupTitle: 'Daily Crew & Production',
    fields: [
      { key: 'dayCostPerDay', label: 'Daily Crew Cost', unit: '$/day', step: 100, description: 'Pipe layer crew & heavy equipment daily rate' },
      { key: 'extraPerDay', label: 'Daily Overheads / Extras', unit: '$/day', step: 10, description: 'Site supervision & dewatering overheads' },
      { key: 'productionMPerDay', label: 'Daily Production Target', unit: 'm/day', step: 1, description: 'Expected lineal meters laid per day' },
      { key: 'efficiency', label: 'Crew Efficiency', unit: '%', step: 1, description: 'Site difficulty efficiency factor' },
    ],
  },
  {
    groupTitle: 'Aggregates & Materials',
    fields: [
      { key: 'stoneImpT', label: 'Clear Stone Imported', unit: '$/ImpT', step: 0.5, description: 'Granular A / clear bedding import rate' },
      { key: 'stoneMt', label: 'Clear Stone Metric Tonne', unit: '$/t', step: 0.5, description: 'Bedding stone metric conversion rate' },
      { key: 'granImpTn', label: 'Granular B Imported', unit: '$/ImpT', step: 0.5, description: 'Trench backfill granular material' },
      { key: 'granMt', label: 'Granular B Metric Tonne', unit: '$/t', step: 0.5, description: 'Granular B metric conversion rate' },
      { key: 'truckingPerCM', label: 'Surplus Spoil Trucking', unit: '$/CM', step: 1, description: 'Surplus material disposal trucking' },
      { key: 'concPipePct', label: 'Concrete Pipe Bedding Add-on', unit: '%', step: 1, description: 'Extra bedding volume for RCP pipes' },
    ],
  },
  {
    groupTitle: 'Financial Factors & Multipliers',
    fields: [
      { key: 'marginFactor', label: 'Margin Multiplier', unit: 'factor', step: 0.01, description: 'Contractor profit & overhead multiplier' },
      { key: 'openCutFactor', label: 'Open Cut Factor', unit: 'factor', step: 0.01, description: 'Open cut excavation production factor' },
      { key: 'provTax', label: 'Provincial Tax Factor', unit: 'factor', step: 0.01, description: 'PST multiplier' },
      { key: 'fedTax', label: 'Federal Tax Factor', unit: 'factor', step: 0.01, description: 'GST/HST multiplier' },
    ],
  },
  {
    groupTitle: 'Baseline PVC Pipe Rates ($/m)',
    fields: [
      { key: 'pvc100', label: '100mm (4") PVC Pipe', unit: '$/m', step: 1, description: 'SDR 35 / 28 PVC unit cost' },
      { key: 'pvc150', label: '150mm (6") PVC Pipe', unit: '$/m', step: 1, description: 'SDR 35 / 28 PVC unit cost' },
      { key: 'pvc200', label: '200mm (8") PVC Pipe', unit: '$/m', step: 1, description: 'SDR 35 / 28 PVC unit cost' },
      { key: 'pvc250', label: '250mm (10") PVC Pipe', unit: '$/m', step: 1, description: 'SDR 35 / 28 PVC unit cost' },
      { key: 'pvc300', label: '300mm (12") PVC Pipe', unit: '$/m', step: 1, description: 'SDR 35 / 28 PVC unit cost' },
      { key: 'pvc375', label: '375mm (15") PVC Pipe', unit: '$/m', step: 1, description: 'SDR 35 / 28 PVC unit cost' },
      { key: 'pvc450', label: '450mm (18") PVC Pipe', unit: '$/m', step: 1, description: 'SDR 35 / 28 PVC unit cost' },
    ],
  },
];

const WATERMAIN_GROUPS: ParamGroup[] = [
  {
    groupTitle: 'Trench Geometry & Clearances',
    fields: [
      { key: 'minTrenchWidth', label: 'Minimum Trench Width', unit: 'm', step: 0.05, description: 'Base water trench excavation width' },
      { key: 'pipeCover', label: 'Watermain Cover Depth', unit: 'm', step: 0.05, description: 'Frost protection depth (typically 1.7m - 2.1m)' },
      { key: 'peelRegionCover', label: 'Regional Depth Offset', unit: 'm', step: 0.05, description: 'Region-specific cover depth adjustment' },
      { key: 'trenchClear', label: 'Trench Side Clearance', unit: 'm', step: 0.05, description: 'Clearance beside pipe wall' },
      { key: 'dualTrSep', label: 'Dual Trench Separation', unit: 'm', step: 0.05, description: 'Offset when sharing trench with sewers' },
      { key: 'mFinGrade', label: 'Finished Grade Allowance', unit: 'm', step: 0.05, description: 'Subgrade surface allowance' },
    ],
  },
  {
    groupTitle: 'Daily Crew & Production',
    fields: [
      { key: 'dayCostPerDay', label: 'Daily Crew Cost', unit: '$/day', step: 100, description: 'Watermain pipe crew & machine daily rate' },
      { key: 'extraPerDay', label: 'Daily Overheads / Extras', unit: '$/day', step: 10, description: 'Testing, chlorination & overheads' },
      { key: 'productionMPerDay', label: 'Daily Production Target', unit: 'm/day', step: 1, description: 'Expected lineal meters laid per day' },
      { key: 'efficiency', label: 'Crew Efficiency', unit: '%', step: 1, description: 'Site difficulty efficiency factor' },
    ],
  },
  {
    groupTitle: 'Aggregates, Concrete & Chambers',
    fields: [
      { key: 'stoneImpTon', label: 'Clear Stone Imported', unit: '$/ImpT', step: 0.5, description: 'Sand / stone bedding import rate' },
      { key: 'stoneMtne', label: 'Clear Stone Metric Tonne', unit: '$/t', step: 0.5, description: 'Bedding stone metric conversion rate' },
      { key: 'granImpTon', label: 'Granular B Imported', unit: '$/ImpT', step: 0.5, description: 'Trench backfill granular material' },
      { key: 'granMtne', label: 'Granular B Metric Tonne', unit: '$/t', step: 0.5, description: 'Granular B metric conversion rate' },
      { key: 'truckingPerCM', label: 'Surplus Spoil Trucking', unit: '$/CM', step: 1, description: 'Surplus material disposal trucking' },
      { key: 'concPerCM', label: 'Thrust Block Concrete', unit: '$/CM', step: 1, description: 'Unreinforced concrete for thrust blocks' },
      { key: 'modulocPerM', label: 'Moduloc Valve Chambers', unit: '$/m', step: 1, description: 'Chamber risers per vertical meter' },
      { key: 'precastPct', label: 'Precast Fitting Add-on', unit: '%', step: 1, description: 'Allowance for precast valve chamber fittings' },
    ],
  },
  {
    groupTitle: 'Financial Factors & Multipliers',
    fields: [
      { key: 'marginFactor', label: 'Margin Multiplier', unit: 'factor', step: 0.01, description: 'Contractor profit & overhead multiplier' },
      { key: 'openCutFactor', label: 'Open Cut Factor', unit: 'factor', step: 0.01, description: 'Open cut excavation production factor' },
      { key: 'provTax', label: 'Provincial Tax Factor', unit: 'factor', step: 0.01, description: 'PST multiplier' },
      { key: 'fedTax', label: 'Federal Tax Factor', unit: 'factor', step: 0.01, description: 'GST/HST multiplier' },
    ],
  },
  {
    groupTitle: 'C900 PVC Pressure Pipe ($/m)',
    fields: [
      { key: 'c900_100', label: '100mm (4") C900 PVC', unit: '$/m', step: 1, description: 'DR 18 C900 watermain pipe' },
      { key: 'c900_150', label: '150mm (6") C900 PVC', unit: '$/m', step: 1, description: 'DR 18 C900 watermain pipe' },
      { key: 'c900_200', label: '200mm (8") C900 PVC', unit: '$/m', step: 1, description: 'DR 18 C900 watermain pipe' },
      { key: 'c900_250', label: '250mm (10") C900 PVC', unit: '$/m', step: 1, description: 'DR 18 C900 watermain pipe' },
      { key: 'c900_300', label: '300mm (12") C900 PVC', unit: '$/m', step: 1, description: 'DR 18 C900 watermain pipe' },
    ],
  },
];

export default function SettingsPage() {
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [saved, setSaved] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [activeTab, setActiveTab] = useState<'all' | 'structures' | 'sewers' | 'watermain'>('all');

  useEffect(() => {
    try {
      const stored = localStorage.getItem('autoinfra_params');
      if (stored) {
        const parsed = JSON.parse(stored);
        setParams({
          manholes: { ...DEFAULT_PARAMS.manholes, ...(parsed.manholes || {}) },
          sewers: { ...DEFAULT_PARAMS.sewers, ...(parsed.sewers || {}) },
          watermain: { ...DEFAULT_PARAMS.watermain, ...(parsed.watermain || {}) },
        });
      }
    } catch (e) {
      console.error('Failed to load params from localStorage', e);
    }
    setIsHydrated(true);
  }, []);

  const updateParam = (section: keyof typeof DEFAULT_PARAMS, key: string, value: number) => {
    setParams((prev) => ({
      ...prev,
      [section]: { ...prev[section], [key]: value },
    }));
    setHasChanges(true);
    setSaved(false);
  };

  const handleSave = () => {
    try {
      localStorage.setItem('autoinfra_params', JSON.stringify(params));
      setSaved(true);
      setHasChanges(false);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      console.error('Failed to save params to localStorage', e);
    }
  };

  const handleReset = () => {
    setParams(DEFAULT_PARAMS);
    try {
      localStorage.removeItem('autoinfra_params');
    } catch (e) {
      console.error('Failed to remove stored params', e);
    }
    setHasChanges(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const renderGroup = (
    sectionKey: keyof typeof DEFAULT_PARAMS,
    group: ParamGroup
  ) => {
    const sectionData = params[sectionKey] as Record<string, unknown>;

    return (
      <div key={group.groupTitle} className="mb-5 last:mb-0">
        <div className="flex items-center gap-2 mb-2 pb-2 border-b border-[var(--border-subtle)]">
          <span className="text-[12.5px] font-semibold text-[var(--text-secondary)]">
            {group.groupTitle}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
          {group.fields.map((field) => {
            const rawVal = sectionData[field.key];
            const numVal = typeof rawVal === 'number' ? rawVal : 0;

            return (
              <div
                key={field.key}
                className="group flex flex-col sm:flex-row sm:items-center justify-between p-2 rounded-[var(--radius-sm)] hover:bg-[var(--bg-elevated)] border border-transparent hover:border-[var(--border-subtle)] transition-all"
              >
                <div className="flex flex-col min-w-0 pr-2 mb-1.5 sm:mb-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium text-[var(--text-primary)]" title={field.key}>
                      {field.label}
                    </span>
                  </div>
                  {field.description && (
                    <span className="text-[12px] text-[var(--text-muted)] line-clamp-1">
                      {field.description}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
                  <div className="relative flex items-center">
                    <input
                      type="number"
                      step={field.step ?? (numVal < 10 && numVal > 0 ? 0.01 : 1)}
                      value={numVal}
                      onChange={(e) =>
                        updateParam(sectionKey, field.key, parseFloat(e.target.value) || 0)
                      }
                      className="input input-sm w-24 sm:w-28 text-right font-mono"
                    />
                    <span className="ml-1.5 text-[11px] font-mono text-[var(--text-muted)] w-12 text-left truncate">
                      {field.unit}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="container-cad pt-8 pb-16 space-y-6">
      {/* Breadcrumb & Navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <Link href="/" className="hover:text-[var(--text-primary)] transition-colors">
            Takeoff Studio
          </Link>
          <span>/</span>
          <span className="text-[var(--text-primary)] font-medium">Settings &amp; Unit Rates</span>
        </div>

        <div className="flex items-center gap-2">
          {hasChanges && (
            <Badge variant="warning" size="sm" dot dotColor="var(--warning)">
              Unsaved modifications
            </Badge>
          )}
          {saved && (
            <Badge variant="success" size="sm" dot dotColor="var(--success)">
              Settings saved
            </Badge>
          )}
        </div>
      </div>

      {/* Header Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-[var(--radius-md)] bg-[var(--bg-surface)] border border-[var(--border-subtle)]">
        <div className="flex items-start gap-3.5">
          <div className="p-2.5 rounded-[var(--radius-sm)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-primary)] shrink-0">
            <SettingsIcon size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-lg font-bold tracking-tight text-[var(--text-primary)]">
                Estimation Rates &amp; Geometry Engine
              </h1>
              <Badge variant="muted" size="sm">
                Ontario Standards (OPSD)
              </Badge>
            </div>
            <p className="text-xs text-[var(--text-secondary)] mt-1 max-w-2xl">
              Configure baseline unit pricing, crew production speeds, excavation geometry, and municipal tax multipliers.
              Values are cached locally in your browser and automatically applied to new plan extractions.
            </p>
          </div>
        </div>

        {/* Global Actions */}
        <div className="flex items-center gap-2.5 shrink-0 self-end md:self-center">
          <Button
            variant="outline"
            size="sm"
            icon={<RefreshIcon size={13} />}
            onClick={handleReset}
            title="Reset all rates to default factory values"
          >
            Reset Defaults
          </Button>
          <Button
            variant={saved ? 'storm' : 'primary'}
            size="sm"
            icon={saved ? <CheckIcon size={14} /> : <DollarIcon size={14} />}
            onClick={handleSave}
          >
            {saved ? 'Saved to Local Cache' : 'Save Changes'}
          </Button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 border-b border-[var(--border-subtle)] pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('all')}
          className={`px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors ${
            activeTab === 'all'
              ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-subtle)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/50'
          }`}
        >
          All Domains
        </button>
        <button
          onClick={() => setActiveTab('structures')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors ${
            activeTab === 'structures'
              ? 'bg-[var(--structures-bg)] text-[var(--structures)] border border-[var(--structures-border)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/50'
          }`}
        >
          <ManholeIcon size={13} />
          <span>Structures &amp; Manholes</span>
          <Badge variant="structures" size="sm">
            {MANHOLE_GROUPS.reduce((acc, g) => acc + g.fields.length, 0)}
          </Badge>
        </button>
        <button
          onClick={() => setActiveTab('sewers')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors ${
            activeTab === 'sewers'
              ? 'bg-[var(--storm-bg)] text-[var(--storm)] border border-[var(--storm-border)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/50'
          }`}
        >
          <PipeIcon size={13} />
          <span>Sewers &amp; Trenching</span>
          <Badge variant="storm" size="sm">
            {SEWER_GROUPS.reduce((acc, g) => acc + g.fields.length, 0)}
          </Badge>
        </button>
        <button
          onClick={() => setActiveTab('watermain')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors ${
            activeTab === 'watermain'
              ? 'bg-[var(--water-bg)] text-[var(--water)] border border-[var(--water-border)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]/50'
          }`}
        >
          <WaterIcon size={13} />
          <span>Watermain &amp; Appurtenances</span>
          <Badge variant="water" size="sm">
            {WATERMAIN_GROUPS.reduce((acc, g) => acc + g.fields.length, 0)}
          </Badge>
        </button>
      </div>

      {/* Domain Rate Cards Grid */}
      <div className="grid grid-cols-1 gap-6">
        {/* Domain 1: Manholes & Structures */}
        {(activeTab === 'all' || activeTab === 'structures') && (
          <div className={activeTab === 'structures' ? 'lg:col-span-3' : ''}>
            <Card
              title={
                <div className="flex items-center gap-2">
                  <span className="text-[var(--structures)]">
                    <ManholeIcon size={16} />
                  </span>
                  <span className="font-semibold text-sm text-[var(--text-primary)]">
                    Structures &amp; Manholes
                  </span>
                </div>
              }
              headerBadge={
                <Badge variant="structures" size="sm">
                  OPSD 700 / 400
                </Badge>
              }
              className="border-t-2 border-t-[var(--structures)]"
            >
              {isHydrated ? (
                <div>
                  {MANHOLE_GROUPS.map((group) => renderGroup('manholes', group))}
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-[var(--text-muted)] font-mono">
                  Loading parameters...
                </div>
              )}
            </Card>
          </div>
        )}

        {/* Domain 2: Sewer Pipes & Trenching */}
        {(activeTab === 'all' || activeTab === 'sewers') && (
          <div className={activeTab === 'sewers' ? 'lg:col-span-3' : ''}>
            <Card
              title={
                <div className="flex items-center gap-2">
                  <span className="text-[var(--storm)]">
                    <PipeIcon size={16} />
                  </span>
                  <span className="font-semibold text-sm text-[var(--text-primary)]">
                    Sewer Pipes &amp; Trenching
                  </span>
                </div>
              }
              headerBadge={
                <Badge variant="storm" size="sm">
                  Storm &amp; Sanitary
                </Badge>
              }
              className="border-t-2 border-t-[var(--storm)]"
            >
              {isHydrated ? (
                <div>
                  {SEWER_GROUPS.map((group) => renderGroup('sewers', group))}
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-[var(--text-muted)] font-mono">
                  Loading parameters...
                </div>
              )}
            </Card>
          </div>
        )}

        {/* Domain 3: Watermain & Appurtenances */}
        {(activeTab === 'all' || activeTab === 'watermain') && (
          <div className={activeTab === 'watermain' ? 'lg:col-span-3' : ''}>
            <Card
              title={
                <div className="flex items-center gap-2">
                  <span className="text-[var(--water)]">
                    <WaterIcon size={16} />
                  </span>
                  <span className="font-semibold text-sm text-[var(--text-primary)]">
                    Watermain &amp; Appurtenances
                  </span>
                </div>
              }
              headerBadge={
                <Badge variant="water" size="sm">
                  Pressure Distribution
                </Badge>
              }
              className="border-t-2 border-t-[var(--water)]"
            >
              {isHydrated ? (
                <div>
                  {WATERMAIN_GROUPS.map((group) => renderGroup('watermain', group))}
                </div>
              ) : (
                <div className="py-8 text-center text-xs text-[var(--text-muted)] font-mono">
                  Loading parameters...
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      {/* Info Footnote */}
      <div className="flex items-start gap-2.5 p-4 rounded-[var(--radius-sm)] bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[var(--text-secondary)] text-xs">
        <span className="text-[var(--info)] shrink-0 mt-0.5">
          <InfoIcon size={14} />
        </span>
        <div className="space-y-1">
          <p className="font-medium text-[var(--text-primary)]">
            Takeoff Calculation Consistency Note
          </p>
          <p className="text-[11px] leading-relaxed">
            Changing these global unit rates will adjust the takeoff calculation engine for future drawing uploads.
            Existing calculation results currently loaded in the studio can be recalculated by clicking &quot;Re-estimate&quot; in the ledger view.
          </p>
        </div>
      </div>
    </div>
  );
}
