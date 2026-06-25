import { describe, it, expect } from 'vitest';
import { adjustFormulaForRow } from './spreadsheet';

describe('adjustFormulaForRow', () => {
  it('is a no-op for a zero offset', () => {
    expect(adjustFormulaForRow('C11+F$7', 0)).toBe('C11+F$7');
  });
  it('shifts relative row references by the offset', () => {
    expect(adjustFormulaForRow('C11', 4)).toBe('C15');
    expect(adjustFormulaForRow('SUM(A1:A2)', 1)).toBe('SUM(A2:A3)');
  });
  it('preserves absolute ($) row references', () => {
    expect(adjustFormulaForRow('C11+F$7', 4)).toBe('C15+F$7');
  });
});
