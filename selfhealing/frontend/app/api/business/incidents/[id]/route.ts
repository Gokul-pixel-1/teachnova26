import { NextResponse } from 'next/server'

import { getSessionUser } from '@/lib/server/auth'
import { errorResponse, handleApiError } from '@/lib/server/response'
import { incidentImpacts } from '@/lib/server/business/impact'
import { readBusinessSettings } from '@/lib/server/business/settings'

// Business impact of one incident — backs the postmortem page.
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser()
  if (!user) return errorResponse('Not authenticated.', 401)

  const { id } = await ctx.params
  try {
    const settings = await readBusinessSettings()
    const [impact] = await incidentImpacts({ id }, settings, 1)
    if (!impact) return errorResponse('Incident not found.', 404)
    return NextResponse.json({ impact, settings })
  } catch (err) {
    return handleApiError(err)
  }
}
