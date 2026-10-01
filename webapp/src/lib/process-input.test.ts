import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMS } from './constants';
import {
  InputError,
  MAX_PDF_BYTES,
  looksLikePdf,
  parseMode,
  parseParams,
  parseProjectName,
  validatePdf,
} from './process-input';

const pdf = (body = 'rest of file') => Buffer.from(`%PDF-1.7\n${body}`);

describe('validatePdf', () => {
  it('accepts a PDF', () => {
    expect(() => validatePdf(pdf(), 'a.pdf')).not.toThrow();
    expect(looksLikePdf(Buffer.from('\n\n%PDF-1.4'))).toBe(true);
  });
  it('rejects empty, oversized and non-PDF files with a 4xx InputError', () => {
    expect(() => validatePdf(Buffer.alloc(0), 'a.pdf')).toThrow(/empty/);
    expect(() => validatePdf(Buffer.from('PK\u0003\u0004 zip'), 'a.pdf')).toThrow(/not a PDF/);
    const big = Buffer.alloc(MAX_PDF_BYTES + 1);
    big.write('%PDF-1.7');
    try {
      validatePdf(big, 'big.pdf');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InputError);
      expect((e as InputError).status).toBe(413);
    }
  });
});

describe('parseMode', () => {
  it('maps empty/default to the server default', () => {
    expect(parseMode(null)).toBeUndefined();
    expect(parseMode('')).toBeUndefined();
    expect(parseMode('default')).toBeUndefined();
  });
  it('passes known modes and rejects unknown ones', () => {
    expect(parseMode('vector')).toBe('vector');
    expect(parseMode('single-pass')).toBe('single-pass');
    expect(() => parseMode('turbo')).toThrow(InputError);
  });
});

describe('parseParams', () => {
  it('returns a copy of the defaults when nothing is sent', () => {
    const p = parseParams(null);
    expect(p).toEqual(DEFAULT_PARAMS);
    (p.manholes as unknown as Record<string, number>).laborPerHr = 1;
    expect(DEFAULT_PARAMS.manholes.laborPerHr).not.toBe(1); // no shared mutation
  });
  it('applies numeric overrides, including numeric strings', () => {
    const p = parseParams(JSON.stringify({ manholes: { laborPerHr: 150 }, sewers: { pipeCover: '0.5' } }));
    expect(p.manholes.laborPerHr).toBe(150);
    expect((p.sewers as unknown as Record<string, number>).pipeCover).toBe(0.5);
  });
  it('ignores unknown keys and blocks prototype pollution', () => {
    const p = parseParams('{"manholes":{"__proto__":{"polluted":1},"notARate":5},"evil":{}}');
    expect((p.manholes as unknown as Record<string, unknown>).notARate).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('rejects NaN, negative and non-numeric rates', () => {
    expect(() => parseParams({ manholes: { laborPerHr: 'abc' } })).toThrow(/non-negative number/);
    expect(() => parseParams({ manholes: { laborPerHr: -1 } })).toThrow(InputError);
    expect(() => parseParams({ manholes: { laborPerHr: null } })).toThrow(InputError);
    expect(() => parseParams('{not json')).toThrow(/not valid JSON/);
    expect(() => parseParams('[1,2]')).toThrow(InputError);
  });
});

describe('parseProjectName', () => {
  it('trims, strips control characters and caps length', () => {
    expect(parseProjectName('  Oak St\u0000 ')).toBe('Oak St');
    expect(parseProjectName(undefined)).toBe('Untitled Project');
    expect(parseProjectName('x'.repeat(500))).toHaveLength(120);
  });
});
