'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import Link from 'next/link'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { useAsync } from '@/lib/hooks'
import {
  fetchSecurityStatus,
  runPipelineFor,
  subscribeSecurityEvents,
  testTelegram,
} from '@/lib/api/security'
import type {
  SecurityFindingDTO,
  SecurityIncidentDTO,
  SecurityStatusDTO,
  SecurityTelegramDTO,
} from '@/lib/api/security'
import { SecurityNetwork } from './security-network'
import { AttackTelemetryCard } from './attack-telemetry'
import { askAiChat, type ChatResponse } from '@/lib/api/learning'
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LiveBadge,
  LoadingState,
  Pill,
  fullStamp,
  relativeTime,
  riskColor,
  severityTone,
  statusTone,
} from './ui'

function tierTone(tier: SecurityStatusDTO['tier']) {
  switch (tier) {
    case 'dashboard':
      return { pill: 'success' as const, label: 'Normal', dot: 'bg-bh-success' }
    case 'incident':
      return { pill: 'warning' as const, label: 'Incident', dot: 'bg-bh-warning' }
    case 'heightened':
      return { pill: 'warning' as const, label: 'Heightened', dot: 'bg-bh-warning' }
    default:
      return { pill: 'danger' as const, label: 'Critical', dot: 'bg-bh-danger' }
  }
}

function findingSeverityTone(severity: SecurityFindingDTO['severity']) {
  return severity === 'HIGH' || severity === 'CRITICAL' ? 'danger' : severity === 'MEDIUM' ? 'warning' : 'info'
}

function AgentChip({ run }: { run: { agent: string; status: string; error: string | null } }) {
  return (
    <span className="flex items-center gap-1.5 rounded border border-bh-line bg-bh-surface-2/60 px-2 py-1">
      <span className="font-mono text-[10px] font-bold text-bh-accent-ink">{run.agent}</span>
      <span
        className={cn(
          'text-[10px] font-semibold',
          run.status === 'COMPLETE'
            ? 'text-bh-success'
            : run.status === 'FAILED'
              ? 'text-bh-danger'
              : 'text-bh-muted',
        )}
        title={run.error ?? undefined}
      >
        {run.status}
      </span>
    </span>
  )
}

function TelegramRow({ row }: { row: SecurityTelegramDTO }) {
  const ok = row.deliveryStatus === 'SENT'
  const duplicate = row.deliveryStatus === 'SKIPPED_DUPLICATE'
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <Icon
        name="bell"
        size={14}
        className={
          ok
            ? 'shrink-0 text-bh-success'
            : duplicate
              ? 'shrink-0 text-bh-warning'
              : 'shrink-0 text-bh-danger'
        }
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-bh-ink">
          {ok
            ? `Message ${row.telegramMessageId} delivered`
            : duplicate
              ? 'Duplicate delivery skipped (already SENT)'
              : row.error ?? 'Delivery failed'}
        </p>
        <p className="truncate font-mono text-[11px] text-bh-faint">
          {row.type} {row.severity ? `· ${row.severity}` : ''} · {fullStamp(row.createdAt)}
        </p>
      </div>
    </li>
  )
}

export function SecurityClient() {
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastRun, setLastRun] = useState<{ ref: string; result: string } | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'operator' | 'assistant'; text: string }>>([])
  const [chatBusy, setChatBusy] = useState(false)

  const fetcher = useCallback(() => fetchSecurityStatus(), [])
  const { data, loading, error, refetch } = useAsync<SecurityStatusDTO>(fetcher)

  // Live refresh via the SSE security events stream: when the backend emits a
  // delivery or lifecycle diff (new incident, agent run, approval, repair),
  // refetch the real security status immediately instead of waiting for a
  // polling fallback. Debounced so a burst of events coalesces into one call.
  const liveRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const unsubscribe = subscribeSecurityEvents({
      onSnapshot: () => {},
      onDelivery: () => scheduleLiveRefresh(),
      onLifecycle: () => scheduleLiveRefresh(),
      onError: () => {},
    })
    return () => {
      unsubscribe()
      if (liveRefreshRef.current) clearTimeout(liveRefreshRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const scheduleLiveRefresh = () => {
    if (liveRefreshRef.current) clearTimeout(liveRefreshRef.current)
    liveRefreshRef.current = setTimeout(() => {
      refetch()
    }, 400)
  }

  const runOn = async (incident: SecurityIncidentDTO) => {
    if (!data?.canOperate) return
    setBusy(true)
    setActionError(null)
    setLastRun(null)
    try {
      const result = await runPipelineFor(incident.id)
      setLastRun({
        ref: incident.ref,
        result: result.aiUnavailable
          ? `AI unavailable — ${result.runs.find((r) => r.status === 'FAILED')?.error ?? 'agent failed'}`
          : `Pipeline complete · Telegram ${result.telegram.sent ? 'sent' : `not sent (${result.telegram.reason})`}`,
      })
      refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Pipeline run failed')
    } finally {
      setBusy(false)
    }
  }

  const testTelegramConduit = async () => {
    if (!data?.canOperate) return
    setBusy(true)
    setActionError(null)
    try {
      const result = await testTelegram()
      setLastRun({
        ref: 'test',
        result: result.ok
          ? `Test message sent (id ${result.telegramMessageId})`
          : `Test failed — ${result.error ?? 'unknown'}`,
      })
      refetch()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Telegram test failed')
    } finally {
      setBusy(false)
    }
  }

  const sendChat = async () => {
    const message = chatInput.trim()
    if (!message || chatBusy) return
    setChatInput('')
    setChatMessages((rows) => [...rows, { role: 'operator', text: message }])
    setChatBusy(true)
    try {
      const result: ChatResponse = await askAiChat(message)
      setChatMessages((rows) => [
        ...rows,
        {
          role: 'assistant',
          text: result.ok && result.reply ? result.reply : `[${result.mode}] ${result.error ?? 'no reply'}`,
        },
      ])
    } catch (err) {
      setChatMessages((rows) => [
        ...rows,
        { role: 'assistant', text: err instanceof Error ? err.message : 'Chat request failed.' },
      ])
    } finally {
      setChatBusy(false)
    }
  }

  if (loading && !data) return <LoadingState label="Loading security status…" />

  if (error && !data) return <ErrorState message={error} onRetry={refetch} />

  if (!data) return null

  const tier = tierTone(data.tier)
  const clean = data.overview.riskScore === 0

  return (
    <div className="space-y-6">
      {/* Ambient network backdrop */}
      <div className="pointer-events-none absolute right-0 top-16 h-[420px] w-full max-w-3xl overflow-hidden opacity-70">
        <SecurityNetwork />
      </div>

      <div className="relative flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-bh-faint">
            Mission Control
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-bh-ink">Security</h1>
          <p className="mt-1 text-sm text-bh-muted">
            live security-log-analyzer posture · updates live via SSE
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={clean ? 'success' : tier.pill} className="uppercase tracking-wider">
            <Icon name="shield" size={12} />
            {clean ? 'ALL SYSTEMS SECURE' : `${tier.label} · risk ${data.overview.riskScore}`}
          </Pill>
          <LiveBadge />
          {data.canOperate && (
            <button
              onClick={() => void testTelegramConduit()}
              disabled={busy}
              className="flex h-8 items-center gap-1.5 rounded-md border border-bh-line px-2.5 text-xs font-medium text-bh-muted hover:bg-bh-surface-2 hover:text-bh-ink disabled:opacity-60"
            >
              <Icon name="bell" size={13} />
              Test Telegram
            </button>
          )}
        </div>
      </div>

      {/* Live posture banner */}
      {clean ? (
        <div className="relative rounded-lg border border-bh-success/25 bg-bh-success/10 p-3.5 text-xs text-bh-success">
          <span className="font-semibold">ALL SYSTEMS SECURE.</span>{' '}
          <span className="text-bh-muted">
            No security findings, no active incidents, and no anomalies in the
            observability window.
          </span>
        </div>
      ) : (
        <div
          className="relative flex flex-wrap items-center gap-2 rounded-lg border px-3.5 py-3 text-xs"
          style={{
            borderColor: 'color-mix(in srgb, var(--bh-danger) 30%, transparent)',
            backgroundColor: 'color-mix(in srgb, var(--bh-danger) 6%, transparent)',
          }}
        >
          <span className={cn('h-2 w-2 rounded-full', tier.dot)} aria-hidden="true" />
          <span className="font-semibold text-bh-danger">
            RISK {data.overview.riskScore} — {tier.label}.
          </span>
          <span className="text-bh-muted">
            {data.overview.activeFindings} active finding
            {data.overview.activeFindings === 1 ? '' : 's'} and{' '}
            {data.overview.activeIncidents} active incident
            {data.overview.activeIncidents === 1 ? '' : 's'} — AI analysis runs against real
            evidence; nothing is auto-applied.
          </span>
        </div>
      )}

      {(actionError || lastRun) && (
        <p className="text-xs" role="status" aria-live="polite">
          {actionError ? (
            <span className="text-bh-danger">Action failed: {actionError}</span>
          ) : lastRun ? (
            <span className="text-bh-muted">
              {lastRun.ref !== 'test' ? `${lastRun.ref}: ` : ''}
              {lastRun.result}
            </span>
          ) : null}
        </p>
      )}

      {/* Score cards */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
        <Card className="relative p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">Risk score</p>
          <p
            className="mt-1.5 text-3xl font-semibold tabular-nums tracking-tight"
            style={{ color: riskColor(data.overview.riskScore) }}
          >
            {data.overview.riskScore}
          </p>
          <p className="mt-1 text-xs text-bh-muted">composite, 0–100 (lower is safer)</p>
        </Card>
        <Card className="relative p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">Cyber safety</p>
          <p className="mt-1.5 text-3xl font-semibold tabular-nums tracking-tight">
            {data.overview.cyberSafetyScore}
          </p>
          <p className="mt-1 text-xs text-bh-muted">
            {data.overview.cyberSafetyScore >= 80 ? 'stable' : 'impacted by active incidents'}
          </p>
        </Card>
        <Card className="relative p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">App reliability</p>
          <p className="mt-1.5 text-3xl font-semibold tabular-nums tracking-tight">
            {data.overview.applicationReliabilityScore}
          </p>
          <p className="mt-1 text-xs text-bh-muted">
            {data.overview.applicationReliabilityScore >= 80 ? 'endpoints healthy' : 'endpoint failures active'}
          </p>
        </Card>
        <Card className="relative p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">Health</p>
          <p className="mt-1.5 text-3xl font-semibold tabular-nums tracking-tight">
            {data.overview.systemHealth}%
          </p>
          <p className="mt-1 text-xs text-bh-muted">component availability</p>
        </Card>
        <Card className="relative p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">Total health</p>
          <p className="mt-1.5 text-3xl font-semibold tabular-nums tracking-tight">
            {data.overview.totalHealthScore}
          </p>
          <p className="mt-1 text-xs text-bh-muted">weighted cyber + reliability + health</p>
        </Card>
        <Card className="relative p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">Active</p>
          <p className="mt-1.5 text-3xl font-semibold tabular-nums tracking-tight">
            {data.overview.activeIncidents}
          </p>
          <p className="mt-1 text-xs text-bh-muted">
            {data.overview.activeFindings} finding{data.overview.activeFindings === 1 ? '' : 's'} open
          </p>
        </Card>
      </div>

      {/* Live attack telemetry (real guard/incident state) + NO-AI vs AI */}
      <div className="relative">
        <AttackTelemetryCard />
      </div>

      <div className="relative grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Findings */}
        <Card className="lg:col-span-2">
          <CardHeader
            icon="radar"
            title="Live Findings"
            hint="security-log-analyzer · real log evidence"
            extra={<Pill tone="accent">Rule-based</Pill>}
          />
          {data.findings.length === 0 ? (
            <EmptyState
              icon="shield"
              title="No findings"
              message="No DETECTED findings from the security log analyzer right now."
            />
          ) : (
            <ul className="divide-y divide-bh-line/60">
              {data.findings.map((finding) => (
                <li key={finding.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-bh-ink">{finding.title}</p>
                    <Pill tone={findingSeverityTone(finding.severity)}>{finding.severity}</Pill>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-bh-faint">
                    {finding.ruleId}
                    {finding.method ? ` · ${finding.method}` : ''}
                    {finding.endpoint ? ` ${finding.endpoint}` : ''}
                  </p>
                  <p className="mt-1 text-xs text-bh-muted">
                    {finding.hitCount} evidence {finding.hitCount === 1 ? 'row' : 'rows'} ·
                    window from {fullStamp(finding.firstSeenAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* AI + conduit status */}
        <Card>
          <CardHeader icon="sparkles" title="AI + Alerting" hint="provider-bound · Telegram" />
          <div className="space-y-3 px-4 py-4 text-xs">
            <div className="flex items-start gap-2">
              <Icon
                name="sparkles"
                size={14}
                className={cn(
                  'mt-0.5 shrink-0',
                  data.model.valid ? 'text-bh-success' : 'text-bh-danger',
                )}
              />
              <div>
                <p className="font-medium text-bh-ink">Model: {data.model.configured}</p>
                <p className="text-bh-faint">
                  provider {data.model.provider} · mode={data.model.mode}
                  {data.model.provider === 'ollama'
                    ? data.model.valid === null
                      ? ' · Ollama not reachable'
                      : data.model.valid
                        ? ' · available locally (Ollama)'
                        : ` · "${data.model.configured}" not pulled`
                    : data.model.valid === null
                      ? ' · catalog unreachable'
                      : data.model.valid
                        ? ' · validated against Groq catalog'
                        : ' · NOT in Groq catalog'}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Icon
                name="bell"
                size={14}
                className={cn(
                  'mt-0.5 shrink-0',
                  data.telegram.configured && data.telegram.status?.reachable
                    ? 'text-bh-success'
                    : data.telegram.configured
                      ? 'text-bh-warning'
                      : 'text-bh-danger',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-bh-ink">Telegram</p>
                <p className="truncate text-bh-faint">
                  {!data.telegram.configured
                    ? 'not configured (TELEGRAM_BOT_TOKEN / _CHAT_ID)'
                    : data.telegram.status?.reachable
                      ? `connected · @${data.telegram.status.botUsername ?? 'bot'} → ${data.telegram.chatId}`
                      : data.telegram.status?.error?.includes('token')
                        ? `delivery unavailable — ${data.telegram.status.error}`
                        : 'configured but NOT reachable (IPv4 network issue?)'}
                </p>
                {data.telegram.status?.reachable && data.telegram.status.latencyMs != null && (
                  <p className="mt-0.5 font-mono text-[10px] text-bh-faint">
                    getMe {data.telegram.status.latencyMs}ms · checked {relativeTime(data.telegram.status.checkedAt)}
                  </p>
                )}
              </div>
            </div>
            {data.telegram.lastDelivery && (
              <div className="flex items-start gap-2">
                <span
                  className={cn(
                    'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                    data.telegram.lastDelivery.deliveryStatus === 'SENT'
                      ? 'bg-bh-success'
                      : data.telegram.lastDelivery.deliveryStatus === 'SKIPPED_DUPLICATE'
                        ? 'bg-bh-warning'
                        : 'bg-bh-danger',
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-bh-ink">
                    {data.telegram.lastDelivery.deliveryStatus === 'SENT'
                      ? `Last delivery sent (msg ${data.telegram.lastDelivery.telegramMessageId})`
                      : `Last delivery ${data.telegram.lastDelivery.deliveryStatus === 'SKIPPED_DUPLICATE' ? 'skipped (duplicate)' : 'FAILED'}`}
                  </p>
                  <p className="truncate font-mono text-[10px] text-bh-faint">
                    {data.telegram.lastDelivery.type} · {relativeTime(data.telegram.lastDelivery.createdAt)}
                  </p>
                </div>
              </div>
            )}
            {data.agents.COMPLETE !== undefined && (
              <div className="flex items-start gap-2">
                <Icon name="gitBranch" size={14} className="mt-0.5 shrink-0 text-bh-accent-ink" />
                <div>
                  <p className="font-medium text-bh-ink">
                    {data.agents.COMPLETE ?? 0} agent run{data.agents.COMPLETE === 1 ? '' : 's'} complete
                  </p>
                  <p className="text-bh-faint">mode={data.model.mode} via {data.model.provider}</p>
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-bh-line px-4 py-2">
            <p className="text-xs text-bh-faint">Recent Telegram</p>
            {data.telegram.recent.length === 0 ? (
              <p className="py-2 text-xs text-bh-faint">No messages sent yet.</p>
            ) : (
              <ul className="divide-y divide-bh-line/60">
                {data.telegram.recent.map((row) => (
                  <TelegramRow key={row.id} row={row} />
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {/* Incidents */}
      <Card className="relative">
        <CardHeader
          icon="bug"
          title="Active Incidents"
          hint="promoted from findings · AWAITING_REVIEW means human sign-off required"
          extra={
            <Link
              href="/ai/incidents"
              className="flex items-center gap-1 text-xs text-bh-accent-ink hover:underline"
            >
              All incidents <Icon name="arrowRight" size={13} />
            </Link>
          }
        />
        {data.incidents.length === 0 ? (
          <EmptyState icon="bug" title="No incidents" message="No incidents have been promoted yet." />
        ) : (
          <ul className="divide-y divide-bh-line/60">
            {data.incidents.map((incident) => (
              <li key={incident.id} className="px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/ai/incidents/${incident.id}`}
                    className="font-mono text-xs font-semibold text-bh-accent-ink hover:underline"
                  >
                    {incident.ref}
                  </Link>
                  <Pill tone={incident.severity === 'HIGH' || incident.severity === 'CRITICAL' ? 'danger' : 'warning'}>
                    {incident.severity}
                  </Pill>
                  <span className={cn('text-xs font-medium', statusTone(incident.status))}>
                    {incident.status}
                  </span>
                  <span className={cn('font-mono text-xs', severityTone(incident.severity))}>
                    risk {incident.riskScore}
                  </span>
                  <span className="hidden font-mono text-[11px] text-bh-faint sm:inline">
                    {incident.method} {incident.endpoint}
                  </span>
                  {data.canOperate &&
                    (incident.agentRuns.some(
                      (r) => r.status === 'QUEUED' || r.status === 'FAILED',
                    ) ||
                      (incident.status === 'DETECTED' && incident.agentRuns.length === 0)) && (
                      <button
                        onClick={() => void runOn(incident)}
                        disabled={busy}
                        className="ml-auto flex h-7 items-center gap-1.5 rounded-md bg-bh-accent px-2.5 text-xs font-medium text-white hover:bg-bh-accent-strong disabled:opacity-60"
                      >
                        <Icon name="refresh" size={12} />
                        {incident.agentRuns.length === 0 ||
                        incident.agentRuns.some((r) => r.status === 'QUEUED')
                          ? 'Run pipeline'
                          : 'Retry'}
                      </button>
                    )}
                </div>
                <p className="mt-1.5 text-sm text-bh-ink">{incident.title}</p>
                {incident.expectedRootCause && (
                  <p className="mt-1 text-xs text-bh-muted">
                    <span className="font-medium">Root cause (Fixer): </span>
                    {incident.expectedRootCause}
                  </p>
                )}
                {incident.agentRuns.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {incident.agentRuns.map((run) => (
                      <AgentChip key={run.id} run={run} />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* AI repair console */}
      <Card className="relative">
        <CardHeader
          icon="terminal"
          title="Self-Healing Console"
          hint={`ask the operations assistant · ${data.model.configured}`}
        />
        <div className="flex min-h-32 max-h-72 flex-col gap-2 overflow-auto px-4 py-3">
          {chatMessages.length === 0 ? (
            <p className="py-6 text-center text-xs text-bh-faint">
              Ask a question about monitoring, fault injection, or the repair pipeline — the
              reply comes from the configured model provider.
            </p>
          ) : (
            chatMessages.map((row, i) => (
              <div
                key={i}
                className={cn(
                  'max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed',
                  row.role === 'operator'
                    ? 'self-end bg-bh-accent text-white'
                    : 'self-start bg-bh-surface-2 text-bh-ink',
                )}
              >
                {row.text}
              </div>
            ))
          )}
          {chatBusy && (
            <p className="self-start text-xs text-bh-faint">
              <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-bh-accent" />
              thinking…
            </p>
          )}
        </div>
        <form
          className="flex items-center gap-2 border-t border-bh-line px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            void sendChat()
          }}
        >
          <input
            aria-label="Message the operations assistant"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="How does the repair engine decide risk?"
            className="h-9 flex-1 rounded-md border border-bh-line bg-bh-surface-2/60 px-3 text-sm text-bh-ink outline-none placeholder:text-bh-faint focus:border-bh-accent"
            disabled={chatBusy}
          />
          <button
            type="submit"
            disabled={chatBusy || chatInput.trim().length === 0}
            className="flex h-9 items-center gap-1.5 rounded-md bg-bh-accent px-3 text-xs font-medium text-white hover:bg-bh-accent-strong disabled:opacity-60"
          >
            <Icon name="launch" size={13} />
            Send
          </button>
        </form>
      </Card>
    </div>
  )
}