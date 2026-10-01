'use client';

import React from 'react';
import type { CatchbasinSummary, ExtractionResult } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Column, DataTable } from '@/components/ui/DataTable';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/formatters';
import { addOnCost, sewerTrade, shareOfTotal, specialGroupCost, valveGroupCost } from './rows';

/**
 * Cost ledger — where the money is, by trade, and every line that produced it.
 *
 * IMPORTANT: this view only *displays* dollars that `priceTakeoff()` already put
 * on the `ExtractionResult`. It must never introduce a rate, markup or fee of
 * its own — pricing lives in `costing-rules.ts` (CLAUDE.md). Everything below is
 * addition over fields that are already priced.
 */

export type TradeKey = 'storm' | 'sanitary' | 'structures' | 'watermain' | 'appurtenances';

export type TradeTotal = {
  key: TradeKey;
  label: string;
  cost: number;
  itemCount: number;
  tone: 'storm' | 'sanitary' | 'structures' | 'water' | 'muted';
};

export type LedgerLine = {
  id: string;
  trade: TradeKey;
  tradeLabel: string;
  description: string;
  quantity: number | null;
  unit: string;
  cost: number;
};

const TRADE_LABEL: Record<TradeKey, string> = {
  storm: 'Storm',
  sanitary: 'Sanitary',
  structures: 'Structures',
  watermain: 'Watermain',
  appurtenances: 'Appurtenances',
};

const TRADE_TONE: Record<TradeKey, TradeTotal['tone']> = {
  storm: 'storm',
  sanitary: 'sanitary',
  structures: 'structures',
  watermain: 'water',
  appurtenances: 'muted',
};

export const TRADE_ORDER: TradeKey[] = [
  'storm',
  'sanitary',
  'structures',
  'watermain',
  'appurtenances',
];

const CB_LABEL: Record<string, string> = {
  SINGLE_CB: 'Single catchbasin',
  DOUBLE_CB: 'Double catchbasin',
  DITCH_INLET_CB: 'Ditch inlet catchbasin',
  DOUBLE_DITCH_INLET_CB: 'Double ditch inlet catchbasin',
};

/** Per-unit labour rate the estimator set for each catchbasin family. */
export function catchbasinLaborRate(
  type: string,
  rates: CatchbasinSummary['laborRates'] | undefined
): number {
  if (!rates) return 0;
  switch (type) {
    case 'SINGLE_CB':
      return rates.scbLabor ?? 0;
    case 'DOUBLE_CB':
      return rates.dcbLabor ?? 0;
    case 'DITCH_INLET_CB':
      return rates.dicbFC ?? 0;
    case 'DOUBLE_DITCH_INLET_CB':
      return rates.ddicbFC ?? 0;
    default:
      return 0;
  }
}

/**
 * Flatten a priced takeoff into ledger lines.
 *
 * Sewer runs split storm vs sanitary by label. A run whose label says neither
 * falls to STORM, because on an Ontario servicing plan the unqualified network
 * is the storm system — sanitary is always called out explicitly.
 */
export function buildLedgerLines(extraction: ExtractionResult): LedgerLine[] {
  const lines: LedgerLine[] = [];

  for (const run of extraction.sewers ?? []) {
    const trade: TradeKey = sewerTrade(run.runLabel);
    lines.push({
      id: `sewer-${run.item}-${run.runLabel}`,
      trade,
      tradeLabel: TRADE_LABEL[trade],
      description: run.isLineItem
        ? `${run.runLabel}${run.lineItemType ? ` (${run.lineItemType})` : ''}`
        : run.runLabel,
      quantity: run.isLineItem ? null : run.length,
      unit: run.isLineItem ? '' : 'm',
      cost: addOnCost(run),
    });
  }

  for (const mh of extraction.manholes ?? []) {
    lines.push({
      id: `structure-${mh.item}-${mh.description}`,
      trade: 'structures',
      tradeLabel: TRADE_LABEL.structures,
      description: mh.description,
      quantity: 1,
      unit: 'ea',
      cost: addOnCost(mh),
    });
  }

  const cbRates = extraction.catchbasins?.laborRates;
  for (const group of extraction.catchbasins?.groups ?? []) {
    const each = (group.grateEach ?? 0) + catchbasinLaborRate(group.type, cbRates);
    lines.push({
      id: `catchbasin-${group.type}`,
      trade: 'structures',
      tradeLabel: TRADE_LABEL.structures,
      description: CB_LABEL[group.type] ?? group.type,
      quantity: group.quantity ?? 0,
      unit: 'ea',
      cost: (group.quantity ?? 0) * each + (group.addMaterials ?? 0),
    });
  }

  for (const run of extraction.watermain ?? []) {
    lines.push({
      id: `watermain-${run.item}-${run.sizeAndType}`,
      trade: 'watermain',
      tradeLabel: TRADE_LABEL.watermain,
      description: run.sizeAndType,
      quantity: run.length ?? null,
      unit: 'm',
      cost: addOnCost(run),
    });
  }

  for (const valve of extraction.watermainValves ?? []) {
    lines.push({
      id: `valve-${valve.item}-${valve.valveSize}`,
      trade: 'appurtenances',
      tradeLabel: TRADE_LABEL.appurtenances,
      description: `${valve.valveSize} valve`,
      quantity: valve.quantity ?? 0,
      unit: 'ea',
      cost: valveGroupCost(valve),
    });
  }

  for (const special of extraction.watermainSpecials ?? []) {
    lines.push({
      id: `special-${special.item}-${special.specialName}`,
      trade: 'appurtenances',
      tradeLabel: TRADE_LABEL.appurtenances,
      description: special.specialName,
      quantity: special.quantity ?? 0,
      unit: 'ea',
      cost: specialGroupCost(special),
    });
  }

  return lines;
}

/** Trade roll-up in a fixed order, so the cards never reshuffle between runs. */
export function tradeTotals(lines: LedgerLine[]): TradeTotal[] {
  return TRADE_ORDER.map((key) => {
    const owned = lines.filter((line) => line.trade === key);
    return {
      key,
      label: TRADE_LABEL[key],
      cost: owned.reduce((acc, line) => acc + line.cost, 0),
      itemCount: owned.length,
      tone: TRADE_TONE[key],
    };
  });
}

export function grandTotal(lines: LedgerLine[]): number {
  return lines.reduce((acc, line) => acc + line.cost, 0);
}

export interface TakeoffHeadline {
  /** Same figure as the ledger's grand total — the two must never disagree. */
  totalCost: number;
  /** Maintenance holes plus every catchbasin unit. */
  structureCount: number;
  /** Valve and special (hydrant, fitting…) units, not table rows. */
  appurtenanceCount: number;
}

/**
 * Figures for the results header tiles. Derived from `buildLedgerLines` so the
 * "Total estimate" tile always equals the Cost Ledger grand total — summing the
 * per-tab totals instead silently dropped catchbasins.
 */
export function takeoffHeadline(extraction: ExtractionResult): TakeoffHeadline {
  const catchbasinUnits = (extraction.catchbasins?.groups ?? []).reduce(
    (acc, group) => acc + (group.quantity ?? 0),
    0
  );
  const units = (items: ReadonlyArray<{ quantity?: number | null }> | null | undefined) =>
    (items ?? []).reduce((acc, item) => acc + (item.quantity ?? 0), 0);

  return {
    totalCost: grandTotal(buildLedgerLines(extraction)),
    structureCount: (extraction.manholes ?? []).length + catchbasinUnits,
    appurtenanceCount: units(extraction.watermainValves) + units(extraction.watermainSpecials),
  };
}

export function ledgerColumns(): Column<LedgerLine>[] {
  return [
    {
      key: 'trade',
      header: 'Trade',
      sortable: true,
      sortKey: 'tradeLabel',
      render: (line) => (
        <Badge variant={TRADE_TONE[line.trade]} size="sm">
          {line.tradeLabel}
        </Badge>
      ),
    },
    {
      key: 'description',
      header: 'Item',
      sortable: true,
      sortKey: 'description',
      accessor: 'description',
      className: 'font-mono',
    },
    {
      key: 'quantity',
      header: 'Qty',
      sortable: true,
      sortKey: (line) => line.quantity ?? -Infinity,
      align: 'right',
      className: 'numeric',
      render: (line) =>
        line.quantity == null ? (
          <span className="text-[var(--text-muted)]">—</span>
        ) : (
          `${formatNumber(line.quantity, line.unit === 'm' ? 1 : 0)}${line.unit ? ` ${line.unit}` : ''}`
        ),
    },
    {
      key: 'cost',
      header: 'Cost ($)',
      sortable: true,
      sortKey: 'cost',
      align: 'right',
      className: 'numeric',
      render: (line) => formatCurrency(line.cost),
    },
  ];
}

export interface CostLedgerViewProps {
  extraction: ExtractionResult;
}

export const CostLedgerView: React.FC<CostLedgerViewProps> = ({ extraction }) => {
  const lines = React.useMemo(() => buildLedgerLines(extraction), [extraction]);
  const totals = React.useMemo(() => tradeTotals(lines), [lines]);
  const total = React.useMemo(() => grandTotal(lines), [lines]);

  return (
    <section className="flex flex-col gap-6" aria-label="Cost ledger">
      <div className="studio-kpi-grid">
        {totals.map((trade) => {
          const share = shareOfTotal(trade.cost, total);
          return (
            <div
              key={trade.key}
              className={`kpi-card ${trade.tone === 'muted' ? '' : `is-${trade.tone}`}`.trim()}
            >
              <div className="kpi-label">{trade.label}</div>
              <div className="kpi-value font-mono">{formatCurrency(trade.cost)}</div>
              <div
                className="ledger-bar"
                style={{ width: `${(share * 100).toFixed(1)}%`, minWidth: share > 0 ? 4 : 0 }}
                role="presentation"
              />
              <div className="kpi-sub">
                {formatPercent(share, 1)} of total · {formatNumber(trade.itemCount, 0)} items
              </div>
            </div>
          );
        })}
      </div>

      <Card
        title="Master Ledger"
        subtitle="Every priced line behind the trade totals"
        headerBadge={
          <Badge variant="success" size="sm">
            {formatCurrency(total)}
          </Badge>
        }
        noPadding
      >
        <DataTable<LedgerLine>
          data={lines}
          columns={ledgerColumns()}
          countLabel="line items"
          searchPlaceholder="Search ledger…"
          searchFields={['description', 'tradeLabel']}
          emptyMessage="Nothing priced yet — no line items in this takeoff."
          totalRow={
            <>
              {totals
                .filter((trade) => trade.itemCount > 0)
                .map((trade) => (
                  <tr key={trade.key}>
                    <td colSpan={3}>{trade.label} subtotal</td>
                    <td className="numeric">{formatCurrency(trade.cost)}</td>
                  </tr>
                ))}
              <tr className="total-row">
                <td colSpan={3}>Grand total</td>
                <td className="numeric">{formatCurrency(total)}</td>
              </tr>
            </>
          }
        />
      </Card>
    </section>
  );
};

export default CostLedgerView;
