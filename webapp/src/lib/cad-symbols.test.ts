import { describe, it, expect } from 'vitest';
import {
  classifyLegendDescription,
  detectLegend,
  extractStructureSymbols,
} from './cad-symbols';
import { extractCadGeometry } from './cad-geometry';
import { extractPageText } from './pdf-text';
import {
  createSyntheticCadPdf,
} from './test-fixtures/synthetic-cad-pdf';

describe('cad-symbols legend classification', () => {
  it('correctly maps legend descriptions to structure types', () => {
    expect(classifyLegendDescription('PROPOSED STORM MANHOLE')).toBe('MH');
    expect(classifyLegendDescription('PROP. SANITARY MAINTENANCE HOLE')).toBe('MH');
    expect(classifyLegendDescription('PROPOSED CATCHBASIN')).toBe('CB');
    expect(classifyLegendDescription('PROPOSED CATCHBASIN MANHOLE (CBMH)')).toBe('CBMH');
    expect(classifyLegendDescription('PROPOSED DOUBLE CBMH')).toBe('DCBMH');
    expect(classifyLegendDescription('PROPOSED DITCH INLET CATCHBASIN (DICB)')).toBe('DICB');
    expect(classifyLegendDescription('PROPOSED FIRE HYDRANT')).toBe('HYDRANT');
    expect(classifyLegendDescription('PROPOSED 150mm GATE VALVE')).toBe('VALVE');
    expect(classifyLegendDescription('PROPERTY LINE')).toBeNull();
  });
});

describe('extractStructureSymbols on synthetic CAD drawings', () => {
  it('detects legend templates and classifies symbols with legend matching', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const geometry = await extractCadGeometry(pdfBytes.slice(), 1);
    const pageTexts = await extractPageText(Buffer.from(pdfBytes.slice()));

    const legendInfo = detectLegend(geometry, pageTexts[0]);
    expect(legendInfo.templates.length).toBeGreaterThan(0);

    const symbols = extractStructureSymbols(geometry, pageTexts[0]);
    expect(symbols.length).toBeGreaterThanOrEqual(5);

    // Verify presence of MHs
    const mhs = symbols.filter((s) => s.type === 'MH');
    expect(mhs.length).toBeGreaterThanOrEqual(3);

    // Verify presence of CBs
    const cbs = symbols.filter((s) => s.type === 'CB');
    expect(cbs.length).toBeGreaterThanOrEqual(1);

    // Verify coordinates match default structures
    const stmh1 = symbols.find(
      (s) => Math.abs(s.centroid.x - 150) < 6 && Math.abs(s.centroid.y - 400) < 6
    );
    expect(stmh1).toBeDefined();
    expect(stmh1?.type).toBe('MH');

    const cb1 = symbols.find(
      (s) => Math.abs(s.centroid.x - 350) < 6 && Math.abs(s.centroid.y - 480) < 6
    );
    expect(cb1).toBeDefined();
    expect(cb1?.type).toBe('CB');
  });

  it('detects and classifies symbols geometrically when no legend exists', async () => {
    const pdfNoLegend = await createSyntheticCadPdf({
      legend: false,
      schedule: false,
      structures: [
        { id: 'MH 1', type: 'MH', x: 200, y: 300, size: 14 },
        { id: 'CB 1', type: 'CB', x: 200, y: 400, size: 12 },
        { id: 'CBMH 1', type: 'CBMH', x: 400, y: 300, size: 14 },
        { id: 'DCBMH 1', type: 'DCBMH', x: 400, y: 400, size: 14 },
      ],
      pipes: [],
    });

    const geometry = await extractCadGeometry(pdfNoLegend.slice(), 1);
    const symbols = extractStructureSymbols(geometry);

    expect(symbols.length).toBe(4);

    const mh = symbols.find(
      (s) => Math.abs(s.centroid.x - 200) < 5 && Math.abs(s.centroid.y - 300) < 5
    );
    expect(mh).toBeDefined();
    expect(mh?.type).toBe('MH');
    expect(mh?.source).toBe('geometric-shape');

    const cb = symbols.find(
      (s) => Math.abs(s.centroid.x - 200) < 5 && Math.abs(s.centroid.y - 400) < 5
    );
    expect(cb).toBeDefined();
    expect(cb?.type).toBe('CB');

    const cbmh = symbols.find(
      (s) => Math.abs(s.centroid.x - 400) < 5 && Math.abs(s.centroid.y - 300) < 5
    );
    expect(cbmh).toBeDefined();
    expect(cbmh?.type).toBe('CBMH');

    const dcbmh = symbols.find(
      (s) => Math.abs(s.centroid.x - 400) < 5 && Math.abs(s.centroid.y - 400) < 5
    );
    expect(dcbmh).toBeDefined();
    expect(dcbmh?.type).toBe('DCBMH');
  });
});
