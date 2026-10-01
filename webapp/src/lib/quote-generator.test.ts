import { describe, it, expect, vi, afterEach } from 'vitest';
import PDFDocument from 'pdfkit';
import {
  generateQuote,
  estimateSewerTotal,
  estimateWatermainTotal,
  quoteMarkup,
  formatLength,
} from './quote-generator';
import { priceTakeoff } from './costing-rules';
import { DEFAULT_PARAMS } from './constants';
import { GlobalParams, TakeoffFacts } from './types';

const PARAMS = DEFAULT_PARAMS as unknown as GlobalParams;

function facts(o: Partial<TakeoffFacts>): TakeoffFacts {
  return {
    projectName: 'P', jobNumber: 'J', date: 'D', confidence: 1, warnings: [],
    structures: [], catchbasins: [], sewers: [], watermain: [], watermainSpecials: [], watermainValves: [],
    ...o,
  };
}

/** Every string drawn on the quote (PDF streams are compressed, so spy on text()). */
async function quoteText(ex: ReturnType<typeof priceTakeoff>, params = PARAMS): Promise<string> {
  const seen: string[] = [];
  const orig = PDFDocument.prototype.text;
  const spy = vi.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (this: PDFKit.PDFDocument, ...args: unknown[]) {
    if (typeof args[0] === 'string') seen.push(args[0]);
    return (orig as (...a: unknown[]) => PDFKit.PDFDocument).apply(this, args);
  });
  try {
    await generateQuote(ex, params);
  } finally {
    spy.mockRestore();
  }
  return seen.join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('quote totals', () => {
  it('includes add-ons and standard fee line items in the sewer total', () => {
    const ex = priceTakeoff(
      facts({ sewers: [{ runLabel: 'MH1-MH2/INS', isLineItem: false, length: 10, pipeDiameter: 300, typeClass: null, slope: null, depth: 2 }] })
    );
    const withoutAddOns = estimateSewerTotal(
      { ...ex, sewers: ex.sewers.filter((s) => !s.isLineItem).map((s) => ({ ...s, addMaterials: 0, addLE: 0 })) },
      PARAMS
    );
    // /INS: 10m * (80 + 40); fees: VIDEO 10*25 + LAYOUT 5000 + AS BUILT 5000
    expect(estimateSewerTotal(ex, PARAMS) - withoutAddOns).toBeCloseTo(1200 + 250 + 10000, 6);
  });

  it('marks each section up by its own margin factor', () => {
    const p = structuredClone(PARAMS);
    p.sewers.marginFactor = 1.1;
    p.manholes.marginFactor = 1.2;
    p.watermain.marginFactor = 1.3;
    expect(quoteMarkup({ sewers: 100, manholes: 100, watermain: 100 }, p)).toBeCloseTo(360, 9);
  });

  it('does not price a watermain run with no length as $0 pipe', () => {
    const ex = priceTakeoff(facts({ watermain: [{ sizeAndType: '200mm PVC', length: 0, pipeDiameter: 200, ocSc: 1.1, avgCover: 1.8 }] }));
    expect(estimateWatermainTotal(ex, PARAMS)).toBe(0);
  });
});

describe('generateQuote output', () => {
  it('formats lengths to one decimal', async () => {
    expect(formatLength(10.1 + 10.2 + 10.3)).toBe('30.6');
    const ex = priceTakeoff(
      facts({
        sewers: [10.1, 10.2, 10.3].map((length, i) => ({
          runLabel: `MH${i}-MH${i + 1}`, isLineItem: false, length, pipeDiameter: 300, typeClass: null, slope: null, depth: 2,
        })),
      })
    );
    const text = await quoteText(ex);
    expect(text).toContain('30.6 m');
    expect(text).not.toContain('30.599999');
  });

  it('says "length TBD" for a watermain with unknown length', async () => {
    const ex = priceTakeoff(
      facts({
        watermain: [
          { sizeAndType: '200mm PVC', length: 0, pipeDiameter: 200, ocSc: 1.1, avgCover: 1.8 },
          { sizeAndType: '150mm PVC', length: 12.5, pipeDiameter: 150, ocSc: 1.1, avgCover: 1.8 },
        ],
      })
    );
    const text = await quoteText(ex);
    expect(text).toContain('12.5 m + length TBD');
    expect(text).toMatch(/length is TBD/);
  });

  it('labels the markup per section when the factors differ', async () => {
    const p = structuredClone(PARAMS);
    p.manholes.marginFactor = 1.25;
    const text = await quoteText(priceTakeoff(facts({})), p);
    expect(text).toContain('MARKUP (per section)');
  });

  it('rejects when the PDF stream errors instead of hanging', async () => {
    vi.spyOn(PDFDocument.prototype, 'end').mockImplementation(function (this: PDFKit.PDFDocument) {
      this.emit('error', new Error('stream boom'));
      return this;
    });
    await expect(generateQuote(priceTakeoff(facts({})), PARAMS)).rejects.toThrow('stream boom');
  });

  it('renders an empty takeoff', async () => {
    const buf = await generateQuote(priceTakeoff(facts({})), PARAMS);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
