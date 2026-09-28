'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'

import type { IncidentDTO, IncidentDetailDTO } from '@/lib/api/observability'
import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { displayOpsText, incidentEvents, STAGE_ORDER, type OperationalEvent, type OperationalStage } from './command-center-model'
import { EmptyState, Pill, relativeTime } from './ui'

const STAGE_COPY: Record<OperationalStage, string> = {
  DETECTION: 'Observed failure evidence', ANALYZER: 'Root-cause analysis', CODER: 'Repair candidate',
  CRITIC: 'Independent review', JUDGE: 'Risk decision', APPROVAL: 'Human control point',
  PATCH: 'Controlled application', VALIDATION: 'Live proof', RECOVERY: 'Terminal service state', LEARNING: 'Repair memory',
}

function tone(status: OperationalEvent['status']) {
  if (status === 'complete') return 'bg-bh-success text-bh-success'
  if (status === 'failed') return 'bg-bh-danger text-bh-danger'
  if (status === 'waiting') return 'bg-bh-warning text-bh-warning'
  return 'bg-bh-accent text-bh-accent-ink'
}

export function LiveAiFeed({ events, streamState }: { events: OperationalEvent[]; streamState: 'connecting' | 'live' | 'error' }) {
  return (
    <section className="overflow-hidden rounded-xl border border-bh-line bg-bh-surface/75" aria-labelledby="ai-feed-title">
      <header className="flex items-center justify-between gap-3 border-b border-bh-line px-4 py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bh-faint">Persisted operations stream</p>
          <h2 id="ai-feed-title" className="mt-1 text-sm font-semibold text-bh-ink">Live AI feed</h2>
        </div>
        <span className={cn('flex items-center gap-1.5 text-[10px] uppercase tracking-wider', streamState === 'live' ? 'text-bh-success' : streamState === 'error' ? 'text-bh-warning' : 'text-bh-faint')}>
          <span className={cn('h-1.5 w-1.5 rounded-full', streamState === 'live' ? 'animate-pulse bg-bh-success' : streamState === 'error' ? 'bg-bh-warning' : 'bg-bh-faint')} />
          {streamState === 'live' ? 'SSE live' : streamState === 'error' ? 'Polling' : 'Connecting'}
        </span>
      </header>
      {events.length === 0 ? (
        <EmptyState icon="activity" title="Waiting for real evidence" message="Detection, agent, approval, patch and learning events appear here after they are persisted." />
      ) : (
        <ol className="max-h-[31rem] overflow-y-auto" aria-live="polite">
          {events.slice(0, 24).map((event) => (
            <li key={event.id} className="command-ticker-row grid grid-cols-[4.2rem_5.3rem_minmax(0,1fr)] gap-2 border-b border-bh-line/70 px-4 py-3 last:border-0 sm:grid-cols-[5.3rem_6.8rem_minmax(0,1fr)]">
              <time className="font-mono text-[10px] tabular-nums text-bh-faint" dateTime={event.at}>{new Date(event.at).toLocaleTimeString([], { hour12: false })}</time>
              <span className="font-mono text-[10px] font-semibold tracking-wide text-bh-accent-ink">{event.stage}</span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-bh-ink" title={event.title}>{event.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs leading-[18px] text-bh-muted">{event.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function IncidentStory({
  incidents,
  selectedId,
  incident,
  onSelect,
}: {
  incidents: IncidentDTO[]
  selectedId: string | null
  incident: IncidentDetailDTO | null
  onSelect: (id: string) => void
}) {
  const events = useMemo(() => incidentEvents(incident), [incident])
  const grouped = useMemo(() => new Map(STAGE_ORDER.map((stage) => [stage, events.filter((item) => item.stage === stage)])), [events])
  const risk = incident?.repairAttempt?.risk ?? incident?.severity ?? 'LOW'
  const humanRequired = risk === 'MEDIUM' || risk === 'HIGH' || risk === 'CRITICAL'
  return (
    <section className="overflow-hidden rounded-xl border border-bh-line bg-bh-surface/75" aria-labelledby="incident-story-title">
      <header className="border-b border-bh-line px-4 py-3 sm:flex sm:items-end sm:justify-between sm:gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bh-faint">One incident, end to end</p>
          <h2 id="incident-story-title" className="mt-1 text-sm font-semibold text-bh-ink">Incident story</h2>
        </div>
        {incidents.length > 0 && (
          <label className="mt-3 block min-w-0 text-[10px] uppercase tracking-wider text-bh-faint sm:mt-0 sm:w-64">
            Selected incident
            <select value={selectedId ?? ''} onChange={(event) => onSelect(event.target.value)} className="mt-1 block w-full rounded-md border border-bh-line bg-bh-bg px-2.5 py-2 text-xs normal-case tracking-normal text-bh-ink">
              {incidents.map((row) => <option key={row.id} value={row.id}>{row.ref} · {row.status}</option>)}
            </select>
          </label>
        )}
      </header>
      {!incident ? (
        <EmptyState icon="bug" title="No incident selected" message="The story will assemble itself from persisted evidence when an incident exists." />
      ) : (
        <div className="p-4 sm:p-5">
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-bh-accent-ink">{incident.ref}</span>
            <Pill tone={incident.severity === 'HIGH' || incident.severity === 'CRITICAL' ? 'danger' : incident.severity === 'MEDIUM' ? 'warning' : 'info'}>{incident.severity}</Pill>
            <Pill tone={incident.status === 'RESOLVED' ? 'success' : incident.status === 'ROLLED_BACK' || incident.status === 'AI_REPAIR_FAILED' || incident.status === 'REJECTED' ? 'danger' : 'accent'}>{incident.status.replaceAll('_', ' ')}</Pill>
            <Pill tone={risk === 'LOW' ? 'success' : risk === 'MEDIUM' ? 'warning' : 'danger'}>RISK {risk}</Pill>
            <Pill tone={humanRequired ? 'warning' : 'neutral'}>{humanRequired ? 'HUMAN APPROVAL REQUIRED' : 'POLICY AUTO-APPLY'}</Pill>
            <Link href={`/ai/incidents/${incident.id}`} className="ml-auto inline-flex items-center gap-1 text-xs text-bh-accent-ink hover:underline">Full evidence <Icon name="arrowRight" size={12} /></Link>
          </div>
          <ol className="relative ml-2 border-l border-bh-line pl-5">
            {STAGE_ORDER.map((stage) => {
              const rows = grouped.get(stage) ?? []
              const latest = rows[0]
              return (
                <li key={stage} className="relative pb-3 last:pb-0">
                  <span className={cn('absolute -left-[1.48rem] top-3 h-2.5 w-2.5 rounded-full border-2 border-bh-surface', latest ? tone(latest.status).split(' ')[0] : 'bg-bh-line-strong')} aria-hidden="true" />
                  <details className="group rounded-lg border border-bh-line bg-bh-bg/45 open:border-bh-line-strong" open={stage === 'DETECTION' || latest?.status === 'active' || latest?.status === 'waiting'}>
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-[10px] font-bold tracking-[0.14em] text-bh-ink">{stage}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-bh-faint">{latest?.title ?? `${STAGE_COPY[stage]} · not reached`}</span>
                      </span>
                      {latest && <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase', tone(latest.status).replace(/^bg-\S+ /, ''))}>{latest.status}</span>}
                      <Icon name="chevronDown" size={13} className="text-bh-faint transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="border-t border-bh-line px-3 py-3">
                      {rows.length ? rows.map((row) => (
                        <div key={row.id} className="border-b border-bh-line/60 py-2 first:pt-0 last:border-0 last:pb-0">
                          <p className="text-xs leading-[18px] text-bh-muted">{row.detail}</p>
                          <time dateTime={row.at} className="mt-1 block font-mono text-[10px] text-bh-faint">{relativeTime(row.at)} · {row.source}</time>
                        </div>
                      )) : <p className="text-xs leading-5 text-bh-faint">No persisted event for this stage. The system does not infer or fabricate missing steps.</p>}
                    </div>
                  </details>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}

interface DecisionNode { id: string; label: string; value: string; x: number; y: number; tone: string }

function graphNodes(incident: IncidentDetailDTO): DecisionNode[] {
  const runs = incident.agentRuns
  const run = (kind: string) => [...runs].reverse().find((item) => item.kind === kind || item.agent === kind)
  const analyzer = run('ANALYZER')
  const coder = run('CODER') ?? run('FIXER')
  const critic = run('CRITIC')
  const judge = run('JUDGE')
  const approval = incident.approvals[0]
  return [
    { id: 'error', label: 'ERROR', value: displayOpsText(incident.summary ?? incident.description ?? incident.title), x: 95, y: 80, tone: '#f87171' },
    { id: 'evidence', label: 'EVIDENCE', value: `${incident.method} ${incident.endpoint}${incident.requestId ? ` · request ${incident.requestId}` : ''}${incident.errorCode ? ` · ${incident.errorCode}` : ''}`, x: 275, y: 80, tone: '#60a5fa' },
    { id: 'cause', label: 'ROOT CAUSE', value: displayOpsText(analyzer?.outputSummary ?? incident.expectedRootCause ?? 'No root-cause summary persisted yet.'), x: 455, y: 80, tone: '#67e8f9' },
    { id: 'candidate', label: 'REPAIR CANDIDATE', value: displayOpsText(coder?.outputSummary ?? (incident.patch ? `${incident.patch.file ?? 'Patch'} · ${incident.patch.status}` : 'No candidate persisted yet.')), x: 635, y: 80, tone: '#8ae0ea' },
    { id: 'review', label: 'CRITIC REVIEW', value: displayOpsText(critic?.outputSummary ?? critic?.error ?? 'No independent review persisted yet.'), x: 545, y: 245, tone: '#c4b5fd' },
    { id: 'risk', label: 'RISK', value: `${incident.repairAttempt?.risk ?? incident.severity}${incident.repairAttempt?.summary ? ` · ${incident.repairAttempt.summary}` : ''}`, x: 365, y: 245, tone: '#fbbf24' },
    { id: 'decision', label: 'DECISION', value: displayOpsText(judge?.outputSummary ?? (approval ? `Human decision ${approval.status}` : `Incident ${incident.status}`)), x: 185, y: 245, tone: incident.status === 'RESOLVED' ? '#34d399' : '#fb923c' },
  ]
}

export function DecisionGraph({ incident }: { incident: IncidentDetailDTO | null }) {
  const nodes = useMemo(() => incident ? graphNodes(incident) : [], [incident])
  const [selected, setSelected] = useState('error')
  const active = nodes.find((node) => node.id === selected) ?? nodes[0]
  return (
    <section className="h-fit self-start overflow-hidden rounded-xl border border-bh-line bg-bh-surface/75" aria-labelledby="decision-graph-title">
      <header className="border-b border-bh-line px-4 py-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bh-faint">Structured summaries · no private chain-of-thought</p>
        <h2 id="decision-graph-title" className="mt-1 text-sm font-semibold text-bh-ink">AI decision graph</h2>
      </header>
      {!incident ? <EmptyState icon="gitBranch" title="No decision path" message="Select an incident to inspect its persisted evidence and decisions." /> : (
        <div className="p-3 sm:p-4">
          <div className="hidden max-w-full overflow-x-auto pb-1 sm:block">
          <svg viewBox="0 0 730 325" className="block h-auto w-full min-w-[680px]" role="group" aria-label="Interactive AI decision graph">
            <defs><marker id="decision-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#40505d" /></marker></defs>
            <path d="M145 80H225 M325 80H405 M505 80H585 M635 116V182Q635 205 610 215L590 223 M495 245H415 M315 245H235" fill="none" stroke="#40505d" strokeWidth="2" markerEnd="url(#decision-arrow)" />
            {nodes.map((node) => (
              <g key={node.id} role="button" tabIndex={0} aria-label={`${node.label}: ${node.value}`} onClick={() => setSelected(node.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(node.id) } }} className="cursor-pointer outline-none">
                <rect x={node.x - 70} y={node.y - 34} width="140" height="68" rx="10" fill={selected === node.id ? '#18252c' : '#0d1216'} stroke={selected === node.id ? node.tone : '#28343d'} strokeWidth={selected === node.id ? 2.5 : 1.5} />
                <circle cx={node.x - 48} cy={node.y - 9} r="4" fill={node.tone} />
                <text x={node.x - 37} y={node.y - 5} fill={node.tone} fontSize="10" fontWeight="700" fontFamily="ui-monospace, monospace">{node.label}</text>
                <text x={node.x - 48} y={node.y + 15} fill="#81909d" fontSize="9" fontFamily="ui-monospace, monospace">SELECT TO INSPECT</text>
              </g>
            ))}
          </svg>
          </div>
          <div className="mb-3 grid gap-2 sm:hidden" role="group" aria-label="AI decision sequence">
            {nodes.map((node, index) => (
              <button key={node.id} type="button" onClick={() => setSelected(node.id)} className={cn('flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left', selected === node.id ? 'border-bh-accent/60 bg-bh-accent-soft' : 'border-bh-line bg-bh-bg/45')}>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-current font-mono text-[10px]" style={{ color: node.tone }}>{index + 1}</span>
                <span className="min-w-0 flex-1 font-mono text-[10px] font-bold tracking-[0.12em]" style={{ color: node.tone }}>{node.label}</span>
                <Icon name="arrowRight" size={12} className="shrink-0 text-bh-faint" />
              </button>
            ))}
          </div>
          {active && (
            <div className="rounded-lg border border-bh-line bg-bh-bg/65 p-3" aria-live="polite">
              <p className="font-mono text-[10px] font-bold tracking-[0.16em]" style={{ color: active.tone }}>{active.label}</p>
              <p className="mt-2 text-xs leading-[18px] text-bh-muted">{active.value}</p>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
