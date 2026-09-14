'use client'

import { useCallback, useEffect } from 'react'

import { useAsync } from '@/lib/hooks'
import { fetchAttackTelemetry } from '@/lib/api/security'
import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { Card, CardHeader, EmptyState, Pill, fullStamp } from './ui'

function phaseTone(phase: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (phase) {
    case 'normal':
    case 'recovered':
      return 'success'
    case 'attack':
      return 'warning'
    case 'detected':
      return 'info'
    case 'mitigating':
      return 'info'
    default:
      return 'neutral'
  }
}

function deltaSeconds(later: string | null, earlier: string | null): string {
  if (!later || !earlier) return '—'
  const a = new Date(later).getTime()
  const b = new Date(earlier).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return '—'
  return `${(Math.max(0, a - b) / 1000).toFixed(1)}s`
}

function Metric({ label, value, danger }: { label: string; value: string | number; danger?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-bh-line/60 py-1.5 last:border-0">
      <dt className="text-xs text-bh-muted">{label}</dt>
      <dd className={cn('font-mono text-xs font-medium text-bh-ink', danger && 'font-semibold text-bh-danger')}>
        {value}
      </dd>
    </div>
  )
}

/**
 * Live attack-telemetry card for /ai/security.
 *
 * Every value is real persisted/observed state from GET /api/demo/attack
 * (guard window, block state, incident row, agent runs, health probe).
 * Polls every 5s; the parent SecurityClient already refetches the wider
 * security status on SSE delivery/lifecycle events.
 */
export function AttackTelemetryCard() {
  const fetcher = useCallback(() => fetchAttackTelemetry(), [])
  const { data, loading, error, refetch } = useAsync(fetcher)

  useEffect(() => {
    const interval = setInterval(() => refetch(), 5000)
    return () => clearInterval(interval)
  }, [refetch])

  return (
    <Card className="relative">
      <CardHeader
        icon="radar"
        title="Attack Telemetry"
        hint="live guard + incident state · 127.0.0.1:3000"
        extra={
          data ? (
            <Pill tone={phaseTone(data.phase)} className="uppercase tracking-wider">
              {data.phase}
            </Pill>
          ) : (
            <Pill tone="neutral">…</Pill>
          )
        }
      />
      {loading && !data ? (
        <p className="px-4 py-6 text-center text-xs text-bh-faint">Loading attack telemetry…</p>
      ) : error && !data ? (
        <EmptyState icon="radar" title="Telemetry unavailable" message={error} />
      ) : !data ? null : (
        <div className="grid grid-cols-1 gap-4 px-4 py-4 md:grid-cols-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">Attack status</p>
            <dl className="mt-2 rounded-lg bg-bh-surface-2 p-3">
              <Metric label="Target" value={`${data.source}:${data.port} (AI)`} />
              <Metric label="Guard" value={data.guardEnabled ? 'enabled' : 'disabled'} />
              <Metric label="Failed sign-ins" value={`${data.state.failCount} / ${data.state.threshold}`} />
              <Metric label="Blocked (HTTP 429)" value={data.state.blockedCount} />
              <Metric label="Source blocked" value={data.state.blocked ? 'yes (mitigating)' : 'no'} />
            </dl>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">Live metrics</p>
            <dl className="mt-2 rounded-lg bg-bh-surface-2 p-3">
              <Metric label="Health" value={data.health.status} danger={data.health.status === 'unavailable'} />
              <Metric label="Availability" value={data.health.availability} />
              <Metric label="Health latency" value={`${data.health.latencyMs} ms`} />
              <Metric label="Detection time" value={deltaSeconds(data.timestamps.detectedAt, data.timestamps.firstFailureAt)} />
              <Metric label="Mitigation time" value={deltaSeconds(data.timestamps.mitigatedAt, data.timestamps.firstFailureAt)} />
            </dl>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">Response</p>
            <dl className="mt-2 rounded-lg bg-bh-surface-2 p-3">
              <Metric label="Incident" value={data.incident ? `${data.incident.ref} · ${data.incident.status}` : 'none'} />
              <Metric label="Severity / risk" value={data.incident ? `${data.incident.severity} · ${data.incident.riskScore}` : '—'} />
              <Metric
                label="Pipeline"
                value={
                  data.agentRuns.length === 0
                    ? 'not started'
                    : data.agentRuns.map((r) => `${r.agent} ${r.status}`).join(' · ')
                }
              />
              <Metric label="First failure" value={data.timestamps.firstFailureAt ? fullStamp(data.timestamps.firstFailureAt) : '—'} />
              <Metric label="Blocked until" value={data.state.blockedUntil ? fullStamp(data.state.blockedUntil) : '—'} />
            </dl>
          </div>
        </div>
      )}
      {data?.incident && (
        <p className="flex items-center gap-1.5 px-4 pb-4 text-xs text-bh-muted">
          <Icon name="shield" size={13} className="shrink-0 text-bh-accent" />
          <span className="truncate">
            {data.incident.ref} — {data.incident.title}
          </span>
        </p>
      )}
      {/* NO-AI vs AI comparison — values above are this (AI) build's live
          state; the WITHOUT-AI side is observed on its own live page. */}
      <div className="border-t border-bh-line px-4 py-3">
        <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          <p className="rounded-md bg-bh-surface-2 px-3 py-2 text-bh-muted">
            <span className="font-semibold text-bh-ink">NO-AI :3001</span> — attack → failure →
            remains unhealthy (no Analyzer/Coder/Critic/Judge, no Telegram).
          </p>
          <p className="rounded-md bg-bh-surface-2 px-3 py-2 text-bh-muted">
            <span className="font-semibold text-bh-ink">AI :3000</span> — attack → detection →
            incident → analysis → 429 mitigation → recovery (this panel, live).
          </p>
        </div>
        <p className="mt-2 text-center text-[11px] text-bh-faint">
          Side-by-side live view:{' '}
          <a
            href="http://127.0.0.1:3001/demo/attack"
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-bh-accent-ink hover:underline"
          >
            http://127.0.0.1:3001/demo/attack
          </a>{' '}
          · every value on this card is real backend state, never simulated.
        </p>
      </div>
    </Card>
  )
}
