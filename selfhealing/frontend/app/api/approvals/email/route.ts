import { NextResponse } from 'next/server'

import { prisma } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import { approveApproval, expireApproval } from '@/lib/server/approval'
import { consumeEmailToken } from '@/lib/server/approval-tokens'
import {
  continueApprovedRepair,
  finalizeRejectedRepair,
} from '@/lib/server/repair/engine'
import { addIncidentEvent } from '@/lib/server/repair/events'
import { sendIncidentTerminalSummary } from '@/lib/server/notifications/summary'
import { sendFinalEmail } from '@/lib/server/gmail'
import { errorResponse, handleApiError } from '@/lib/server/response'

// One-click Gmail approval links: GET /api/approvals/email?token=<raw>.
//
// The token IS the credential (32 random bytes, SHA-256 stored, one-time,
// 5-minute expiry mirroring the approval). No session required — email
// clients hold no BuildHub session. Every guard is server-side:
// unknown/used/expired token, non-PENDING approval, or terminal incident all
// render an honest answer and never execute a repair twice.

function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json')
}

function resultPage(args: {
  title: string
  heading: string
  detail: string
  incidentId: string | null
  incidentRef: string | null
}): NextResponse {
  const link = args.incidentId
    ? `<p><a href="/ai/incidents/${args.incidentId}">Open ${args.incidentRef ?? 'incident'} in BuildHub</a></p>`
    : ''
  return new NextResponse(
    [
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>${args.title}</title></head>`,
      '<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;">',
      `<h2>${args.heading}</h2>`,
      `<p>${args.detail}</p>`,
      link,
      '</body></html>',
    ].join(''),
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const token = (url.searchParams.get('token') ?? '').trim()
  if (!token) return errorResponse('Approval token is required.', 400)

  try {
    const consumed = await consumeEmailToken(token)
    if (!consumed.ok) {
      // Expired but still PENDING → close it honestly like the dashboard flow.
      if (consumed.reason.includes('expired') && consumed.approvalId) {
        await expireApproval(consumed.approvalId)
        const row = await prisma.approval.findUnique({
          where: { approvalId: consumed.approvalId },
          include: { incident: true },
        })
        if (row && row.status === 'EXPIRED') {
          await prisma.incident.update({
            where: { id: row.incidentId },
            data: { status: 'AI_REPAIR_FAILED', summary: `Approval ${row.approvalId} expired without a decision.` },
          })
          await addIncidentEvent(row.incidentId, 'EXPIRED', 'Approval expired without decision', row.approvalId)
          await sendIncidentTerminalSummary(row.incident).catch(() => undefined)
          await sendFinalEmail({ incident: row.incident }).catch(() => undefined)
        }
      }
      await logger.warn({
        service: 'approval',
        message: `Email approval link rejected: ${consumed.reason}`,
        route: '/api/approvals/email',
        method: 'GET',
        status: 200,
      })
      if (wantsJson(request)) {
        return NextResponse.json({ ok: false, reason: consumed.reason, alreadyDecided: consumed.alreadyDecided ?? false })
      }
      return resultPage({
        title: 'BuildHub approval link',
        heading: 'Approval link not actioned',
        detail: `${consumed.reason} No code was changed by this click.`,
        incidentId: consumed.incidentId ?? null,
        incidentRef: null,
      })
    }

    if (consumed.action === 'REJECT') {
      const finalized = await finalizeRejectedRepair(consumed.approvalId ?? '', 'email-approval')
      await logger.info({
        service: 'approval',
        message: `Email REJECT applied (${consumed.approvalId})`,
        route: '/api/approvals/email',
        method: 'GET',
        status: 200,
      })
      if (wantsJson(request)) {
        return NextResponse.json({ ok: finalized.ok, rejected: true, approvalId: consumed.approvalId, incidentRef: finalized.incidentRef })
      }
      return resultPage({
        title: 'BuildHub repair rejected',
        heading: 'Repair rejected — no patch applied',
        detail: `Approval ${consumed.approvalId} recorded as REJECTED. The application is unchanged; the decision is stored in repair memory.`,
        incidentId: consumed.incidentId ?? null,
        incidentRef: finalized.incidentRef,
      })
    }

    // APPROVE: transition PENDING→APPROVED, then continue the SAME workflow.
    const approved = await approveApproval(consumed.approvalId ?? '')
    if (!approved) {
      if (wantsJson(request)) {
        return NextResponse.json({ ok: false, reason: 'Approval is no longer pending — no duplicate execution.', alreadyDecided: true })
      }
      return resultPage({
        title: 'BuildHub approval link',
        heading: 'Already decided',
        detail: 'This approval is no longer pending, so nothing was executed twice.',
        incidentId: consumed.incidentId ?? null,
        incidentRef: null,
      })
    }
    const bound = await prisma.approval.findUnique({
      where: { approvalId: consumed.approvalId ?? '' },
      select: { repairAttemptId: true },
    })
    if (bound?.repairAttemptId) {
      const repair = await continueApprovedRepair(consumed.approvalId ?? '', 'email-approval')
      await logger.info({
        service: 'approval',
        message: `Email APPROVE applied (${consumed.approvalId}) → ${repair.stage}`,
        route: '/api/approvals/email',
        method: 'GET',
        status: 200,
      })
      if (wantsJson(request)) {
        return NextResponse.json({
          ok: repair.ok || repair.stage === 'ROLLED_BACK',
          approved: true,
          approvalId: consumed.approvalId,
          stage: repair.stage,
          incidentRef: repair.incidentRef,
          rollback: repair.rollback,
        })
      }
      const good = repair.stage === 'RESOLVED'
      return resultPage({
        title: good ? 'BuildHub repair resolved' : 'BuildHub repair rolled back',
        heading: good ? 'Repair approved, applied and validated' : 'Repair approved but rolled back',
        detail: good
          ? `Patch applied and validation passed — incident ${repair.incidentRef} is RESOLVED.`
          : `Patch applied but validation failed, so the original code was restored — incident ${repair.incidentRef} is ROLLED_BACK. A failed validation is never reported as success.`,
        incidentId: consumed.incidentId ?? null,
        incidentRef: repair.incidentRef,
      })
    }
    if (wantsJson(request)) {
      return NextResponse.json({ ok: true, approved: true, approvalId: consumed.approvalId, note: 'No repair attempt is bound to this approval, so there is no patch to apply.' })
    }
    return resultPage({
      title: 'BuildHub approval recorded',
      heading: 'Approval recorded',
      detail: 'No repair attempt is bound to this approval, so there is no patch to apply.',
      incidentId: consumed.incidentId ?? null,
      incidentRef: null,
    })
  } catch (err) {
    return handleApiError(err)
  }
}
