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
 * Gemini API list prices, USD per million tokens. These price the LLM CALL, not
 * the takeoff — construction pricing lives in `costing-rules.ts` and must never
 * be duplicated here. Exported so a caller on a different model or a negotiated
 * rate can override the estimate instead of reading a wrong number.
 */
export const USD_PER_MILLION_INPUT_TOKENS = 0.3;
export const USD_PER_MILLION_OUTPUT_TOKENS = 2.5;

export type TokenRates = { inputPerMillion: number; outputPerMillion: number };

export const DEFAULT_TOKEN_RATES: TokenRates = {
  inputPerMillion: USD_PER_MILLION_INPUT_TOKENS,
  outputPerMillion: USD_PER_MILLION_OUTPUT_TOKENS,
};

/**
 * Estimated USD spend for a run. Returns null when there is no telemetry at all
 * — a blank cell is honest, "$0.00" would imply the run was free.
 */
export function estimateUsdCost(
  cost: FactsCostTelemetry | null | undefined,
  rates: TokenRates = DEFAULT_TOKEN_RATES
): number | null {
  if (!cost) return null;
  const input = cost.promptTokens ?? 0;
  const output = cost.outputTokens ?? 0;
  if (input <= 0 && output <= 0) return null;
  return (input / 1_000_000) * rates.inputPerMillion + (output / 1_000_000) * rates.outputPerMillion;
}

/** Fixed 4 decimals: a single run often lands under a cent. */
export function formatUsd(value: number | null): string {
  if (value == null || !isFinite(value)) return '—';
  return `$${value.toFixed(4)}`;
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
        ? `${formatNumber(cost.promptTokens ?? 0, 0)} in · ${formatNumber(cost.outputTokens ?? 0, 0)} out`
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
      sub: `Estimate at $${rates.inputPerMillion}/M in · $${rates.outputPerMillion}/M out`,
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
