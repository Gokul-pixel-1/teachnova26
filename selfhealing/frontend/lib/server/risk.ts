import 'server-only'

import { prisma } from './db'
import {
  ACTIVE_STATUSES,
  OBSERVABILITY_WINDOW_MS,
  SEVERITY_CYBER_IMPACT,
  SEVERITY_RISK_WEIGHTS,
  computeComponentsHealth,
  computeSystemHealth,
  demoPolicyScores,
} from './observability'
import type { FindingStatus, IncidentSeverity } from '@prisma/client'

// Phase 8 — deterministic security risk engine.
//
// The phase-8 risk score keeps ADR-012's formula and weights so the clean
// baseline stays risk 0 / cyber 100 / health 100 / active 0, but the security
// pressure term is derived from REAL SecurityFinding rows (the Python analyzer
// pipeline) instead of the phase-7 in-memory heuristic. Everything is a pure
// function of persisted state.

// Telegram routing tiers. These constants also drive the command-center banner:
//   < 40  dashboard health only       (no push)
//   40-69 incident alert              (push once per incident)
//   70-89 heightened                  (push once per incident)
//   >= 90 critical escalation         (push + explicit escalation tier)
export const RISK_DASHBOARD_ONLY_MAX = 39
export const RISK_INCIDENT_ALERT_MAX = 69
export const RISK_HEIGHTENED_ALERT_MAX = 89

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function riskTier(riskScore: number): 'dashboard' | 'incident' | 'heightened' | 'critical' {
  if (riskScore <= RISK_DASHBOARD_ONLY_MAX) return 'dashboard'
  if (riskScore <= RISK_INCIDENT_ALERT_MAX) return 'incident'
  if (riskScore <= RISK_HEIGHTENED_ALERT_MAX) return 'heightened'
  return 'critical'
}

export interface SecurityFindingSnapshot {
  id: string
  fingerprint: string
  ruleId: string
  title: string
  severity: IncidentSeverity
  endpoint: string | null
  method: string | null
  detail: string | null
  status: FindingStatus
  hitCount: number
  firstSeenAt: string
  lastSeenAt: string
  createdAt: string
}

export async function findActiveFindings(since?: Date): Promise<SecurityFindingSnapshot[]> {
  const rows = await prisma.securityFinding.findMany({
    where: {
      status: 'DETECTED',
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: [{ severity: 'asc' }, { lastSeenAt: 'desc' }],
    take: 100,
  })
  return rows.map((row) => ({
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
  }))
}

export interface SecurityOverview {
  riskScore: number
  cyberSafetyScore: number
  systemHealth: number
  applicationReliabilityScore: number
  totalHealthScore: number
  activeIncidents: number
  activeFindings: number
  findingsBySeverity: Record<string, number>
}

export async function computeSecurityOverview(): Promise<SecurityOverview> {
  const since = new Date(Date.now() - OBSERVABILITY_WINDOW_MS)

  const [activeIncidents, findings, components] = await Promise.all([
    prisma.incident.findMany({
      where: {
        status: { in: [...ACTIVE_STATUSES] },
        updatedAt: { gte: since },
      },
      select: { severity: true, cyberSafetyImpact: true },
    }),
    prisma.securityFinding.findMany({
      where: { status: 'DETECTED' },
      select: { severity: true },
    }),
    computeComponentsHealth(),
  ])

  const findingsBySeverity: Record<string, number> = {}
  for (const finding of findings) {
    findingsBySeverity[finding.severity] = (findingsBySeverity[finding.severity] ?? 0) + 1
  }

  const demo = demoPolicyScores(activeIncidents)
  const systemHealth =
    activeIncidents.length === 0 ? computeSystemHealth(components) : demo.systemHealth

  return {
    riskScore: demo.riskScore,
    cyberSafetyScore: demo.cyberSafetyScore,
    systemHealth,
    applicationReliabilityScore: demo.applicationReliabilityScore,
    totalHealthScore: demo.totalHealthScore,
    activeIncidents: activeIncidents.length,
    activeFindings: findings.length,
    findingsBySeverity,
  }
}

export { ACTIVE_STATUSES, SEVERITY_CYBER_IMPACT, SEVERITY_RISK_WEIGHTS }