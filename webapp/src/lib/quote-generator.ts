import PDFDocument from 'pdfkit';
import { ExtractionResult, GlobalParams } from './types';

/**
 * Generate a professional quote PDF from extraction results
 */
export async function generateQuote(
  extraction: ExtractionResult,
  params: GlobalParams,
  overrides?: { totalOverride?: number; notes?: string }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      // ---- Header ----
      doc.fontSize(20).font('Helvetica-Bold').text('TOPSITE CONTRACTING LIMITED', { align: 'center' });
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica').text('Site Servicing Quotation', { align: 'center' });
      doc.moveDown(1);

      // ---- Project Info ----
      doc.fontSize(11).font('Helvetica-Bold');
      doc.text(`Project: ${extraction.projectName}`);
      doc.font('Helvetica').text(`Job #: ${extraction.jobNumber}`);
      doc.text(`Date: ${extraction.date}`);
      doc.moveDown(1);

      // Horizontal line
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(0.5);

      // ---- Summary Table ----
      doc.fontSize(12).font('Helvetica-Bold').text('SUMMARY OF ESTIMATE', { align: 'center' });
      doc.moveDown(0.5);

      // Calculate rough totals (simplified — actual totals come from Excel formulas)
      const sewerTotal = estimateSewerTotal(extraction, params);
      const manholeTotal = estimateManholeTotal(extraction, params);
      const watermainTotal = estimateWatermainTotal(extraction, params);
      const subtotal = sewerTotal + manholeTotal + watermainTotal;
      const markup = params.sewers.marginFactor - 1;
      const grandTotal = overrides?.totalOverride ?? subtotal * (1 + markup);

      // Table header
      const tableTop = doc.y;
      const col1 = 50, col2 = 200, col3 = 350, col4 = 470;
      doc.fontSize(9).font('Helvetica-Bold');
      doc.text('ITEM', col1, tableTop);
      doc.text('QUANTITY', col2, tableTop);
      doc.text('DESCRIPTION', col3, tableTop);
      doc.text('AMOUNT', col4, tableTop, { width: 92, align: 'right' });

      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(0.3);

      // Rows
      doc.font('Helvetica').fontSize(9);
      const totalSewerLen = extraction.sewers.reduce((s, r) => s + r.length, 0);
      const totalWmLen = extraction.watermain.reduce((s, r) => s + r.length, 0);

      addQuoteRow(doc, col1, col2, col3, col4, '1', `${totalSewerLen} m`, 'Sewer Installation', formatCurrency(sewerTotal));
      addQuoteRow(doc, col1, col2, col3, col4, '2', `${extraction.manholes.length} ea`, 'Manholes & Catchbasins', formatCurrency(manholeTotal));
      addQuoteRow(doc, col1, col2, col3, col4, '3', `${totalWmLen} m`, 'Watermain Installation', formatCurrency(watermainTotal));

      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(0.3);

      // Totals
      doc.font('Helvetica-Bold');
      doc.text('SUB TOTAL', col3, doc.y);
      doc.text(formatCurrency(subtotal), col4, doc.y - doc.currentLineHeight(), { width: 92, align: 'right' });
      doc.moveDown(0.3);

      doc.text(`MARKUP (${(markup * 100).toFixed(0)}%)`, col3, doc.y);
      doc.text(formatCurrency(subtotal * markup), col4, doc.y - doc.currentLineHeight(), { width: 92, align: 'right' });
      doc.moveDown(0.3);

      doc.fontSize(11);
      doc.text('GRAND TOTAL', col3, doc.y);
      doc.text(formatCurrency(grandTotal), col4, doc.y - doc.currentLineHeight(), { width: 92, align: 'right' });

      doc.moveDown(1.5);
      doc.moveTo(50, doc.y).lineTo(562, doc.y).stroke();
      doc.moveDown(0.5);

      // ---- Scope Details ----
      doc.fontSize(10).font('Helvetica-Bold').text('SCOPE INCLUDES:');
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9);

      const scopeItems = [
        `Supply and install ${totalSewerLen}m of storm/sanitary sewer`,
        `Supply and install ${extraction.manholes.length} manholes/catchbasins`,
        `Supply and install ${totalWmLen}m of watermain`,
        'Excavation, backfill, and compaction',
        'Granular and crushed stone bedding',
        'Trucking of excess material',
        'All fittings and connections as shown on drawings',
      ];
      scopeItems.forEach((item) => {
        doc.text(`• ${item}`, 60);
        doc.moveDown(0.2);
      });

      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').text('EXCLUSIONS:');
      doc.moveDown(0.3);
      doc.font('Helvetica');
      const exclusions = [
        'Rock excavation',
        'Dewatering (if required)',
        'Asphalt and curb restoration',
        'Permits and inspection fees',
        'HST',
      ];
      exclusions.forEach((item) => {
        doc.text(`• ${item}`, 60);
        doc.moveDown(0.2);
      });

      if (overrides?.notes) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').text('NOTES:');
        doc.moveDown(0.2);
        doc.font('Helvetica').text(overrides.notes);
      }

      // ---- Footer ----
      doc.moveDown(2);
      doc.text('This quotation is valid for 30 days from the date above.', { align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function addQuoteRow(
  doc: PDFKit.PDFDocument,
  col1: number, col2: number, col3: number, col4: number,
  item: string, qty: string, desc: string, amount: string
) {
  const y = doc.y;
  doc.text(item, col1, y);
  doc.text(qty, col2, y);
  doc.text(desc, col3, y);
  doc.text(amount, col4, y, { width: 92, align: 'right' });
  doc.moveDown(0.5);
}

function formatCurrency(val: number): string {
  return `$${val.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- Rough cost estimation (for quote — actual precision comes from Excel formulas) ----

function estimateSewerTotal(extraction: ExtractionResult, params: GlobalParams): number {
  let total = 0;
  for (const sw of extraction.sewers) {
    const dailyCost = params.sewers.dayCostPerDay + params.sewers.extraPerDay;
    const daysPer = sw.length / params.sewers.productionMPerDay;
    const laborCost = dailyCost * daysPer;
    const pipeCost = sw.length * getPipePrice(sw.pipeDiameter);
    const trenchWidth = Math.max(params.sewers.minTrenchWidth, sw.pipeDiameter * 0.00125 * 2 + 0.6);
    const excavVol = trenchWidth * (sw.depth + 0.1 + sw.pipeDiameter * 0.00125) * sw.length;
    const truckCost = excavVol * params.sewers.truckingPerCM;
    total += laborCost + pipeCost + truckCost;
  }
  return total;
}

function estimateManholeTotal(extraction: ExtractionResult, params: GlobalParams): number {
  let total = 0;
  for (const mh of extraction.manholes) {
    const depth = mh.topElevation > 0 && mh.lowInvert > 0 ? mh.topElevation - mh.lowInvert : 2.0;
    const precastCost = depth * 500 + 400; // rough estimate
    const laborCost = params.manholes.laborPerHr * (15 + depth * 5);
    const truckCost = depth * 0.5 * params.manholes.truckingPerCM;
    total += precastCost + laborCost + truckCost + mh.addMaterials + mh.addLE;
  }
  return total;
}

function estimateWatermainTotal(extraction: ExtractionResult, params: GlobalParams): number {
  let total = 0;
  for (const wm of extraction.watermain) {
    const dailyCost = params.watermain.dayCostPerDay + params.watermain.extraPerDay;
    const daysPer = wm.length / params.watermain.productionMPerDay;
    const laborCost = dailyCost * daysPer;
    const pipeCost = wm.length * getWmPipePrice(wm.pipeDiameter, params);
    total += laborCost + pipeCost;
  }
  // Add specials and valves
  for (const sp of extraction.watermainSpecials) {
    total += sp.quantity * (sp.costEach + sp.anodeCost + sp.laborEach);
  }
  for (const v of extraction.watermainValves) {
    total += v.quantity * (v.valveCost + v.boxCost + v.anodeCost + v.laborPerValve);
  }
  return total;
}

function getPipePrice(dia: number): number {
  const prices: Record<number, number> = {
    150: 25, 200: 35, 250: 55, 300: 75, 375: 105, 450: 140, 525: 180, 600: 230, 675: 290, 750: 350, 900: 500
  };
  return prices[dia] || 50;
}

function getWmPipePrice(dia: number, params: GlobalParams): number {
  const map: Record<number, number> = {
    100: params.watermain.c900_100,
    150: params.watermain.c900_150,
    200: params.watermain.c900_200,
    250: params.watermain.c900_250,
    300: params.watermain.c900_300,
  };
  return map[dia] || 84;
}
