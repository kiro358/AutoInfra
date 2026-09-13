export function formatCurrency(amount: number | null | undefined): string {
  if (amount == null || isNaN(amount)) return '$0';
  const rounded = Math.round(amount);
  if (rounded < 0) {
    return '-$' + Math.abs(rounded).toLocaleString('en-US');
  }
  return '$' + rounded.toLocaleString('en-US');
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

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || isNaN(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  const val = bytes / Math.pow(k, idx);
  return `${idx === 0 ? Math.round(val) : val.toFixed(1)} ${sizes[idx]}`;
}

