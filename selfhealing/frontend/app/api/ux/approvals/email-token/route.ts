import { NextResponse } from 'next/server'

import { prisma } from '@/lib/server/db'
import { testModeEnabled } from '@/lib/server/provider'
import { requireSecurityOperator } from '@/lib/server/security'
import { createUxApprovalTokens } from '@/lib/server/ux/approval-tokens'
import { errorResponse, handleApiError } from '@/lib/server/response'

// TEST-ONLY one-click token issuer for UX approvals — mirrors
// app/api/approvals/email-token/route.ts exactly, targeting UxApproval. Only
// reachable when SELF_HEALING_TEST_MODE is honored; production always 404s.
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
    const approval = await prisma.uxApproval.findUnique({ where: { approvalId } })
    if (!approval) return errorResponse('Approval not found.', 404)
    if (approval.status !== 'PENDING') {
      return errorResponse(`Approval is ${approval.status}, not PENDING.`, 409)
    }
    const tokens = await createUxApprovalTokens(approval.id, approval.expiresAt)
    return NextResponse.json({
      ok: true,
      approvalId,
      uxSuggestionId: approval.uxSuggestionId,
      expiresAt: approval.expiresAt.toISOString(),
      tokens: tokens.map((t) => ({ action: t.action, token: t.token })),
    })
  } catch (err) {
    return handleApiError(err)
  }
}
