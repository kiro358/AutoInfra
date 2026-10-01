/**
 * GET /api/jobs/[id] — poll a takeoff job started by POST /api/process.
 * The result (priced takeoff + base64 workbook/quote) is included once complete.
 */
import { NextResponse } from 'next/server';
import { jobStore } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = jobStore.get(id);
  if (!job) {
    return NextResponse.json(
      {
        error:
          'This takeoff is no longer available — the server may have restarted. Please upload the drawing set again.',
      },
      { status: 404 }
    );
  }
  return NextResponse.json(job, { headers: { 'Cache-Control': 'no-store' } });
}
