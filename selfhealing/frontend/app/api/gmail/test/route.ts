import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { handleApiError } from '@/lib/server/response'
import { logger, resolveRequestId } from '@/lib/server/logger'
import { prisma } from '@/lib/server/db'
import { gmailConfig, sendGmail } from '@/lib/server/gmail'

// Phase 12 — operator-gated Gmail conduit check. Sends a SINGLE TEST email to
// the configured approver inbox and records the delivery row. Never returns
// or logs credential values — only the delivery outcome.
export async function POST(request: Request) {
  const requestId = resolveRequestId(request)

  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  try {
    const timestamp = new Date().toISOString()
    const subject = `BuildHub Gmail test — ${timestamp}`
    const text = [
      'BuildHub Gmail integration test.',
      '',
      `Sent at ${timestamp} to verify Gmail API authentication and delivery.`,
      'No incident, no repair, no action required.',
    ].join('\n')
    const html = [
      '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;">',
      '<h3>BuildHub Gmail integration test</h3>',
      `<p>Sent at ${timestamp} to verify Gmail API authentication and delivery.</p>`,
      '<p>No incident, no repair, no action required.</p>',
      '</div>',
    ].join('')

    const result = await sendGmail({ type: 'TEST', subject, text, html })

    await logger.info({
      service: 'security',
      message: 'Gmail test message attempted',
      route: '/api/gmail/test',
      method: 'POST',
      status: 200,
      requestId,
      errorCode: result.ok ? null : 'GMAIL_FAILED',
    })

    const config = gmailConfig()
    const recent = await prisma.gmailNotification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        type: true,
        severity: true,
        deliveryStatus: true,
        gmailMessageId: true,
        error: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      ok: result.ok,
      configured: result.configured,
      deliveryStatus: result.deliveryStatus,
      gmailMessageId: result.gmailMessageId,
      error: result.error,
      missing: config.missing,
      recent,
    })
  } catch (err) {
    return handleApiError(err)
  }
}
