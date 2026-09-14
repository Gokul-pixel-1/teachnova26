'use client'

import { useCallback } from 'react'
import Link from 'next/link'

import { cn } from '@/lib/cn'
import { useAsync } from '@/lib/hooks'
import { fetchIncident, fetchIncidents } from '@/lib/api/observability'
import type { AgentRunDTO, IncidentDetailDTO } from '@/lib/api/observability'
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LiveBadge,
  LoadingState,
  Pill,
  ProgressBar,
  agentStatusTone,
  statusTone,
} from './ui'

const FLOW: Array<{ stage: string; label: string; detail: string }> = [
  {
    stage: 'FIXER',
    label: 'Fixer — candidate generator',
    detail: 'Analyzes the incident context and proposes a candidate remediation.',
  },
  {
    stage: 'CRITIC',
    label: 'Critic — candidate reviewer',
    detail: 'Reviews the candidate for safety, scope and regression risk.',
  },
  {
    stage: 'JUDGE',
    label: 'Judge — final arbiter',
    detail: 'Weighs the critic signal and decides whether to pass to humans.',
  },
  {
    stage: 'HUMAN',
    label: 'Human approval',
    detail: 'A reviewer approves or rejects. Phase 7: nothing is applied without this.',
  },
  {
    stage: 'DEPLOY',
    label: 'Deploy → Verify → Rollback',
    detail: 'Applied change is verified; a regression triggers an automatic rollback.',
  },
]

function RunCard({ run, flowStage }: { run: AgentRunDTO | undefined; flowStage: string }) {
  const isHuman = flowStage === 'HUMAN' || flowStage === 'DEPLOY'
  if (isHuman) {
    return (
      <div className="rounded-md border border-dashed border-bh-line p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] font-bold tracking-wide text-bh-faint">
            {flowStage}
          </span>
          <span className="text-[11px] text-bh-faint">Wait — pending</span>
        </div>
        <p className="mt-1.5 text-[11px] text-bh-faint">
          Not reached — real fixes still require human approval.
        </p>
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] font-bold tracking-wide text-bh-accent-ink">
          {flowStage}
        </span>
        <span className={cn('text-[11px] font-semibold', agentStatusTone(run?.status ?? 'QUEUED'))}>
          {run?.status ?? '•'}
        </span>
      </div>
      <p className="mt-1 line-clamp-1 text-[11px] text-bh-muted">
        {run?.status === 'FAILED' && run.error
          ? `AI ANALYSIS UNAVAILABLE — ${run.error}`
          : (run?.currentActivity ?? run?.role ?? 'Waiting')}
      </p>
      {run?.contextSize != null && (
        <p className="mt-0.5 font-mono text-[10px] text-bh-faint">
          context {run.contextSize} tok · {run.model ?? ''}
        </p>
      )}
      <ProgressBar
        value={run?.progress ?? 0}
        tone={
          run?.status === 'COMPLETE'
            ? 'success'
            : run?.status === 'REJECTED' || run?.status === 'FAILED'
              ? 'danger'
              : 'accent'
        }
        className="mt-1.5"
      />
    </div>
  )
}

export function PipelineClient() {
  const fetcher = useCallback(async () => {
    const list = await fetchIncidents({ pageSize: 100 })
    const active = list.incidents.filter((i) =>
      ['DETECTED', 'INVESTIGATING', 'AWAITING_REVIEW'].includes(i.status),
    )
    const details: IncidentDetailDTO[] = []
    await Promise.all(
      active.map(async (incident) => {
        try {
          const detail = await fetchIncident(incident.id)
          details.push(detail.incident)
        } catch {
          // Skip incidents that fail to load; the list still renders.
        }
      }),
    )
    return { details, total: list.pagination.total }
  }, [])

  const { data, loading, error, refetch } = useAsync(fetcher)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-bh-faint">
            Mission Control
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-bh-ink">AI Pipeline</h1>
          <p className="mt-1 text-sm text-bh-muted">
            real Fixer → Critic → Judge runs against active incidents (Groq)
          </p>
        </div>
        <LiveBadge />
      </div>

      {/* Flow legend */}
      <Card>
        <CardHeader icon="gitBranch" title="Pipeline Phases" hint="how a candidate would flow" />
        <ol className="grid grid-cols-1 gap-2 p-4 sm:grid-cols-2 lg:grid-cols-5">
          {FLOW.map((phase, index) => (
            <li key={phase.stage} className="relative rounded-md border border-bh-line bg-bh-surface-2/50 p-3">
              <span className="font-mono text-[11px] font-bold text-bh-accent-ink">
                {String(index + 1).padStart(2, '0')} · {phase.stage}
              </span>
              <p className="mt-1 text-xs font-medium text-bh-ink">{phase.label}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-bh-faint">{phase.detail}</p>
            </li>
          ))}
        </ol>
        <div className="border-t border-bh-line px-4 py-3">
<p className="text-[11px] leading-relaxed text-bh-faint">
          Every stage runs on real evidence through the Groq-backed agent pipeline.
          Candidates are proposed as text only: nothing is auto-applied, and human
          approval remains mandatory in every flow.
        </p>
        </div>
      </Card>

      {loading && !data ? <LoadingState label="Loading pipeline…" /> : null}
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : null}
      {data && data.details.length === 0 ? (
        <div className="rounded-lg border border-bh-line bg-bh-surface">
          <EmptyState
            icon="gitBranch"
            title="No active pipeline"
            message="There are no active incidents to analyze right now."
          />
        </div>
      ) : null}

      {data && data.details.length > 0 ? (
        <div className="space-y-4">
          {data.details.map((incident) => (
            <PipelineIncident key={incident.id} incident={incident} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function PipelineIncident({ incident }: { incident: IncidentDetailDTO }) {
  const runOf = (agent: AgentRunDTO['agent']) =>
    incident.agentRuns.find((run) => run.agent === agent)

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-bh-line px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
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
        </div>
        <span className="shrink-0 font-mono text-[11px] text-bh-faint">
          risk {incident.riskScore} · trust context below
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-5">
        {FLOW.map((phase) => (
          <RunCard key={phase.stage} run={runOf(phase.stage as AgentRunDTO['agent'])} flowStage={phase.stage} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-2 border-t border-bh-line bg-bh-surface-2/40 px-4 py-3 sm:grid-cols-3">
        <ContextLine label="Culprit endpoint" value={`${incident.method} ${incident.endpoint}`} />
        <ContextLine label="Error code" value={incident.errorCode ?? '—'} />
        <ContextLine label="Expected root cause" value={incident.expectedRootCause ?? '—'} />
      </div>
    </Card>
  )
}

function ContextLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wider text-bh-faint">{label}</p>
      <p className="mt-0.5 truncate font-mono text-xs text-bh-muted" title={value}>
        {value}
      </p>
    </div>
  )
}