import { NextResponse } from 'next/server'

import { getSessionUser } from '@/lib/server/auth'
import { errorResponse } from '@/lib/server/response'
import { logger } from '@/lib/server/logger'
import { prisma } from '@/lib/server/db'
import { fetchIncidentDetail, computeOverview } from '@/lib/server/observability'
import { generateIncidentReport } from '@/lib/server/report'
import { buildIncidentBrief } from '@/lib/server/notifications/brief'

// Authenticated PDF report endpoint. Returns `application/pdf` for a single
// incident: observed facts + real Groq pipeline analysis + Telegram delivery
// status. No secrets are ever embedded (the report is generated purely from
// serialized DTOs).
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  const { id } = await ctx.params
  const detail = await fetchIncidentDetail(id)
  if (!detail) {
    return errorResponse('Incident not found.', 404)
  }

  try {
    const overview = await computeOverview()
    const [brief, telegramRows, gmailRows, securityRows] = await Promise.all([
      buildIncidentBrief(id),
      prisma.telegramNotification.findMany({ where: { incidentId: id }, orderBy: { createdAt: 'asc' }, take: 30 }),
      prisma.gmailNotification.findMany({ where: { incidentId: id }, orderBy: { createdAt: 'asc' }, take: 30 }),
      detail.errorCode
        ? prisma.securityFinding.findMany({
            where: { ruleId: { equals: detail.errorCode, mode: 'insensitive' } },
            orderBy: { createdAt: 'desc' },
            take: 5,
          })
        : Promise.resolve([]),
    ])
    const pdf = await generateIncidentReport({
      detail,
      overview,
      generatedAt: new Date().toISOString(),
      brief,
      telegram: telegramRows.map((row) => ({
        id: row.id,
        type: row.type,
        severity: row.severity,
        deliveryStatus: row.deliveryStatus,
        externalMessageId: row.telegramMessageId,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
      })),
      gmail: gmailRows.map((row) => ({
        id: row.id,
        type: row.type,
        severity: row.severity,
        deliveryStatus: row.deliveryStatus,
        externalMessageId: row.gmailMessageId,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
      })),
      securityEvidence: securityRows.map((row) => ({
        ruleId: row.ruleId,
        title: row.title,
        detail: row.detail,
        hitCount: row.hitCount,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      })),
    })

    await logger.info({
      service: 'api',
      message: `Incident report generated: ${detail.ref}`,
      route: `/api/incidents/${id}/report`,
      method: 'POST',
      status: 200,
      requestId: request.headers.get('x-request-id') ?? undefined,
    })

    const filename = `buildhub-incident-${detail.ref.toLowerCase()}.pdf`
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdf.byteLength),
      },
    })
  } catch {
    await logger.error({
      service: 'api',
      message: `Incident report generation failed: ${detail.ref}`,
      route: `/api/incidents/${id}/report`,
      method: 'POST',
      status: 500,
      requestId: request.headers.get('x-request-id') ?? undefined,
      errorCode: 'REPORT_GENERATION_FAILED',
    })
    return errorResponse('Could not generate report.', 500)
  }
}
