// Client-side access to the Phase 8 security APIs. Types mirror the server DTOs
// in `lib/server/security.ts`, `lib/server/risk.ts` and the status route so the
// command center UI never imports server-only modules.

import type { AgentStatus, IncidentSeverity, IncidentStatus } from './observability'

export type SecurityFindingStatus = 'DETECTED' | 'PROCESSED' | 'DISMISSED'
export type SecurityTier = 'dashboard' | 'incident' | 'heightened' | 'critical'
export type DeliveryStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED_DUPLICATE'
export type NotificationType =
  | 'INCIDENT'
  | 'ESCALATION'
  | 'TEST'
  | 'HIGH_RISK_APPROVAL_REQUIRED'
  | 'REPAIR_APPLIED'
  | 'REPAIR_FAILED'
  | 'ROLLBACK_COMPLETED'
  | 'RECOVERY'
  | 'FINAL_SUMMARY'

export interface SecurityFindingDTO {
  id: string
  fingerprint: string
  ruleId: string
  title: string
  severity: IncidentSeverity
  endpoint: string | null
  method: string | null
  detail: string | null
  status: SecurityFindingStatus
  hitCount: number
  firstSeenAt: string
  lastSeenAt: string
  createdAt: string
}

export interface SecurityAgentRunDTO {
  id: string
  agent: string
  role: string
  status: AgentStatus
  progress: number
  currentActivity: string | null
  outputSummary: string | null
  confidence: number | null
  mode: string
  model: string | null
  error: string | null
  completedAt: string | null
}

export interface SecurityIncidentDTO {
  id: string
  ref: string
  status: IncidentStatus
  severity: IncidentSeverity
  riskScore: number
  title: string
  endpoint: string
  method: string
  errorCode: string | null
  expectedRootCause: string | null
  detectedBy: string | null
  summary: string | null
  createdAt: string
  updatedAt: string
  agentRuns: SecurityAgentRunDTO[]
}

export interface SecurityTelegramDTO {
  id: string
  type: NotificationType
  severity: IncidentSeverity | null
  deliveryStatus: DeliveryStatus
  telegramMessageId: string | null
  error: string | null
  incidentId: string | null
  createdAt: string
}

export interface SecurityOverviewDTO {
  riskScore: number
  cyberSafetyScore: number
  systemHealth: number
  applicationReliabilityScore: number
  totalHealthScore: number
  activeIncidents: number
  activeFindings: number
  findingsBySeverity: Record<string, number>
}

export interface SecurityStatusDTO {
  canOperate: boolean
  operators: string[]
  tiers: { table: SecurityTier[]; thresholds: Record<string, number> }
  overview: SecurityOverviewDTO
  tier: SecurityTier
  findings: SecurityFindingDTO[]
  incidents: SecurityIncidentDTO[]
  agents: Record<string, number>
  model: {
    provider: string
    mode: 'REAL' | 'TEST'
    configured: string
    offered: string[] | null
    valid: boolean | null
  }
  telegram: {
    configured: boolean
    chatId: string | null
    status: {
      configured: boolean
      reachable: boolean
      botUsername: string | null
      latencyMs: number | null
      error: string | null
      checkedAt: string
    }
    lastDelivery: {
      type: NotificationType
      deliveryStatus: DeliveryStatus
      telegramMessageId: string | null
      error: string | null
      createdAt: string
    } | null
    lastIncident: {
      ref: string
      status: IncidentStatus
      severity: IncidentSeverity
      createdAt: string
      deliveries: Array<{ type: NotificationType; deliveryStatus: DeliveryStatus; createdAt: string }>
    } | null
    recent: SecurityTelegramDTO[]
  }
  gmail: {
    configured: boolean
    missing: string[]
    recipient: string | null
    lastDelivery: {
      type: NotificationType
      deliveryStatus: DeliveryStatus
      gmailMessageId: string | null
      error: string | null
      createdAt: string
    } | null
    recent: Array<{
      id: string
      type: NotificationType
      severity: IncidentSeverity | null
      subject: string
      deliveryStatus: DeliveryStatus
      gmailMessageId: string | null
      error: string | null
      incidentId: string | null
      createdAt: string
    }>
  }
}

export interface AgentPipelineRunResult {
  ok: boolean
  incidentRef: string | null
  runs: Array<{ agent: string; status: string; summary?: string; error?: string }>
  aiUnavailable: boolean
  telegram: { sent: boolean; reason: string }
  gmail: { sent: boolean; reason: string }
}

export interface TelegramTestResult {
  ok: boolean
  configured: boolean
  deliveryStatus: DeliveryStatus
  telegramMessageId: string | null
  error: string | null
  recent: SecurityTelegramDTO[]
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? 'Request failed')
  }
  return (await res.json()) as T
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? 'Request failed')
  }
  return (await res.json()) as T
}

export const fetchSecurityStatus = () =>
  getJson<SecurityStatusDTO>('/api/security/status')

// ---------------------------------------------------------------------------
// Attack telemetry — GET /api/demo/attack (public, real guard/incident state)
// ---------------------------------------------------------------------------

export interface AttackTelemetryDTO {
  build: string
  port: number
  source: string
  guardEnabled: boolean
  phase: 'normal' | 'attack' | 'detected' | 'mitigating' | 'recovered'
  state: {
    threshold: number
    windowMs: number
    blockMs: number
    failCount: number
    blocked: boolean
    blockedUntil: string | null
    blockedCount: number
  }
  health: {
    status: string
    availability: string
    latencyMs: number
    checkedAt: string
    systemHealth: number
    components: Array<{ name?: string; label?: string; status?: string; detail?: string }>
  }
  incident: {
    ref: string
    severity: string
    status: string
    riskScore: number
    title: string
    createdAt: string
  } | null
  agentRuns: Array<{
    agent: string
    status: string
    progress: number | null
    currentActivity: string | null
    round: number
    mode: string
    outputSummary: string | null
  }>
  timestamps: {
    firstFailureAt: string | null
    detectedAt: string | null
    mitigatedAt: string | null
  }
}

export const fetchAttackTelemetry = () =>
  getJson<AttackTelemetryDTO>('/api/demo/attack')

export const runPipelineFor = (incidentId: string) =>
  postJson<AgentPipelineRunResult>('/api/security/run', { incidentId })

export const testTelegram = () =>
  postJson<TelegramTestResult>('/api/telegram/test', {})

// ---------------------------------------------------------------------------
// Approval decisions (HITL gate for HIGH-risk patches)
// ---------------------------------------------------------------------------

export interface ApprovalDecisionResult {
  ok: boolean
  approved?: boolean
  rejected?: boolean
  expired?: boolean
  message?: string
  status?: string
  repair?: {
    ok: boolean
    stage?: string
    validation?: { result: string; probes: Array<{ name: string; ok: boolean }> }
  } | null
  approvalId?: string
}

export const submitApprovalDecision = (approvalId: string, action: 'proceed' | 'reject') =>
  postJson<ApprovalDecisionResult>('/api/approvals/proceed', { approvalId, action })

// ---------------------------------------------------------------------------
// Realtime (SSE) events — /api/security/events
// ---------------------------------------------------------------------------

export interface RealtimeDeliveryDTO {
  id: string
  type: NotificationType
  severity: IncidentSeverity | null
  deliveryStatus: DeliveryStatus
  telegramMessageId: string | null
  error: string | null
  incidentId: string | null
  createdAt: string
}

export interface RealtimeLastIncidentDTO {
  ref: string
  status: IncidentStatus
  severity: IncidentSeverity
  createdAt: string
}

export interface RealtimeSecuritySnapshot {
  rows: RealtimeDeliveryDTO[]
  lastIncident: RealtimeLastIncidentDTO | null
  checkedAt: string
}

/** Realtime lifecycle diff from /api/security/events (event: lifecycle). */
export interface LifecycleEventDTO {
  incidents: Array<{
    id: string
    ref: string
    status: IncidentStatus
    severity: IncidentSeverity
    title: string
    updatedAt: string
  }>
  events: Array<{
    id: string
    incidentId: string
    ref: string | null
    stage: string
    label: string
    detail: string | null
    at: string
  }>
  agentRuns: Array<{
    id: string
    incidentId: string
    ref: string | null
    agent: string
    kind: string | null
    role: string
    status: string
    round: number
    mode: string
    model: string | null
    updatedAt: string
  }>
  approvals: Array<{
    id: string
    incidentId: string
    ref: string | null
    approvalId: string
    status: string
    operator: string
    createdAt: string
    expiresAt: string
  }>
  repairs: Array<{
    attemptId: string
    incidentId: string
    ref: string | null
    status: string
    risk: string | null
    startedAt: string
  }>
}

/** Subscribes to the security SSE stream. Returns an unsubscribe function. */
export function subscribeSecurityEvents(handlers: {
  onSnapshot: (snapshot: RealtimeSecuritySnapshot) => void
  onDelivery: (rows: RealtimeDeliveryDTO[]) => void
  onLifecycle?: (lifecycle: LifecycleEventDTO) => void
  onError?: (message: string) => void
}): () => void {
  const source = new EventSource('/api/security/events')
  if (typeof handlers.onSnapshot === 'function') {
    source.addEventListener('snapshot', (e) => {
      try {
        handlers.onSnapshot(JSON.parse((e as MessageEvent).data) as RealtimeSecuritySnapshot)
      } catch {
        // malformed frame
      }
    })
  }
  if (typeof handlers.onDelivery === 'function') {
    source.addEventListener('delivery', (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as { rows: RealtimeDeliveryDTO[] }
        handlers.onDelivery(payload.rows ?? [])
      } catch {
        // malformed frame
      }
    })
  }
  if (typeof handlers.onLifecycle === 'function') {
    const onLifecycle = handlers.onLifecycle
    source.addEventListener('lifecycle', (e) => {
      try {
        onLifecycle(JSON.parse((e as MessageEvent).data) as LifecycleEventDTO)
      } catch {
        // malformed frame
      }
    })
  }
  source.addEventListener('error', () => {
    handlers.onError?.('Realtime event stream disconnected.')
  })
  return () => source.close()
}