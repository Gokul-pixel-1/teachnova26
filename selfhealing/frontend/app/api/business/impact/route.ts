import { NextResponse } from 'next/server'

import { getSessionUser } from '@/lib/server/auth'
import { errorResponse, handleApiError } from '@/lib/server/response'
import { computeImpactReport } from '@/lib/server/business/impact'
import { computeUxImpact } from '@/lib/server/business/ux-impact'

export const dynamic = 'force-dynamic'

const WINDOWS = new Set([7, 30, 90])

// Business impact of self-healing (money, hours, AI cost) + UX impact proof.
export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) return errorResponse('Not authenticated.', 401)

  const requested = Number.parseInt(new URL(request.url).searchParams.get('days') ?? '30', 10)
  const days = WINDOWS.has(requested) ? requested : 30
  try {
    const [report, ux] = await Promise.all([computeImpactReport(days), computeUxImpact()])
    return NextResponse.json({ report, ux })
  } catch (err) {
    return handleApiError(err)
  }
}
