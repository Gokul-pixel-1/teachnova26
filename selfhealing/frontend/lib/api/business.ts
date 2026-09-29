// Client-side access to the business APIs (impact, settings, status). Types
// mirror lib/server/business/* so the UI never imports server-only modules.

export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
type PerSeverity = Record<Severity, number>

export interface BusinessSettings {
  companyName: string
  currency: string
  revenuePerHour: number
  engineerCostPerHour: number
  manualMttrMinutes: PerSeverity
  revenueAtRisk: PerSeverity
  engineersPerIncident: PerSeverity
  aiCostPerMillionTokens: number
}

export type ImpactOutcome = 'AUTO_FIXED' | 'APPROVED_FIX' | 'REJECTED' | 'NEEDS_ENGINEER' | 'OPEN'

export interface IncidentImpact {
  id: string
  ref: string
  title: string
  service: string
  severity: string
  status: string
  outcome: ImpactOutcome
  createdAt: string
  resolvedAt: string | null
  fixMinutes: number
  manualMinutes: number
  minutesSaved: number
  revenueProtected: number
  engineerHoursSaved: number
  engineerCostSaved: number
  tokens: number
  aiCost: number
  approvedBy: string | null
  jiraKey: string | null
  jiraUrl: string | null
}

export interface ImpactReport {
  settings: BusinessSettings
  windowDays: number
  totals: {
    incidents: number
    fixed: number
    autoFixed: number
    approvedFixes: number
    rejected: number
    needsEngineer: number
    open: number
    revenueProtected: number
    engineerHoursSaved: number
    engineerCostSaved: number
    aiCost: number
    netValue: number
    roiMultiple: number | null
    avgAiFixMinutes: number | null
    avgManualMinutes: number | null
    downtimeAvoidedMinutes: number
  }
  days: Array<{ date: string; incidents: number; fixed: number; value: number }>
  incidents: IncidentImpact[]
}

export interface UxWindowMetrics {
  sessions: number
  targetClicks: number
  deadClicks: number
  rageClicks: number
  strugglePerVisitor: number
  findRate: number
  medianFindSeconds: number | null
}

export interface UxImpactItem {
  id: string
  ref: string
  uxId: string
  component: string
  summary: string | null
  status: string
  appliedAt: string
  before: UxWindowMetrics
  after: UxWindowMetrics
  struggleChangePct: number | null
  findTimeChangePct: number | null
  verdict: 'improved' | 'worse' | 'no-change' | 'collecting'
  headline: string
}

export type ServiceState = 'operational' | 'repairing' | 'awaiting' | 'investigating'

export interface StatusReport {
  generatedAt: string
  overall: ServiceState
  services: Array<{
    id: string
    label: string
    description: string
    state: ServiceState
    uptime: number
    days: Array<{ date: string; downtimeMinutes: number }>
  }>
  incidents: Array<{
    id: string
    service: string
    headline: string
    state: 'resolved' | 'repairing' | 'awaiting' | 'investigating'
    resolution: string
    startedAt: string
    endedAt: string | null
    durationSeconds: number
    automatic: boolean
  }>
  stats: { incidents30d: number; autoFixed30d: number; medianRecoverySeconds: number | null; uptime30d: number }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? 'Request failed')
  }
  return (await res.json()) as T
}

export const fetchImpact = (days: number) =>
  request<{ report: ImpactReport; ux: UxImpactItem[] }>(`/api/business/impact?days=${days}`)

export const fetchIncidentImpact = (id: string) =>
  request<{ impact: IncidentImpact; settings: BusinessSettings }>(`/api/business/incidents/${encodeURIComponent(id)}`)

export const saveBusinessSettings = (settings: BusinessSettings) =>
  request<{ settings: BusinessSettings }>('/api/business/settings', { method: 'PUT', body: JSON.stringify(settings) })

export const fetchStatus = () => request<StatusReport>('/api/status')

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Compact money: ₹1.2L / ₹3.4Cr for rupees, K/M otherwise. */
export function money(value: number, currency: string): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (currency === '₹') {
    if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`
    if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`
    if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}K`
  } else {
    if (abs >= 1e6) return `${sign}${currency}${(abs / 1e6).toFixed(1)}M`
    if (abs >= 1e3) return `${sign}${currency}${(abs / 1e3).toFixed(1)}K`
  }
  return `${sign}${currency}${abs < 10 ? abs.toFixed(2) : Math.round(abs).toLocaleString('en-IN')}`
}

export function duration(minutes: number): string {
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))}s`
  if (minutes < 60) return `${Math.round(minutes)}m`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m ? `${h}h ${m}m` : `${h}h`
}
