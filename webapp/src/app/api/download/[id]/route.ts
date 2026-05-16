import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const OUTPUT_DIR = path.join(process.cwd(), 'outputs');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'xlsx';

  const ext = type === 'quote' ? '-quote.pdf' : '.xlsx';
  const mime =
    type === 'quote'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const filename = type === 'quote' ? `${id}-quote.pdf` : `${id}.xlsx`;

  const filePath = path.join(OUTPUT_DIR, `${id}${ext}`);

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const buffer = await readFile(filePath);
  return new NextResponse(buffer, {
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
