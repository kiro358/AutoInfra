import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { extractFromPDF } from '@/lib/extraction';
import { populateTemplate } from '@/lib/spreadsheet';
import { generateQuote } from '@/lib/quote-generator';
import { DEFAULT_PARAMS } from '@/lib/constants';
import { GlobalParams } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('pdf') as File | null;
    const projectName = (formData.get('projectName') as string) || 'Untitled Project';
    const paramsJson = formData.get('params') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No PDF file provided' }, { status: 400 });
    }

    // Parse optional parameter overrides
    let params = structuredClone(DEFAULT_PARAMS) as unknown as GlobalParams;
    if (paramsJson) {
      try {
        const overrides = JSON.parse(paramsJson);
        for (const section of ['manholes', 'sewers', 'watermain'] as const) {
          if (overrides[section] && typeof overrides[section] === 'object') {
            Object.assign(
              (params as unknown as Record<string, Record<string, unknown>>)[section],
              overrides[section]
            );
          }
        }
      } catch {
        // Ignore invalid JSON, use defaults
      }
    }

    const projectId = uuidv4();
    const pdfBuffer = Buffer.from(await file.arrayBuffer());

    // Extract data using Gemini VLM
    const extraction = await extractFromPDF(pdfBuffer, projectName);

    // Populate spreadsheet template
    const xlsxBuffer = await populateTemplate(extraction, params);

    // Generate quote PDF
    const quoteBuffer = await generateQuote(extraction, params);

    // Return everything inline — no filesystem dependency
    return NextResponse.json({
      projectId,
      extraction,
      // Encode files as base64 so the client can download directly
      xlsxBase64: xlsxBuffer.toString('base64'),
      quoteBase64: quoteBuffer.toString('base64'),
      status: 'completed',
    });
  } catch (error) {
    console.error('Processing error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Processing failed' },
      { status: 500 }
    );
  }
}
