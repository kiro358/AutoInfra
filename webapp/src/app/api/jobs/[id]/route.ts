/**
 * GET /api/jobs/[id] — poll a takeoff job started by POST /api/process.
 * The result (priced takeoff + base64 workbook/quote) is included once complete.
 *
 * Reads go through getAsync: memory first, then the persistent store
 * (lib/job-persistence.ts), so a job accepted by a previous instance —
 * completed, failed, or reconciled to `interrupted` after a restart —
 * still resolves here. The 404 below is only for genuinely unknown ids
 * (or jobs whose persistence the kill switch disabled).
 */
import { NextResponse } from 'next/server';
import { jobStore } from '@/lib/jobs';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await jobStore.getAsync(id);
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
