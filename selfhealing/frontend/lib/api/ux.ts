// Client-side access to the UX Suggestion Agent APIs. Types mirror the server
// DTOs in lib/server/ux/* so the command center UI never imports server-only
// modules.

export type UxSuggestionStatus =
  | 'DRAFTED'
  | 'SIMULATING'
  | 'NO_EASY_PLACEMENT'
  | 'SANDBOX_FAILED'
  | 'AWAITING_APPROVAL'
  | 'APPLIED'
  | 'VALIDATED'
  | 'REJECTED'
  | 'ROLLED_BACK'
  | 'EXPIRED'

export type UxApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED'

export interface UxApprovalDTO {
  id: string
  approvalId: string
  status: UxApprovalStatus
  expiresAt: string
  /** Jira card for this approval when the Jira channel requested it. */
  jira?: { issueKey: string | null; issueUrl: string | null; state: string; error: string | null } | null
}

export interface SandboxRoundDTO {
  round: number
  summary: string
  currentCode: string
  proposedCode: string
  model: string | null
  screenshot: string | null
  error: string | null
  result: {
    easy: boolean
    score: number
    simulatedUsers: number
    foundWhereExpected: number
    foundRate: number
    avgDistanceBefore: number | null
    avgDistanceAfter: number | null
    distanceImprovement: number | null
    predictedSecondsBefore: number | null
    predictedSecondsAfter: number | null
    checks: Record<string, boolean>
    reasons: string[]
  } | null
}

export interface SandboxDTO {
  skipped?: boolean
  reason?: string
  error?: string | null
  passed?: boolean
  winnerRound?: number | null
  rounds?: SandboxRoundDTO[]
  viewports?: Array<{ w: number; h: number }>
  simulatedUsers?: number
  baselineScreenshot?: string | null
  startedAt?: string
  finishedAt?: string
}

export interface UxSuggestionDTO {
  id: string
  ref: string
  status: UxSuggestionStatus
  component: string
  file: string
  instruction: string
  summary: string | null
  currentCode: string
  proposedCode: string
  validationResult: string | null
  model: string | null
  uxId: string | null
  source: 'AUTO' | 'MANUAL'
  evidence: Record<string, unknown> | null
  sandbox: SandboxDTO | null
  createdAt: string
  appliedAt: string | null
  rolledBackAt: string | null
  approvals: UxApprovalDTO[]
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
  const body = (await res.json().catch(() => null)) as (T & { error?: string; ok?: boolean }) | null
  if (!res.ok) {
    throw new Error(body?.error ?? 'Request failed')
  }
  return body as T
}

export const fetchUxSuggestions = () =>
  getJson<{ suggestions: UxSuggestionDTO[] }>('/api/ux/suggestions')

export const requestUxSuggestion = (input: { component: string; file: string; instruction?: string }) =>
  postJson<{ ok: boolean; suggestion?: UxSuggestionDTO; approvalId?: string; simulating?: boolean; error?: string }>(
    '/api/ux/suggestions',
    input,
  )

export interface ComponentFrictionDTO {
  uxId: string
  label: string
  file: string
  since: string
  sessions: number
  strugglingSessions: number
  targetClicks: number
  deadClicks: number
  deadClicksBySide: { LEFT: number; RIGHT: number; ABOVE: number; BELOW: number }
  rageClicks: number
  slowFinds: number
  avgFindMs: number | null
  score: number
  flagged: boolean
  direction: 'left' | 'right' | 'up' | 'down' | null
  hotspot: { dx: number; dy: number; samples: number } | null
  reason: string
  openSuggestion: { ref: string; status: string } | null
}

export interface BehaviorReportDTO {
  autoSuggest: boolean
  thresholds: { windowHours: number; slowFindMs: number; minScore: number; minSessions: number }
  report: ComponentFrictionDTO[]
  created?: Array<{ uxId: string; ref: string; approvalId?: string }>
  failed?: Array<{ uxId: string; error: string }>
}

export const fetchBehaviorReport = () => getJson<BehaviorReportDTO>('/api/ux/behavior')

export const analyzeBehaviorNow = () => postJson<BehaviorReportDTO>('/api/ux/behavior', {})

/** Starts the live-simulation browser streamed by the /ai/ux-live tab. */
export const openLiveSandbox = () => postJson<{ ok: boolean }>('/api/ux/live', {})

export const retestUxSuggestion = (id: string) =>
  postJson<{ ok: boolean; status?: string }>(`/api/ux/suggestions/${id}/retest`, {})

export const sandboxScreenshotUrl = (id: string, name: string) =>
  `/api/ux/suggestions/${id}/screenshot?name=${encodeURIComponent(name)}`

export const decideUxApproval = (approvalId: string, action: 'proceed' | 'reject') =>
  postJson<{ ok: boolean; status?: string; reason?: string }>('/api/ux/approvals/proceed', {
    approvalId,
    action,
  })
