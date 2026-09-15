import { NextResponse } from 'next/server'

import { prisma } from '@/lib/server/db'
import { testModeEnabled } from '@/lib/server/provider'
import { requireSecurityOperator } from '@/lib/server/security'
import { createApprovalTokens } from '@/lib/server/approval-tokens'
import { errorResponse, handleApiError } from '@/lib/server/response'

// TEST-ONLY one-click token issuer. The raw email tokens are one-way hashed
// in the database, so hermetic harnesses need a way to obtain a real token
// without a mailbox. This route mints a fresh one-time pair for a PENDING
// approval and returns the raw values — available ONLY when
// SELF_HEALING_TEST_MODE is honored (dev TEST server); production always 404s.
export async function GET(request: Request) {
  if (!testModeEnabled()) {
    return errorResponse('Not found.', 404)
  }
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  try {
    const url = new URL(request.url)
    const approvalId = (url.searchParams.get('approvalId') ?? '').trim()
    if (!approvalId) return errorResponse('approvalId is required.', 400)
    const approval = await prisma.approval.findUnique({ where: { approvalId } })
    if (!approval) return errorResponse('Approval not found.', 404)
    if (approval.status !== 'PENDING') {
      return errorResponse(`Approval is ${approval.status}, not PENDING.`, 409)
    }
    const tokens = await createApprovalTokens(approval.id, approval.expiresAt)
    return NextResponse.json({
      ok: true,
      approvalId,
      incidentId: approval.incidentId,
      expiresAt: approval.expiresAt.toISOString(),
      tokens: tokens.map((t) => ({ action: t.action, token: t.token })),
    })
  } catch (err) {
    return handleApiError(err)
  }
}
