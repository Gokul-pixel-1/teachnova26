import 'server-only'

import { prisma } from '@/lib/server/db'
import { readBusinessSettings, severityKey, type BusinessSettings } from './settings'
import { serviceFor } from './services'

// Business impact of the self-healing pipeline, computed from REAL incident
// rows (createdAt → resolvedAt) and the company's own assumptions
// (settings.ts). Read-only: this module never touches the repair pipeline.
//
// For every repaired incident:
//   minutes saved     = manual MTTR for that severity − actual AI fix time
//   revenue protected = minutes saved × revenue/min × share of revenue at risk
//   engineer hours    = manual MTTR × engineers normally pulled in
//   AI cost           = tokens actually spent by the agents × price per token

export type ImpactOutcome = 'AUTO_FIXED' | 'APPROVED_FIX' | 'REJECTED' | 'NEEDS_ENGINEER' | 'OPEN'

const OPEN_STATUSES = new Set(['DETECTED', 'INVESTIGATING', 'AWAITING_REVIEW', 'WAITING_APPROVAL', 'VALIDATING'])

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

export interface ImpactDay {
  date: string
  incidents: number
  fixed: number
  value: number
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
  days: ImpactDay[]
  incidents: IncidentImpact[]
}

function outcomeOf(status: string, hadApproval: boolean): ImpactOutcome {
  if (status === 'RESOLVED') return hadApproval ? 'APPROVED_FIX' : 'AUTO_FIXED'
  if (status === 'REJECTED') return 'REJECTED'
  if (OPEN_STATUSES.has(status)) return 'OPEN'
  return 'NEEDS_ENGINEER'
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function incidentImpacts(
  where: { createdAt?: { gte: Date }; id?: string },
  settings?: BusinessSettings,
  take = 500,
): Promise<IncidentImpact[]> {
  const cfg = settings ?? (await readBusinessSettings())
  const rows = await prisma.incident.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      ref: true,
      title: true,
      endpoint: true,
      method: true,
      severity: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
      approvals: { select: { approvalId: true, status: true } },
    },
  })
  if (rows.length === 0) return []

  const ids = rows.map((r) => r.id)
  const [tokenRows, jiraRows] = await Promise.all([
    prisma.agentRun.groupBy({
      by: ['incidentId'],
      where: { incidentId: { in: ids } },
      _sum: { promptTokens: true, completionTokens: true },
    }),
    prisma.jiraApproval.findMany({
      where: { kind: 'REPAIR', approvalId: { in: rows.flatMap((r) => r.approvals.map((a) => a.approvalId)) } },
      select: { approvalId: true, issueKey: true, issueUrl: true, state: true, decidedBy: true },
    }),
  ])
  const tokens = new Map(tokenRows.map((t) => [t.incidentId, (t._sum.promptTokens ?? 0) + (t._sum.completionTokens ?? 0)]))
  const jira = new Map(jiraRows.map((j) => [j.approvalId, j]))
  const now = Date.now()

  return rows.map((row) => {
    const sev = severityKey(row.severity)
    const hadApproval = row.approvals.length > 0
    const outcome = outcomeOf(row.status, hadApproval)
    const end =
      row.resolvedAt?.getTime() ?? (outcome === 'OPEN' ? now : row.updatedAt.getTime())
    const fixMinutes = Math.max(0, (end - row.createdAt.getTime()) / 60000)
    const manualMinutes = cfg.manualMttrMinutes[sev]
    const fixed = outcome === 'AUTO_FIXED' || outcome === 'APPROVED_FIX'
    const minutesSaved = fixed ? Math.max(0, manualMinutes - fixMinutes) : 0
    const revenueProtected = fixed ? (minutesSaved / 60) * cfg.revenuePerHour * cfg.revenueAtRisk[sev] : 0
    const engineerHoursSaved = fixed ? (manualMinutes / 60) * cfg.engineersPerIncident[sev] : 0
    const used = tokens.get(row.id) ?? 0
    const link = row.approvals.map((a) => jira.get(a.approvalId)).find(Boolean) ?? null
    return {
      id: row.id,
      ref: row.ref,
      title: row.title,
      service: serviceFor(row.endpoint, row.method).label,
      severity: row.severity,
      status: row.status,
      outcome,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      fixMinutes: round2(fixMinutes),
      manualMinutes,
      minutesSaved: round2(minutesSaved),
      revenueProtected: round2(revenueProtected),
      engineerHoursSaved: round2(engineerHoursSaved),
      engineerCostSaved: round2(engineerHoursSaved * cfg.engineerCostPerHour),
      tokens: used,
      aiCost: round2((used / 1_000_000) * cfg.aiCostPerMillionTokens),
      approvedBy: link?.decidedBy ?? null,
      jiraKey: link?.issueKey ?? null,
      jiraUrl: link?.issueUrl ?? null,
    }
  })
}

export async function computeImpactReport(windowDays: number): Promise<ImpactReport> {
  const settings = await readBusinessSettings()
  const since = new Date(Date.now() - windowDays * 86_400_000)
  since.setHours(0, 0, 0, 0)
  const incidents = await incidentImpacts({ createdAt: { gte: since } }, settings)

  const fixed = incidents.filter((i) => i.outcome === 'AUTO_FIXED' || i.outcome === 'APPROVED_FIX')
  const sum = (list: IncidentImpact[], pick: (i: IncidentImpact) => number) =>
    round2(list.reduce((acc, i) => acc + pick(i), 0))
  const revenueProtected = sum(fixed, (i) => i.revenueProtected)
  const engineerCostSaved = sum(fixed, (i) => i.engineerCostSaved)
  const aiCost = sum(incidents, (i) => i.aiCost)
  const netValue = round2(revenueProtected + engineerCostSaved - aiCost)

  const byDay = new Map<string, ImpactDay>()
  for (let d = 0; d < windowDays; d += 1) {
    const day = new Date(since.getTime() + d * 86_400_000)
    const key = day.toISOString().slice(0, 10)
    byDay.set(key, { date: key, incidents: 0, fixed: 0, value: 0 })
  }
  for (const i of incidents) {
    const key = i.createdAt.slice(0, 10)
    const day = byDay.get(key)
    if (!day) continue
    day.incidents += 1
    if (i.outcome === 'AUTO_FIXED' || i.outcome === 'APPROVED_FIX') {
      day.fixed += 1
      day.value = round2(day.value + i.revenueProtected + i.engineerCostSaved - i.aiCost)
    }
  }

  const avg = (list: number[]) => (list.length ? round2(list.reduce((a, b) => a + b, 0) / list.length) : null)

  return {
    settings,
    windowDays,
    totals: {
      incidents: incidents.length,
      fixed: fixed.length,
      autoFixed: incidents.filter((i) => i.outcome === 'AUTO_FIXED').length,
      approvedFixes: incidents.filter((i) => i.outcome === 'APPROVED_FIX').length,
      rejected: incidents.filter((i) => i.outcome === 'REJECTED').length,
      needsEngineer: incidents.filter((i) => i.outcome === 'NEEDS_ENGINEER').length,
      open: incidents.filter((i) => i.outcome === 'OPEN').length,
      revenueProtected,
      engineerHoursSaved: sum(fixed, (i) => i.engineerHoursSaved),
      engineerCostSaved,
      aiCost,
      netValue,
      roiMultiple: aiCost > 0 ? round2((revenueProtected + engineerCostSaved) / aiCost) : null,
      avgAiFixMinutes: avg(fixed.map((i) => i.fixMinutes)),
      avgManualMinutes: avg(fixed.map((i) => i.manualMinutes)),
      downtimeAvoidedMinutes: sum(fixed, (i) => i.minutesSaved),
    },
    days: [...byDay.values()],
    incidents: incidents.slice(0, 60),
  }
}
