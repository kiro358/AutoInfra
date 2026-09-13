export type SortDirection = 'asc' | 'desc';

/**
 * Sort an array of objects by a key or accessor function in ascending or descending order.
 * Handles null/undefined values, numbers, and case-insensitive string comparisons.
 */
export function sortData<T>(
  data: T[],
  field: keyof T | ((item: T) => any),
  direction: SortDirection = 'asc'
): T[] {
  return [...data].sort((a, b) => {
    const valA = typeof field === 'function' ? field(a) : a[field];
    const valB = typeof field === 'function' ? field(b) : b[field];

    if (valA == null && valB == null) return 0;
    if (valA == null) return direction === 'asc' ? 1 : -1;
    if (valB == null) return direction === 'asc' ? -1 : 1;

    if (typeof valA === 'number' && typeof valB === 'number') {
      return direction === 'asc' ? valA - valB : valB - valA;
    }

    const strA = String(valA).toLowerCase();
    const strB = String(valB).toLowerCase();
    return direction === 'asc' ? strA.localeCompare(strB) : strB.localeCompare(strA);
  });
}

/**
 * Filter an array of objects by matching a query string across multiple fields or accessor functions.
 */
export function filterData<T>(
  data: T[],
  query: string,
  searchFields: (keyof T | ((item: T) => any))[]
): T[] {
  if (!query || !query.trim()) return data;
  const q = query.toLowerCase().trim();
  return data.filter((item) =>
    searchFields.some((field) => {
      const val = typeof field === 'function' ? field(item) : item[field];
      if (val == null) return false;
      return String(val).toLowerCase().includes(q);
    })
  );
}
