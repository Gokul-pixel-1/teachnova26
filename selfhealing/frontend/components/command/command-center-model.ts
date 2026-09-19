import type {
  IncidentDetailDTO,
  IncidentEventDTO,
  LogEventDTO,
} from '@/lib/api/observability'
import type { LifecycleEventDTO } from '@/lib/api/security'

export type OperationalStage =
  | 'DETECTION'
  | 'ANALYZER'
  | 'CODER'
  | 'CRITIC'
  | 'JUDGE'
  | 'APPROVAL'
  | 'PATCH'
  | 'VALIDATION'
  | 'RECOVERY'
  | 'LEARNING'

export interface OperationalEvent {
  id: string
  stage: OperationalStage
  at: string
  title: string
  detail: string
  status: 'complete' | 'active' | 'waiting' | 'failed'
  source: 'incident' | 'timeline' | 'agent' | 'approval' | 'patch' | 'learning' | 'log'
}

export const STAGE_ORDER: OperationalStage[] = [
  'DETECTION',
  'ANALYZER',
  'CODER',
  'CRITIC',
  'JUDGE',
  'APPROVAL',
  'PATCH',
  'VALIDATION',
  'RECOVERY',
  'LEARNING',
]

/** Hides implementation-only fault labels from normal operator-facing copy. */
export function displayOpsText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\b(?:LOW|MEDIUM|HIGH|COMMENT)-\d{1,2}\b\s*(?:INTENTIONAL\s+RUNTIME\s+ERROR|CREATED)?/gi, 'controlled incident')
    .replace(/\b(?:intentional|demo)\s+(?:runtime\s+)?fault\b/gi, 'controlled incident')
    .replace(/\bfault\s+fixture\b/gi, 'controlled incident')
}

function stageFromText(value: string): OperationalStage | null {
  const text = value.toUpperCase()
  if (text.includes('ANALYZ')) return 'ANALYZER'
  if (text.includes('CODER') || text.includes('FIXER')) return 'CODER'
  if (text.includes('CRITIC')) return 'CRITIC'
  if (text.includes('JUDGE') || text.includes('RISK')) return 'JUDGE'
  if (text.includes('APPROV') || text.includes('HUMAN')) return 'APPROVAL'
  if (text.includes('ROLLBACK') || text.includes('PATCH') || text.includes('APPLY')) return 'PATCH'
  if (text.includes('VALIDAT') || text.includes('PROBE') || text.includes('TEST')) return 'VALIDATION'
  if (text.includes('RESOLV') || text.includes('RECOVER')) return 'RECOVERY'
  if (text.includes('LEARN') || text.includes('REWARD') || text.includes('MEMORY')) return 'LEARNING'
  if (text.includes('DETECT') || text.includes('INCIDENT') || text.includes('ERROR')) return 'DETECTION'
  return null
}

function stageFromAgent(value: string): OperationalStage | null {
  const role = value.toUpperCase()
  if (role === 'JUDGE') return 'JUDGE'
  if (role === 'CRITIC') return 'CRITIC'
  if (role === 'CODER' || role === 'FIXER') return 'CODER'
  if (role === 'ANALYZER') return 'ANALYZER'
  return stageFromText(role)
}

function eventStatus(value: string): OperationalEvent['status'] {
  const text = value.toUpperCase()
  if (text.includes('FAIL') || text.includes('REJECT') || text.includes('ROLLBACK')) return 'failed'
  if (text.includes('WAIT') || text.includes('PENDING') || text.includes('QUEUED')) return 'waiting'
  if (text.includes('COMPLETE') || text.includes('RESOLV') || text.includes('CONSUMED') || text.includes('VALIDATED')) return 'complete'
  return 'active'
}

function eventFromTimeline(row: IncidentEventDTO): OperationalEvent | null {
  const stage = stageFromText(row.label) ?? stageFromText(row.stage)
  if (!stage) return null
  return {
    id: `event:${row.id}`,
    stage,
    at: row.at,
    title: displayOpsText(row.label),
    detail: displayOpsText(row.detail ?? `${row.stage} recorded for this incident.`),
    status: eventStatus(`${row.stage} ${row.label}`),
    source: 'timeline',
  }
}

export function incidentEvents(incident: IncidentDetailDTO | null): OperationalEvent[] {
  if (!incident) return []
  const events: OperationalEvent[] = [
    {
      id: `incident:${incident.id}`,
      stage: 'DETECTION',
      at: incident.createdAt,
      title: `${incident.method} ${incident.endpoint}`,
      detail: displayOpsText(incident.summary ?? incident.description ?? incident.title),
      status: incident.status === 'DETECTED' ? 'active' : 'complete',
      source: 'incident',
    },
  ]

  const agentStages = new Set(incident.agentRuns.map((run) => stageFromAgent(run.kind ?? run.agent)).filter(Boolean))
  for (const row of incident.timeline) {
    const item = eventFromTimeline(row)
    if (item && !agentStages.has(item.stage)) events.push(item)
  }

  for (const run of incident.agentRuns) {
    const stage = stageFromAgent(run.kind ?? run.agent)
    if (!stage) continue
    events.push({
      id: `agent:${run.id}`,
      stage,
      at: run.completedAt ?? run.createdAt,
      title: `${run.kind ?? run.agent}${run.round > 0 ? ` · round ${run.round}` : ''}`,
      detail: displayOpsText(run.outputSummary ?? run.currentActivity ?? run.role),
      status: eventStatus(run.status),
      source: 'agent',
    })
  }

  for (const approval of incident.approvals) {
    events.push({
      id: `approval:${approval.id}`,
      stage: 'APPROVAL',
      at: approval.statusUpdatedAt ?? approval.createdAt,
      title: `Human decision · ${approval.status}`,
      detail: displayOpsText(approval.reason ?? approval.outcome ?? `Approval ${approval.approvalId} is ${approval.status.toLowerCase()}.`),
      status: eventStatus(approval.status),
      source: 'approval',
    })
  }

  if (incident.patch) {
    events.push({
      id: `patch:${incident.patch.id}`,
      stage: 'PATCH',
      at: incident.patch.createdAt,
      title: `Patch ${incident.patch.status}`,
      detail: [incident.patch.file, incident.patch.function].filter(Boolean).join(' · ') || incident.patch.patchId,
      status: eventStatus(incident.patch.status),
      source: 'patch',
    })
    if (incident.patch.validatedAt) {
      events.push({
        id: `validation:${incident.patch.id}`,
        stage: 'VALIDATION',
        at: incident.patch.validatedAt,
        title: incident.terminalSummary?.validation.result === 'fail' ? 'Validation failed' : 'Validation passed',
        detail: incident.terminalSummary?.validation.detail ?? 'Persisted validation completed.',
        status: incident.terminalSummary?.validation.result === 'fail' ? 'failed' : 'complete',
        source: 'patch',
      })
    }
  }

  if (incident.resolvedAt || incident.status === 'RESOLVED' || incident.status === 'ROLLED_BACK') {
    events.push({
      id: `recovery:${incident.id}`,
      stage: 'RECOVERY',
      at: incident.resolvedAt ?? incident.updatedAt,
      title: incident.status === 'RESOLVED' ? 'Service recovered' : incident.status.replaceAll('_', ' '),
      detail: displayOpsText(incident.terminalSummary?.text ?? incident.summary ?? 'Terminal incident state persisted.'),
      status: incident.status === 'RESOLVED' ? 'complete' : 'failed',
      source: 'incident',
    })
  }

  if (incident.learning) {
    events.push({
      id: `learning:${incident.id}`,
      stage: 'LEARNING',
      at: incident.learning.updatedAt,
      title: `Reward ${incident.learning.reward >= 0 ? '+' : ''}${incident.learning.reward} recorded`,
      detail: `${incident.learning.outcome} · recurrence ${incident.learning.recurrenceCount}`,
      status: 'complete',
      source: 'learning',
    })
  }

  return dedupeEvents(events)
}

export function lifecycleEvents(payload: LifecycleEventDTO): OperationalEvent[] {
  const rows: OperationalEvent[] = []
  for (const row of payload.events) {
    const stage = stageFromText(`${row.stage} ${row.label}`)
    if (!stage) continue
    rows.push({ id: `live:event:${row.id}`, stage, at: row.at, title: displayOpsText(`${row.ref ?? 'Incident'} · ${row.label}`), detail: displayOpsText(row.detail ?? row.stage), status: eventStatus(`${row.stage} ${row.label}`), source: 'timeline' })
  }
  for (const row of payload.agentRuns) {
    const stage = stageFromAgent(row.kind ?? row.agent)
    if (!stage) continue
    rows.push({ id: `live:agent:${row.id}`, stage, at: row.updatedAt, title: `${row.ref ?? 'Incident'} · ${row.kind ?? row.agent}`, detail: `${row.status} · round ${row.round} · ${row.mode}`, status: eventStatus(row.status), source: 'agent' })
  }
  for (const row of payload.approvals) {
    rows.push({ id: `live:approval:${row.id}`, stage: 'APPROVAL', at: row.createdAt, title: `${row.ref ?? 'Incident'} · human approval`, detail: `${row.approvalId} · ${row.status}`, status: eventStatus(row.status), source: 'approval' })
  }
  for (const row of payload.repairs) {
    const stage = stageFromText(row.status) ?? 'PATCH'
    rows.push({ id: `live:repair:${row.attemptId}:${row.status}`, stage, at: row.startedAt, title: `${row.ref ?? 'Incident'} · repair`, detail: `${row.status}${row.risk ? ` · risk ${row.risk}` : ''}`, status: eventStatus(row.status), source: 'patch' })
  }
  for (const row of payload.incidents) {
    const stage = stageFromText(row.status) ?? 'DETECTION'
    rows.push({ id: `live:incident:${row.id}:${row.status}`, stage, at: row.updatedAt, title: displayOpsText(`${row.ref} · ${row.status}`), detail: displayOpsText(row.title), status: eventStatus(row.status), source: 'incident' })
  }
  return dedupeEvents(rows)
}

export function logEvents(logs: LogEventDTO[]): OperationalEvent[] {
  return logs.filter((log) => log.level === 'ERROR' || log.level === 'SECURITY').map((log) => ({
    id: `log:${log.id}`,
    stage: stageFromText(`${log.service} ${log.message}`) ?? 'DETECTION',
    at: log.createdAt,
    title: `${log.level} · ${log.method ?? log.service}${log.route ? ` ${log.route}` : ''}`,
    detail: displayOpsText(log.message),
    status: log.level === 'ERROR' || log.level === 'SECURITY' ? 'failed' : 'active',
    source: 'log',
  }))
}

export function dedupeEvents(rows: OperationalEvent[]): OperationalEvent[] {
  const seen = new Set<string>()
  return [...rows]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .filter((row) => {
      const bucket = Math.floor(Date.parse(row.at) / 5000)
      const semanticTitle = row.title
        .toUpperCase()
        .replace(/INC-\d+/g, '')
        .replace(/ROUND \d+/g, '')
        .replace(/[^A-Z]+/g, ' ')
        .trim()
      const key = `${row.stage}:${bucket}:${semanticTitle}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function activeStage(incident: IncidentDetailDTO | null): OperationalStage {
  const events = incidentEvents(incident)
  const active = events.find((event) => event.status === 'active' || event.status === 'waiting')
  if (active) return active.stage
  return events[0]?.stage ?? 'DETECTION'
}
