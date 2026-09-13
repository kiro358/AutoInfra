'use client';

import React from 'react';
import { Badge } from '@/components/ui/Badge';
import { Column, DataTable } from '@/components/ui/DataTable';
import { formatCurrency, formatMm, formatNumber } from '@/lib/formatters';
import {
  ManholeRow,
  formatMetersAt,
  isPhysicalStructure,
  structureKind,
  structureTone,
  sumCost,
} from './rows';
import { SummaryFigure, ViewSummary } from './ViewSummary';

/**
 * Structures tab — manholes, catchbasin-manholes and inlets with their rim and
 * invert elevations.
 *
 * The estimator's structure sheet also carries non-structure line items (fees,
 * allowances). They stay in the table so the dollars reconcile with the sheet,
 * but the "structures" count excludes them — see `countStructures`.
 */

/** Physical structures only; fee/allowance rows are not structures. */
export function countStructures(rows: ManholeRow[]): number {
  return rows.filter((row) => isPhysicalStructure(row)).length;
}

export function structuresSummaryFigures(
  rows: ManholeRow[],
  totalStructuresCost: number
): SummaryFigure[] {
  return [
    {
      key: 'count',
      label: 'Structures',
      value: formatNumber(countStructures(rows), 0),
      sub: 'Manholes, CBMHs and inlets',
      tone: 'structures',
    },
    {
      key: 'cost',
      label: 'Total structures cost',
      value: formatCurrency(totalStructuresCost),
      sub: 'Materials + labour/equipment add-ons',
      tone: 'structures',
    },
  ];
}

/**
 * Depth is the rim-to-lowest-invert drop. It is preferred from the row when the
 * estimator recorded it, and only derived when both elevations are present —
 * a missing elevation must read "—", never 0.00 m.
 */
export function structureDepth(row: {
  depth?: number | null;
  topElevation?: number | null;
  lowInvert?: number | null;
}): number | null {
  if (row.depth != null) return row.depth;
  if (row.topElevation == null || row.lowInvert == null) return null;
  return row.topElevation - row.lowInvert;
}

export function structuresColumns(): Column<ManholeRow>[] {
  return [
    {
      key: 'description',
      header: 'ID',
      sortable: true,
      sortKey: 'description',
      accessor: 'description',
      className: 'font-mono',
    },
    {
      key: 'type',
      header: 'Type',
      sortable: true,
      sortKey: (row) => structureKind(row),
      render: (row) => {
        const kind = structureKind(row);
        return (
          <Badge variant={structureTone(kind)} size="sm">
            {kind === 'ITEM' ? 'Line item' : kind}
          </Badge>
        );
      },
    },
    {
      key: 'diameter',
      header: 'Size / Dia (mm)',
      sortable: true,
      sortKey: 'diameter',
      align: 'right',
      className: 'numeric',
      render: (row) => formatMm(row.diameter),
    },
    {
      key: 'topElevation',
      header: 'Rim Elev (m)',
      sortable: true,
      sortKey: 'topElevation',
      align: 'right',
      className: 'numeric',
      render: (row) => formatMetersAt(row.topElevation, 2),
    },
    {
      key: 'lowInvert',
      header: 'Invert Elev (m)',
      sortable: true,
      sortKey: 'lowInvert',
      align: 'right',
      className: 'numeric',
      render: (row) => formatMetersAt(row.lowInvert, 2),
    },
    {
      key: 'depth',
      header: 'Depth (m)',
      sortable: true,
      sortKey: (row) => structureDepth(row) ?? -Infinity,
      align: 'right',
      className: 'numeric',
      render: (row) => formatMetersAt(structureDepth(row), 2),
    },
    {
      key: 'benching',
      header: 'Benching',
      sortable: true,
      sortKey: (row) => row.benching ?? '',
      render: (row) =>
        row.benching ? row.benching : <span className="text-[var(--text-muted)]">—</span>,
    },
    {
      key: 'unitCost',
      header: 'Unit Cost ($)',
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

export interface StructuresViewProps {
  manholes: ManholeRow[];
  totalStructuresCost: number;
}

export const StructuresView: React.FC<StructuresViewProps> = ({
  manholes,
  totalStructuresCost,
}) => (
  <section className="flex flex-col gap-4" aria-label="Structures">
    <DataTable<ManholeRow>
      data={manholes}
      columns={structuresColumns()}
      countLabel="structures"
      searchPlaceholder="Search structures…"
      searchFields={['description', 'structureType', 'benching']}
      emptyMessage="No structures were found in this drawing."
      totalRow={
        manholes.length > 0 ? (
          <tr className="total-row">
            <td colSpan={8}>Total ({formatNumber(countStructures(manholes), 0)} structures)</td>
            <td className="numeric">{formatCurrency(totalStructuresCost || sumCost(manholes))}</td>
          </tr>
        ) : undefined
      }
    />
    <ViewSummary
      label="Structure totals"
      figures={structuresSummaryFigures(manholes, totalStructuresCost)}
    />
  </section>
);

export default StructuresView;
