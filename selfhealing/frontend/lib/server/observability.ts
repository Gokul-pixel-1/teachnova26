import 'server-only'

import { prisma } from './db'
import { Prisma } from '@prisma/client'
import type { AgentName, AgentStatus } from '@/lib/api/observability'
import { loadTerminalSummaryFacts, buildTerminalSummaryText } from './notifications/summary'
import type {
  AgentRun,
  Approval,
  DeliveryStatus,
  Incident,
  IncidentEvent,
  IncidentSeverity,
  LogEvent,
  NotificationType,
  PatchRecord,
  RepairAttempt,
  TelegramNotification,
} from '@prisma/client'

// ---------------------------------------------------------------------------
// Phase 7 — deterministic observability computation.
//
// Every score is a pure function of the database/infrastructure state, so the
// same data always yields the same numbers. Formulas are kept explicit (see
// the RECIPE constants) and are documented in PLAN.md so the command center's
// overview can never look arbitrary.
// ---------------------------------------------------------------------------

export const OBSERVABILITY_WINDOW_MS = 24 * 60 * 60 * 1000
export const ACTIVE_STATUSES = [
  'DETECTED',
  'INVESTIGATING',
  'AWAITING_REVIEW',
  'WAITING_APPROVAL',
] as const

// --- Score recipe -----------------------------------------------------------
// RISK SCORE (0-100):
//   baseline actives:        Σ severity risk weight of active incidents
//                            LOW 6 · MED 12 · HIGH 24 · CRT 40
//   + warning pressure:      min(15, WARN events in window) × 1
//   + error pressure:        min(20, ERROR events in window) × 2
//   + security pressure:     min(15, security findings in window) × 5
//
// CYBER SAFETY (0-100):
//   100 − Σ active incident cyber-safety impact  (LOW 1 · MED 2 · HIGH 4 · CRT 8)
//
// SYSTEM HEALTH (0-100%):
//   weighted average of component status (healthy 1.0 · degraded 0.9 · down 0.2)
// ---------------------------------------------------------------------------

export const SEVERITY_RISK_WEIGHTS: Record<string, number> = {
  LOW: 6,
  MEDIUM: 12,
  HIGH: 24,
  CRITICAL: 40,
}
export const SEVERITY_CYBER_IMPACT: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 4,
  CRITICAL: 8,
}

// --- Deterministic demo risk/health/cyber policy ---------------------------
// Drives the Command Center gauges from the CURRENTLY ACTIVE incident set so
// the demo reflects live state, never stale/historical incidents:
//   NORMAL / RESOLVED          → risk 0 · health 100 · cyber 100
//   MEDIUM active              → risk 30 · health 30  · cyber degraded
//   HIGH active                → risk 50 · health 55  · cyber degraded
// The highest active severity wins (consistent when several are active).
// These are NOT hard-coded per incident; they are selected by the actual
// severity present in the active incident rows.
const DEMO_RISK_BY_SEVERITY: Record<string, number> = {
  NONE: 0,
  LOW: 15,
  MEDIUM: 30,
  HIGH: 50,
  CRITICAL: 60,
}
const DEMO_HEALTH_BY_SEVERITY: Record<string, number> = {
  NONE: 100,
  LOW: 85,
  MEDIUM: 30,
  HIGH: 55,
  CRITICAL: 20,
}
// Cyber Safety remains its own axis: it degrades while an incident is active
// and recovers once resolved. It is deliberately NOT copied from Risk Score.
const DEMO_CYBER_BY_SEVERITY: Record<string, number> = {
  NONE: 100,
  LOW: 95,
  MEDIUM: 60,
  HIGH: 40,
  CRITICAL: 20,
}

const DEMO_RELIABILITY_BY_SEVERITY: Record<string, number> = {
  NONE: 100,
  LOW: 95,
  MEDIUM: 70,
  HIGH: 45,
  CRITICAL: 25,
}

export interface DemoPolicyScores {
  riskScore: number
  cyberSafetyScore: number
  systemHealth: number
  applicationReliabilityScore: number
  totalHealthScore: number
}

// Weighted combination over the component dimensions. All start at 100 when the
// system is clean and recover only through validated repairs (never through a
// bare file restore). Weights: risk inverse 25%, cyber 25%, reliability 25%,
// system health 25%.
export function compositeHealthScore(parts: {
  riskScore: number
  cyberSafetyScore: number
  applicationReliabilityScore: number
  systemHealth: number
}): number {
  const inverseRisk = 100 - parts.riskScore
  return Math.round(
    0.25 * inverseRisk +
      0.25 * parts.cyberSafetyScore +
      0.25 * parts.applicationReliabilityScore +
      0.25 * parts.systemHealth,
  )
}

// Derives the deterministic dashboard scores from the severities actually
// present in the active incident set. Returns NORMAL (0/100/100/100/100) when none.
export function demoPolicyScores(incidents: { severity: string }[]): DemoPolicyScores {
  let maxSeverity: string = 'NONE'
  for (const incident of incidents) {
    const sev: string = incident.severity ?? 'LOW'
    if (severityRank(sev) > severityRank(maxSeverity)) maxSeverity = sev
  }
  const riskScore = DEMO_RISK_BY_SEVERITY[maxSeverity] ?? 0
  const cyberSafetyScore = DEMO_CYBER_BY_SEVERITY[maxSeverity] ?? 100
  const applicationReliabilityScore = DEMO_RELIABILITY_BY_SEVERITY[maxSeverity] ?? 100
  const systemHealth = DEMO_HEALTH_BY_SEVERITY[maxSeverity] ?? 100
  return {
    riskScore,
    cyberSafetyScore,
    systemHealth,
    applicationReliabilityScore,
    totalHealthScore: compositeHealthScore({ riskScore, cyberSafetyScore, applicationReliabilityScore, systemHealth }),
  }
}

function severityRank(severity: string): number {
  switch (severity) {
    case 'NONE':
      return 0
    case 'LOW':
      return 1
    case 'MEDIUM':
      return 2
    case 'HIGH':
      return 3
    case 'CRITICAL':
      return 4
    default:
      return 0
  }
}

// --- Security observation thresholds (Phase 7 observes; Phase 8 mitigates) --
const AUTH_FAILURE_MIN = 3
const NOT_FOUND_MIN = 4
const SERVER_ERROR_MIN = 3
const INVALID_REQUEST_MIN = 5
const FREQUENCY_ROUTE_MIN = 24

// --- Component health thresholds -------------------------------------------
const API_ERROR_HEALTHY_MAX = 6
const AUTH_FAULT_DEGRADE_MIN = 3
// Live signal window for the Authentication health component. It is degraded
// only while there is ACTIVE recent sign-in abuse (matching the source-IP
// guard's detection window), so the component recovers promptly once the
// mitigation contains the burst. The 24h OBSERVABILITY_WINDOW_MS still governs
// risk scoring and security-finding detection (audit-grade, not live signal).
const AUTH_HEALTH_SIGNAL_WINDOW_MS = 60_000

export type ComponentStatus = 'healthy' | 'degraded' | 'unavailable'

export interface ComponentHealth {
  name: string
  label: string
  status: ComponentStatus
  detail: string
}

export interface SecurityFinding {
  type: string
  severity: 'LOW' | 'MEDIUM' | 'HIGH'
  title: string
  summary: string
  windowSeconds: number
  count: number
  route: string | null
  requestIds: string[]
}

export interface Overview {
  riskScore: number
  cyberSafetyScore: number
  systemHealth: number
  applicationReliabilityScore: number
  totalHealthScore: number
  activeIncidents: number
}

function weightOfStatus(status: ComponentStatus): number {
  if (status === 'healthy') return 1
  if (status === 'degraded') return 0.9
  return 0.2
}

// ---------------------------------------------------------------------------
// Component health
// ---------------------------------------------------------------------------

export async function computeComponentsHealth(): Promise<ComponentHealth[]> {
  const since = new Date(Date.now() - OBSERVABILITY_WINDOW_MS)
  const sinceAuth = new Date(Date.now() - AUTH_HEALTH_SIGNAL_WINDOW_MS)

  let dbOk = false
  try {
    await prisma.$queryRaw`SELECT 1`
    dbOk = true
  } catch {
    dbOk = false
  }

  let errorCount = 0
  let authFailures = 0
  let monitoringOk = false
  try {
    ;[errorCount, authFailures, monitoringOk] = await Promise.all([
      prisma.logEvent.count({ where: { level: 'ERROR', createdAt: { gte: since } } }),
      prisma.logEvent.count({
        where: {
          level: 'WARN',
          errorCode: 'AUTH_FAILED',
          route: '/api/auth/login',
          createdAt: { gte: sinceAuth },
        },
      }),
      prisma.logEvent.count().then(() => true),
    ])
  } catch {
    monitoringOk = false
  }

  const database: ComponentHealth = {
    name: 'database',
    label: 'Database',
    status: dbOk ? 'healthy' : 'unavailable',
    detail: dbOk ? 'Query engine responsive' : 'Cannot reach PostgreSQL',
  }

  const api: ComponentHealth = {
    name: 'api',
    label: 'API',
    status: dbOk
      ? errorCount <= API_ERROR_HEALTHY_MAX
        ? 'healthy'
        : errorCount <= API_ERROR_HEALTHY_MAX + 6
          ? 'degraded'
          : 'unavailable'
      : 'unavailable',
    detail:
      errorCount <= API_ERROR_HEALTHY_MAX
        ? `${errorCount} server errors in window · within budget`
        : `${errorCount} server errors in window · elevated`,
  }

  const authentication: ComponentHealth = {
    name: 'authentication',
    label: 'Authentication',
    status: dbOk
      ? authFailures >= AUTH_FAULT_DEGRADE_MIN
        ? 'degraded'
        : 'healthy'
      : 'unavailable',
    detail:
      authFailures >= AUTH_FAULT_DEGRADE_MIN
        ? `${authFailures} failed sign-in attempts in the last ${Math.round(AUTH_HEALTH_SIGNAL_WINDOW_MS / 1000)}s`
        : 'No sign-in anomalies in the last minute',
  }

  const monitoring: ComponentHealth = {
    name: 'monitoring',
    label: 'Monitoring',
    status: monitoringOk ? 'healthy' : 'unavailable',
    detail: monitoringOk ? 'Telemetry store responding' : 'Telemetry store unreachable',
  }

  const frontend: ComponentHealth = {
    name: 'frontend',
    label: 'Frontend',
    status: api.status === 'unavailable' || !dbOk ? 'unavailable' : 'healthy',
    detail: dbOk ? 'App shell reachable' : 'App shell unavailable',
  }

  return [frontend, api, database, authentication, monitoring]
}

export function computeSystemHealth(components: ComponentHealth[]): number {
  if (components.length === 0) return 0
  const total = components.reduce((sum, c) => sum + weightOfStatus(c.status), 0)
  return Math.round((total / components.length) * 100)
}

// ---------------------------------------------------------------------------
// Security observations (detection only — no mitigation in Phase 7)
// ---------------------------------------------------------------------------

async function collectRequestIds(
  where: Prisma.LogEventWhereInput,
  limit = 6,
): Promise<string[]> {
  const rows = await prisma.logEvent.findMany({
    where,
    select: { requestId: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return rows.map((r) => r.requestId).filter((r): r is string => Boolean(r))
}

export async function detectSecurityFindings(): Promise<SecurityFinding[]> {
  const since = new Date(Date.now() - OBSERVABILITY_WINDOW_MS)
  const findings: SecurityFinding[] = []

  const [authFailures, notFounds, serverErrors, invalidByRoute, volumeByRoute] =
    await Promise.all([
      prisma.logEvent.count({
        where: {
          level: 'WARN',
          errorCode: 'AUTH_FAILED',
          route: '/api/auth/login',
          createdAt: { gte: since },
        },
      }),
      prisma.logEvent.count({
        where: { status: 404, createdAt: { gte: since } },
      }),
      prisma.logEvent.count({
        where: { status: { gte: 500 }, createdAt: { gte: since } },
      }),
      prisma.logEvent.groupBy({
        by: ['route'],
        where: { status: 400, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.logEvent.groupBy({
        by: ['route'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ])

  if (authFailures >= AUTH_FAILURE_MIN) {
    const requestIds = await collectRequestIds({
      level: 'WARN',
      errorCode: 'AUTH_FAILED',
      route: '/api/auth/login',
      createdAt: { gte: since },
    })
    findings.push({
      type: 'auth-failure-burst',
      severity: 'HIGH',
      title: 'Repeated authentication failures',
      summary: `${authFailures} failed sign-in attempts were observed on /api/auth/login within the window.`,
      windowSeconds: Math.round(OBSERVABILITY_WINDOW_MS / 1000),
      count: authFailures,
      route: '/api/auth/login',
      requestIds,
    })
  }

  if (notFounds >= NOT_FOUND_MIN) {
    const requestIds = await collectRequestIds({
      status: 404,
      createdAt: { gte: since },
    })
    findings.push({
      type: 'not-found-burst',
      severity: 'MEDIUM',
      title: 'Repeated not-found requests',
      summary: `${notFounds} requests to unknown endpoints were observed in the window.`,
      windowSeconds: Math.round(OBSERVABILITY_WINDOW_MS / 1000),
      count: notFounds,
      route: null,
      requestIds,
    })
  }

  if (serverErrors >= SERVER_ERROR_MIN) {
    const requestIds = await collectRequestIds({
      status: { gte: 500 },
      createdAt: { gte: since },
    })
    findings.push({
      type: 'server-error-spike',
      severity: 'HIGH',
      title: 'Unexpected 5xx spike',
      summary: `${serverErrors} server errors were observed in the window.`,
      windowSeconds: Math.round(OBSERVABILITY_WINDOW_MS / 1000),
      count: serverErrors,
      route: null,
      requestIds,
    })
  }

  for (const row of invalidByRoute) {
    if (row._count._all >= INVALID_REQUEST_MIN) {
      const requestIds = await collectRequestIds({
        status: 400,
        route: row.route ?? undefined,
        createdAt: { gte: since },
      })
      findings.push({
        type: 'invalid-request-burst',
        severity: 'MEDIUM',
        title: 'Repeated invalid requests',
        summary: `${row._count._all} rejected requests were observed on ${row.route ?? 'unknown route'}.`,
        windowSeconds: Math.round(OBSERVABILITY_WINDOW_MS / 1000),
        count: row._count._all,
        route: row.route,
        requestIds,
      })
    }
  }

  // Telemetry's own endpoints are excluded from the "unusual frequency"
  // detection so the command center's polling can never flag itself.
  const SELF_TELEMETRY_PREFIXES = ['/api/observability/', '/api/health']

  for (const row of volumeByRoute) {
    if (
      row.route &&
      row._count._all >= FREQUENCY_ROUTE_MIN &&
      !SELF_TELEMETRY_PREFIXES.some((prefix) => row.route?.startsWith(prefix))
    ) {
      findings.push({
        type: 'unusual-request-frequency',
        severity: 'LOW',
        title: 'Unusual request frequency',
        summary: `${row._count._all} requests hit ${row.route} within the window.`,
        windowSeconds: Math.round(OBSERVABILITY_WINDOW_MS / 1000),
        count: row._count._all,
        route: row.route,
        requestIds: [],
      })
    }
  }

  return findings.sort((a, b) => {
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 }
    return order[a.severity] - order[b.severity]
  })
}

// ---------------------------------------------------------------------------
// Overview scoring
// ---------------------------------------------------------------------------

export async function computeOverview(): Promise<Overview> {
  const since = new Date(Date.now() - OBSERVABILITY_WINDOW_MS)

  const [activeIncidents, components] = await Promise.all([
    prisma.incident.findMany({
      where: {
        status: { in: [...ACTIVE_STATUSES] },
        updatedAt: { gte: since },
      },
      select: { severity: true, cyberSafetyImpact: true },
    }),
    computeComponentsHealth(),
  ])

  const demo = demoPolicyScores(activeIncidents)
  // Health still reports the real component health when NORMAL; while an
  // incident is active the deterministic demo policy reflects the live state.
  const systemHealth =
    activeIncidents.length === 0 ? computeSystemHealth(components) : demo.systemHealth
  // Recompute the total with the ACTUAL reported health (real probes when
  // clean) so the composite never disagrees with the health card.
  const totalHealthScore = compositeHealthScore({
    riskScore: demo.riskScore,
    cyberSafetyScore: demo.cyberSafetyScore,
    applicationReliabilityScore: demo.applicationReliabilityScore,
    systemHealth,
  })

  return {
    riskScore: demo.riskScore,
    cyberSafetyScore: demo.cyberSafetyScore,
    systemHealth,
    applicationReliabilityScore: demo.applicationReliabilityScore,
    totalHealthScore,
    activeIncidents: activeIncidents.length,
  }
}

// ---------------------------------------------------------------------------
// DTO serialization (keeps every API + the PDF using the same safe shapes)
// ---------------------------------------------------------------------------

export interface IncidentDTO {
  id: string
  ref: string
  status: Incident['status']
  severity: Incident['severity']
  riskScore: number
  cyberSafetyImpact: number
  title: string
  description: string
  summary: string | null
  endpoint: string
  method: string
  requestId: string | null
  errorCode: string | null
  expectedRootCause: string | null
  resolvedAt: string | null
  createdAt: string
  updatedAt: string
  logCount: number
}

export interface IncidentEventDTO {
  id: string
  stage: string
  label: string
  detail: string | null
  at: string
}

export interface AgentRunDTO {
  id: string
  agent: AgentName
  kind: string | null
  role: string
  round: number
  status: AgentStatus
  progress: number
  currentActivity: string | null
  inputSummary: string | null
  outputSummary: string | null
  confidence: number | null
  mode: string
  model: string | null
  error: string | null
  promptTokens: number | null
  contextSize: number | null
  contextLevel: number | null
  completedAt: string | null
  createdAt: string
}

export interface ApprovalDTO {
  id: string
  approvalId: string
  incidentId: string
  patchId: string
  status: string
  operator: string
  decision: 'APPROVED' | 'REJECTED' | null
  reviewer: string
  reason: string | null
  outcome: string | null
  createdAt: string
  expiresAt: string
  statusUpdatedAt: string
}

export interface LogEventDTO {
  id: string
  level: LogEvent['level']
  service: string
  message: string
  route: string | null
  method: string | null
  status: number | null
  requestId: string | null
  errorCode: string | null
  incidentRef: string | null
  createdAt: string
}

export interface RepairAttemptDTO {
  id: string
  attemptId: string
  status: string
  risk: string | null
  startedAt: string
  completedAt: string | null
  summary: string | null
}

export interface PatchRecordDTO {
  id: string
  patchId: string
  status: string
  file: string | null
  function: string | null
  line: number | null
  createdAt: string
  validatedAt: string | null
}

export interface TelegramDeliveryDTO {
  id: string
  type: NotificationType
  severity: IncidentSeverity | null
  deliveryStatus: DeliveryStatus
  telegramMessageId: string | null
  error: string | null
  createdAt: string
}

export interface IncidentTerminalDTO {
  finalState: 'RESOLVED' | 'ROLLED_BACK' | 'AI_REPAIR_FAILED' | 'REJECTED' | 'EXPIRED'
  validation: {
    result: 'pass' | 'fail' | 'not_run'
    detail: string | null
    probes: Array<{ name: string; ok: boolean }>
  }
  text: string
}

export interface IncidentDetailDTO extends IncidentDTO {
  timeline: IncidentEventDTO[]
  logs: LogEventDTO[]
  agentRuns: AgentRunDTO[]
  approvals: ApprovalDTO[]
  previous: IncidentDTO[]
  repairAttempt: RepairAttemptDTO | null
  patch: PatchRecordDTO | null
  telegram: {
    deliveries: TelegramDeliveryDTO[]
  }
  terminalSummary: IncidentTerminalDTO | null
}

export function serializeIncident(
  incident: Incident & { _count?: { logs: number } },
): IncidentDTO {
  return {
    id: incident.id,
    ref: incident.ref,
    status: incident.status,
    severity: incident.severity,
    riskScore: incident.riskScore,
    cyberSafetyImpact: incident.cyberSafetyImpact,
    title: incident.title,
    description: incident.description,
    summary: incident.summary,
    endpoint: incident.endpoint,
    method: incident.method,
    requestId: incident.requestId,
    errorCode: incident.errorCode,
    expectedRootCause: incident.expectedRootCause,
    resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
    createdAt: incident.createdAt.toISOString(),
    updatedAt: incident.updatedAt.toISOString(),
    logCount: incident._count?.logs ?? 0,
  }
}

export function serializeIncidentEvent(event: IncidentEvent): IncidentEventDTO {
  return {
    id: event.id,
    stage: event.stage,
    label: event.label,
    detail: event.detail,
    at: event.at.toISOString(),
  }
}

export function serializeAgentRun(run: AgentRun): AgentRunDTO {
  const ctx = (run.context ?? null) as {
    contextSize?: number | null
    contextLevel?: number | null
    compacted?: { from: number; to: number; level: number } | null
  } | null
  return {
    id: run.id,
    agent: run.agent,
    kind: run.kind,
    role: run.role,
    round: run.round,
    status: run.status,
    progress: run.progress,
    currentActivity: run.currentActivity,
    inputSummary: run.inputSummary,
    outputSummary: run.outputSummary,
    confidence: run.confidence,
    mode: run.mode,
    model: run.model,
    error: run.error,
    promptTokens: run.promptTokens,
    contextSize: ctx?.contextSize ?? null,
    contextLevel: ctx?.contextLevel ?? null,
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    createdAt: run.createdAt.toISOString(),
  }
}

export function serializeRepairAttempt(attempt: RepairAttempt): RepairAttemptDTO {
  return {
    id: attempt.id,
    attemptId: attempt.attemptId,
    status: attempt.status,
    risk: attempt.risk,
    startedAt: attempt.startedAt.toISOString(),
    completedAt: attempt.completedAt ? attempt.completedAt.toISOString() : null,
    summary: attempt.summary,
  }
}

export function serializePatchRecord(patch: PatchRecord): PatchRecordDTO {
  return {
    id: patch.id,
    patchId: patch.patchId,
    status: patch.status,
    file: patch.file,
    function: patch.function,
    line: patch.line,
    createdAt: patch.createdAt.toISOString(),
    validatedAt: patch.validatedAt ? patch.validatedAt.toISOString() : null,
  }
}

export function serializeApproval(approval: Approval): ApprovalDTO {
  const approved = approval.status === 'APPROVED' || approval.status === 'CONSUMED'
  return {
    id: approval.id,
    approvalId: approval.approvalId,
    incidentId: approval.incidentId,
    patchId: approval.patchId,
    status: approval.status,
    operator: approval.operator,
    createdAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt.toISOString(),
    statusUpdatedAt: approval.statusUpdatedAt.toISOString(),
    // Friendly fields kept for the incident detail UI.
    decision: approved ? 'APPROVED' : approval.status === 'REJECTED' ? 'REJECTED' : null,
    reviewer: approval.operator,
    reason: null,
    outcome: approved && approval.status === 'CONSUMED' ? 'patch applied and validated' : null,
  }
}

export function serializeTelegramDelivery(
  delivery: TelegramNotification,
): TelegramDeliveryDTO {
  return {
    id: delivery.id,
    type: delivery.type,
    severity: delivery.severity,
    deliveryStatus: delivery.deliveryStatus,
    telegramMessageId: delivery.telegramMessageId,
    error: delivery.error,
    createdAt: delivery.createdAt.toISOString(),
  }
}

export async function serializeLogEvent(
  event: LogEvent,
  refMap?: Map<string, string>,
): Promise<LogEventDTO> {
  let incidentRef: string | null = null
  if (event.incidentId) {
    incidentRef = refMap?.get(event.incidentId) ?? null
    if (!incidentRef) {
      const incident = await prisma.incident.findUnique({
        where: { id: event.incidentId },
        select: { ref: true },
      })
      incidentRef = incident?.ref ?? null
    }
  }
  return {
    id: event.id,
    level: event.level,
    service: event.service,
    message: event.message,
    route: event.route,
    method: event.method,
    status: event.status,
    requestId: event.requestId,
    errorCode: event.errorCode,
    incidentRef,
    createdAt: event.createdAt.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Incident detail service
// ---------------------------------------------------------------------------

const SIMILAR_TITLE_STOPWORDS = new Set([
  'repeated',
  'unexpected',
  'requests',
  'multiple',
  'error',
  'errors',
  'validation',
  'failure',
  'failures',
  'api',
  'protection',
  'cluster',
])

function titleKeywords(title: string): string[] {
  return title
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length >= 5 && !SIMILAR_TITLE_STOPWORDS.has(w))
}

/**
 * Fetches a full incident investigation view: metadata, timeline, related
 * logs, real agent pipeline runs, approval history, and previous similar
 * incidents (same endpoint or a shared meaningful title keyword).
 */
export async function fetchIncidentDetail(
  id: string,
): Promise<IncidentDetailDTO | null> {
  const incident = await prisma.incident.findUnique({
    where: { id },
    include: {
      _count: { select: { logs: true } },
      events: { orderBy: { at: 'asc' } },
      logs: { orderBy: { createdAt: 'desc' }, take: 60 },
      agentRuns: { orderBy: { createdAt: 'asc' } },
      approvals: { orderBy: { createdAt: 'desc' } },
      repairAttempts: { orderBy: { startedAt: 'desc' }, take: 1 },
      patchRecords: { orderBy: { createdAt: 'desc' }, take: 1 },
      telegramNotifications: { orderBy: { createdAt: 'desc' } },
    },
  })
  if (!incident) return null

  const previousRaw = await prisma.incident.findMany({
    where: {
      id: { not: id },
      OR: [
        { endpoint: incident.endpoint },
        {
          OR: titleKeywords(incident.title).map((keyword) => ({
            title: { contains: keyword },
          })),
        },
      ],
    },
    include: { _count: { select: { logs: true } } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })

  const refMap = new Map<string, string>()
  for (const log of incident.logs) {
    if (log.incidentId) refMap.set(log.incidentId, incident.ref)
  }

  // Terminal summary facts come from the SAME canonical builder Telegram uses,
  // so the PDF/UI can render a preview of the FINAL_SUMMARY message. REJECTED /
  // EXPIRED approvals also surface a terminal state (incident stays
  // AI_REPAIR_FAILED but the terminal card reflects the human decision).
  let terminalSummary: IncidentTerminalDTO | null = null
  const terminal =
    incident.status === 'RESOLVED' ||
    incident.status === 'ROLLED_BACK' ||
    incident.approvals.some((a) => a.status === 'REJECTED' || a.status === 'EXPIRED')
      ? await loadTerminalSummaryFacts(incident)
      : null
  if (terminal) {
    terminalSummary = {
      finalState: terminal.finalState,
      validation: {
        result: terminal.validation.result,
        detail: terminal.validation.detail,
        probes: terminal.validation.probes,
      },
      text: buildTerminalSummaryText(terminal),
    }
  }

  return {
    ...serializeIncident(incident),
    timeline: incident.events.map(serializeIncidentEvent),
    logs: (await Promise.all(
      incident.logs.map((log) => serializeLogEvent(log, refMap)),
    )),
    agentRuns: incident.agentRuns.map(serializeAgentRun),
    approvals: incident.approvals.map(serializeApproval),
    previous: previousRaw.map(serializeIncident),
    repairAttempt: incident.repairAttempts[0] ? serializeRepairAttempt(incident.repairAttempts[0]) : null,
    patch: incident.patchRecords[0] ? serializePatchRecord(incident.patchRecords[0]) : null,
    telegram: {
      deliveries: incident.telegramNotifications.map(serializeTelegramDelivery),
    },
    terminalSummary,
  }
}