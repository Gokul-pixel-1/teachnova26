'use client'

import Link from 'next/link'

import { Icon } from '@/components/ui/icon'
import type { IncidentDTO, Overview } from '@/lib/api/observability'
import { cn } from '@/lib/cn'
import { LiveBadge, Pill } from './ui'
import { displayOpsText } from './command-center-model'

const LOOP = ['Detect', 'Diagnose', 'Repair', 'Validate', 'Learn']

function scoreTone(value: number, inverse = false) {
  const good = inverse ? value <= 20 : value >= 90
  const bad = inverse ? value >= 60 : value < 65
  return good ? 'text-bh-success' : bad ? 'text-bh-danger' : 'text-bh-warning'
}

export function CommandCenterHero({
  overview,
  incident,
  latestRecovery,
  streamState,
  updatedLabel,
}: {
  overview: Overview
  incident: IncidentDTO | null
  latestRecovery: IncidentDTO | null
  streamState: 'connecting' | 'live' | 'error'
  updatedLabel: string
}) {
  const healthy = overview.activeIncidents === 0
  return (
    <section className="command-hero relative overflow-hidden rounded-2xl border border-bh-line bg-bh-surface/90">
      <div className="command-hero-glow" aria-hidden="true" />
      <div className="relative grid gap-8 px-5 py-6 sm:px-7 sm:py-8 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.58fr)] lg:px-9 lg:py-10">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-bh-accent-ink">
              BuildHub / Autonomous Operations
            </span>
            <LiveBadge />
            <span className={cn('text-[11px]', streamState === 'live' ? 'text-bh-success' : streamState === 'error' ? 'text-bh-warning' : 'text-bh-faint')}>
              {streamState === 'live' ? 'Realtime linked' : streamState === 'error' ? 'Polling fallback' : 'Linking telemetry'}
            </span>
          </div>
          <h1 className="mt-5 max-w-3xl text-3xl font-semibold leading-[1.04] tracking-[-0.045em] text-bh-ink sm:text-5xl lg:text-[3.45rem]">
            BUILDHUB
            <span className="mt-1 block text-bh-muted">AI SELF-HEALING COMMAND CENTER</span>
          </h1>
          <div className="mt-6 flex flex-wrap items-center gap-2" aria-label="Self-healing lifecycle">
            {LOOP.map((label, index) => (
              <span key={label} className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-bh-ink">{label}</span>
                {index < LOOP.length - 1 && <span className="text-bh-faint" aria-hidden="true">→</span>}
              </span>
            ))}
          </div>
          <p className="mt-5 max-w-2xl text-sm leading-6 text-bh-muted">
            Live evidence moves through specialized AI review, deterministic risk policy,
            human control, validation, and repair memory. Only persisted system state appears here.
          </p>
        </div>

        <div className="flex min-w-0 flex-col justify-between rounded-xl border border-bh-line bg-bh-bg/55 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-bh-faint">Current operating state</p>
              <p className={cn('mt-2 text-2xl font-semibold tracking-tight', healthy ? 'text-bh-success' : 'text-bh-warning')}>
                {healthy ? 'System nominal' : 'Incident in progress'}
              </p>
            </div>
            <span className={cn('mt-1 h-3 w-3 rounded-full shadow-[0_0_18px_currentColor]', healthy ? 'bg-bh-success text-bh-success' : 'animate-pulse bg-bh-warning text-bh-warning')} />
          </div>

          {incident ? (
            <Link href={`/ai/incidents/${incident.id}`} className="group mt-6 block rounded-lg border border-bh-line bg-bh-surface/75 p-3.5 transition-colors hover:border-bh-accent/60">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs font-bold text-bh-accent-ink">{incident.ref}</span>
                <Pill tone={incident.severity === 'HIGH' || incident.severity === 'CRITICAL' ? 'danger' : 'warning'}>{incident.severity}</Pill>
                <span className="ml-auto font-mono text-[10px] text-bh-faint">{incident.status.replaceAll('_', ' ')}</span>
              </div>
              <p className="mt-2 truncate text-sm font-medium text-bh-ink">{displayOpsText(incident.title)}</p>
              <p className="mt-1 truncate font-mono text-[11px] text-bh-faint">{incident.method} {incident.endpoint}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-bh-accent-ink">Inspect evidence <Icon name="arrowRight" size={13} /></span>
            </Link>
          ) : (
            <div className="mt-6 rounded-lg border border-bh-success/20 bg-bh-success/5 p-3.5">
              <p className="text-sm font-medium text-bh-ink">No active incident</p>
              <p className="mt-1 text-xs leading-5 text-bh-muted">Monitoring is ready. The operational spine activates when real evidence is persisted.</p>
            </div>
          )}

          {latestRecovery && (
            <Link href={`/ai/incidents/${latestRecovery.id}`} className="mt-3 flex items-center justify-between gap-3 rounded-md border border-bh-line px-3 py-2 text-[11px] text-bh-muted transition-colors hover:border-bh-success/35 hover:text-bh-ink">
              <span className="min-w-0 truncate"><span className="text-bh-success">Latest verified recovery</span> · {latestRecovery.ref}</span>
              <Icon name="arrowRight" size={12} className="shrink-0" />
            </Link>
          )}

          <div className="mt-5 grid grid-cols-3 divide-x divide-bh-line border-t border-bh-line pt-4">
            <div className="pr-3">
              <p className={cn('font-mono text-xl font-semibold tabular-nums', scoreTone(overview.totalHealthScore))}>{overview.totalHealthScore}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-bh-faint">Health</p>
            </div>
            <div className="px-3">
              <p className={cn('font-mono text-xl font-semibold tabular-nums', scoreTone(overview.riskScore, true))}>{overview.riskScore}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-bh-faint">Risk</p>
            </div>
            <div className="pl-3">
              <p className="font-mono text-xl font-semibold tabular-nums text-bh-ink">{overview.activeIncidents}</p>
              <p className="mt-1 text-[10px] uppercase tracking-wider text-bh-faint">Active</p>
            </div>
          </div>
          <p className="mt-3 font-mono text-[10px] text-bh-faint">Updated {updatedLabel}</p>
        </div>
      </div>
    </section>
  )
}
