import { describe, it, expect } from 'vitest';
import {
  createSyntheticCadPdf,
  drawStructureSymbol,
  DEFAULT_SYNTHETIC_STRUCTURES,
  DEFAULT_SYNTHETIC_PIPES,
  DEFAULT_SYNTHETIC_LAYERS,
} from './synthetic-cad-pdf';
import { extractPageText } from '../pdf-text';
import { getPdfjs } from '../pdfjs-loader';

describe('synthetic-cad-pdf fixture generator', () => {
  it('generates a valid PDF buffer with default vector elements', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.length).toBeGreaterThan(1000);

    // PDF magic bytes %PDF-
    const header = Buffer.from(pdfBytes.subarray(0, 5)).toString('utf-8');
    expect(header).toBe('%PDF-');
  });

  it('reads back text callouts and schedule table with extractPageText', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const pages = await extractPageText(Buffer.from(pdfBytes));

    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page.width).toBe(842);
    expect(page.height).toBe(595);

    const fullText = page.items.map((i) => i.text).join(' ');

    // Structure labels
    expect(fullText).toContain('STMH 1');
    expect(fullText).toContain('STMH 2');
    expect(fullText).toContain('CB 1');
    expect(fullText).toContain('SAN MH 1');

    // Pipe callouts
    expect(fullText).toContain('40.0m - 300mmØ PVC STORM @ 0.50%');
    expect(fullText).toContain('16.0m - 200mmØ PVC CB LEAD @ 1.00%');
    expect(fullText).toContain('40.0m - 200mmØ PVC SANITARY @ 0.40%');
    expect(fullText).toContain('34.0m - 150mmØ PVC WATERMAIN');

    // Elevations
    expect(fullText).toContain('T/G=100.50');
    expect(fullText).toContain('INV=97.50');

    // Legend
    expect(fullText).toContain('LEGEND');
    expect(fullText).toContain('PROPOSED STORM / SANITARY MANHOLE');
    expect(fullText).toContain('PROPOSED CATCHBASIN');

    // Schedule
    expect(fullText).toContain('STORM SEWER SCHEDULE');
    expect(fullText).toContain('STRUCTURE');
    expect(fullText).toContain('STATION');
    expect(fullText).toContain('INVERT');
  });

  it('verifies vector paths and line operations via pdfjs getOperatorList', async () => {
    const pdfBytes = await createSyntheticCadPdf();
    const lib = await getPdfjs();
    const doc = await lib.getDocument({
      data: pdfBytes,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    try {
      const page = await doc.getPage(1);
      const opList = await page.getOperatorList();

      expect(opList.fnArray.length).toBeGreaterThan(20);

      // Verify constructPath operators exist
      const constructPathOps = opList.fnArray.filter(
        (fn: number) => fn === lib.OPS.constructPath
      );
      expect(constructPathOps.length).toBeGreaterThan(10);

      // Verify stroke color setting ops exist
      const strokeColorOps = opList.fnArray.filter(
        (fn: number) => fn === lib.OPS.setStrokeRGBColor || fn === lib.OPS.setStrokeColorN
      );
      expect(strokeColorOps.length).toBeGreaterThan(5);

      // Verify line width and dash pattern ops exist
      const lineWidthOps = opList.fnArray.filter(
        (fn: number) => fn === lib.OPS.setLineWidth
      );
      expect(lineWidthOps.length).toBeGreaterThan(5);

      const dashOps = opList.fnArray.filter(
        (fn: number) => fn === lib.OPS.setDash
      );
      expect(dashOps.length).toBeGreaterThan(0);
    } finally {
      await doc.destroy?.();
    }
  });

  it('verifies AutoCAD OCG layers are preserved and queryable', async () => {
    const pdfBytes = await createSyntheticCadPdf({
      layers: DEFAULT_SYNTHETIC_LAYERS,
    });
    const lib = await getPdfjs();
    const doc = await lib.getDocument({
      data: pdfBytes,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;

    try {
      const optConfig = await doc.getOptionalContentConfig();
      expect(optConfig).toBeDefined();

      const order = optConfig.getOrder();
      expect(order).toBeDefined();
      expect(order.length).toBe(DEFAULT_SYNTHETIC_LAYERS.length);

      const groupNames = order.map((id: string) => optConfig.getGroup(id)?.name);
      expect(groupNames).toContain('3-STORM');
      expect(groupNames).toContain('2-SANITARY');
      expect(groupNames).toContain('1-WATERMAIN');
      expect(groupNames).toContain('0-STRUCTURES');
    } finally {
      await doc.destroy?.();
    }
  });

  it('supports custom structures, pipes, and dimensions', async () => {
    const customPdf = await createSyntheticCadPdf({
      width: 1200,
      height: 900,
      title: 'CUSTOM TEST SITE PLAN',
      structures: [
        { id: 'MH 101', type: 'MH', x: 200, y: 500, rimElevation: 105.0, invertElevation: 101.5 },
        { id: 'MH 102', type: 'CBMH', x: 400, y: 500, rimElevation: 104.8, invertElevation: 101.2 },
        { id: 'CB 201', type: 'CB', x: 400, y: 600, rimElevation: 104.5, invertElevation: 102.5 },
        { id: 'DCBMH 301', type: 'DCBMH', x: 600, y: 500 },
        { id: 'HYD 501', type: 'HYDRANT', x: 700, y: 400 },
        { id: 'VLV 501', type: 'VALVE', x: 500, y: 400 },
      ],
      pipes: [
        {
          id: 'STM-101',
          fromStructureId: 'MH 101',
          toStructureId: 'MH 102',
          system: 'STORM',
          diameterMm: 375,
          calloutText: '50.0m - 375mmØ PVC STORM @ 0.60%',
        },
      ],
      legend: false,
      schedule: false,
    });

    const pages = await extractPageText(Buffer.from(customPdf));
    expect(pages).toHaveLength(1);
    expect(pages[0].width).toBe(1200);
    expect(pages[0].height).toBe(900);

    const fullText = pages[0].items.map((i) => i.text).join(' ');
    expect(fullText).toContain('CUSTOM TEST SITE PLAN');
    expect(fullText).toContain('MH 101');
    expect(fullText).toContain('MH 102');
    expect(fullText).toContain('CB 201');
    expect(fullText).toContain('DCBMH 301');
    expect(fullText).toContain('50.0m - 375mmØ PVC STORM @ 0.60%');
    expect(fullText).not.toContain('STORM SEWER SCHEDULE');
  });
});
