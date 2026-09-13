'use client';

import React from 'react';
import { Badge } from '@/components/ui/Badge';
import { Column, DataTable } from '@/components/ui/DataTable';
import { formatCurrency, formatMm, formatNumber } from '@/lib/formatters';
import {
  SewerRunRow,
  formatMetersAt,
  formatSlopePct,
  materialLabel,
  splitRunLabel,
  sumCost,
  sumLength,
} from './rows';
import { SummaryFigure, ViewSummary } from './ViewSummary';

/**
 * Storm and sanitary sewers are the SAME takeoff geometry priced off different
 * rate tables, so both tabs render this one table and differ only in accent and
 * copy. Keeping a single column definition means a change to, say, how slope is
 * displayed can't land on one tab and miss the other.
 */

export type SewerAccent = 'storm' | 'sanitary';

/** Roll-up used by the footer cards and the table's total row. */
export function sewerTotals(rows: SewerRunRow[]): {
  runCount: number;
  totalLength: number;
  totalCost: number;
} {
  const physical = rows.filter((row) => !row.isLineItem);
  return {
    runCount: physical.length,
    totalLength: sumLength(physical),
    totalCost: sumCost(rows),
  };
}

/**
 * Footer cards. `totalCost` / `totalLength` come in as props rather than being
 * recomputed, because the caller may hold the authoritative priced totals; the
 * row-derived numbers are only the fallback when it doesn't.
 */
export function sewerSummaryFigures(
  accent: SewerAccent,
  rows: SewerRunRow[],
  totalCost: number,
  totalLength: number
): SummaryFigure[] {
  const label = accent === 'storm' ? 'Storm' : 'Sanitary';
  const { runCount } = sewerTotals(rows);
  return [
    {
      key: 'runs',
      label: `${label} runs`,
      value: formatNumber(runCount, 0),
      sub: 'Pipe segments between structures',
      tone: accent,
    },
    {
      key: 'length',
      label: 'Total linear metres',
      value: formatMetersAt(totalLength, 1),
      sub: 'Sum of run lengths',
      tone: accent,
    },
    {
      key: 'cost',
      label: `Total ${label.toLowerCase()} cost`,
      value: formatCurrency(totalCost),
      sub: 'Materials + labour/equipment add-ons',
      tone: accent,
    },
  ];
}

/** Non-physical rows (LAYOUT, VIDEO, AS BUILT) get a tag instead of a from/to. */
function endLabel(row: SewerRunRow, end: 'from' | 'to'): React.ReactNode {
  if (row.isLineItem) {
    return end === 'from' ? (
      <Badge variant="muted" size="sm">
        {row.lineItemType || 'Line item'}
      </Badge>
    ) : (
      <span className="text-[var(--text-muted)]">—</span>
    );
  }
  const explicit = end === 'from' ? row.fromStructure : row.toStructure;
  if (explicit !== undefined && explicit !== null) return explicit || '—';
  const parsed = splitRunLabel(row.runLabel);
  return (end === 'from' ? parsed.from : parsed.to) || '—';
}

export function sewerColumns(accent: SewerAccent): Column<SewerRunRow>[] {
  return [
    {
      key: 'runLabel',
      header: 'Run ID',
      sortable: true,
      sortKey: 'runLabel',
      accessor: 'runLabel',
      className: 'font-mono',
    },
    {
      key: 'from',
      header: 'From MH',
      sortable: true,
      sortKey: (row) => row.fromStructure ?? splitRunLabel(row.runLabel).from ?? '',
      render: (row) => endLabel(row, 'from'),
      className: 'font-mono',
    },
    {
      key: 'to',
      header: 'To MH',
      sortable: true,
      sortKey: (row) => row.toStructure ?? splitRunLabel(row.runLabel).to ?? '',
      render: (row) => endLabel(row, 'to'),
      className: 'font-mono',
    },
    {
      key: 'pipeDiameter',
      header: 'Size (mm)',
      sortable: true,
      sortKey: 'pipeDiameter',
      align: 'right',
      className: 'numeric',
      render: (row) => formatMm(row.pipeDiameter),
    },
    {
      key: 'material',
      header: 'Material',
      sortable: true,
      sortKey: (row) => materialLabel(row.material, row.typeClass) ?? '',
      render: (row) => {
        const material = materialLabel(row.material, row.typeClass);
        if (!material) return <span className="text-[var(--text-muted)]">—</span>;
        return (
          <Badge variant={accent} size="sm">
            {material}
          </Badge>
        );
      },
    },
    {
      key: 'length',
      header: 'Length (m)',
      sortable: true,
      sortKey: 'length',
      align: 'right',
      className: 'numeric',
      render: (row) => formatMetersAt(row.length, 1),
    },
    {
      key: 'slope',
      header: 'Slope (%)',
      sortable: true,
      sortKey: 'slope',
      align: 'right',
      className: 'numeric',
      render: (row) => formatSlopePct(row.slope),
    },
    {
      key: 'depth',
      header: 'Avg Depth (m)',
      sortable: true,
      sortKey: 'depth',
      align: 'right',
      className: 'numeric',
      render: (row) => formatMetersAt(row.depth, 2),
    },
    {
      key: 'unitCost',
      header: 'Unit Cost ($/m)',
      sortable: true,
      sortKey: 'unitCost',
      align: 'right',
      className: 'numeric',
      render: (row) =>
        row.unitCost == null ? (
          <span className="text-[var(--text-muted)]">—</span>
        ) : (
          formatCurrency(row.unitCost)
        ),
    },
    {
      key: 'totalCost',
      header: 'Total Cost ($)',
      sortable: true,
      sortKey: 'totalCost',
      align: 'right',
      className: 'numeric',
      render: (row) => formatCurrency(row.totalCost ?? 0),
    },
  ];
}

export interface SewerRunTableProps {
  accent: SewerAccent;
  rows: SewerRunRow[];
  totalCost: number;
  totalLength: number;
  emptyMessage?: string;
}

export const SewerRunTable: React.FC<SewerRunTableProps> = ({
  accent,
  rows,
  totalCost,
  totalLength,
  emptyMessage,
}) => {
  const label = accent === 'storm' ? 'Storm' : 'Sanitary';
  const columns = sewerColumns(accent);

  return (
    <section className="flex flex-col gap-4" aria-label={`${label} sewer runs`}>
      <DataTable<SewerRunRow>
        data={rows}
        columns={columns}
        countLabel={`${label.toLowerCase()} runs`}
        searchPlaceholder={`Search ${label.toLowerCase()} runs…`}
        searchFields={['runLabel', 'material', 'lineItemType']}
        emptyMessage={emptyMessage ?? `No ${label.toLowerCase()} runs were found in this drawing.`}
        totalRow={
          rows.length > 0 ? (
            <tr className="total-row">
              <td colSpan={5}>Total</td>
              <td className="numeric">{formatMetersAt(totalLength, 1)}</td>
              <td className="numeric">—</td>
              <td className="numeric">—</td>
              <td className="numeric">—</td>
              <td className="numeric">{formatCurrency(totalCost)}</td>
            </tr>
          ) : undefined
        }
      />
      <ViewSummary
        label={`${label} sewer totals`}
        figures={sewerSummaryFigures(accent, rows, totalCost, totalLength)}
      />
    </section>
  );
};

export default SewerRunTable;
