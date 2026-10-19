'use client';

import React from 'react';
import type { ExtractionResult } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon } from '@/components/ui/Icons';
import { formatNumber, formatPercent } from '@/lib/formatters';
import type { FactsCostTelemetry } from './rows';
import { SummaryFigure, ViewSummary } from './ViewSummary';

/**
 * Telemetry tab — what the extraction run cost to produce, and the raw facts it
 * produced. This is an engineering panel: it is the fastest way to tell a bad
 * read (low confidence, warnings) from a starved read (too few tiles, one LLM
 * call) without re-running the pipeline.
 */

/**
 * Gemini list prices, USD per million tokens (Developer API list, verified
 * 2026-10-18 — model_optimisation.md §3; confirm against Vertex pricing
 * before quoting externally). These price the LLM CALL, not the takeoff —
 * construction pricing lives in `costing-rules.ts` and must never be
 * duplicated here.
 *
 * PR30: jobs are MIXED-model (each role runs a different model), so there is
 * no single honest rate card. Facts now carry per-model usage buckets
 * (cost.byModel) and each bucket is priced at ITS model's row. A model id
 * missing from this table falls back to the FALLBACK_MODEL_ID row AND is
 * flagged in the telemetry caption (unknownCostModels) — never silently
 * mispriced.
 */
export type TokenRates = { inputPerMillion: number; outputPerMillion: number };

export const MODEL_TOKEN_RATES: Record<string, TokenRates> = {
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-2.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gemini-3.1-flash-lite': { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  'gemini-3.5-flash-lite': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-3.8-flash': { inputPerMillion: 0.75, outputPerMillion: 3.75 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10 },
};

/** Unknown model ids are priced at this model's row — and flagged, not hidden. */
export const FALLBACK_MODEL_ID = 'gemini-2.5-flash';

/** The fallback rate card: prices legacy facts that carry no per-model buckets. */
export const DEFAULT_TOKEN_RATES: TokenRates = MODEL_TOKEN_RATES[FALLBACK_MODEL_ID];

/** Rate card for one model id; unknown ids get the fallback row. */
export function ratesForModel(model: string): TokenRates {
  return MODEL_TOKEN_RATES[model] ?? DEFAULT_TOKEN_RATES;
}

/** Model ids in a run's per-model buckets that have no price-table row. */
export function unknownCostModels(cost: FactsCostTelemetry | null | undefined): string[] {
  if (!cost?.byModel) return [];
  return Object.keys(cost.byModel).filter((m) => !(m in MODEL_TOKEN_RATES));
}

function priceTokens(prompt: number, output: number, thoughts: number, rates: TokenRates): number {
  // Thoughts are billed at the OUTPUT rate (they are generated tokens).
  return (prompt / 1_000_000) * rates.inputPerMillion
    + ((output + thoughts) / 1_000_000) * rates.outputPerMillion;
}

/**
 * Estimated USD spend for a run. Returns null when there is no telemetry at all
 * — a blank cell is honest, "$0.00" would imply the run was free.
 *
 * With per-model buckets (PR30 facts) each bucket is priced at its own model's
 * row and the `rates` override does not apply — a single override cannot
 * describe a mixed-model job. Legacy facts without buckets price their
 * aggregate at `rates` (default: the fallback row).
 */
export function estimateUsdCost(
  cost: FactsCostTelemetry | null | undefined,
  rates: TokenRates = DEFAULT_TOKEN_RATES
): number | null {
  if (!cost) return null;
  const input = cost.promptTokens ?? 0;
  const output = cost.outputTokens ?? 0;
  const thoughts = cost.thoughtsTokens ?? 0;
  if (input <= 0 && output <= 0 && thoughts <= 0) return null;
  const buckets = cost.byModel ? Object.values(cost.byModel) : [];
  if (buckets.length > 0) {
    return buckets.reduce(
      (sum, b) => sum + priceTokens(b.promptTokens ?? 0, b.outputTokens ?? 0, b.thoughtsTokens ?? 0, ratesForModel(b.model)),
      0
    );
  }
  return priceTokens(input, output, thoughts, rates);
}

/** Fixed 4 decimals: a single run often lands under a cent. */
export function formatUsd(value: number | null): string {
  if (value == null || !isFinite(value)) return '—';
  return `$${value.toFixed(4)}`;
}

/**
 * The pricing caption under the USD figure. Mixed-model jobs name every model
 * actually used with its own rates; a model missing from the price table is
 * flagged with ⚠ and its fallback stated — a wrong-but-quiet caption is how
 * the old single-rate telemetry underpriced jobs. Legacy facts (no buckets)
 * keep the single-rate caption.
 */
export function costCaption(
  cost: FactsCostTelemetry | null | undefined,
  rates: TokenRates = DEFAULT_TOKEN_RATES
): string {
  const buckets = cost?.byModel ? Object.values(cost.byModel) : [];
  if (buckets.length === 0) {
    return `Estimate at $${rates.inputPerMillion}/M in · $${rates.outputPerMillion}/M out`;
  }
  const unknown = new Set(unknownCostModels(cost));
  const parts = buckets.map((b) => {
    const r = ratesForModel(b.model);
    return unknown.has(b.model)
      ? `⚠ ${b.model} not in price table — priced as ${FALLBACK_MODEL_ID} ($${r.inputPerMillion}/M in · $${r.outputPerMillion}/M out)`
      : `${b.model} $${r.inputPerMillion}/M in · $${r.outputPerMillion}/M out`;
  });
  return `Estimate: ${parts.join(' · ')}`;
}

export function telemetryFigures(
  cost: FactsCostTelemetry | null | undefined,
  rates: TokenRates = DEFAULT_TOKEN_RATES
): SummaryFigure[] {
  return [
    {
      key: 'llmCalls',
      label: 'LLM calls',
      value: cost ? formatNumber(cost.llmCalls ?? 0, 0) : '—',
      sub: 'Model round-trips for this drawing',
    },
    {
      key: 'tokens',
      label: 'Total tokens',
      value: cost ? formatNumber(cost.totalTokens ?? 0, 0) : '—',
      sub: cost
        ? `${formatNumber(cost.promptTokens ?? 0, 0)} in · ${formatNumber(cost.outputTokens ?? 0, 0)} out${(cost.thoughtsTokens ?? 0) > 0 ? ` · ${formatNumber(cost.thoughtsTokens ?? 0, 0)} thinking` : ''}`
        : 'No token telemetry recorded',
    },
    {
      key: 'tiles',
      label: 'Tile budget',
      value: cost ? formatNumber(cost.tiles ?? 0, 0) : '—',
      sub: 'Page crops rasterised and sent',
    },
    {
      key: 'dpi',
      label: 'Raster DPI',
      value: cost ? formatNumber(cost.dpi ?? 0, 0) : '—',
      sub: 'Resolution each tile was rendered at',
    },
    {
      key: 'usd',
      label: 'Est. API cost',
      value: formatUsd(estimateUsdCost(cost, rates)),
      sub: costCaption(cost, rates),
    },
  ];
}

// ============ JSON syntax highlighting ============

export type JsonTokenType = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct';
export type JsonToken = { type: JsonTokenType; text: string };

/**
 * Tokenise pretty-printed JSON for highlighting.
 *
 * Returns tokens rather than an HTML string on purpose: the facts blob is model
 * output, and building markup from it would mean `dangerouslySetInnerHTML` over
 * untrusted text. React escapes each token when it renders.
 */
const JSON_TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g;

export function highlightJson(json: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const re = new RegExp(JSON_TOKEN_RE.source, 'g');
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(json)) !== null) {
    if (match.index > last) {
      tokens.push({ type: 'punct', text: json.slice(last, match.index) });
    }
    if (match[1] !== undefined) {
      // A quoted run followed by ':' is a key; otherwise it is a string value.
      if (match[2] !== undefined) {
        tokens.push({ type: 'key', text: match[1] });
        tokens.push({ type: 'punct', text: match[2] });
      } else {
        tokens.push({ type: 'string', text: match[1] });
      }
    } else if (match[3] !== undefined) {
      tokens.push({ type: 'number', text: match[3] });
    } else if (match[4] !== undefined) {
      tokens.push({ type: 'boolean', text: match[4] });
    } else if (match[5] !== undefined) {
      tokens.push({ type: 'null', text: match[5] });
    }
    last = re.lastIndex;
  }

  if (last < json.length) tokens.push({ type: 'punct', text: json.slice(last) });
  return tokens;
}

const TOKEN_COLOR: Record<JsonTokenType, string> = {
  key: 'var(--water)',
  string: 'var(--success)',
  number: 'var(--storm)',
  boolean: 'var(--sanitary)',
  null: 'var(--text-muted)',
  punct: 'var(--text-secondary)',
};

/** Stable 2-space indentation so diffing two runs by eye is possible. */
export function serializeFacts(extraction: ExtractionResult): string {
  return JSON.stringify(extraction, null, 2);
}

// ============ Component ============

export interface TelemetryViewProps {
  extraction: ExtractionResult;
  factsCost?: FactsCostTelemetry;
  /** Override the token rates used for the USD estimate. */
  rates?: TokenRates;
  /** Start with the raw JSON collapsed. Defaults to collapsed. */
  defaultJsonOpen?: boolean;
}

export const TelemetryView: React.FC<TelemetryViewProps> = ({
  extraction,
  factsCost,
  rates = DEFAULT_TOKEN_RATES,
  defaultJsonOpen = false,
}) => {
  const [jsonOpen, setJsonOpen] = React.useState(defaultJsonOpen);
  const [copied, setCopied] = React.useState(false);

  const json = React.useMemo(() => serializeFacts(extraction), [extraction]);
  const tokens = React.useMemo(() => (jsonOpen ? highlightJson(json) : []), [json, jsonOpen]);

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard is unavailable (insecure origin, denied permission). Leave the
      // button in its default state rather than claiming a copy that never
      // happened — the JSON is on screen and selectable.
      setCopied(false);
    }
  }, [json]);

  const warnings = extraction.warnings ?? [];

  return (
    <section className="flex flex-col gap-6" aria-label="Extraction telemetry">
      <ViewSummary label="Extraction runtime" figures={telemetryFigures(factsCost, rates)} />

      <Card title="Run Quality" subtitle="How much of this drawing the model was sure about">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={extraction.confidence >= 0.7 ? 'success' : 'warning'} size="md">
            {formatPercent(extraction.confidence, 1)} confidence
          </Badge>
          <Badge variant="muted" size="md">
            {extraction.templateType} template
          </Badge>
          <Badge variant={warnings.length > 0 ? 'alarm' : 'success'} size="md">
            {formatNumber(warnings.length, 0)} warnings
          </Badge>
        </div>
        {warnings.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
            {warnings.map((warning, i) => (
              <li key={`${i}-${warning}`}>• {warning}</li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Raw Extraction Facts"
        subtitle="The takeoff exactly as the pipeline produced it"
        action={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              icon={copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
            >
              {copied ? 'Copied' : 'Copy JSON'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setJsonOpen((open) => !open)}
              aria-expanded={jsonOpen}
              aria-controls="telemetry-json"
              icon={jsonOpen ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
            >
              {jsonOpen ? 'Hide' : 'Show'}
            </Button>
          </>
        }
      >
        {jsonOpen ? (
          <pre
            id="telemetry-json"
            className="font-mono overflow-auto"
            style={{
              maxHeight: 520,
              fontSize: 11,
              lineHeight: 1.6,
              margin: 0,
              padding: 12,
              borderRadius: 'var(--radius-sm, 6px)',
              background: 'var(--bg-inset, rgba(0,0,0,0.18))',
            }}
          >
            <code>
              {tokens.map((token, i) => (
                <span key={i} style={{ color: TOKEN_COLOR[token.type] }}>
                  {token.text}
                </span>
              ))}
            </code>
          </pre>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">
            {formatNumber(json.length, 0)} characters of JSON — expand to inspect, or copy it
            straight to the clipboard.
          </p>
        )}
      </Card>
    </section>
  );
};

export default TelemetryView;
