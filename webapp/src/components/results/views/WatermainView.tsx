'use client';

import React from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Column, DataTable } from '@/components/ui/DataTable';
import { formatCurrency, formatMm, formatNumber } from '@/lib/formatters';
import {
  WatermainPipeRow,
  WatermainValveRow,
  formatMetersAt,
  sumCost,
  sumLength,
  sumQuantity,
  valveGroupCost,
  watermainMaterial,
} from './rows';
import { SummaryFigure, ViewSummary } from './ViewSummary';

/**
 * Watermain tab — two tables, because watermain is priced on two different
 * bases and merging them would be wrong: pipe is linear (per metre) and
 * appurtenances are per-unit (valve + box + anode + labour, times quantity).
 */

/** Per-unit cost of a valve group; the table shows both this and the extension. */
export function valveUnitCost(row: {
  valveCost?: number | null;
  boxCost?: number | null;
  anodeCost?: number | null;
  laborPerValve?: number | null;
}): number {
  return (
    (row.valveCost ?? 0) + (row.boxCost ?? 0) + (row.anodeCost ?? 0) + (row.laborPerValve ?? 0)
  );
}

export function watermainSummaryFigures(
  pipes: WatermainPipeRow[],
  valves: WatermainValveRow[],
  totalWatermainCost: number,
  totalWatermainLength: number
): SummaryFigure[] {
  return [
    {
      key: 'length',
      label: 'Pipe linear metres',
      value: formatMetersAt(totalWatermainLength, 1),
      sub: `${formatNumber(pipes.length, 0)} pipe runs`,
      tone: 'water',
    },
    {
      key: 'valves',
      label: 'Valves & appurtenances',
      value: formatNumber(sumQuantity(valves), 0),
      sub: `${formatNumber(valves.length, 0)} groups`,
      tone: 'water',
    },
    {
      key: 'cost',
      label: 'Total watermain cost',
      value: formatCurrency(totalWatermainCost),
      sub: 'Pipe plus appurtenances',
      tone: 'water',
    },
  ];
}

export function watermainPipeColumns(): Column<WatermainPipeRow>[] {
  return [
    {
      key: 'sizeAndType',
      header: 'Size & Type',
      sortable: true,
      sortKey: 'sizeAndType',
      accessor: 'sizeAndType',
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
      sortKey: (row) => row.material ?? watermainMaterial(row.sizeAndType) ?? '',
      render: (row) => {
        const material = row.material ?? watermainMaterial(row.sizeAndType);
        if (!material) return <span className="text-[var(--text-muted)]">—</span>;
        return (
          <Badge variant="water" size="sm">
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
      key: 'avgCover',
      header: 'Avg Cover (m)',
      sortable: true,
      sortKey: 'avgCover',
      align: 'right',
      className: 'numeric',
      render: (row) => formatMetersAt(row.avgCover, 2),
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

export function watermainValveColumns(): Column<WatermainValveRow>[] {
  return [
    {
      key: 'itemName',
      header: 'Item',
      sortable: true,
      sortKey: (row) => row.itemName ?? row.valveSize,
      render: (row) => row.itemName || row.valveSize || '—',
      className: 'font-mono',
    },
    {
      key: 'valveSize',
      header: 'Valve Size',
      sortable: true,
      sortKey: 'valveSize',
      accessor: 'valveSize',
      className: 'font-mono',
    },
    {
      key: 'quantity',
      header: 'Qty',
      sortable: true,
      sortKey: 'quantity',
      align: 'right',
      className: 'numeric',
      render: (row) => formatNumber(row.quantity, 0),
    },
    {
      key: 'valveCost',
      header: 'Valve Cost ($)',
      sortable: true,
      sortKey: 'valveCost',
      align: 'right',
      className: 'numeric',
      render: (row) => formatCurrency(row.valveCost),
    },
    {
      key: 'boxCost',
      header: 'Box Cost ($)',
      sortable: true,
      sortKey: 'boxCost',
      align: 'right',
      className: 'numeric',
      render: (row) => formatCurrency(row.boxCost),
    },
    {
      key: 'anodeCost',
      header: 'Anode Cost ($)',
      sortable: true,
      sortKey: 'anodeCost',
      align: 'right',
      className: 'numeric',
      render: (row) => formatCurrency(row.anodeCost),
    },
    {
      key: 'laborPerValve',
      header: 'Labour / Valve ($)',
      sortable: true,
      sortKey: 'laborPerValve',
      align: 'right',
      className: 'numeric',
      render: (row) => formatCurrency(row.laborPerValve),
    },
    {
      key: 'totalCost',
      header: 'Total Cost ($)',
      sortable: true,
      sortKey: (row) => row.totalCost ?? valveGroupCost(row),
      align: 'right',
      className: 'numeric',
      render: (row) => formatCurrency(row.totalCost ?? valveGroupCost(row)),
    },
  ];
}

export interface WatermainViewProps {
  watermainPipes: WatermainPipeRow[];
  watermainValves: WatermainValveRow[];
  totalWatermainCost: number;
  totalWatermainLength: number;
}

export const WatermainView: React.FC<WatermainViewProps> = ({
  watermainPipes,
  watermainValves,
  totalWatermainCost,
  totalWatermainLength,
}) => {
  const valveTotal = watermainValves.reduce(
    (acc, row) => acc + (row.totalCost ?? valveGroupCost(row)),
    0
  );

  return (
    <section className="flex flex-col gap-6" aria-label="Watermain">
      <Card
        title="Watermain Pipe Runs"
        subtitle="Linear pipe priced per metre"
        headerBadge={
          <Badge variant="water" size="sm">
            {formatMetersAt(totalWatermainLength || sumLength(watermainPipes), 1)}
          </Badge>
        }
        noPadding
      >
        <DataTable<WatermainPipeRow>
          data={watermainPipes}
          columns={watermainPipeColumns()}
          countLabel="pipe runs"
          searchPlaceholder="Search pipe runs…"
          searchFields={['sizeAndType', 'material']}
          emptyMessage="No watermain pipe runs were found in this drawing."
          totalRow={
            watermainPipes.length > 0 ? (
              <tr className="total-row">
                <td colSpan={3}>Total</td>
                <td className="numeric">
                  {formatMetersAt(totalWatermainLength || sumLength(watermainPipes), 1)}
                </td>
                <td className="numeric">—</td>
                <td className="numeric">—</td>
                <td className="numeric">{formatCurrency(sumCost(watermainPipes))}</td>
              </tr>
            ) : undefined
          }
        />
      </Card>

      <Card
        title="Valves, Hydrants & Fittings"
        subtitle="Appurtenances priced per unit"
        headerBadge={
          <Badge variant="water" size="sm">
            {formatNumber(sumQuantity(watermainValves), 0)} units
          </Badge>
        }
        noPadding
      >
        <DataTable<WatermainValveRow>
          data={watermainValves}
          columns={watermainValveColumns()}
          countLabel="valve groups"
          searchPlaceholder="Search valves and fittings…"
          searchFields={['itemName', 'valveSize']}
          emptyMessage="No valves, hydrants or fittings were found in this drawing."
          totalRow={
            watermainValves.length > 0 ? (
              <tr className="total-row">
                <td colSpan={2}>Total</td>
                <td className="numeric">{formatNumber(sumQuantity(watermainValves), 0)}</td>
                <td className="numeric">—</td>
                <td className="numeric">—</td>
                <td className="numeric">—</td>
                <td className="numeric">—</td>
                <td className="numeric">{formatCurrency(valveTotal)}</td>
              </tr>
            ) : undefined
          }
        />
      </Card>

      <ViewSummary
        label="Watermain totals"
        figures={watermainSummaryFigures(
          watermainPipes,
          watermainValves,
          totalWatermainCost,
          totalWatermainLength
        )}
      />
    </section>
  );
};

export default WatermainView;
