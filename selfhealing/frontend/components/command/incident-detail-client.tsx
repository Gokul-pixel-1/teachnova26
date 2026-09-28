'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { downloadIncidentReport, fetchIncident } from '@/lib/api/observability'
import type {
  AgentRunDTO,
  IncidentDetailDTO,
} from '@/lib/api/observability'
import { useAsync } from '@/lib/hooks'
import { subscribeSecurityEvents } from '@/lib/api/security'
import { submitApprovalDecision } from '@/lib/api/security'
import {
  Card,
  CardHeader,
  DetailGrid,
  EmptyState,
  ErrorState,
  LiveBadge,
  LoadingState,
  Pill,
  ProgressBar,
  agentStatusTone,
  fullStamp,
  levelTone,
  relativeTime,
  severityTone,
  statusTone,
} from './ui'

/** Canonical approval state for the dashboard (all values from the DB). */
function approvalState(incident: IncidentDetailDTO): string {
  if (incident.approvals.length === 0) return 'NOT_REQUIRED'
  const latest = incident.approvals[0]
  if (latest.status === 'PENDING') return 'WAITING_FOR_APPROVAL'
  if (latest.status === 'APPROVED' || latest.status === 'CONSUMED') return 'APPROVED'
  if (latest.status === 'REJECTED') return 'REJECTED'
  if (latest.status === 'EXPIRED') return 'EXPIRED'
  return latest.status
}

function approvalStateTone(state: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (state === 'APPROVED') return 'success'
  if (state === 'WAITING_FOR_APPROVAL') return 'warning'
  if (state === 'REJECTED' || state === 'EXPIRED') return 'danger'
  if (state === 'NOT_REQUIRED') return 'info'
  return 'neutral'
}

export function IncidentDetailClient({ id }: { id: string }) {
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [action, setAction] = useState<'proceed' | 'reject' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const fetcher = useCallback(() => fetchIncident(id).then((res) => res.incident), [id])
  const { data: incident, loading, error, refetch } = useAsync<IncidentDetailDTO>(fetcher)

  const isActive =
    incident != null &&
    ['DETECTED', 'INVESTIGATING', 'AWAITING_REVIEW', 'VALIDATING', 'WAITING_APPROVAL'].includes(
      incident.status,
    )

  const pendingApprovals =
    incident?.approvals.filter((a) => a.status === 'PENDING' && a.decision === null) ?? []

  // Jira cards for pending approvals (when the Jira approval channel is on).
  const pendingKey = pendingApprovals.map((a) => a.approvalId).join(',')
  const [jiraLinks, setJiraLinks] = useState<Record<string, { issueKey: string | null; issueUrl: string | null }>>({})
  useEffect(() => {
    if (!pendingKey) return
    let cancelled = false
    fetch(`/api/jira/links?approvalId=${encodeURIComponent(pendingKey)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { links?: Record<string, { issueKey: string | null; issueUrl: string | null }> } | null) => {
        if (!cancelled && j?.links) setJiraLinks(j.links)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [pendingKey])

  const handleApproval = async (approvalId: string, decision: 'proceed' | 'reject') => {
    setAction(decision)
    setActionError(null)
    try {
      await submitApprovalDecision(approvalId, decision)
      refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not process the approval decision.')
    } finally {
      setAction(null)
    }
  }

  // Live refresh: the SSE lifecycle stream drives immediate refetches as agent
  // runs / repairs land for this incident, with a polling fallback so the detail
  // still updates even if the stream is unavailable. Both stop once the incident
  // reaches a terminal state.
  useEffect(() => {
    if (!isActive) return
    let closed = false

    const refresh = () => {
      if (!closed) refetch()
    }

    const interval = setInterval(refresh, 4000)

    const unsubscribe = subscribeSecurityEvents({
      onSnapshot: () => {},
      onDelivery: () => {},
      onLifecycle: (payload) => {
        const touched =
          payload.incidents.some((i) => i.id === id) ||
          payload.events.some((e) => e.incidentId === id) ||
          payload.agentRuns.some((r) => r.incidentId === id) ||
          payload.repairs.some((r) => r.incidentId === id) ||
          payload.approvals.some((a) => a.incidentId === id)
        if (touched) refresh()
      },
      onError: () => {},
    })

    return () => {
      closed = true
      clearInterval(interval)
      unsubscribe()
    }
  }, [isActive, refetch, id])

  const handleDownload = async () => {
    setDownloading(true)
    setDownloadError(null)
    try {
      await downloadIncidentReport(id)
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Could not generate report')
    } finally {
      setDownloading(false)
    }
  }

  if (loading && !incident) {
    return <LoadingState label="Loading incident…" />
  }

  if (error && !incident) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState message={error} onRetry={refetch} />
      </div>
    )
  }

  if (!incident) return null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <BackLink />
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-bh-ink">{incident.title}</h1>
            <Pill tone={incident.severity === 'HIGH' || incident.severity === 'CRITICAL' ? 'danger' : 'warning'}>
              {incident.severity}
            </Pill>
            <span className={cn('text-sm font-medium', statusTone(incident.status))}>
              {incident.status}
            </span>
            {isActive && <LiveBadge />}
          </div>
          <p className="mt-1.5 font-mono text-xs text-bh-faint">
            {incident.ref} · raised {fullStamp(incident.createdAt)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={() => void handleDownload()}
            disabled={downloading}
            className="flex h-9 items-center gap-2 rounded-md bg-bh-accent px-3.5 text-sm font-medium text-white hover:bg-bh-accent-strong disabled:opacity-60"
          >
            {downloading ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
            ) : (
              <Icon name="download" size={15} />
            )}
            {downloading ? 'Generating…' : 'Download report (PDF)'}
          </button>
          {downloadError && (
            <p className="text-xs text-bh-danger" role="alert">
              {downloadError}
            </p>
          )}
        </div>
      </div>

      {/* Summary + description */}
      {incident.summary && (
        <Card className="p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-bh-faint">Summary</p>
          <p className="mt-1.5 text-sm text-bh-muted">{incident.summary}</p>
        </Card>
      )}

      <Card className="p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-bh-faint">Description</p>
        <p className="mt-1.5 text-sm leading-relaxed text-bh-ink">{incident.description}</p>
      </Card>

      {/* Metadata */}
      <Card className="p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-bh-faint">
          Observed context
        </p>
        <DetailGrid
          items={[
            ['Endpoint', `${incident.method} ${incident.endpoint}`],
            ['Request ID', incident.requestId],
            ['Error code', incident.errorCode],
            ['Risk score', `${incident.riskScore} / 100`],
            ['Cyber safety impact', String(incident.cyberSafetyImpact)],
            ['Related logs', String(incident.logCount)],
            ['Expected root cause', incident.expectedRootCause],
            ['Updated', fullStamp(incident.updatedAt)],
            ['Resolved at', incident.resolvedAt ? fullStamp(incident.resolvedAt) : '—'],
          ]}
        />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Timeline */}
        <Card>
          <CardHeader icon="history" title="Timeline" hint="observed events" />
          {incident.timeline.length === 0 ? (
            <EmptyState icon="history" title="No events" message="No timeline events recorded." />
          ) : (
            <ol className="px-4 py-4">
              {incident.timeline.map((event, index) => (
                <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
                  {index < incident.timeline.length - 1 && (
                    <span
                      className="absolute left-[4px] top-3 h-full w-px bg-bh-line-strong"
                      aria-hidden="true"
                    />
                  )}
                  <span
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                      index === incident.timeline.length - 1
                        ? 'bg-bh-accent'
                        : 'bg-bh-line-strong',
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-bh-ink">{event.label}</p>
                    {event.detail && <p className="mt-0.5 text-xs text-bh-muted">{event.detail}</p>}
                    <p className="mt-1 font-mono text-[11px] text-bh-faint">
                      {fullStamp(event.at)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Card>

        {/* Self-Healing Repair */}
        <Card>
          <CardHeader
            icon="gitBranch"
            title="Self-Healing Repair"
            hint="iterative Coder → Critic → Judge · real conversation"
            extra={isActive ? <LiveBadge /> : null}
          />
          {incident.repairAttempt && (
            <div className="border-b border-bh-line px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs font-bold text-bh-accent-ink">
                  {incident.repairAttempt.attemptId}
                </span>
                <span className="rounded bg-bh-surface-2 px-2 py-0.5 font-mono text-[11px] text-bh-muted">
                  {incident.repairAttempt.status}
                </span>
                {incident.repairAttempt.risk && (
                  <Pill tone={incident.repairAttempt.risk === 'HIGH' ? 'danger' : 'warning'}>
                    {incident.repairAttempt.risk} risk
                  </Pill>
                )}
                {incident.patch && (
                  <span className="font-mono text-[11px] text-bh-faint">
                    patch {incident.patch.patchId} · {incident.patch.status}
                    {incident.patch.file ? ` · ${incident.patch.file}${incident.patch.line ? `:${incident.patch.line}` : ''}` : ''}
                  </span>
                )}
              </div>
              {incident.repairAttempt.summary && (
                <p className="mt-1.5 text-xs text-bh-muted">{incident.repairAttempt.summary}</p>
              )}
            </div>
          )}
          {incident.agentRuns.length === 0 ? (
            <EmptyState
              icon="sparkles"
              title="No conversation yet"
              message="No real agent runs have executed for this incident."
            />
          ) : (
            <RepairConversation runs={incident.agentRuns} />
          )}
          <div className="border-t border-bh-line px-4 py-3">
            <p className="text-[11px] leading-relaxed text-bh-faint">
              Rounds are real per-call transcripts persisted on AgentRun. LOW/MEDIUM-risk
              accepted patches are auto-applied then validated with live HTTP probes and
              rolled back on failure; HIGH-risk patches require human approval first.
            </p>
          </div>
        </Card>
      </div>

      {/* Related logs */}
      <Card>
        <CardHeader
          icon="terminal"
          title="Related Log Events"
          hint={`${incident.logs.length} most recent of ${incident.logCount}`}
        />
        {incident.logs.length === 0 ? (
          <EmptyState icon="terminal" title="No logs" message="No log events linked to this incident." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead>
                <tr className="border-b border-bh-line text-[11px] uppercase tracking-wider text-bh-faint">
                  <th className="px-4 py-2.5 font-medium">Level</th>
                  <th className="px-4 py-2.5 font-medium">Service</th>
                  <th className="px-4 py-2.5 font-medium">Event</th>
                  <th className="px-4 py-2.5 font-medium">Route · Status</th>
                  <th className="px-4 py-2.5 font-medium">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bh-line/60">
                {incident.logs.map((log) => (
                  <tr key={log.id}>
                    <td className="px-4 py-2.5">
                      <span className={cn('font-mono text-xs font-semibold uppercase', levelTone(log.level))}>
                        {log.level}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-bh-muted">{log.service}</td>
                    <td className="px-4 py-2.5 text-xs text-bh-ink">{log.message}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-bh-faint">
                      {log.method ?? ''} {log.route ?? '—'}
                      {log.status ? ` · ${log.status}` : ''}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-bh-faint">
                      {relativeTime(log.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Approval history */}
      <Card>
        <CardHeader
          icon="shield"
          title="Human Approval History"
          hint="workflow decisions only — nothing is applied without these"
          extra={<Pill tone={approvalStateTone(approvalState(incident))}>{approvalState(incident)}</Pill>}
        />
        {pendingApprovals.length > 0 && (
          <div
            className="space-y-3 border-b border-bh-line bg-bh-surface-2/40 px-4 py-4"
            role="group"
            aria-label="Approval decision"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-bh-warning" aria-hidden="true" />
              <p className="text-sm font-medium text-bh-ink">
                {pendingApprovals.length === 1
                  ? `Patch ${pendingApprovals[0]?.patchId ?? ''} is awaiting your decision`
                  : `${pendingApprovals.length} patches are awaiting your decision`}
              </p>
            </div>
            <p className="text-xs leading-relaxed text-bh-muted">
              PROCEED applies this {incident.severity === 'HIGH' ? 'HIGH' : incident.severity === 'MEDIUM' ? 'MEDIUM' : 'elevated'}-risk candidate, then runs live validation probes and rolls
              back on failure. REJECT closes the incident without applying any code change.
            </p>
            <div className="flex flex-wrap gap-2">
              {pendingApprovals.map((approval) => (
                <div key={approval.id} className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => void handleApproval(approval.approvalId, 'proceed')}
                    disabled={action !== null}
                    className="flex h-8 items-center gap-1.5 rounded-md bg-bh-accent px-3 text-xs font-medium text-white hover:bg-bh-accent-strong disabled:opacity-60"
                  >
                    <Icon name="shield" size={13} />
                    {action === 'proceed' ? 'Applying…' : 'PROCEED'}
                  </button>
                  <button
                    onClick={() => void handleApproval(approval.approvalId, 'reject')}
                    disabled={action !== null}
                    className="flex h-8 items-center gap-1.5 rounded-md border border-bh-line px-3 text-xs font-medium text-bh-muted hover:border-bh-danger/50 hover:text-bh-danger disabled:opacity-60"
                  >
                    <Icon name="x" size={13} />
                    REJECT
                  </button>
                  <span className="ml-1 font-mono text-[11px] text-bh-faint">
                    {approval.approvalId}
                  </span>
                  {jiraLinks[approval.approvalId]?.issueUrl && (
                    <a
                      href={jiraLinks[approval.approvalId].issueUrl ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] font-medium text-bh-accent hover:underline"
                    >
                      Jira {jiraLinks[approval.approvalId].issueKey}: move to Done to approve, To Do to reject
                    </a>
                  )}
                </div>
              ))}
            </div>
            {actionError && (
              <p className="text-xs text-bh-danger" role="alert">
                {actionError}
              </p>
            )}
          </div>
        )}
        {incident.approvals.length === 0 ? (
          <EmptyState
            icon="shield"
            title="Awaiting review"
            message={isActive ? 'This incident is still open; no approval decision recorded yet.' : 'No approval decisions were recorded.'}
          />
        ) : (
          <ul className="divide-y divide-bh-line/60">
            {incident.approvals.map((approval) => (
              <li key={approval.id} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                    approval.decision === 'APPROVED'
                      ? 'bg-bh-success/15 text-bh-success'
                      : approval.decision === 'REJECTED'
                        ? 'bg-bh-danger/15 text-bh-danger'
                        : 'bg-bh-surface-2 text-bh-muted',
                  )}
                  aria-hidden="true"
                >
<Icon
                      name={approval.decision === 'APPROVED' ? 'check' : approval.decision === 'REJECTED' ? 'x' : 'history'}
                      size={13}
                    />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-bh-ink">
                    {approval.decision === 'APPROVED'
                      ? 'Approved'
                      : approval.decision === 'REJECTED'
                        ? 'Rejected'
                        : `Pending (${approval.status})`}
                    <span className="ml-2 font-mono text-xs">{approval.approvalId}</span>
                    <span className="ml-2 text-xs font-normal text-bh-faint">
                      by {approval.reviewer} · {relativeTime(approval.createdAt)}
                    </span>
                  </p>
                  {approval.reason && <p className="mt-0.5 text-xs text-bh-muted">{approval.reason}</p>}
                  {approval.outcome && (
                    <p className="mt-0.5 text-xs text-bh-faint">Outcome: {approval.outcome}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Alert delivery (Telegram) */}
      <Card>
        <CardHeader
          icon="bell"
          title="Alert Delivery"
          hint="append-only Telegram delivery log · SENT / FAILED / SKIPPED_DUPLICATE"
          extra={incident.telegram.deliveries.length > 0 ? <Pill tone="accent">{incident.telegram.deliveries.length}</Pill> : null}
        />
        {incident.telegram.deliveries.length === 0 ? (
          <EmptyState
            icon="bell"
            title="No Telegram deliveries"
            message="No alert push has been attempted for this incident yet."
          />
        ) : (
          <ul className="divide-y divide-bh-line/60">
            {incident.telegram.deliveries.map((delivery) => (
              <li key={delivery.id} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                    delivery.deliveryStatus === 'SENT'
                      ? 'bg-bh-success/15 text-bh-success'
                      : delivery.deliveryStatus === 'SKIPPED_DUPLICATE'
                        ? 'bg-bh-warning/15 text-bh-warning'
                        : 'bg-bh-danger/15 text-bh-danger',
                  )}
                  aria-hidden="true"
                >
                  <Icon
                    name={delivery.deliveryStatus === 'SENT' ? 'check' : delivery.deliveryStatus === 'SKIPPED_DUPLICATE' ? 'bell' : 'x'}
                    size={13}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-bh-ink">
                    {delivery.deliveryStatus === 'SENT'
                      ? `Delivered · message ${delivery.telegramMessageId}`
                      : delivery.deliveryStatus === 'SKIPPED_DUPLICATE'
                        ? 'Skipped — duplicate already SENT'
                        : delivery.error ?? `Failed (${delivery.deliveryStatus})`}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-bh-faint">
                    {delivery.type}
                    {delivery.severity ? ` · ${delivery.severity}` : ''} · {fullStamp(delivery.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {incident.terminalSummary && (
          <div className="border-t border-bh-line px-4 py-3">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-bh-faint">
              <span
                className={cn(
                  'font-mono text-[10px] font-bold tracking-wide',
                  incident.terminalSummary.finalState === 'RESOLVED'
                    ? 'text-bh-success'
                    : incident.terminalSummary.finalState === 'ROLLED_BACK'
                      ? 'text-bh-danger'
                      : incident.terminalSummary.finalState === 'REJECTED' ||
                          incident.terminalSummary.finalState === 'EXPIRED'
                        ? 'text-bh-warning'
                        : 'text-bh-muted',
                )}
              >
                {incident.terminalSummary.finalState === 'RESOLVED'
                  ? 'RESOLVED'
                  : incident.terminalSummary.finalState === 'ROLLED_BACK'
                    ? 'ROLLED BACK'
                    : incident.terminalSummary.finalState === 'REJECTED'
                      ? 'REJECTED'
                      : incident.terminalSummary.finalState === 'EXPIRED'
                        ? 'APPROVAL EXPIRED'
                        : incident.terminalSummary.finalState}
              </span>
              <span className="text-bh-line-strong">·</span>
              {incident.terminalSummary.finalState === 'REJECTED' ||
              incident.terminalSummary.finalState === 'EXPIRED' ? (
                <>
                  approval {incident.terminalSummary.finalState.toLowerCase()}
                  {incident.terminalSummary.finalState === 'REJECTED' ? ' by operator' : ' — no human decision'}
                </>
              ) : (
                <>
                  validation {incident.terminalSummary.validation.result}
                  {incident.terminalSummary.validation.probes.length > 0
                    ? ` · ${incident.terminalSummary.validation.probes.filter((p) => p.ok).length}/${incident.terminalSummary.validation.probes.length} probes OK`
                    : ''}
                </>
              )}
            </p>
            <p className="mt-2 whitespace-pre-wrap rounded-md border border-bh-line bg-bh-surface-2/50 p-3 font-mono text-[11px] leading-relaxed text-bh-muted">
              {incident.terminalSummary.text.replace(/<\/?[^>]+>/g, '')}
            </p>
          </div>
        )}
      </Card>

      {/* Alert delivery (Gmail) */}
      <Card>
        <CardHeader
          icon="mail"
          title="Gmail Delivery"
          hint="append-only Gmail delivery log · SENT / FAILED / SKIPPED_DUPLICATE"
          extra={incident.gmail.deliveries.length > 0 ? <Pill tone="accent">{incident.gmail.deliveries.length}</Pill> : null}
        />
        {incident.gmail.deliveries.length === 0 ? (
          <EmptyState
            icon="mail"
            title="No Gmail deliveries"
            message="No Gmail notification has been attempted for this incident yet."
          />
        ) : (
          <ul className="divide-y divide-bh-line/60">
            {incident.gmail.deliveries.map((delivery) => (
              <li key={delivery.id} className="flex items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                    delivery.deliveryStatus === 'SENT'
                      ? 'bg-bh-success/15 text-bh-success'
                      : delivery.deliveryStatus === 'SKIPPED_DUPLICATE'
                        ? 'bg-bh-warning/15 text-bh-warning'
                        : 'bg-bh-danger/15 text-bh-danger',
                  )}
                  aria-hidden="true"
                >
                  <Icon
                    name={delivery.deliveryStatus === 'SENT' ? 'check' : delivery.deliveryStatus === 'SKIPPED_DUPLICATE' ? 'mail' : 'x'}
                    size={13}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-bh-ink">
                    {delivery.deliveryStatus === 'SENT'
                      ? `Delivered · ${delivery.gmailMessageId ?? 'message recorded'}`
                      : delivery.deliveryStatus === 'SKIPPED_DUPLICATE'
                        ? 'Skipped — duplicate already SENT'
                        : delivery.error ?? `Failed (${delivery.deliveryStatus})`}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-bh-muted">{delivery.subject}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-bh-faint">
                    {delivery.type}
                    {delivery.severity ? ` · ${delivery.severity}` : ''} · {fullStamp(delivery.createdAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Repair reward (learning signal — outcome-only, never for applying) */}
      <Card>
        <CardHeader
          icon="sparkles"
          title="Repair Reward"
          hint="transparent outcome-based learning signal"
          extra={
            incident.learning ? (
              <Pill tone={incident.learning.reward > 0 ? 'success' : incident.learning.reward < 0 ? 'danger' : 'neutral'}>
                {incident.learning.reward > 0 ? `+${incident.learning.reward}` : `${incident.learning.reward}`}
              </Pill>
            ) : null
          }
        />
        {!incident.learning ? (
          <EmptyState
            icon="sparkles"
            title="No learning record yet"
            message="A normalized repair experience is stored when this incident reaches a terminal state."
          />
        ) : (
          <div className="px-4 py-3">
            <dl className="rounded-lg bg-bh-surface-2 p-3 text-xs">
              <div className="flex items-baseline justify-between gap-3 border-b border-bh-line/60 py-1.5">
                <dt className="text-bh-muted">Outcome</dt>
                <dd className="font-mono font-medium text-bh-ink">{incident.learning.outcome}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-b border-bh-line/60 py-1.5">
                <dt className="text-bh-muted">Human decision</dt>
                <dd className="font-mono font-medium text-bh-ink">{incident.learning.humanDecision ?? '—'}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-b border-bh-line/60 py-1.5">
                <dt className="text-bh-muted">Recurrences</dt>
                <dd className="font-mono font-medium text-bh-ink">{incident.learning.recurrenceCount}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-1.5">
                <dt className="text-bh-muted">Breakdown</dt>
                <dd className="text-right font-mono font-medium text-bh-ink">
                  {incident.learning.rewardBreakdown && Object.keys(incident.learning.rewardBreakdown).length > 0
                    ? Object.entries(incident.learning.rewardBreakdown)
                        .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`)
                        .join(' · ')
                    : '—'}
                </dd>
              </div>
            </dl>
            <p className="mt-2 font-mono text-[11px] text-bh-faint">signature {incident.learning.errorSignature.slice(0, 80)}</p>
          </div>
        )}
      </Card>

      {/* Previous similar incidents */}
      <Card>
        <CardHeader
          icon="history"
          title="Previous Similar Incidents"
          hint={incident.previous.length > 0 ? `around ${incident.endpoint}` : 'none found'}
        />
        {incident.previous.length === 0 ? (
          <EmptyState
            icon="history"
            title="No similar history"
            message="No previous incidents share this endpoint or a meaningful title keyword."
          />
        ) : (
          <ul className="divide-y divide-bh-line/60">
            {incident.previous.map((previous) => (
              <li key={previous.id}>
                <Link
                  href={`/ai/incidents/${previous.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-bh-surface-2/60"
                >
                  <span className="font-mono text-xs font-semibold text-bh-accent-ink">
                    {previous.ref}
                  </span>
                  <span className={cn('font-mono text-xs', severityTone(previous.severity))}>
                    {previous.severity}
                  </span>
                  <span className={cn('text-xs', statusTone(previous.status))}>
                    {previous.status}
                  </span>
                  {(previous.outcome ?? previous.reward != null) && (
                    <span className="font-mono text-[11px] text-bh-faint">
                      {previous.outcome ?? ''}
                      {previous.reward != null ? ` · ${previous.reward > 0 ? '+' : ''}${previous.reward}` : ''}
                      {previous.humanDecision ? ` · human ${previous.humanDecision}` : ''}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-bh-ink">{previous.title}</span>
                  <span className="font-mono text-[11px] text-bh-faint">
                    {fullStamp(previous.createdAt).slice(0, 10)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function RepairConversation({ runs }: { runs: AgentRunDTO[] }) {
  const ordered = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const rounds: AgentRunDTO[][] = []
  for (const run of ordered) {
    let bucket = rounds[rounds.length - 1]
    if (!bucket || bucket[0].round !== run.round) {
      bucket = []
      rounds.push(bucket)
    }
    bucket.push(run)
  }

  return (
    <ol className="space-y-3 px-4 py-4">
      {rounds.map((bucket, index) => {
        const first = bucket[0]
        const isJudge = bucket[0].kind === 'JUDGE' || bucket[0].agent === 'JUDGE'
        return (
          <li key={bucket[0].id} className="space-y-2">
            <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-bh-faint">
              {isJudge ? (
                <>Final verdict</>
              ) : (
                <>
                  Round {first.round}
                  <span className="text-bh-line-strong">·</span>
                  {bucket.map((r) => r.kind ?? r.agent).join(' → ')}
                </>
              )}
              {index < rounds.length - 1 && <span className="h-px flex-1 bg-bh-line/60" aria-hidden="true" />}
            </p>
            {bucket.map((run) => (
              <AgentRunRow key={run.id} run={run} />
            ))}
          </li>
        )
      })}
    </ol>
  )
}

function AgentRunRow({ run }: { run: AgentRunDTO }) {
  const tone =
    run.status === 'COMPLETE'
      ? 'success'
      : run.status === 'REJECTED' || run.status === 'FAILED'
        ? 'danger'
        : 'accent'
  return (
    <div className="rounded-md border border-bh-line bg-bh-surface-2/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-xs font-bold tracking-wide text-bh-accent-ink">
          {run.kind ?? run.agent}
          <span className="ml-2 font-sans font-medium text-bh-muted">{run.role}</span>
          {run.round > 0 && run.kind !== 'JUDGE' && (
            <span className="ml-2 text-[11px] text-bh-faint">round {run.round}</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-bh-faint">
            {run.mode === 'TEST' ? 'TEST' : run.model ?? ''}
            {run.contextSize != null ? ` · ${run.contextSize} tok ctx` : ''}
          </span>
          <span className={cn('text-[11px] font-semibold', agentStatusTone(run.status))}>
            {run.status}
            {run.confidence !== null && run.confidence !== undefined ? ` · ${run.confidence}% confidence` : ''}
          </span>
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <ProgressBar value={run.progress} tone={tone} className="flex-1" />
        <span className="shrink-0 font-mono text-[11px] text-bh-faint">{run.progress}%</span>
      </div>
      {run.currentActivity && <p className="mt-2 text-xs text-bh-muted">{run.currentActivity}</p>}
      {run.status === 'FAILED' && run.error && (
        <p className="mt-2 text-xs font-medium text-bh-danger">
          AI ANALYSIS UNAVAILABLE — {run.error}
        </p>
      )}
      {run.outputSummary && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-bh-faint">
          <span className="font-medium text-bh-muted">Verdict:</span> {run.outputSummary}
        </p>
      )}
    </div>
  )
}

function BackLink() {
  return (
    <Link
      href="/ai/incidents"
      className="inline-flex items-center gap-1.5 text-xs text-bh-muted hover:text-bh-accent-ink"
    >
      <Icon name="arrowLeft" size={13} /> Back to incidents
    </Link>
  )
}