/**
 * POST /api/process — validate an upload and start a background takeoff job.
 *
 * Returns 202 `{ jobId }` immediately; poll GET /api/jobs/[id] for progress and
 * the result. (Running the whole extraction inside this request is what caused
 * the production 504s — see lib/jobs.ts.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { extractFromPDF } from '@/lib/extraction';
import { priceTakeoff } from '@/lib/costing-rules';
import { populateTemplate } from '@/lib/spreadsheet';
import { generateQuote } from '@/lib/quote-generator';
import { jobStore, JobCapacityError } from '@/lib/jobs';
import {
  InputError,
  parseMode,
  parseParams,
  parseProjectName,
  validatePdf,
} from '@/lib/process-input';
import type { ProcessResponse } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      throw new InputError('Expected a multipart/form-data upload with a "pdf" field.');
    }

    const file = formData.get('pdf');
    if (!(file instanceof File)) {
      throw new InputError('No PDF file provided.');
    }

    const pdfBuffer = Buffer.from(await file.arrayBuffer());
    validatePdf(pdfBuffer, file.name || 'upload.pdf');

    const mode = parseMode(formData.get('extractionMode'));
    const params = parseParams(formData.get('params'));
    const projectName = parseProjectName(
      formData.get('projectName') || file.name.replace(/\.pdf$/i, '')
    );

    const jobId = jobStore.start(file.name || 'upload.pdf', async (setStage, id) => {
      // Stage 1: physical facts only (no pricing)
      const facts = await extractFromPDF(pdfBuffer, projectName, undefined, { mode });

      // Stage 2: deterministic costing rules -> priced takeoff
      setStage('pricing');
      const extraction = priceTakeoff(facts);

      // Stage 3: workbook + quote
      setStage('documents');
      const xlsxBuffer = await populateTemplate(extraction, params);
      const quoteBuffer = await generateQuote(extraction, params);

      const response: ProcessResponse = {
        projectId: id,
        extraction,
        xlsxBase64: xlsxBuffer.toString('base64'),
        quoteBase64: quoteBuffer.toString('base64'),
        status: 'completed',
        cost: facts.cost,
        processedAt: new Date().toISOString(),
      };
      return response;
    });

    return NextResponse.json({ jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof InputError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof JobCapacityError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    console.error('Process submission error:', error);
    return NextResponse.json({ error: 'Could not start processing.' }, { status: 500 });
  }
}
