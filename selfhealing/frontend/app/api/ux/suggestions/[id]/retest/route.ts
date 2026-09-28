import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { retestSuggestion } from '@/lib/server/ux/engine'
import { errorResponse, handleApiError } from '@/lib/server/response'

// Re-runs the sandbox usability test for a suggestion whose test failed
// (NO_EASY_PLACEMENT or SANDBOX_FAILED). Runs in the background; the
// dashboard shows SIMULATING until it finishes.
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response
  try {
    const { id } = await ctx.params
    const result = await retestSuggestion(id, guard.user.username)
    if (!result.ok) return errorResponse(result.error ?? 'Could not re-test.', 409)
    return NextResponse.json({ ok: true, status: 'SIMULATING' })
  } catch (err) {
    return handleApiError(err)
  }
}
