import { NextResponse } from 'next/server'
import { z } from 'zod'

import { requireSecurityOperator } from '@/lib/server/security'
import { prisma } from '@/lib/server/db'
import {
  approveUxApproval,
  rejectUxApproval,
  consumeUxApproval,
  expireUxApproval,
  getPendingUxApproval,
  isUxApprovalExpired,
} from '@/lib/server/ux/approval'
import { applyUxSuggestion } from '@/lib/server/ux/apply'
import { sendUxSuggestionOutcomeEmail } from '@/lib/server/ux/email'
import { errorResponse, handleApiError, firstZodIssue } from '@/lib/server/response'

// Dashboard approve/reject for a UX suggestion — the session-authenticated
// counterpart to the one-click email link in app/api/ux/approvals/email.
// Mirrors app/api/approvals/proceed/route.ts's shape, but targets
// UxApproval/UxSuggestion exclusively; it never touches Approval/Incident.

const bodySchema = z.object({
  approvalId: z.string().trim().min(1).max(32),
  action: z.enum(['proceed', 'reject']),
})

export async function POST(request: Request) {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid request body.', 400)
  }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return errorResponse(firstZodIssue(parsed.error), 400)
  const { approvalId, action } = parsed.data

  try {
    if (action === 'reject') {
      const pendingReject = await getPendingUxApproval(approvalId)
      if (!pendingReject) return errorResponse('Approval not found or not pending.', 404)
      const rejected = await rejectUxApproval(approvalId)
      if (!rejected) return errorResponse('Approval not found or not pending.', 404)
      const suggestion = await prisma.uxSuggestion.update({
        where: { id: pendingReject.uxSuggestionId },
        data: { status: 'REJECTED' },
      })
      await sendUxSuggestionOutcomeEmail(suggestion, 'REJECTED').catch(() => undefined)
      return NextResponse.json({ ok: true, approvalId, status: 'REJECTED' })
    }

    const pending = await getPendingUxApproval(approvalId)
    if (!pending) {
      const existing = await prisma.uxApproval.findFirst({ where: { approvalId }, select: { status: true } })
      if (existing) return NextResponse.json({ ok: true, alreadyDecided: true, status: existing.status })
      return errorResponse('Approval not found or not pending.', 404)
    }
    if (isUxApprovalExpired(pending)) {
      await expireUxApproval(approvalId)
      await prisma.uxSuggestion.update({ where: { id: pending.uxSuggestionId }, data: { status: 'EXPIRED' } })
      return NextResponse.json({ ok: true, expired: true, status: 'EXPIRED' })
    }

    const approved = await approveUxApproval(approvalId)
    if (!approved) return errorResponse('Failed to approve.', 500)
    const suggestion = await prisma.uxSuggestion.findUniqueOrThrow({ where: { id: pending.uxSuggestionId } })
    const decision = await applyUxSuggestion(suggestion)
    await consumeUxApproval(approvalId)
    if (decision.ok) {
      const updated = await prisma.uxSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } })
      await sendUxSuggestionOutcomeEmail(updated, 'APPLIED').catch(() => undefined)
    }

    return NextResponse.json({ ok: decision.ok, approvalId, status: decision.status, reason: decision.reason })
  } catch (err) {
    return handleApiError(err)
  }
}
