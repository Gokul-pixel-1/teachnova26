import { NextResponse } from 'next/server'

import { prisma } from '@/lib/server/db'
import { consumeUxEmailToken } from '@/lib/server/ux/approval-tokens'
import { approveUxApproval, consumeUxApproval, expireUxApproval } from '@/lib/server/ux/approval'
import { applyUxSuggestion } from '@/lib/server/ux/apply'
import { sendUxSuggestionOutcomeEmail } from '@/lib/server/ux/email'
import { errorResponse, handleApiError } from '@/lib/server/response'

// One-click Gmail approval link for a UX suggestion: GET /api/ux/approvals/
// email?token=<raw>. Mirrors app/api/approvals/email/route.ts's token-is-the-
// credential contract, but targets UxApprovalToken/UxApproval/UxSuggestion
// exclusively — it never joins against Approval/ApprovalToken/Incident.

function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json')
}

function resultPage(args: { title: string; heading: string; detail: string }): NextResponse {
  return new NextResponse(
    [
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>${args.title}</title></head>`,
      '<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;">',
      `<h2>${args.heading}</h2>`,
      `<p>${args.detail}</p>`,
      '<p><a href="/ai/ux-suggestions">Open UX Suggestions in BuildHub</a></p>',
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
    const consumed = await consumeUxEmailToken(token)
    if (!consumed.ok) {
      if (consumed.reason.includes('expired') && consumed.approvalId) {
        await expireUxApproval(consumed.approvalId)
        const row = await prisma.uxApproval.findUnique({ where: { approvalId: consumed.approvalId } })
        if (row && row.status === 'EXPIRED') {
          await prisma.uxSuggestion.update({ where: { id: row.uxSuggestionId }, data: { status: 'EXPIRED' } })
        }
      }
      if (wantsJson(request)) {
        return NextResponse.json({ ok: false, reason: consumed.reason, alreadyDecided: consumed.alreadyDecided ?? false })
      }
      return resultPage({
        title: 'BuildHub UX approval link',
        heading: 'Approval link not actioned',
        detail: `${consumed.reason} No UI file was changed by this click.`,
      })
    }

    if (consumed.action === 'REJECT') {
      const approval = await prisma.uxApproval.findUnique({ where: { approvalId: consumed.approvalId ?? '' } })
      if (approval) {
        await prisma.uxApproval.update({ where: { id: approval.id }, data: { status: 'REJECTED', statusUpdatedAt: new Date() } })
        const suggestion = await prisma.uxSuggestion.update({
          where: { id: approval.uxSuggestionId },
          data: { status: 'REJECTED' },
        })
        await sendUxSuggestionOutcomeEmail(suggestion, 'REJECTED').catch(() => undefined)
      }
      if (wantsJson(request)) {
        return NextResponse.json({ ok: true, rejected: true, approvalId: consumed.approvalId })
      }
      return resultPage({
        title: 'BuildHub UX suggestion rejected',
        heading: 'Suggestion rejected — no file changed',
        detail: `Approval ${consumed.approvalId} recorded as REJECTED. The application is unchanged.`,
      })
    }

    const approved = await approveUxApproval(consumed.approvalId ?? '')
    if (!approved) {
      if (wantsJson(request)) {
        return NextResponse.json({ ok: false, reason: 'Approval is no longer pending — no duplicate execution.', alreadyDecided: true })
      }
      return resultPage({
        title: 'BuildHub UX approval link',
        heading: 'Already decided',
        detail: 'This approval is no longer pending, so nothing was executed twice.',
      })
    }
    const suggestion = await prisma.uxSuggestion.findUniqueOrThrow({ where: { id: approved.uxSuggestionId } })
    const decision = await applyUxSuggestion(suggestion)
    await consumeUxApproval(consumed.approvalId ?? '')
    if (decision.ok) {
      const updated = await prisma.uxSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } })
      await sendUxSuggestionOutcomeEmail(updated, 'APPLIED').catch(() => undefined)
    }

    if (wantsJson(request)) {
      return NextResponse.json({
        ok: decision.ok,
        approved: true,
        approvalId: consumed.approvalId,
        status: decision.status,
        reason: decision.reason,
      })
    }
    return resultPage({
      title: decision.ok ? 'BuildHub UX change applied' : 'BuildHub UX change rolled back',
      heading: decision.ok ? 'Approved, applied and validated' : 'Approved but rolled back',
      detail: decision.ok
        ? `Change applied and validated — suggestion ${suggestion.ref} is ${decision.status}.`
        : `Change could not be safely validated, so the original file was restored — suggestion ${suggestion.ref} is ${decision.status}. ${decision.reason}`,
    })
  } catch (err) {
    return handleApiError(err)
  }
}
