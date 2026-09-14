'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import {
  fetchIncident,
  fetchIncidents,
  fetchSummary,
} from '@/lib/api/observability'
import type {
  ComponentHealth,
  IncidentDTO,
  IncidentDetailDTO,
  LogEventDTO,
  SecurityFinding,
  SummaryResponse,
} from '@/lib/api/observability'
import { subscribeSecurityEvents } from '@/lib/api/security'
import type {
  LifecycleEventDTO,
  RealtimeDeliveryDTO,
  RealtimeLastIncidentDTO,
} from '@/lib/api/security'
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LiveBadge,
  LoadingState,
  Pill,
  ProgressBar,
  StatCard,
  levelTone,
  relativeTime,
  riskColor,
} from './ui'

const REFRESH_MS = 15000

function RiskGauge({ score }: { score: number }) {
  const color = riskColor(score)
  const circumference = 2 * Math.PI * 34
  const offset = circumference * (1 - score / 100)
  return (
    <svg width="72" height="72" viewBox="0 0 80 80" className="shrink-0" aria-hidden="true">
      <circle cx="40" cy="40" r="34" fill="none" stroke="var(--bh-surface-2)" strokeWidth="7" />
      <circle
        cx="40"
        cy="40"
        r="34"
        fill="none"
        stroke={color}
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 40 40)"
      />
      <text
        x="40"
        y="46"
        textAnchor="middle"
        fontSize="16"
        fontWeight="700"
        fill="var(--bh-ink)"
        fontFamily="var(--font-geist-mono), monospace"
      >
        {score}
      </text>
    </svg>
  )
}

function componentStatusStyle(status: ComponentHealth['status']) {
  switch (status) {
    case 'healthy':
      return { dot: 'bg-bh-success', label: 'Healthy', text: 'text-bh-success' }
    case 'degraded':
      return { dot: 'bg-bh-warning', label: 'Degraded', text: 'text-bh-warning' }
    default:
      return { dot: 'bg-bh-danger', label: 'Unavailable', text: 'text-bh-danger' }
  }
}

function findingTone(severity: SecurityFinding['severity']) {
  switch (severity) {
    case 'HIGH':
      return 'danger'
    case 'MEDIUM':
      return 'warning'
    default:
      return 'info'
  }
}

function LogRow({ log }: { log: LogEventDTO }) {
  const dotClass =
    log.level === 'ERROR' || log.level === 'SECURITY'
      ? 'bg-bh-danger'
      : log.level === 'WARN'
        ? 'bg-bh-warning'
        : 'bg-bh-info'

  return (
    <li className="command-ticker-row flex items-start gap-3 border-b border-bh-line/60 px-4 py-2.5 last:border-0">
      <span
        className={cn('mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full', dotClass)}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn('font-mono text-xs font-semibold uppercase', levelTone(log.level))}>
            {log.level}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-bh-faint">
            {relativeTime(log.createdAt)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-bh-ink" title={log.message}>
          {log.message}
        </p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-bh-faint">
          {log.service} · {log.route ?? '—'}
          {log.status ? ` · ${log.status}` : ''}
          {log.incidentRef ? ` · ${log.incidentRef}` : ''}
        </p>
      </div>
    </li>
  )
}

function TelegramDeliveryRow({ row }: { row: RealtimeDeliveryDTO }) {
  const ok = row.deliveryStatus === 'SENT'
  const duplicate = row.deliveryStatus === 'SKIPPED_DUPLICATE'
  return (
    <li className="command-ticker-row flex items-start gap-3 border-b border-bh-line/60 px-4 py-2.5 last:border-0">
      <span
        className={cn(
          'mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full',
          ok ? 'bg-bh-success' : duplicate ? 'bg-bh-warning' : 'bg-bh-danger',
        )}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn('font-mono text-xs font-semibold', ok ? 'text-bh-success' : duplicate ? 'text-bh-warning' : 'text-bh-danger')}>
            {ok
              ? 'Delivered'
              : duplicate
                ? 'Skipped duplicate'
                : 'Delivery failed'}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-bh-faint">
            {relativeTime(row.createdAt)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-bh-ink">
          {row.type}
          {row.severity ? ` · ${row.severity}` : ''}
          {ok && row.telegramMessageId ? ` · msg ${row.telegramMessageId}` : ''}
          {!ok && !duplicate && row.error ? ` · ${row.error}` : ''}
        </p>
        {row.incidentId && (
          <Link
            href={`/ai/incidents/${row.incidentId}`}
            className="mt-0.5 inline-block font-mono text-[11px] text-bh-accent-ink hover:underline"
          >
            view incident →
          </Link>
        )}
      </div>
    </li>
  )
}

interface LifecycleFeedItem {
  key: string
  at: string
  kind: 'Incident' | 'Event' | 'Coder' | 'Approval' | 'Repair'
  text: string
  tone: 'success' | 'warning' | 'danger' | 'accent'
}

function lifecycleItems(payload: LifecycleEventDTO): LifecycleFeedItem[] {
  const items: LifecycleFeedItem[] = []
  for (const row of payload.incidents) {
    items.push({
      key: `i:${row.id}`,
      at: row.updatedAt,
      kind: 'Incident',
      text: `${row.ref} · ${row.status}`,
      tone:
        row.status === 'RESOLVED'
          ? 'success'
          : row.status === 'ROLLED_BACK'
            ? 'danger'
            : row.status === 'WAITING_APPROVAL'
              ? 'warning'
              : 'accent',
    })
  }
  for (const row of payload.events) {
    items.push({
      key: `e:${row.id}`,
      at: row.at,
      kind: 'Event',
      text: `${row.ref ?? '—'} ${row.stage} · ${row.label}`,
      tone: 'accent',
    })
  }
  for (const row of payload.agentRuns) {
    items.push({
      key: `a:${row.id}`,
      at: row.updatedAt,
      kind: 'Coder',
      text: `${row.ref ?? '—'} · ${row.status === 'COMPLETE' ? 'completed' : row.status} (R${row.round} · ${row.agent})`,
      tone: row.status === 'COMPLETE' ? 'success' : row.status === 'FAILED' ? 'danger' : 'accent',
    })
  }
  for (const row of payload.approvals) {
    items.push({
      key: `ap:${row.id}`,
      at: row.createdAt,
      kind: 'Approval',
      text: `${row.ref ?? '—'} ${row.approvalId} · ${row.status}`,
      tone:
        row.status === 'APPROVED' || row.status === 'CONSUMED'
          ? 'success'
          : row.status === 'REJECTED' || row.status === 'EXPIRED'
            ? 'danger'
            : 'warning',
    })
  }
  for (const row of payload.repairs) {
    items.push({
      key: `r:${row.attemptId}:${row.status}`,
      at: row.startedAt,
      kind: 'Repair',
      text: `${row.ref ?? '—'} · ${row.status}${row.risk ? ` (${row.risk})` : ''}`,
      tone:
        row.status === 'RESOLVED'
          ? 'success'
          : row.status === 'ROLLED_BACK'
            ? 'danger'
            : row.status === 'WAITING_APPROVAL'
              ? 'warning'
              : 'accent',
    })
  }
  return items
}

function appendLifecycle(prev: LifecycleFeedItem[], payload: LifecycleEventDTO): LifecycleFeedItem[] {
  const seen = new Set(prev.map((item) => item.key))
  const fresh = lifecycleItems(payload).filter((item) => !seen.has(item.key))
  return [...fresh, ...prev].slice(0, 24)
}

export function OverviewClient() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [incidents, setIncidents] = useState<IncidentDTO[]>([])
  const [pipeline, setPipeline] = useState<Record<string, IncidentDetailDTO>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [telegramFeed, setTelegramFeed] = useState<RealtimeDeliveryDTO[]>([])
  const [telegramLastIncident, setTelegramLastIncident] = useState<RealtimeLastIncidentDTO | null>(null)
  const [telegramLive, setTelegramLive] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [lifecycleFeed, setLifecycleFeed] = useState<LifecycleFeedItem[]>([])
  const [lifecycleLive, setLifecycleLive] = useState<'connecting' | 'live' | 'error'>('connecting')

  // Debounced live refresh: coalesces a burst of lifecycle diffs into a single
  // refetch so the dashboard stays responsive and we never hammer the API.
  const liveRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleLiveRefresh = () => {
    if (liveRefreshRef.current) clearTimeout(liveRefreshRef.current)
    liveRefreshRef.current = setTimeout(() => {
      void load()
    }, 400)
  }
  useEffect(() => () => {
    if (liveRefreshRef.current) clearTimeout(liveRefreshRef.current)
  }, [])

  const load = async () => {
    try {
      const [summaryData, incidentData] = await Promise.all([
        fetchSummary(),
        fetchIncidents({ pageSize: 8 }),
      ])
      setSummary(summaryData)
      setIncidents(incidentData.incidents)

      const active = incidentData.incidents
        .filter((i) =>
          ['DETECTED', 'INVESTIGATING', 'AWAITING_REVIEW', 'WAITING_APPROVAL'].includes(i.status),
        )
        .slice(0, 2)
      const pipelineMap: Record<string, IncidentDetailDTO> = {}
      await Promise.all(
        active.map(async (incident) => {
          try {
            const detail = await fetchIncident(incident.id)
            pipelineMap[incident.id] = detail.incident
          } catch {
            // Pipeline snapshot is best-effort; the list still renders.
          }
        }),
      )
      setPipeline(pipelineMap)

      setError(null)
      setLastUpdated(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const first = setTimeout(() => {
      void load()
    }, 0)
    const interval = setInterval(() => {
      void load()
    }, REFRESH_MS)
    return () => {
      clearTimeout(first)
      clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeSecurityEvents({
      onSnapshot: (snapshot) => {
        setTelegramFeed(snapshot.rows)
        setTelegramLastIncident(snapshot.lastIncident)
        setTelegramLive('live')
      },
      onDelivery: (rows) => {
        setTelegramFeed((prev) => [...rows, ...prev].slice(0, 12))
        setTelegramLive('live')
      },
      onLifecycle: (payload) => {
        setLifecycleFeed((prev) => appendLifecycle(prev, payload))
        setLifecycleLive('live')
        // A lifecycle diff means real backend state changed (incident,
        // agent run, approval or repair). Refresh the live dashboard state
        // immediately so the UI tracks the pipeline without waiting for the
        // polling fallback interval. The refetch pulls the freshest DB state,
        // so a newer SSE update can never be overwritten by an older poll.
        scheduleLiveRefresh()
      },
      onError: () => {
        setTelegramLive('error')
        setLifecycleLive('error')
      },
    })
    return unsubscribe
  }, [])

  if (loading && !summary) {
    return <LoadingState label="Loading command center…" />
  }

  if (error && !summary) {
    return <ErrorState message={error} onRetry={() => void load()} />
  }

  const overview = summary?.overview
  const activeIncidents = incidents.filter((i) =>
    ['DETECTED', 'INVESTIGATING', 'AWAITING_REVIEW', 'WAITING_APPROVAL'].includes(i.status),
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-bh-faint">
            Mission Control
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-bh-ink">Overview</h1>
          <p className="mt-1 text-sm text-bh-muted">
            {lifecycleLive === 'live'
              ? 'Live via SSE — updates as incidents and repairs happen'
              : lastUpdated
                ? `Auto-refreshing every ${REFRESH_MS / 1000}s (SSE stream unavailable)`
                : 'Live telemetry'}
          </p>
        </div>
        <LiveBadge />
      </div>

      {overview && overview.riskScore > 0 ? (
        <div className="flex items-start gap-3 rounded-lg border border-bh-warning/30 bg-bh-warning/10 p-3.5 text-xs text-bh-muted">
          <Icon name="radar" size={16} className="mt-0.5 shrink-0 text-bh-warning" />
          <p>
            <span className="font-semibold text-bh-warning">Active security posture.</span>{' '}
            Real findings from the security-log analyzer are weighted into the scores below.
            AI analysis runs on real evidence via Groq; nothing is applied without human
            approval.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-lg border border-bh-success/25 bg-bh-success/10 p-3.5 text-xs text-bh-muted">
          <Icon name="shield" size={16} className="mt-0.5 shrink-0 text-bh-success" />
          <p>
            <span className="font-semibold text-bh-success">ALL SYSTEMS SECURE.</span> No
            security findings and no active incidents. The AI pipeline below is live and will
            only run when real evidence arrives.
          </p>
        </div>
      )}

      {/* Score cards */}
      <section aria-label="System scores" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card className="flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">
              Risk Score
            </p>
            <p className="mt-2 text-sm text-bh-muted">Composite system risk, 0–100</p>
          </div>
          <RiskGauge score={overview?.riskScore ?? 0} />
        </Card>
        <StatCard
          label="Cyber Safety"
          value={overview?.cyberSafetyScore ?? 0}
          sub="/ 100 · impacted by active incidents"
          accent={(overview?.cyberSafetyScore ?? 0) >= 80 ? 'var(--bh-success)' : 'var(--bh-warning)'}
          icon="shield"
        />
        <StatCard
          label="App Reliability"
          value={overview?.applicationReliabilityScore ?? 0}
          sub="/ 100 · endpoint failure load"
          accent={(overview?.applicationReliabilityScore ?? 0) >= 80 ? 'var(--bh-success)' : 'var(--bh-warning)'}
          icon="activity"
        />
        <StatCard
          label="System Health"
          value={`${overview?.systemHealth ?? 0}%`}
          sub="weighted component availability"
          accent={(overview?.systemHealth ?? 0) >= 95 ? 'var(--bh-success)' : 'var(--bh-warning)'}
          icon="activity"
        />
        <StatCard
          label="Total Health"
          value={overview?.totalHealthScore ?? 0}
          sub="/ 100 · cyber + reliability + health"
          accent={(overview?.totalHealthScore ?? 0) >= 90 ? 'var(--bh-success)' : 'var(--bh-warning)'}
          icon="shield"
        />
        <StatCard
          label="Active Incidents"
          value={overview?.activeIncidents ?? 0}
          sub="open across the platform"
          accent={(overview?.activeIncidents ?? 0) > 0 ? 'var(--bh-warning)' : 'var(--bh-success)'}
          icon="bug"
        />
      </section>

      {/* Components + security */}
      <section aria-label="System posture" className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader icon="radar" title="Component Health" hint="5-point system posture" />
          <ul className="divide-y divide-bh-line/60">
            {summary?.components.map((component) => {
              const style = componentStatusStyle(component.status)
              return (
                <li key={component.name} className="flex items-center gap-3 px-4 py-3">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', style.dot)} aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-bh-ink">{component.label}</p>
                    <p className="truncate text-xs text-bh-faint">{component.detail}</p>
                  </div>
                  <span className={cn('shrink-0 text-xs font-semibold', style.text)}>
                    {style.label}
                  </span>
                </li>
              )
            })}
          </ul>
        </Card>

        <Card>
          <CardHeader
            icon="shield"
            title="Security Observations"
            hint="anomaly detection · 24h window"
            extra={<Pill tone="info">Observe only</Pill>}
          />
          {!summary?.securityEvents.length ? (
            <EmptyState
              icon="shield"
              title="No anomalies"
              message="No security-relevant patterns were observed in the current window."
            />
          ) : (
            <ul className="divide-y divide-bh-line/60">
              {summary?.securityEvents.map((finding, index) => (
                <li key={`${finding.type}-${index}`} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-bh-ink">{finding.title}</p>
                    <Pill tone={findingTone(finding.severity) as 'danger'}>{finding.severity}</Pill>
                  </div>
                  <p className="mt-1 text-xs text-bh-muted">{finding.summary}</p>
                  <p className="mt-1 font-mono text-[11px] text-bh-faint">
                    {finding.count} event{finding.count === 1 ? '' : 's'}
                    {finding.route ? ` · ${finding.route}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Live activity + active incidents */}
      <section aria-label="Live activity" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader
            icon="terminal"
            title="Live Activity"
            hint="most recent log events"
            extra={
              <span className="flex items-center gap-1.5 text-[11px] text-bh-faint">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bh-accent" aria-hidden="true" />
                streaming
              </span>
            }
          />
          {!summary?.recentLogs.length ? (
            <EmptyState icon="terminal" title="No activity" message="Log stream is quiet." />
          ) : (
            <ul>
              {summary?.recentLogs.map((log) => <LogRow key={log.id} log={log} />)}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            icon="bug"
            title="Active Incidents"
            hint="open investigations"
            extra={
              <Link
                href="/ai/incidents"
                className="flex items-center gap-1 text-xs text-bh-accent-ink hover:underline"
              >
                View all <Icon name="arrowRight" size={13} />
              </Link>
            }
          />
          {!activeIncidents.length ? (
            <EmptyState
              icon="heart"
              title="All clear"
              message="No active incidents right now."
            />
          ) : (
            <ul className="divide-y divide-bh-line/60">
              {activeIncidents.map((incident) => (
                <li key={incident.id}>
                  <Link
                    href={`/ai/incidents/${incident.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bh-surface-2/70"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-bh-faint">
                          {incident.ref}
                        </span>
                        <Pill
                          tone={
                            incident.severity === 'HIGH' || incident.severity === 'CRITICAL'
                              ? 'danger'
                              : 'warning'
                          }
                        >
                          {incident.severity}
                        </Pill>
                      </span>
                      <span className="mt-1 block truncate text-sm font-medium text-bh-ink">
                        {incident.title}
                      </span>
                      <span className="mt-0.5 block font-mono text-[11px] text-bh-faint">
                        {incident.method} {incident.endpoint} · {relativeTime(incident.createdAt)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-bh-muted">{incident.status}</span>
                    <Icon name="chevronDown" size={14} className="-rotate-90 shrink-0 text-bh-faint" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            icon="bell"
            title="Telegram Delivery"
            hint="append-only alert log · SSE"
            extra={
              telegramLive === 'live' ? (
                <span className="flex items-center gap-1.5 text-[11px] text-bh-success">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bh-success" aria-hidden="true" />
                  live
                </span>
              ) : telegramLive === 'error' ? (
                <span className="text-[11px] text-bh-danger">offline</span>
              ) : (
                <span className="text-[11px] text-bh-faint">connecting…</span>
              )
            }
          />
          {telegramLive === 'error' && telegramFeed.length === 0 ? (
            <EmptyState
              icon="bell"
              title="Stream unavailable"
              message="The realtime Telegram stream is not reachable. Admin status shows persisted deliveries."
            />
          ) : telegramFeed.length === 0 ? (
            <EmptyState
              icon="bell"
              title="No deliveries yet"
              message="Telegram alert activity will appear here the moment a push is attempted."
            />
          ) : (
            <ul>
              {telegramFeed.map((row) => <TelegramDeliveryRow key={row.id} row={row} />)}
            </ul>
          )}
          {telegramLastIncident && (
            <div className="border-t border-bh-line px-4 py-2.5">
              <p className="truncate text-[11px] text-bh-faint">
                Latest incident <span className="font-mono text-bh-muted">{telegramLastIncident.ref}</span> ·{' '}
                <span className={cn('font-medium')}>{telegramLastIncident.status}</span> ·{' '}
                {relativeTime(telegramLastIncident.createdAt)}
              </p>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            icon="activity"
            title="Incident Lifecycle"
            hint="incident · events · coder · approvals · repairs · SSE"
            extra={
              lifecycleLive === 'live' ? (
                <span className="flex items-center gap-1.5 text-[11px] text-bh-success">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-bh-success" aria-hidden="true" />
                  live
                </span>
              ) : lifecycleLive === 'error' ? (
                <span className="text-[11px] text-bh-danger">offline</span>
              ) : (
                <span className="text-[11px] text-bh-faint">connecting…</span>
              )
            }
          />
          {lifecycleLive === 'error' && lifecycleFeed.length === 0 ? (
            <EmptyState
              icon="activity"
              title="Stream unavailable"
              message="The realtime lifecycle stream is not reachable."
            />
          ) : lifecycleFeed.length === 0 ? (
            <EmptyState
              icon="activity"
              title="No lifecycle activity yet"
              message="Incident, agent, approval and repair updates will stream here in real time."
            />
          ) : (
            <ul>
              {lifecycleFeed.map((item) => (
                <li
                  key={item.key}
                  className="flex items-start gap-3 border-b border-bh-line/60 px-4 py-2 last:border-0"
                >
                  <span
                    className={cn(
                      'mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                      item.tone === 'success'
                        ? 'bg-bh-success'
                        : item.tone === 'warning'
                          ? 'bg-bh-warning'
                          : item.tone === 'danger'
                            ? 'bg-bh-danger'
                            : 'bg-bh-accent-ink',
                    )}
                    aria-hidden="true"
                  />
                  <span className="shrink-0 rounded bg-bh-surface-2 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-bh-muted">
                    {item.kind}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-bh-ink">{item.text}</span>
                  <span className="shrink-0 font-mono text-[11px] text-bh-faint">
                    {relativeTime(item.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Pipeline snapshot */}
      <Card>
        <CardHeader
          icon="gitBranch"
          title="AI Pipeline Snapshot"
          hint="Fixer → Critic → Judge · live, real Groq runs per incident"
          extra={null}
        />
        <ul className="divide-y divide-bh-line/60">
          {activeIncidents.slice(0, 2).map((incident) => (
            <li key={incident.id} className="px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-bh-ink">
                  <span className="font-mono text-xs text-bh-faint">{incident.ref}</span>
                  <span className="mx-2 text-bh-line-strong">/</span>
                  {incident.title}
                </p>
                <span className="text-xs text-bh-faint">{incident.status}</span>
              </div>
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(['FIXER', 'CRITIC', 'JUDGE'] as const).map((agent) => {
                  const run = pipeline[incident.id]?.agentRuns.find(
                    (r) => r.agent === agent,
                  )
                  return (
                    <div
                      key={agent}
                      className="rounded-md border border-bh-line bg-bh-surface-2/50 p-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] font-bold tracking-wide text-bh-accent-ink">
                          {agent}
                        </span>
                        <span className="text-[11px] text-bh-faint">
                          {run?.status ?? '—'}
                        </span>
                      </div>
                      <p className="mt-1.5 line-clamp-1 text-[11px] text-bh-muted">
                        {run?.currentActivity ?? run?.role ?? 'Waiting'}
                      </p>
                      <ProgressBar
                        value={run?.progress ?? 0}
                        tone={run?.status === 'COMPLETE' ? 'success' : 'accent'}
                        className="mt-2"
                      />
                    </div>
                  )
                })}
              </div>
            </li>
          ))}
        </ul>
        <div className="border-t border-bh-line px-4 py-3">
          <Link
            href="/ai/pipeline"
            className="flex items-center justify-center gap-1.5 text-xs font-medium text-bh-accent-ink hover:underline"
          >
            Open full pipeline view <Icon name="arrowRight" size={13} />
          </Link>
        </div>
      </Card>
    </div>
  )
}