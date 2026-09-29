import { NextResponse } from 'next/server'

import { handleApiError } from '@/lib/server/response'
import { computeStatusReport } from '@/lib/server/business/status'

export const dynamic = 'force-dynamic'

// PUBLIC (no login): customer-facing service status. The payload is
// customer-safe by construction — see lib/server/business/status.ts.
export async function GET() {
  try {
    return NextResponse.json(await computeStatusReport(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return handleApiError(err)
  }
}
