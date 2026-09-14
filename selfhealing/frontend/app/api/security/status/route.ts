import { NextResponse } from 'next/server'

import { getSessionUser } from '@/lib/server/auth'
import { errorResponse, handleApiError } from '@/lib/server/response'
import { logger, resolveRequestId } from '@/lib/server/logger'
import { prisma } from '@/lib/server/db'
import {
  computeSecurityOverview,
  findActiveFindings,
  riskTier,
} from '@/lib/server/risk'
import { securityOperators, isSecurityOperator } from '@/lib/server/security'
import { offeredModels, configuredModel } from '@/lib/server/ai'
import { aiProviderName, providerModeLabel } from '@/lib/server/provider'
import { telegramConfig, checkTelegramConnectivity } from '@/lib/server/telegram'

// Phase 8 — live security status for the command center. Any authenticated user
// may read it; write/trigger actions are separated onto the operator-gated
// endpoints (POST findings / ingest / run). Contains no secrets: never returns
// tokens or keys, only capability flags.
export async function GET(request: Request) {
  const requestId = resolveRequestId(request)

  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }
  const userIsOperator = isSecurityOperator(user)

  try {
    const [overview, findings, activeIncidents, recentTerminalIncidents, agentCounts, modelOptions, config, connectivity] =
      await Promise.all([
        computeSecurityOverview(),
        findActiveFindings(),
        prisma.incident.findMany({
          where: { status: { in: ['DETECTED', 'INVESTIGATING', 'AWAITING_REVIEW', 'WAITING_APPROVAL'] } },
          orderBy: { createdAt: 'desc' },
          take: 15,
          include: { agentRuns: { orderBy: { createdAt: 'asc' } } },
        }),
        prisma.incident.findMany({
          where: { status: { notIn: ['DETECTED', 'INVESTIGATING', 'AWAITING_REVIEW', 'WAITING_APPROVAL'] } },
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { agentRuns: { orderBy: { createdAt: 'asc' } } },
        }),
        prisma.agentRun.groupBy({
          by: ['status'],
          _count: { _all: true },
        }),
        offeredModels(),
        Promise.resolve(telegramConfig()),
        checkTelegramConnectivity(),
      ])
    // Active incidents appear first so the UI always shows the current state.
    const seenIds = new Set(activeIncidents.map((i) => i.id))
    const incidents = [
      ...activeIncidents,
      ...recentTerminalIncidents.filter((i) => !seenIds.has(i.id)),
    ].slice(0, 20)

    const telegramRecents = await prisma.telegramNotification.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        type: true,
        severity: true,
        deliveryStatus: true,
        telegramMessageId: true,
        error: true,
        createdAt: true,
        incidentId: true,
      },
    })

    const lastDelivery = await prisma.telegramNotification.findFirst({
      orderBy: { createdAt: 'desc' },
      select: {
        type: true,
        deliveryStatus: true,
        telegramMessageId: true,
        error: true,
        createdAt: true,
      },
    })
    const lastIncident = await prisma.incident.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { ref: true, status: true, severity: true, createdAt: true, telegramNotifications: { orderBy: { createdAt: 'desc' }, take: 3, select: { type: true, deliveryStatus: true, createdAt: true } } },
    })

    const agentStats = Object.fromEntries(
      agentCounts.map((row) => [row.status, row._count._all]),
    )

    const configured = configuredModel()
    const offered = modelOptions
    const modelValid = offered === null ? null : offered.includes(configured)

    await logger.info({
      service: 'security',
      message: 'Security status fetched',
      route: '/api/security/status',
      method: 'GET',
      status: 200,
      requestId,
    })

    return NextResponse.json({
      canOperate: userIsOperator,
      operators: securityOperators(),
      tiers: {
        table: ['dashboard', 'incident', 'heightened', 'critical'],
        thresholds: { dashboardMax: 39, incidentMax: 69, heightenedMax: 89 },
      },
      overview,
      tier: riskTier(overview.riskScore),
      findings,
      incidents: incidents.map((incident) => ({
        id: incident.id,
        ref: incident.ref,
        status: incident.status,
        severity: incident.severity,
        riskScore: incident.riskScore,
        title: incident.title,
        endpoint: incident.endpoint,
        method: incident.method,
        errorCode: incident.errorCode,
        expectedRootCause: incident.expectedRootCause,
        detectedBy: incident.detectedBy,
        summary: incident.summary,
        createdAt: incident.createdAt.toISOString(),
        updatedAt: incident.updatedAt.toISOString(),
        agentRuns: incident.agentRuns.map((run) => ({
          id: run.id,
          agent: run.agent,
          role: run.role,
          status: run.status,
          progress: run.progress,
          currentActivity: run.currentActivity,
          outputSummary: run.outputSummary,
          confidence: run.confidence,
          mode: run.mode,
          model: run.model,
          error: run.error,
          completedAt: run.completedAt?.toISOString() ?? null,
        })),
      })),
      agents: agentStats,
      model: {
        provider: aiProviderName(),
        mode: providerModeLabel(),
        configured,
        offered,
        valid: modelValid,
      },
      telegram: {
        configured: config.configured,
        chatId: config.chatId,
        status: {
          reachable: connectivity.reachable,
          botUsername: connectivity.botUsername,
          latencyMs: connectivity.latencyMs,
          error: connectivity.error,
          configured: connectivity.configured,
          checkedAt: new Date().toISOString(),
        },
        lastDelivery: lastDelivery
          ? {
              type: lastDelivery.type,
              deliveryStatus: lastDelivery.deliveryStatus,
              telegramMessageId: lastDelivery.telegramMessageId,
              error: lastDelivery.error,
              createdAt: lastDelivery.createdAt.toISOString(),
            }
          : null,
        lastIncident: lastIncident
          ? {
              ref: lastIncident.ref,
              status: lastIncident.status,
              severity: lastIncident.severity,
              createdAt: lastIncident.createdAt.toISOString(),
              deliveries: lastIncident.telegramNotifications.map((row) => ({
                type: row.type,
                deliveryStatus: row.deliveryStatus,
                createdAt: row.createdAt.toISOString(),
              })),
            }
          : null,
        recent: telegramRecents.map((row) => ({
          id: row.id,
          type: row.type,
          severity: row.severity,
          deliveryStatus: row.deliveryStatus,
          telegramMessageId: row.telegramMessageId,
          error: row.error,
          incidentId: row.incidentId,
          createdAt: row.createdAt.toISOString(),
        })),
      },
    })
  } catch (err) {
    return handleApiError(err)
  }
}