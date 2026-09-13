import { describe, it, expect } from 'vitest';
import { formatCurrency, formatNumber, formatPercent, formatMeters, formatMm, formatFileSize } from './formatters';

describe('formatters', () => {
  it('formats currency cleanly without decimals', () => {
    expect(formatCurrency(124500.75)).toBe('$124,501');
    expect(formatCurrency(-450.2)).toBe('-$450');
    expect(formatCurrency(0)).toBe('$0');
    expect(formatCurrency(null)).toBe('$0');
    expect(formatCurrency(undefined)).toBe('$0');
    expect(formatCurrency(NaN)).toBe('$0');
  });

  it('formats precision numbers and meters', () => {
    expect(formatNumber(12.345, 2)).toBe('12.35');
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatNumber(NaN)).toBe('—');
    expect(formatMeters(45.6)).toBe('45.6 m');
    expect(formatMeters(null)).toBe('— m');
    expect(formatMeters(undefined)).toBe('— m');
    expect(formatMm(375)).toBe('375 mm');
    expect(formatMm(null)).toBe('— mm');
  });

  it('formats percentages correctly', () => {
    expect(formatPercent(0.485, 1)).toBe('48.5%');
    expect(formatPercent(null)).toBe('—%');
    expect(formatPercent(undefined)).toBe('—%');
  });

  it('formats file sizes accurately', () => {
    expect(formatFileSize(null)).toBe('0 B');
    expect(formatFileSize(undefined)).toBe('0 B');
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1048576)).toBe('1.0 MB');
    expect(formatFileSize(5242880)).toBe('5.0 MB');
  });
});

