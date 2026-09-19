import 'server-only'

import { createHash } from 'node:crypto'
import { prisma } from './db'
import {
  SEVERITY_CYBER_IMPACT,
  SEVERITY_RISK_WEIGHTS,
} from './observability'
import { callAgent, configuredModel } from './ai'
import type { AgentOutput, AgentContext, AgentKind } from './ai'
import { sendTelegram } from './telegram'
import { sendIncidentAlert, buildAttackAnalysisMessage } from './notifications/summary'
import { computeSecurityOverview } from './risk'
import { suspectSourceFor } from './routes-map'
import { getSessionUser, safeUser } from './auth'
import type { Incident, IncidentSeverity } from '@prisma/client'
import { Prisma } from '@prisma/client'
import type { SafeUser } from './auth'
import { NextResponse } from 'next/server'
import { createApproval } from './approval'
import { sendSecurityIncidentEmail } from './gmail'

// Phase 8 — security finding ingest, incident promotion and the real agent
// pipeline. Fingerprinting/correlation happens here (Next.js side) so the
// Python analyzer stays a dumb, pure emitter.

export const ANALYZER_CONTRACT_VERSION = 2

export interface AnalyzerFinding {
  ruleId: string
  title: string
  severity: IncidentSeverity
  endpoint?: string | null
  method?: string | null
  detail?: string | null
  windowStartMs: number
  bucketKey: string
  count: number
  requestIds?: string[]
}

const SEVERITY_RANK: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
}

export function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 0
}

export function fingerprintFor(finding: AnalyzerFinding): string {
  const canonical = [
    finding.ruleId,
    String(finding.windowStartMs),
    finding.bucketKey ?? 'global',
    finding.endpoint ?? '',
    finding.method ?? '',
    finding.severity,
  ].join('|')
  return createHash('sha1').update(canonical).digest('hex')
}

export function serializeFinding(row: {
  id: string
  fingerprint: string
  ruleId: string
  title: string
  severity: IncidentSeverity
  endpoint: string | null
  method: string | null
  detail: string | null
  signal: unknown
  status: string
  hitCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  createdAt: Date
}) {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    ruleId: row.ruleId,
    title: row.title,
    severity: row.severity,
    endpoint: row.endpoint,
    method: row.method,
    detail: row.detail,
    status: row.status,
    hitCount: row.hitCount,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }
}

async function storeFinding(finding: AnalyzerFinding, fingerprint: string) {
  const existing = await prisma.securityFinding.findUnique({
    where: { fingerprint },
  })
  if (existing) {
    if (existing.status === 'DISMISSED') {
      return { fingerprint, created: false, dismissed: true }
    }
    await prisma.securityFinding.update({
      where: { fingerprint },
      data: {
        title: existing.title,
        severity: existing.severity,
        hitCount: existing.hitCount + Math.max(1, finding.count ?? 1),
        lastSeenAt: new Date(),
        detail: finding.detail ?? existing.detail,
      },
    })
    return { fingerprint, created: false, dismissed: false }
  }
  await prisma.securityFinding.create({
    data: {
      fingerprint,
      ruleId: finding.ruleId,
      title: finding.title,
      severity: finding.severity,
      endpoint: finding.endpoint ?? null,
      method: finding.method ?? null,
      detail: finding.detail ?? null,
      signal: {
        windowStartMs: finding.windowStartMs,
        bucketKey: finding.bucketKey,
        count: finding.count,
        requestIds: (finding.requestIds ?? []).slice(0, 8),
      },
      status: 'DETECTED',
      hitCount: Math.max(1, finding.count ?? 1),
    },
  })
  return { fingerprint, created: true, dismissed: false }
}

export async function ingestAnalyzerFindings(
  findings: AnalyzerFinding[],
): Promise<{ created: number; updated: number; ignored: number }> {
  let created = 0
  let updated = 0
  let ignored = 0
  for (const finding of findings) {
    const result = await storeFinding(finding, fingerprintFor(finding))
    if (result.created) created += 1
    else if (result.dismissed) ignored += 1
    else updated += 1
  }
  return { created, updated, ignored }
}

async function addIncidentEvent(
  incidentId: string,
  stage: string,
  label: string,
  detail?: string,
) {
  await prisma.incidentEvent.create({
    data: { incidentId, stage, label, detail: detail ?? null },
  })
}

export async function nextIncidentRef(): Promise<string> {
  const rows = await prisma.incident.findMany({ select: { ref: true } })
  let max = 0
  for (const row of rows) {
    const match = row.ref.match(/^INC-(\d+)$/)
    if (match) max = Math.max(max, Number.parseInt(match[1], 10))
  }
  return `INC-${String(max + 1).padStart(5, '0')}`
}

function descriptionFor(finding: AnalyzerFinding): string {
  return [
    `${finding.title} (rule ${finding.ruleId}).`,
    `${finding.count ?? 1} matching events observed` +
      `${finding.windowStartMs ? ` in a window starting at ${new Date(finding.windowStartMs).toISOString()}` : ''}.`,
    `${finding.detail ?? 'The security log analyzer correlated these rows from real BuildHub log_events.'}`,
  ].join(' ')
}

export async function createIncidentFromFinding(
  finding: AnalyzerFinding,
): Promise<Incident> {
  const ref = await nextIncidentRef()
  const firstRequestId =
    (finding.requestIds ?? []).find((id) => typeof id === 'string') ?? null
  return prisma.incident.create({
    data: {
      ref,
      status: 'DETECTED',
      severity: finding.severity,
      riskScore: SEVERITY_RISK_WEIGHTS[finding.severity] ?? 0,
      cyberSafetyImpact: SEVERITY_CYBER_IMPACT[finding.severity] ?? 0,
      title: finding.title,
      description: descriptionFor(finding),
      endpoint: finding.endpoint ?? 'unknown',
      method: finding.method ?? 'ANY',
      requestId: firstRequestId,
      errorCode: finding.ruleId.toUpperCase(),
      expectedRootCause: null,
      detectedBy: `security-log-analyzer v${ANALYZER_CONTRACT_VERSION} · ${finding.ruleId}`,
    },
  })
}

export async function queueAgentRuns(incidentId: string): Promise<void> {
  const specs: Array<[AgentKind, string]> = [
    ['FIXER', 'Candidate generator'],
    ['CRITIC', 'Candidate reviewer'],
    ['JUDGE', 'Final arbiter'],
  ]
  for (const [agent, role] of specs) {
    await prisma.agentRun.create({
      data: {
        incidentId,
        agent,
        role,
        status: 'QUEUED',
        progress: 0,
        currentActivity: 'Queued for real Groq analysis',
        mode: 'REAL',
        model: configuredModel(),
      },
    })
  }
}

/**
 * Promotes all DETECTED findings into incidents with queued REAL agent runs and
 * marks the finding PROCESSED (idempotent: re-running without new findings is a
 * no-op).
 */
export async function promoteFindingsToIncidents(): Promise<{
  promoted: string[]
  remaining: number
}> {
  const findings = await prisma.securityFinding.findMany({
    where: { status: 'DETECTED' },
    orderBy: [{ severity: 'asc' }, { lastSeenAt: 'desc' }],
  })

  const promoted: string[] = []
  for (const finding of findings) {
    const incident = await createIncidentFromFinding({
      ruleId: finding.ruleId,
      title: finding.title,
      severity: finding.severity,
      endpoint: finding.endpoint,
      method: finding.method,
      detail: finding.detail,
      windowStartMs: finding.createdAt.getTime(),
      bucketKey: 'promote',
      count: finding.hitCount,
      requestIds: Array.isArray(finding.signal)
        ? []
        : ((finding.signal as { requestIds?: string[] } | null)?.requestIds ?? []),
    })
    await queueAgentRuns(incident.id)
    await addIncidentEvent(
      incident.id,
      'DETECTED',
      'Security anomaly detected',
      `${finding.ruleId} · ${finding.title} · ${finding.hitCount} evidence rows`,
    )
    await addIncidentEvent(
      incident.id,
      'INVESTIGATING',
      'Real AI analysis queued',
      `Fixer → Critic → Judge queued (mode=REAL, ${configuredModel()})`,
    )
    // Initial INCIDENT alert — one push at incident creation. Any later
    // INCIDENT attempt for the same incident is deduplicated (SKIPPED_DUPLICATE).
    await sendIncidentAlert(incident).catch(() => undefined)
    await prisma.securityFinding.update({
      where: { id: finding.id },
      data: { status: 'PROCESSED' },
    })
    promoted.push(incident.ref)
  }

  const remaining = await prisma.securityFinding.count({
    where: { status: 'DETECTED' },
  })
  return { promoted, remaining }
}

function evidenceCountOf(incident: Incident): number {
  return (
    (incident as Incident & { _count?: { logs?: number } })._count?.logs ?? 0
  )
}

function agentContextFor(incident: Incident): AgentContext {
  return {
    incidentRef: incident.ref,
    incidentId: incident.id,
    severity: incident.severity,
    title: incident.title,
    description: incident.description,
    summary: incident.summary,
    endpoint: incident.endpoint,
    method: incident.method,
    errorCode: incident.errorCode,
    requestId: incident.requestId,
    expectedRootCause: incident.expectedRootCause,
    suspectSource: suspectSourceFor(incident.endpoint),
    ruleId: (incident.errorCode ?? 'UNKNOWN').toLowerCase(),
    detectedBy: incident.detectedBy ?? 'BuildHub monitoring',
    evidenceCount: evidenceCountOf(incident),
  }
}

export interface PipelineResult {
  ok: boolean
  incidentRef: string | null
  runs: Array<{ agent: AgentKind; status: string; summary?: string; error?: string }>
  aiUnavailable: boolean
  telegram: { sent: boolean; reason: string }
  gmail: { sent: boolean; reason: string }
}

/**
 * Executes the REAL Fixer → Critic → Judge pipeline for an incident. Failures
 * are always recorded honestly (FAILED status + error, no fabricated output)
 * and a Telegram alert still fires when the severity warrants one.
 */
export async function runAgentPipeline(incidentId: string): Promise<PipelineResult> {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: {
      _count: { select: { logs: true } },
      agentRuns: {
        where: { mode: 'REAL', incidentId },
        orderBy: { createdAt: 'asc' },
      },
    },
  })
  if (!incident) {
    return {
      ok: false,
      incidentRef: null,
      runs: [],
      aiUnavailable: false,
      telegram: { sent: false, reason: 'incident not found' },
      gmail: { sent: false, reason: 'incident not found' },
    }
  }

  const runs = incident.agentRuns.sort((a, b) => {
    const order: Record<string, number> = { FIXER: 0, CRITIC: 1, JUDGE: 2 }
    return order[a.agent] - order[b.agent]
  })
  const summarizeRuns = (r: (typeof runs)[number]) => ({
    agent: r.agent as AgentKind,
    status: r.status,
  })
  if (runs.some((run) => run.status === 'COMPLETE')) {
    return {
      ok: false,
      incidentRef: incident.ref,
      runs: runs.map(summarizeRuns),
      aiUnavailable: false,
      telegram: { sent: false, reason: 'pipeline already completed for this incident' },
      gmail: { sent: false, reason: 'pipeline already completed for this incident' },
    }
  }
  if (runs.some((run) => run.status === 'ANALYZING')) {
    return {
      ok: false,
      incidentRef: incident.ref,
      runs: runs.map(summarizeRuns),
      aiUnavailable: false,
      telegram: { sent: false, reason: 'pipeline currently running for this incident' },
      gmail: { sent: false, reason: 'pipeline currently running for this incident' },
    }
  }

  const ctx = agentContextFor(incident)
  const resultRuns: Array<{ agent: AgentKind; status: string; summary?: string; error?: string }> = []
  let prior: AgentOutput | undefined
  let fixerRootCause: string | null = null
  let failed: { agent: AgentKind; error: string } | null = null

  for (const agentKind of ['FIXER', 'CRITIC', 'JUDGE'] as const) {
    const row = runs.find((r) => r.agent === agentKind)
    if (!row) continue

    if (failed) {
      await prisma.agentRun.update({
        where: { id: row.id },
        data: {
          status: 'FAILED',
          progress: 100,
          currentActivity: null,
          error: `Not executed: ${failed.agent} failed earlier.`,
          completedAt: new Date(),
        },
      })
      resultRuns.push({ agent: agentKind, status: 'FAILED', error: failed.error })
      continue
    }

    await prisma.agentRun.update({
      where: { id: row.id },
      data: {
        status: 'ANALYZING',
        progress: 40,
        currentActivity: `Calling Groq (${configuredModel()}, mode=REAL)`,
      },
    })

    const result = await callAgent(agentKind, ctx, prior)
    if (result.ok && result.output) {
      prior = result.output
      if (agentKind === 'FIXER') fixerRootCause = result.output.hypothesizedRootCause ?? null
      await prisma.agentRun.update({
        where: { id: row.id },
        data: {
          status: 'COMPLETE',
          progress: 100,
          currentActivity: null,
          output: result.output as unknown as Prisma.InputJsonValue,
          outputSummary: result.output.summary.slice(0, 300),
          confidence: result.output.confidence,
          model: result.model,
          completedAt: new Date(),
        },
      })
      await addIncidentEvent(
        incident.id,
        'ANALYZING',
        `${agentKind} completed`,
        result.output.summary.slice(0, 400),
      )
      resultRuns.push({
        agent: agentKind,
        status: 'COMPLETE',
        summary: result.output.summary,
      })
      continue
    }

    await prisma.agentRun.update({
      where: { id: row.id },
      data: {
        status: 'FAILED',
        progress: 100,
        currentActivity: null,
        output: { error: result.error },
        error: result.error,
        model: result.model,
        completedAt: new Date(),
      },
    })
    failed = { agent: agentKind, error: result.error ?? 'Groq call failed' }
    await addIncidentEvent(
      incident.id,
      'ANALYZING',
      `${agentKind} failed (AI unavailable)`,
      (result.error ?? 'AI call failed').slice(0, 400),
    )
    resultRuns.push({ agent: agentKind, status: 'FAILED', error: result.error })
  }

  const aiUnavailable = failed !== null
  let telegram: PipelineResult['telegram'] = { sent: false, reason: 'no alert sent' }
  let gmail: PipelineResult['gmail'] = { sent: false, reason: 'no email sent' }

  if (!aiUnavailable) {
    const judge = runs.find((r) => r.agent === 'JUDGE')
    await prisma.incident.update({
      where: { id: incident.id },
      data: {
        status: 'AWAITING_REVIEW',
        summary: judge?.outputSummary ?? null,
        expectedRootCause: fixerRootCause,
      },
    })
    await addIncidentEvent(
      incident.id,
      'AWAITING_REVIEW',
      'Human review required',
      'AI analysis complete — candidate is text-only; nothing was auto-applied.',
    )
    // Create an approval request so a human (or test harness) can authorize
    // the proposed repair. The approval maps to the specific incident and
    // the patch identified by the AI output.
    const operatorResult = await getSessionUser()
    const operatorName = operatorResult?.username ?? 'unknown'
    await createApproval({
      incidentId: incident.id,
      patchId: `PATCH-${incident.id.slice(0, 8)}`,
      operator: operatorName,
    })
    // Telegram routing is driven by the overall deterministic risk score at
    // alert time (findings may already be PROCESSED, dropping the security
    // penalty term), so a real incident above the dashboard-only floor gets a
    // push even when its own recorded riskScore was a plain severity weight.
    const overall = await computeSecurityOverview()
    telegram = await alertTelegramForIncident(incident, overall.riskScore)
    const gmailResult = await sendSecurityIncidentEmail({ incident })
    gmail = gmailResult.ok
      ? { sent: true, reason: `sent${gmailResult.gmailMessageId ? ` · ${gmailResult.gmailMessageId}` : ''}` }
      : { sent: false, reason: gmailResult.error ?? gmailResult.deliveryStatus }
  }

  return {
    ok: !aiUnavailable,
    incidentRef: incident.ref,
    runs: resultRuns,
    aiUnavailable,
    telegram,
    gmail,
  }
}

async function alertTelegramForIncident(
  incident: Incident,
  _riskScore: number,
): Promise<PipelineResult['telegram']> {
  // Canonical attack assessment built from the SAME persisted facts the UI,
  // PDF and AI chat use (buildIncidentBrief). One ESCALATION per incident
  // (delivery layer dedupes any retry).
  const message = await buildAttackAnalysisMessage(incident)
  const result = await sendTelegram({
    type: 'ESCALATION',
    incidentId: incident.id,
    severity: incident.severity,
    message,
  })
  if (result.ok) return { sent: true, reason: 'sent' }
  return { sent: false, reason: `send failed: ${result.error}` }
}

// ---------------------------------------------------------------------------
// Security operator authorization
// ---------------------------------------------------------------------------

export function securityOperators(): string[] {
  const raw = process.env.SECURITY_OPERATOR_USERNAMES?.trim() || 'arjun'
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

export function isSecurityOperator(user: { username: string } | null): boolean {
  if (!user) return false
  return securityOperators().includes(user.username)
}

/**
 * Resolves the current session user and whether they are a security operator.
 * Returns a SafeUser (secret-free) always; no exception is thrown.
 */
export async function resolveOperatorContext(): Promise<{
  user: SafeUser | null
  operator: boolean
}> {
  const user = await getSessionUser()
  if (!user) return { user: null, operator: false }
  return { user: safeUser(user), operator: isSecurityOperator(user) }
}

/**
 * Route guard for operator-only endpoints: 401 when unauthenticated, 403 when
 * the signed-in user is not a security operator, otherwise passes the SafeUser.
 */
export async function requireSecurityOperator(): Promise<
  { ok: true; user: SafeUser } | { ok: false; response: NextResponse }
> {
  const context = await resolveOperatorContext()
  if (!context.user) {
    return { ok: false, response: NextResponse.json({ error: 'Authentication required.' }, { status: 401 }) }
  }
  if (!context.operator) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Security operator required.' }, { status: 403 }),
    }
  }
  return { ok: true, user: context.user }
}
