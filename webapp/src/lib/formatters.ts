export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null || isNaN(amount)) return '$0';
  return '$' + Math.round(amount).toLocaleString('en-US');
}

export function formatNumber(val: number | null | undefined, decimals = 1): string {
  if (val == null || isNaN(val)) return '—';
  return Number(val).toFixed(decimals);
}

export function formatPercent(val: number | null | undefined, decimals = 1): string {
  if (val == null || isNaN(val)) return '—%';
  return (val * 100).toFixed(decimals) + '%';
}

export function formatMeters(val: number | null | undefined): string {
  if (val == null || isNaN(val)) return '— m';
  return Number(val).toFixed(1) + ' m';
}

export function formatMm(val: number | null | undefined): string {
  if (val == null || isNaN(val)) return '— mm';
  return Math.round(val) + ' mm';
}
