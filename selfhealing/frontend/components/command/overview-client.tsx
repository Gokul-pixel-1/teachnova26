'use client'

import dynamic from 'next/dynamic'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { fetchIncident, fetchIncidents, fetchSummary } from '@/lib/api/observability'
import type { IncidentDTO, IncidentDetailDTO, SummaryResponse } from '@/lib/api/observability'
import { fetchLearning } from '@/lib/api/learning'
import type { LearningResponse } from '@/lib/api/learning'
import { fetchSecurityStatus, subscribeSecurityEvents } from '@/lib/api/security'
import type { LifecycleEventDTO, SecurityStatusDTO } from '@/lib/api/security'
import { CommandCenterHero } from './command-center-hero'
import { DecisionGraph, IncidentStory, LiveAiFeed } from './incident-operations'
import { dedupeEvents, incidentEvents, lifecycleEvents, logEvents, type OperationalEvent } from './command-center-model'
import { LearningSecurityEvidence, SystemHealthRail } from './operations-evidence'
import { ErrorState, LoadingState } from './ui'

const SystemTopology = dynamic(
  () => import('./system-topology').then((module) => module.SystemTopology),
  {
    ssr: false,
    loading: () => <div className="flex h-[22rem] items-center justify-center rounded-xl border border-bh-line bg-bh-surface/75"><LoadingState label="Loading system topology…" /></div>,
  },
)

const REFRESH_MS = 15_000
const TERMINAL = new Set(['RESOLVED', 'ROLLED_BACK', 'AI_REPAIR_FAILED', 'REJECTED'])

function pickIncident(rows: IncidentDTO[], current: string | null): string | null {
  if (current && rows.some((row) => row.id === current)) return current
  return rows.find((row) => !TERMINAL.has(row.status))?.id ?? rows[0]?.id ?? null
}

export function OverviewClient() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [incidents, setIncidents] = useState<IncidentDTO[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<IncidentDetailDTO | null>(null)
  const [learning, setLearning] = useState<LearningResponse | null>(null)
  const [security, setSecurity] = useState<SecurityStatusDTO | null>(null)
  const [liveEvents, setLiveEvents] = useState<OperationalEvent[]>([])
  const [streamState, setStreamState] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const selectedRef = useRef<string | null>(null)
  const refreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectIncident = useCallback(async (id: string) => {
    selectedRef.current = id
    setSelectedId(id)
    try {
      const response = await fetchIncident(id)
      if (selectedRef.current === id) setDetail(response.incident)
    } catch {
      if (selectedRef.current === id) setDetail(null)
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const [nextSummary, incidentResult] = await Promise.all([
        fetchSummary(), fetchIncidents({ pageSize: 12 }),
      ])
      const nextIncidents = incidentResult.incidents
      const nextSelected = pickIncident(nextIncidents, selectedRef.current)
      setSummary(nextSummary)
      setIncidents(nextIncidents)
      setError(null)
      setLastUpdated(new Date())
      setLoading(false)

      void fetchLearning().then(setLearning).catch(() => undefined)
      void fetchSecurityStatus().then(setSecurity).catch(() => undefined)

      if (nextSelected) {
        selectedRef.current = nextSelected
        setSelectedId(nextSelected)
        void fetchIncident(nextSelected).then((response) => {
          if (selectedRef.current === nextSelected) setDetail(response.incident)
        }).catch(() => {
          if (selectedRef.current === nextSelected) setDetail(null)
        })
      } else {
        selectedRef.current = null
        setSelectedId(null)
        setDetail(null)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load command center state.')
    } finally {
      setLoading(false)
    }
  }, [])

  const scheduleRefresh = useCallback(() => {
    if (refreshRef.current) clearTimeout(refreshRef.current)
    refreshRef.current = setTimeout(() => void load(), 450)
  }, [load])

  useEffect(() => {
    const first = setTimeout(() => void load(), 0)
    const interval = setInterval(() => void load(), REFRESH_MS)
    return () => {
      clearTimeout(first)
      clearInterval(interval)
      if (refreshRef.current) clearTimeout(refreshRef.current)
    }
  }, [load])

  useEffect(() => {
    const unsubscribe = subscribeSecurityEvents({
      onSnapshot: () => setStreamState('live'),
      onDelivery: () => {
        setStreamState('live')
        scheduleRefresh()
      },
      onLifecycle: (payload: LifecycleEventDTO) => {
        setStreamState('live')
        setLiveEvents((current) => dedupeEvents([...lifecycleEvents(payload), ...current]).slice(0, 36))
        scheduleRefresh()
      },
      onError: () => setStreamState('error'),
    })
    return unsubscribe
  }, [scheduleRefresh])

  const feed = useMemo(
    () => dedupeEvents([
      ...liveEvents,
      ...incidentEvents(detail),
      ...logEvents(summary?.recentLogs ?? []),
    ]),
    [detail, liveEvents, summary?.recentLogs],
  )

  if (loading && !summary) {
    return (
      <div className="space-y-4" role="status">
        <section className="command-hero relative overflow-hidden rounded-2xl border border-bh-line bg-bh-surface/90 px-5 py-8 sm:px-9 sm:py-10">
          <div className="command-hero-glow" aria-hidden="true" />
          <div className="relative">
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.24em] text-bh-accent-ink">BuildHub / Autonomous Operations</p>
            <h1 className="mt-5 text-3xl font-semibold leading-[1.04] tracking-[-0.045em] text-bh-ink sm:text-5xl">BUILDHUB<span className="mt-1 block text-bh-muted">AI SELF-HEALING COMMAND CENTER</span></h1>
            <p className="mt-5 font-mono text-xs uppercase tracking-[0.12em] text-bh-muted">Detect → Diagnose → Repair → Validate → Learn</p>
            <div className="mt-6 flex items-center gap-3 text-xs text-bh-faint"><span className="h-2 w-2 animate-pulse rounded-full bg-bh-accent" />Connecting persisted system state…</div>
          </div>
        </section>
        <div className="grid gap-4 lg:grid-cols-2"><div className="h-64 animate-pulse rounded-xl border border-bh-line bg-bh-surface/60" /><div className="h-64 animate-pulse rounded-xl border border-bh-line bg-bh-surface/60" /></div>
        <span className="sr-only">Loading AI self-healing command center…</span>
      </div>
    )
  }

  if (error && !summary) return <ErrorState message={error} onRetry={() => void load()} />
  if (!summary) return null

  const selectedSummary = incidents.find((row) => row.id === selectedId) ?? null
  const activeHeroIncident = selectedSummary && !TERMINAL.has(selectedSummary.status) ? selectedSummary : null
  const latestRecovery = incidents.find((row) => row.status === 'RESOLVED') ?? null
  return (
    <div className="command-center-experience min-w-0 space-y-5 pb-10">
      <CommandCenterHero
        overview={summary.overview}
        incident={activeHeroIncident}
        latestRecovery={latestRecovery}
        streamState={streamState}
        updatedLabel={lastUpdated ? lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'now'}
      />

      {error && <div className="rounded-lg border border-bh-warning/30 bg-bh-warning/5 px-4 py-2 text-xs text-bh-warning">Realtime refresh paused: {error}. Showing the last confirmed state.</div>}

      <SystemHealthRail summary={summary} />

      <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,0.75fr)]" aria-label="Live operational intelligence">
        <SystemTopology incident={detail} />
        <LiveAiFeed events={feed} streamState={streamState} />
      </section>

      <section className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(21rem,0.78fr)_minmax(0,1.22fr)]" aria-label="Incident reasoning and repair story">
        <IncidentStory incidents={incidents} selectedId={selectedId} incident={detail} onSelect={(id) => void selectIncident(id)} />
        <DecisionGraph incident={detail} />
      </section>

      <LearningSecurityEvidence learning={learning} security={security} />
    </div>
  )
}
