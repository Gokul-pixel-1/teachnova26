// Client-side access to the observability APIs. Types mirror the server DTOs
// in `lib/server/observability.ts` (kept here so the command center UI does not
// import server-only modules).

export type IncidentStatus =
  | 'DETECTED'
  | 'INVESTIGATING'
  | 'AWAITING_REVIEW'
  | 'WAITING_APPROVAL'
  | 'VALIDATING'
  | 'RESOLVED'
  | 'ROLLED_BACK'
  | 'AI_REPAIR_FAILED'
  | 'REJECTED'

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SECURITY'

export type AgentName = 'FIXER' | 'CRITIC' | 'JUDGE' | 'CODER' | 'ANALYZER'

export type AgentStatus =
  | 'QUEUED'
  | 'ANALYZING'
  | 'GENERATING'
  | 'WAITING'
  | 'REVIEWING'
  | 'COMPLETE'
  | 'REJECTED'
  | 'FAILED'

export type ComponentStatus = 'healthy' | 'degraded' | 'unavailable'

export interface Overview {
  riskScore: number
  cyberSafetyScore: number
  systemHealth: number
  applicationReliabilityScore: number
  totalHealthScore: number
  activeIncidents: number
}

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

export interface IncidentDTO {
  id: string
  ref: string
  status: IncidentStatus
  severity: IncidentSeverity
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
  patchId: string
  status: string
  operator: string
  decision: 'APPROVED' | 'REJECTED' | null
  reviewer: string
  reason: string | null
  outcome: string | null
  createdAt: string
  expiresAt?: string
  statusUpdatedAt?: string
}

export interface LogEventDTO {
  id: string
  level: LogLevel
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

export interface TelegramDeliveryDTO {
  id: string
  type: string
  severity: IncidentSeverity | null
  deliveryStatus: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED_DUPLICATE'
  telegramMessageId: string | null
  error: string | null
  createdAt: string
}

export interface IncidentTerminalDTO {
  finalState: 'RESOLVED' | 'ROLLED_BACK' | 'REJECTED' | 'EXPIRED' | 'AI_REPAIR_FAILED'
  validation: {
    result: 'pass' | 'fail' | 'not_run'
    detail: string | null
    probes: Array<{ name: string; ok: boolean }>
  }
  text: string
}

export interface GmailDeliveryDTO {
  id: string
  type: string
  severity: IncidentSeverity | null
  subject: string
  deliveryStatus: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED_DUPLICATE'
  gmailMessageId: string | null
  error: string | null
  createdAt: string
}

export interface PreviousSimilarDTO extends IncidentDTO {
  outcome: string | null
  reward: number | null
  humanDecision: string | null
}

export interface RepairMemoryDTO {
  errorSignature: string
  outcome: string
  reward: number
  rewardBreakdown: Record<string, number> | null
  recurrenceCount: number
  humanDecision: string | null
  risk: string | null
  updatedAt: string
}

export interface IncidentDetailDTO extends IncidentDTO {
  timeline: IncidentEventDTO[]
  logs: LogEventDTO[]
  agentRuns: AgentRunDTO[]
  approvals: ApprovalDTO[]
  previous: PreviousSimilarDTO[]
  repairAttempt: {
    id: string
    attemptId: string
    status: string
    risk: string | null
    startedAt: string
    completedAt: string | null
    summary: string | null
  } | null
  patch: {
    id: string
    patchId: string
    status: string
    file: string | null
    function: string | null
    line: number | null
    createdAt: string
    validatedAt: string | null
  } | null
  telegram: {
    deliveries: TelegramDeliveryDTO[]
  }
  gmail: {
    deliveries: GmailDeliveryDTO[]
  }
  learning: RepairMemoryDTO | null
  terminalSummary: IncidentTerminalDTO | null
}

export interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface SummaryResponse {
  overview: Overview
  components: ComponentHealth[]
  securityEvents: SecurityFinding[]
  recentLogs: LogEventDTO[]
}

export interface IncidentListResponse {
  incidents: IncidentDTO[]
  pagination: Pagination
}

export interface IncidentDetailResponse {
  incident: IncidentDetailDTO
}

export interface LogListResponse {
  logs: LogEventDTO[]
  pagination: Pagination
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? 'Request failed')
  }
  return (await res.json()) as T
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

export const fetchSummary = () => getJson<SummaryResponse>('/api/observability/summary')

export const fetchIncidents = (params: {
  status?: string
  severity?: string
  page?: number
  pageSize?: number
}) => getJson<IncidentListResponse>(`/api/incidents${qs(params)}`)

export const fetchIncident = (id: string) =>
  getJson<IncidentDetailResponse>(`/api/incidents/${encodeURIComponent(id)}`)

export const fetchLogs = (params: Record<string, string | number | undefined>) =>
  getJson<LogListResponse>(`/api/logs${qs(params)}`)

/** Triggers the authenticated PDF report download for a single incident. */
export async function downloadIncidentReport(id: string): Promise<string> {
  const res = await fetch(`/api/incidents/${encodeURIComponent(id)}/report`, {
    method: 'POST',
    headers: { Accept: 'application/pdf' },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? 'Could not generate report')
  }
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="([^"]+)"/)
  const filename = match?.[1] ?? 'buildhub-incident-report.pdf'
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
  return filename
}