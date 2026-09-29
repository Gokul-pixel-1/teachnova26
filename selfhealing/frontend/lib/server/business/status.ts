import 'server-only'

import { prisma } from '@/lib/server/db'
import { PUBLIC_SERVICES, serviceFor } from './services'

// Public status page data. Customer-safe by construction: only service
// names, states, timestamps and plain-English resolution notes leave this
// module — never endpoints, files, stack traces, AI output or approval ids.

export type ServiceState = 'operational' | 'repairing' | 'awaiting' | 'investigating'

export interface StatusDay {
  date: string
  downtimeMinutes: number
}

export interface StatusService {
  id: string
  label: string
  description: string
  state: ServiceState
  uptime: number
  days: StatusDay[]
}

export interface StatusIncident {
  id: string
  service: string
  headline: string
  state: 'resolved' | 'repairing' | 'awaiting' | 'investigating'
  resolution: string
  startedAt: string
  endedAt: string | null
  durationSeconds: number
  automatic: boolean
}

export interface StatusReport {
  generatedAt: string
  overall: ServiceState
  services: StatusService[]
  incidents: StatusIncident[]
  stats: { incidents30d: number; autoFixed30d: number; medianRecoverySeconds: number | null; uptime30d: number }
}

const DAYS = 30
const REPAIRING = new Set(['DETECTED', 'INVESTIGATING', 'VALIDATING'])
const AWAITING = new Set(['WAITING_APPROVAL', 'AWAITING_REVIEW'])
const ESCALATED = new Set(['AI_REPAIR_FAILED', 'REJECTED', 'ROLLED_BACK'])
// A repair the AI could not finish shows as "engineers investigating" for
// this long unless a later incident on the same service resolved.
const ESCALATION_VISIBLE_MS = 60 * 60 * 1000
const SEVERITY_ORDER: ServiceState[] = ['operational', 'repairing', 'awaiting', 'investigating']

function human(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round((minutes / 60) * 10) / 10
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

export async function computeStatusReport(): Promise<StatusReport> {
  const now = Date.now()
  const start = new Date(now - (DAYS - 1) * 86_400_000)
  start.setHours(0, 0, 0, 0)

  const rows = await prisma.incident.findMany({
    where: { createdAt: { gte: start } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      endpoint: true,
      method: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
      _count: { select: { approvals: true } },
    },
  })

  type Row = (typeof rows)[number] & { serviceId: string; end: number }
  const enriched: Row[] = rows.map((row) => {
    const open = REPAIRING.has(row.status) || AWAITING.has(row.status)
    const end = row.resolvedAt
      ? row.resolvedAt.getTime()
      : open
        ? now
        : Math.min(row.updatedAt.getTime(), row.createdAt.getTime() + ESCALATION_VISIBLE_MS)
    return { ...row, serviceId: serviceFor(row.endpoint, row.method).id, end }
  })

  const stateOf = (row: Row): ServiceState | null => {
    if (REPAIRING.has(row.status)) return 'repairing'
    if (AWAITING.has(row.status)) return 'awaiting'
    if (ESCALATED.has(row.status) && now - row.updatedAt.getTime() < ESCALATION_VISIBLE_MS) return 'investigating'
    return null
  }

  const services: StatusService[] = PUBLIC_SERVICES.map((svc) => {
    const own = enriched.filter((r) => r.serviceId === svc.id)
    // Current state: the most serious live signal, ignoring escalations that
    // a newer incident on the same service already superseded.
    let state: ServiceState = 'operational'
    own.forEach((row, index) => {
      const s = stateOf(row)
      if (!s) return
      // A newer incident on the same service supersedes an older escalation.
      if (s === 'investigating' && index < own.length - 1) return
      if (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(state)) state = s
    })

    const days: StatusDay[] = []
    let downtimeTotal = 0
    for (let d = 0; d < DAYS; d += 1) {
      const dayStart = start.getTime() + d * 86_400_000
      const dayEnd = Math.min(dayStart + 86_400_000, now)
      let minutes = 0
      for (const row of own) {
        const from = Math.max(row.createdAt.getTime(), dayStart)
        const to = Math.min(row.end, dayEnd)
        if (to > from) minutes += (to - from) / 60000
      }
      minutes = Math.min(minutes, 1440)
      downtimeTotal += minutes
      days.push({ date: new Date(dayStart).toISOString().slice(0, 10), downtimeMinutes: Math.round(minutes * 10) / 10 })
    }
    const totalMinutes = (now - start.getTime()) / 60000
    const uptime = Math.max(0, Math.min(100, 100 - (downtimeTotal / totalMinutes) * 100))
    return { ...svc, state, uptime: Math.round(uptime * 1000) / 1000, days }
  })

  const superseded = new Set(
    enriched.filter((row, i) => enriched.slice(i + 1).some((later) => later.serviceId === row.serviceId)).map((r) => r.id),
  )
  const recent = [...enriched].reverse().slice(0, 15)
  const incidents: StatusIncident[] = recent.map((row) => {
    const svc = PUBLIC_SERVICES.find((s) => s.id === row.serviceId)!
    const durationSeconds = Math.max(0, (row.end - row.createdAt.getTime()) / 1000)
    const approved = row._count.approvals > 0
    let state: StatusIncident['state'] = 'resolved'
    let resolution: string
    if (row.status === 'RESOLVED') {
      resolution = approved
        ? `BuildHub AI prepared a fix, an engineer approved it, and ${svc.label.toLowerCase()} recovered in ${human(durationSeconds)}.`
        : `Detected and repaired automatically by BuildHub AI in ${human(durationSeconds)} — no one had to be paged.`
    } else if (REPAIRING.has(row.status)) {
      state = 'repairing'
      resolution = 'BuildHub AI has detected the problem and is repairing it now.'
    } else if (AWAITING.has(row.status)) {
      state = 'awaiting'
      resolution = 'A fix is ready and waiting for an engineer to approve it.'
    } else {
      state =
        !superseded.has(row.id) && now - row.updatedAt.getTime() < ESCALATION_VISIBLE_MS ? 'investigating' : 'resolved'
      resolution =
        row.status === 'REJECTED'
          ? 'Engineers reviewed the automatic fix and chose to handle this one by hand.'
          : 'The automatic repair was not confident enough, so the issue was handed to engineers.'
    }
    return {
      id: row.id.slice(-8),
      service: svc.label,
      headline: `${svc.label} ${state === 'resolved' ? 'was' : 'is'} failing for some users`,
      state,
      resolution,
      startedAt: row.createdAt.toISOString(),
      endedAt: state === 'resolved' ? new Date(row.end).toISOString() : null,
      durationSeconds: Math.round(durationSeconds),
      automatic: row.status === 'RESOLVED' && !approved,
    }
  })

  const recoveries = enriched
    .filter((r) => r.status === 'RESOLVED' && r.resolvedAt)
    .map((r) => (r.resolvedAt!.getTime() - r.createdAt.getTime()) / 1000)
    .sort((a, b) => a - b)
  const overall = services.reduce<ServiceState>(
    (worst, s) => (SEVERITY_ORDER.indexOf(s.state) > SEVERITY_ORDER.indexOf(worst) ? s.state : worst),
    'operational',
  )

  return {
    generatedAt: new Date(now).toISOString(),
    overall,
    services,
    incidents,
    stats: {
      incidents30d: enriched.length,
      autoFixed30d: enriched.filter((r) => r.status === 'RESOLVED' && r._count.approvals === 0).length,
      medianRecoverySeconds: recoveries.length ? Math.round(recoveries[Math.floor(recoveries.length / 2)]) : null,
      uptime30d:
        Math.round((services.reduce((acc, s) => acc + s.uptime, 0) / services.length) * 1000) / 1000,
    },
  }
}
