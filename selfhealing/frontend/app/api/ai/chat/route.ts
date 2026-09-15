import { NextResponse } from 'next/server'
import { z } from 'zod'

import { requireSecurityOperator } from '@/lib/server/security'
import { getProvider, providerConfiguredModel, providerModeLabel, testModeEnabled } from '@/lib/server/provider'
import { logger, resolveRequestId } from '@/lib/server/logger'
import { errorResponse, handleApiError, firstZodIssue } from '@/lib/server/response'
import { prisma } from '@/lib/server/db'
import { buildIncidentBrief } from '@/lib/server/notifications/brief'
import { getRewardPolicy } from '@/lib/server/learning/memory'

// POST /api/ai/chat — operator-facing Q&A with the configured model provider.
// The operator's message is the only free input; every fact the model may use
// comes from the SAME canonical incident brief (buildIncidentBrief) that drives
// Telegram, the incident detail and the PDF — so the chat can never invent
// incident state. In hermetic TEST mode the provider is never called and a
// deterministic TEST-mode reply is returned instead.
const chatSchema = z.object({
  message: z.string().trim().min(1, 'message is required.').max(2000),
})

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
  const parsed = chatSchema.safeParse(body)
  if (!parsed.success) {
    return errorResponse(firstZodIssue(parsed.error), 400)
  }

  try {
    const mode = providerModeLabel()
    const model = providerConfiguredModel()

    if (testModeEnabled() || mode === 'TEST') {
      await logger.info({
        service: 'ai-chat',
        message: 'Chat request (TEST mode — provider not called)',
        route: '/api/ai/chat',
        method: 'POST',
        status: 200,
        requestId,
      })
      return NextResponse.json({
        ok: true,
        mode: 'TEST',
        model,
        reply: `[TEST mode] The generated chat reply is disabled while SELF_HEALING_TEST_MODE is active so no fabrication ever reaches the operator chat. Configure a real provider to enable live Q&A.`,
      })
    }

    const provider = getProvider()

    // Observed alert-delivery context (safe, persisted facts — never secrets).
    const now = new Date()
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const [deliveryCounts, gmailCounts, lastIncident, lastHigh, memories] = await Promise.all([
      prisma.telegramNotification.groupBy({
        by: ['deliveryStatus'],
        where: { createdAt: { gte: dayAgo } },
        _count: { _all: true },
      }),
      prisma.gmailNotification.groupBy({
        by: ['deliveryStatus'],
        where: { createdAt: { gte: dayAgo } },
        _count: { _all: true },
      }),
      prisma.incident.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { id: true, ref: true },
      }),
      prisma.incident.findFirst({
        where: { severity: 'HIGH' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, ref: true },
      }),
      prisma.repairMemory.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          errorSignature: true,
          outcome: true,
          reward: true,
          recurrenceCount: true,
          humanDecision: true,
          risk: true,
          incident: { select: { ref: true, status: true, severity: true } },
        },
      }),
    ])

    const deliverySummary = deliveryCounts.length
      ? deliveryCounts.map((c) => `${c.deliveryStatus} ${c._count._all}`).join(', ')
      : 'none in the last 24h'
    const gmailSummary = gmailCounts.length
      ? gmailCounts.map((c) => `${c.deliveryStatus} ${c._count._all}`).join(', ')
      : 'none in the last 24h'

    // Canonical incident brief → the exact same facts the Telegram alert used.
    let incidentBriefText = 'no incidents on record.'
    let deliverabilityNote = ''
    if (lastIncident) {
      const brief = await buildIncidentBrief(lastIncident.id)
      if (brief) {
        const judge = brief.aiAnalysis.judge
        const judgeLine = judge ? `Judge ${judge.decision} (${judge.confidence ?? 'n/a'}%)` : 'Judge not run'
        const riskLine = `risk ${brief.risk.tier ?? 'UNDETERMINED'}${brief.risk.requiresApproval ? ' (approval required)' : ''}`
        const approvalLine = brief.approval
          ? `approval ${brief.approval.approvalId} ${brief.approval.status}`
          : 'no approval'
        const validationLine = `validation ${brief.validation.result}${
          brief.validation.result === 'pass' && brief.validation.probes.length > 0
            ? ` (${brief.validation.probes.length} probes ok)`
            : ''
        }`
        incidentBriefText =
          `latest incident ${brief.incident.ref} (${brief.incident.severity}) status=${brief.incident.status} ` +
          `riskScore=${brief.incident.riskScore}; attack=${brief.attack ? 'yes (security-log-analyzer)' : 'no'}; ` +
          `endpoint=${brief.incident.method} ${brief.incident.endpoint}; errorCode=${brief.incident.errorCode ?? 'n/a'}; ` +
          `root cause: ${brief.rootCause ?? 'n/a'}; proposed fix: ${brief.proposedFix ?? 'n/a'}; ${judgeLine}; ` +
          `${riskLine}; ${approvalLine}; ${validationLine}; ` +
          `code change: ${brief.codeChange ? 'before/after proposed' : 'none proposed'} (file ${brief.location?.file ?? 'n/a'}); ` +
          `provider mode: ${brief.aiAnalysis.providerMode ?? 'n/a'}`
        const last = brief.delivery.last
        if (last) {
          if (last.status === 'FAILED') {
            deliverabilityNote = ' Telegram delivery failed for the latest incident.'
          } else if (last.status === 'SENT') {
            deliverabilityNote = ` Latest Telegram delivery for the latest incident was SENT (${last.type}).`
          } else {
            deliverabilityNote = ` Latest Telegram attempt for the latest incident was ${last.status}.`
          }
        }
      }
    }

    // Last HIGH-risk incident (answers "what happened with the last HIGH incident?").
    let highBriefText = ' No HIGH-risk incidents on record.'
    if (lastHigh && (!lastIncident || lastHigh.id !== lastIncident.id)) {
      const highBrief = await buildIncidentBrief(lastHigh.id)
      if (highBrief) {
        const judge = highBrief.aiAnalysis.judge
        highBriefText =
          ` Last HIGH incident ${highBrief.incident.ref}: status=${highBrief.incident.status}; ` +
          `endpoint=${highBrief.incident.method} ${highBrief.incident.endpoint}; ` +
          `root cause: ${highBrief.rootCause ?? 'n/a'}; proposed fix file ${highBrief.location?.file ?? 'n/a'}; ` +
          `coder: ${(highBrief.aiAnalysis.rounds.map((r) => r.coder.diagnosis).find(Boolean) ?? 'n/a').slice(0, 200)}; ` +
          `critic: ${(highBrief.aiAnalysis.rounds.map((r) => r.critic.verdict).find(Boolean) ?? 'n/a')}; ` +
          `judge: ${judge ? `${judge.decision} (${judge.confidence ?? 'n/a'}%)` : 'not run'}; ` +
          `approval: ${highBrief.approval ? `${highBrief.approval.approvalId} ${highBrief.approval.status}` : 'none'}; ` +
          `validation: ${highBrief.validation.result}; final: ${highBrief.incident.status}.`
      }
    }

    // Repair memory (answers "have we seen this error before?").
    let memoryText = ' Repair memory is empty.'
    if (memories.length > 0) {
      const rows = memories.map(
        (m) =>
          `${m.incident.ref} [${m.incident.severity}/${m.outcome}, reward ${m.reward >= 0 ? '+' : ''}${m.reward}` +
          `${m.recurrenceCount > 0 ? `, error returned ${m.recurrenceCount}× after` : ''}` +
          `${m.humanDecision ? `, human ${m.humanDecision}` : ''}] sig=${m.errorSignature.slice(0, 60)}`,
      )
      memoryText = ` Recent repair experiences (${memories.length}): ${rows.join(' | ')}.`
    }

    const policy = getRewardPolicy()
    const rewardText =
      `RESOLVED +${policy.successfulRepair} (+${policy.humanApproval} if human-approved), ` +
      `ROLLED_BACK ${policy.rollback}/${policy.validationFailure}, AI_REPAIR_FAILED ${policy.validationFailure}, ` +
      `REJECTED ${policy.rejection}, same-error-returns ${policy.regression}`

    const context =
      `Observed system facts (last 24h): Telegram delivery counts: ${deliverySummary}. Gmail delivery counts: ${gmailSummary}. ` +
      `${incidentBriefText}.${deliverabilityNote}` +
      `${highBriefText}` +
      `${memoryText}` +
      ` Reward policy (outcome-only): ${rewardText}.`

    const result = await provider.call({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are the BuildHub operations assistant. Answer operator questions about the BuildHub developer collaboration platform, its monitoring, fault-injection sandbox, self-healing repair pipeline, Telegram and Gmail alerting, and repair-memory learning. ' +
            'Be concise and factual. The following OBSERVED facts are real persisted BuildHub state — you may reference them directly, but never invent state beyond them: ' +
            context,
        },
        { role: 'user', content: parsed.data.message },
      ],
      maxTokens: 600,
      temperature: 0.4,
      context: { role: 'JUDGE', round: 0 },
    })

    await logger.info({
      service: 'ai-chat',
      message: `Chat request ${result.ok ? 'complete' : `failed: ${result.error ?? ''}`}`,
      route: '/api/ai/chat',
      method: 'POST',
      status: 200,
      requestId,
    })

    if (!result.ok || !result.content) {
      return NextResponse.json(
        { ok: false, mode: 'REAL', model, reply: null, error: result.error ?? 'empty completion' },
        { status: 502 },
      )
    }

    return NextResponse.json({ ok: true, mode: 'REAL', model, reply: result.content })
  } catch (err) {
    return handleApiError(err)
  }
}