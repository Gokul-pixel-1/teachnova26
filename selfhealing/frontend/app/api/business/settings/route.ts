import { NextResponse } from 'next/server'

import { getSessionUser } from '@/lib/server/auth'
import { requireSecurityOperator } from '@/lib/server/security'
import { errorResponse, firstZodIssue, handleApiError } from '@/lib/server/response'
import {
  businessSettingsSchema,
  readBusinessSettings,
  writeBusinessSettings,
} from '@/lib/server/business/settings'

export async function GET() {
  const user = await getSessionUser()
  if (!user) return errorResponse('Not authenticated.', 401)
  return NextResponse.json({ settings: await readBusinessSettings() })
}

// Operator-only: the numbers behind every "money saved" figure.
export async function PUT(request: Request) {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid request body.', 400)
  }
  const parsed = businessSettingsSchema.safeParse(body)
  if (!parsed.success) return errorResponse(firstZodIssue(parsed.error), 400)
  try {
    return NextResponse.json({ settings: await writeBusinessSettings(parsed.data) })
  } catch (err) {
    return handleApiError(err)
  }
}
