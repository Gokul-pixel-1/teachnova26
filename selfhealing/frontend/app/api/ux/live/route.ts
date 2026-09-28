import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { liveEnabled, openLiveWindow } from '@/lib/server/ux/live'
import { ensureSandbox, sandboxBaseUrl, sandboxEnabled } from '@/lib/server/ux/sandbox'
import { errorResponse, handleApiError } from '@/lib/server/response'

// Starts (or keeps) the live-simulation browser whose screen the
// /ai/ux-live tab streams, so the UX agent's sandbox tests can be watched.
export async function POST() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response
  if (!sandboxEnabled()) return errorResponse('Sandbox testing is turned off (UX_SANDBOX=false).', 409)
  if (!liveEnabled()) {
    return errorResponse('The live sandbox view is off. Set UX_SIM_LIVE=true in .env.local and restart BuildHub.', 409)
  }
  try {
    await ensureSandbox()
    await openLiveWindow(sandboxBaseUrl())
    return NextResponse.json({ ok: true })
  } catch (err) {
    return handleApiError(err)
  }
}
