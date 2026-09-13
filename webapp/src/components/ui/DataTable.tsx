'use client';

import React, { useState, useMemo } from 'react';
import { sortData, filterData, SortDirection } from '../../lib/table-sort';
import { SearchIcon, ArrowUpIcon, ArrowDownIcon, CloseIcon } from './Icons';

export interface Column<T> {
  header: string | React.ReactNode;
  key?: string;
  accessor?: keyof T | ((item: T) => any);
  render?: (item: T, index: number) => React.ReactNode;
  sortable?: boolean;
  sortKey?: keyof T | ((item: T) => any);
  align?: 'left' | 'center' | 'right';
  className?: string;
  headerClassName?: string;
  width?: string | number;
}

export interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  searchable?: boolean;
  searchPlaceholder?: string;
  searchFields?: (keyof T | ((item: T) => any))[];
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  defaultSortField?: keyof T | ((item: T) => any);
  defaultSortDirection?: SortDirection;
  sortField?: keyof T | ((item: T) => any);
  sortDirection?: SortDirection;
  onSortChange?: (field: keyof T | ((item: T) => any), direction: SortDirection) => void;
  onRowClick?: (item: T, index: number) => void;
  rowClassName?: string | ((item: T, index: number) => string);
  emptyMessage?: string | React.ReactNode;
  totalRow?: React.ReactNode;
  footer?: React.ReactNode;
  toolbarActions?: React.ReactNode;
  countLabel?: string;
  className?: string;
  tableClassName?: string;
  containerClassName?: string;
}

export function DataTable<T extends Record<string, any>>({
  data = [],
  columns = [],
  searchable = true,
  searchPlaceholder = 'Search items...',
  searchFields,
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
  defaultSortField,
  defaultSortDirection = 'asc',
  sortField: controlledSortField,
  sortDirection: controlledSortDirection,
  onSortChange,
  onRowClick,
  rowClassName,
  emptyMessage = 'No matching records found',
  totalRow,
  footer,
  toolbarActions,
  countLabel = 'items',
  className = '',
  tableClassName = '',
  containerClassName = '',
}: DataTableProps<T>) {
  const [internalSearchQuery, setInternalSearchQuery] = useState('');
  const [internalSortField, setInternalSortField] = useState<keyof T | ((item: T) => any) | undefined>(
    defaultSortField
  );
  const [internalSortDirection, setInternalSortDirection] = useState<SortDirection>(defaultSortDirection);

  const query = controlledSearchQuery !== undefined ? controlledSearchQuery : internalSearchQuery;
  const currentSortField = controlledSortField !== undefined ? controlledSortField : internalSortField;
  const currentSortDirection = controlledSortDirection !== undefined ? controlledSortDirection : internalSortDirection;

  const handleSearchChange = (val: string) => {
    if (onSearchQueryChange) {
      onSearchQueryChange(val);
    } else {
      setInternalSearchQuery(val);
    }
  };

  const handleSort = (column: Column<T>) => {
    if (!column.sortable) return;
    const targetField = column.sortKey || column.accessor;
    if (!targetField) return;

    let newDirection: SortDirection = 'asc';
    if (currentSortField === targetField) {
      newDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
    }

    if (onSortChange) {
      onSortChange(targetField, newDirection);
    } else {
      setInternalSortField(() => targetField);
      setInternalSortDirection(newDirection);
    }
  };

  // Automatically determine search fields if not specified
  const effectiveSearchFields = useMemo(() => {
    if (searchFields && searchFields.length > 0) return searchFields;
    return columns
      .map((col) => col.accessor)
      .filter((acc): acc is keyof T | ((item: T) => any) => Boolean(acc));
  }, [searchFields, columns]);

  // Filtered & sorted data
  const processedData = useMemo(() => {
    let result = data;
    if (query && effectiveSearchFields.length > 0) {
      result = filterData(result, query, effectiveSearchFields);
    }
    if (currentSortField) {
      result = sortData(result, currentSortField, currentSortDirection);
    }
    return result;
  }, [data, query, effectiveSearchFields, currentSortField, currentSortDirection]);

  return (
    <div className={`flex flex-col gap-2 ${className}`.trim()}>
      {(searchable || toolbarActions) && (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
          {searchable && (
            <div className="relative flex-1 max-w-sm">
              <SearchIcon
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => handleSearchChange(e.target.value)}
                placeholder={searchPlaceholder}
                className="input input-sm pl-8 pr-7 w-full text-xs font-mono"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => handleSearchChange('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  aria-label="Clear search"
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 justify-between sm:justify-end text-xs text-[var(--text-muted)]">
            <span>
              Showing <strong className="text-[var(--text-primary)] font-mono">{processedData.length}</strong>
              {data.length !== processedData.length && (
                <> of <span className="font-mono">{data.length}</span></>
              )}{' '}
              {countLabel}
            </span>
            {toolbarActions && <div className="flex items-center gap-2">{toolbarActions}</div>}
          </div>
        </div>
      )}

      <div className={`table-container ${containerClassName}`.trim()}>
        <table className={`data-table ${tableClassName}`.trim()}>
          <thead>
            <tr>
              {columns.map((col, idx) => {
                const targetField = col.sortKey || col.accessor;
                const isSorted = Boolean(col.sortable && targetField && currentSortField === targetField);
                const alignClass =
                  col.align === 'right' ? 'num' : col.align === 'center' ? 'center' : '';

                return (
                  <th
                    key={col.key || (typeof col.header === 'string' ? col.header : idx)}
                    onClick={() => handleSort(col)}
                    className={`${col.sortable ? 'cursor-pointer select-none hover:text-[var(--text-primary)]' : ''} ${alignClass} ${col.headerClassName || ''}`.trim()}
                    style={col.width ? { width: col.width } : undefined}
                  >
                    <div
                      className={`inline-flex items-center gap-1.5 ${
                        col.align === 'right' ? 'justify-end w-full' : col.align === 'center' ? 'justify-center w-full' : ''
                      }`}
                    >
                      <span>{col.header}</span>
                      {col.sortable && (
                        <span className="inline-flex text-[10px] text-[var(--text-muted)]">
                          {isSorted ? (
                            currentSortDirection === 'asc' ? (
                              <ArrowUpIcon size={11} className="text-[var(--text-primary)]" />
                            ) : (
                              <ArrowDownIcon size={11} className="text-[var(--text-primary)]" />
                            )
                          ) : (
                            <span className="opacity-40">↕</span>
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {processedData.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="text-center py-8 text-[var(--text-muted)] italic font-sans"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              processedData.map((item, rowIndex) => {
                const rowCustomClass =
                  typeof rowClassName === 'function'
                    ? rowClassName(item, rowIndex)
                    : rowClassName || '';
                const clickableClass = onRowClick ? 'cursor-pointer hover:bg-[var(--bg-hover)]' : '';

                return (
                  <tr
                    key={(item as any).id || (item as any).key || rowIndex}
                    onClick={() => onRowClick && onRowClick(item, rowIndex)}
                    className={`${clickableClass} ${rowCustomClass}`.trim()}
                  >
                    {columns.map((col, colIndex) => {
                      const alignClass =
                        col.align === 'right' ? 'num' : col.align === 'center' ? 'center' : '';
                      const cellContent = col.render
                        ? col.render(item, rowIndex)
                        : typeof col.accessor === 'function'
                        ? col.accessor(item)
                        : col.accessor
                        ? item[col.accessor]
                        : null;

                      return (
                        <td
                          key={col.key || colIndex}
                          className={`${alignClass} ${col.className || ''}`.trim()}
                        >
                          {cellContent != null ? cellContent : '—'}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
          {(totalRow || footer) && (
            <tfoot>
              {totalRow && (
                typeof totalRow === 'function' ? (
                  totalRow
                ) : (
                  totalRow
                )
              )}
              {footer && (
                <tr>
                  <td colSpan={columns.length}>{footer}</td>
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
