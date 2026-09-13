'use client';

import React, { useMemo, useState } from 'react';
import type { PerformanceSummary, ProjectSummary } from '@/lib/perf-summary';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  AlertIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  RefreshIcon,
  SearchIcon,
  SpinnerIcon,
} from '@/components/ui/Icons';
import { formatNumber, formatPercent } from '@/lib/formatters';
import { EntityMeters } from './EntityMeters';
import { ProjectScoreCard, classifyScore, scoreTierMeta } from './ProjectScoreCard';

/**
 * BenchmarkDashboard — the facts-metric accuracy panel.
 *
 * The headline is detF1 over runs that returned a takeoff; the pessimistic read
 * (failures counted as zero) sits beside it rather than replacing it, because
 * the two answer different questions and are NOT interchangeable (CLAUDE.md).
 * This panel must never be wired to the legacy cell-accuracy scoreboard.
 */

/** Case-insensitive match over project name, job code and source folder. */
export function filterProjects(projects: ProjectSummary[], query: string): ProjectSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((p) =>
    [p.name, p.jobCode, p.folder, p.label].some((field) =>
      (field || '').toLowerCase().includes(q)
    )
  );
}

export interface HeadlineFigure {
  key: string;
  label: string;
  value: string;
  note: string;
  tone?: 'strong' | 'fair' | 'alarm' | 'neutral';
}

/** The KPI row under the headline — total sets, passing sets, failed runs. */
export function headlineFigures(summary: PerformanceSummary): HeadlineFigure[] {
  return [
    {
      key: 'withFailures',
      label: 'Including failed runs',
      value: formatPercent(summary.meanDetF1WithFailures, 1),
      note: `All ${formatNumber(summary.projectsTotal, 0)} test sets, counting a failed extraction as zero.`,
      tone: 'neutral',
    },
    {
      key: 'fieldAcc',
      label: 'Field accuracy',
      value: formatPercent(summary.meanFieldAcc, 1),
      note: 'Correct field values on entities that were matched to truth.',
      tone: 'neutral',
    },
    {
      key: 'scored',
      label: 'Passing sets',
      value: `${formatNumber(summary.projectsScored, 0)} / ${formatNumber(summary.projectsTotal, 0)}`,
      note: 'Test sets that produced a non-empty takeoff.',
      tone: 'neutral',
    },
    {
      key: 'failed',
      label: 'Empty / failed runs',
      value: formatNumber(summary.projectsFailed, 0),
      note: 'Returned nothing at all — a run failure, not a bad read.',
      tone: summary.projectsFailed > 0 ? 'alarm' : 'strong',
    },
  ];
}

export interface BenchmarkDashboardProps {
  summary: PerformanceSummary | null;
  error: string | null;
  onRefresh: () => void;
  isLoading: boolean;
  /** Start collapsed. Defaults to expanded. */
  defaultCollapsed?: boolean;
  className?: string;
}

export const BenchmarkDashboard: React.FC<BenchmarkDashboardProps> = ({
  summary,
  error,
  onRefresh,
  isLoading,
  defaultCollapsed = false,
  className = '',
}) => {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [query, setQuery] = useState('');

  const projects = summary?.projects ?? [];
  const visible = useMemo(() => filterProjects(projects, query), [projects, query]);

  const tier = summary ? classifyScore(summary.meanDetF1) : 'alarm';
  const tierMeta = scoreTierMeta(tier);

  const body = (
    <>
      {isLoading && (
        <div className="bench-state" role="status" aria-live="polite">
          <SpinnerIcon size={14} className="animate-spin" />
          <span>Loading golden-set results…</span>
        </div>
      )}

      {!isLoading && error && (
        <div className="bench-state is-alarm" role="alert">
          <AlertIcon size={14} />
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={onRefresh} icon={<RefreshIcon size={12} />}>
            Retry
          </Button>
        </div>
      )}

      {!isLoading && !error && !summary && (
        <div className="bench-state">
          <span>
            No benchmark results yet. Run <code className="font-mono">npm run score:offline</code> to
            generate them.
          </span>
        </div>
      )}

      {!isLoading && !error && summary && (
        <>
          <div className="bench-headline">
            <div className={`bench-figure is-${tier}`}>
              <div className="bench-figure-value font-mono">
                {formatPercent(summary.meanDetF1, 1)}
              </div>
              <div className="bench-figure-label">
                Mean detF1
                <Badge variant={tierMeta.variant} size="sm">
                  {tierMeta.label}
                </Badge>
              </div>
              <p className="bench-figure-note">
                Detection F1 across the {formatNumber(summary.projectsScored, 0)} test sets that
                returned a takeoff.
              </p>
            </div>

            <div className="bench-kpis">
              {headlineFigures(summary).map((f) => (
                <div key={f.key} className={`bench-kpi is-${f.tone ?? 'neutral'}`}>
                  <div className="bench-kpi-value font-mono">{f.value}</div>
                  <div className="bench-kpi-label">{f.label}</div>
                  <p className="bench-kpi-note">{f.note}</p>
                </div>
              ))}
            </div>
          </div>

          <section className="bench-section" aria-label="Entity-level accuracy">
            <h4 className="bench-section-title">Accuracy by entity class</h4>
            <EntityMeters entities={summary.entities} />
          </section>

          <section className="bench-section" aria-label="Test set results">
            <div className="bench-toolbar">
              <h4 className="bench-section-title">
                Test sets
                <span className="bench-count font-mono">
                  {formatNumber(visible.length, 0)} / {formatNumber(projects.length, 0)}
                </span>
              </h4>
              <div className="search-input-wrapper bench-search">
                <SearchIcon size={13} className="search-input-icon" />
                <input
                  className="input"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by project or job code…"
                  aria-label="Filter test projects"
                />
              </div>
            </div>

            {visible.length === 0 ? (
              <p className="bench-empty">No test sets match “{query}”.</p>
            ) : (
              <div className="bench-grid">
                {visible.map((p) => (
                  <ProjectScoreCard key={p.folder} project={p} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </>
  );

  return (
    <Card
      className={`bench ${className}`.trim()}
      title="Extraction Accuracy Benchmark"
      subtitle="Facts metric — entity detection F1 over the golden set"
      headerBadge={
        summary && !isLoading && !error ? (
          <Badge variant={tierMeta.variant} size="sm">
            {formatPercent(summary.meanDetF1, 1)} detF1
          </Badge>
        ) : undefined
      }
      action={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            loading={isLoading}
            loadingText="Refreshing"
            icon={<RefreshIcon size={12} />}
          >
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-controls="bench-body"
            icon={collapsed ? <ChevronDownIcon size={12} /> : <ChevronUpIcon size={12} />}
          >
            {collapsed ? 'Show' : 'Hide'}
          </Button>
        </>
      }
    >
      {collapsed ? undefined : <div id="bench-body">{body}</div>}
    </Card>
  );
};

export default BenchmarkDashboard;
