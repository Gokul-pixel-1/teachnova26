import { NextResponse } from 'next/server'

import { requireSecurityOperator, runAgentPipeline } from '@/lib/server/security'
import { runSelfHealingRepair } from '@/lib/server/repair/engine'
import { isRepairInFlight } from '@/lib/server/repair/auto-trigger'
import { prisma } from '@/lib/server/db'
import { errorResponse, firstZodIssue, handleApiError } from '@/lib/server/response'
import { logger, resolveRequestId } from '@/lib/server/logger'
import { runPipelineSchema } from '@/lib/validation'

// Phase 9 — repairs incidents.
//
// Runtime incidents discovered from REAL ERROR logs by the log monitor
// (incident.metadata.source === 'log-monitor') — and any legacy fault-triggered
// incident — run the full self-healing conversation engine (evidence →
// Coder/Critic → Judge → risk → patch → validation → resolve/rollback).
// Security-log-analyzer incidents keep the legacy single-pass
// Fixer/Critic/Judge analysis pipeline. Nothing is faked: model failures are
// recorded as AI UNAVAILABLE / AI_REPAIR_FAILED.
export async function POST(request: Request) {
  const requestId = resolveRequestId(request)

  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid request body.', 400)
  }

  const parsed = runPipelineSchema.safeParse(body)
  if (!parsed.success) {
    return errorResponse(firstZodIssue(parsed.error), 400)
  }

  try {
    const incident = await prisma.incident.findUnique({
      where: { id: parsed.data.incidentId },
      select: { id: true, ref: true, metadata: true },
    })
    if (!incident) return errorResponse('Incident not found.', 404)

    const metadata = (incident.metadata ?? null) as { source?: string; faultId?: string } | null
    const isRuntime = metadata?.source === 'log-monitor' || Boolean(metadata?.faultId)

    // Never let a manual run and an automatic run race on the SAME incident:
    // the auto-trigger may already be repairing it in the background.
    if (isRuntime && isRepairInFlight(parsed.data.incidentId)) {
      return NextResponse.json(
        {
          ok: false,
          incidentRef: incident.ref,
          stage: 'ALREADY_RUNNING',
          error: 'A repair is already running for this incident.',
        },
        { status: 409 },
      )
    }

    const result = isRuntime
      ? await runSelfHealingRepair(incident.id, { scenario: parsed.data.scenario })
      : await runAgentPipeline(incident.id)

    await logger.info({
      service: 'security',
      message: 'Repair pipeline run requested',
      route: '/api/security/run',
      method: 'POST',
      status: 200,
      requestId,
      incidentId: parsed.data.incidentId,
      errorCode: isRuntime ? null : (result as { aiUnavailable?: boolean }).aiUnavailable ? 'AI_UNAVAILABLE' : null,
    })

    return NextResponse.json(result)
  } catch (err) {
    return handleApiError(err)
  }
}