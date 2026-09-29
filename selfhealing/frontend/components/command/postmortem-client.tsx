'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'

import { cn } from '@/lib/cn'
import { Icon, type IconName } from '@/components/ui/icon'
import { useAsync } from '@/lib/hooks'
import { downloadIncidentReport, fetchIncident } from '@/lib/api/observability'
import type { AgentName, AgentRunDTO, IncidentDetailDTO } from '@/lib/api/observability'
import { duration, fetchIncidentImpact, money, type BusinessSettings, type IncidentImpact } from '@/lib/api/business'
import { Card, ErrorState, LoadingState, Pill, severityTone, statusTone } from './ui'

// Auto-generated, blameless postmortem. Every sentence is assembled from
// persisted facts (timeline, agent runs, approvals, validation, learning
// memory, business impact) — nothing here is invented by the page.

export function PostmortemClient({ id }: { id: string }) {
  const fetcher = useCallback(
    () => Promise.all([fetchIncident(id), fetchIncidentImpact(id)]).then(([d, i]) => ({ incident: d.incident, ...i })),
    [id],
  )
  const { data, loading, error, refetch } = useAsync(fetcher)

  if (loading && !data) return <LoadingState label="Writing the postmortem…" />
  if (error) return <ErrorState message={error} onRetry={refetch} />
  if (!data) return null
  return <Postmortem incident={data.incident} impact={data.impact} settings={data.settings} />
}

function latestRun(runs: AgentRunDTO[], agent: AgentName): AgentRunDTO | null {
  return [...runs].filter((r) => r.agent === agent).sort((a, b) => b.round - a.round || b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

function outcomeSentence(inc: IncidentDetailDTO, impact: IncidentImpact): string {
  const fix = duration(impact.fixMinutes)
  switch (impact.outcome) {
    case 'AUTO_FIXED':
      return `BuildHub AI classified the fix as low risk, applied it automatically and verified recovery ${fix} after detection — no engineer was paged.`
    case 'APPROVED_FIX':
      return `BuildHub AI prepared a fix, and because it was ${inc.severity} risk it waited for a human decision${impact.jiraKey ? ` in Jira (${impact.jiraKey})` : ''}. After approval it was applied and verified ${fix} after detection.`
    case 'REJECTED':
      return `BuildHub AI prepared a fix, but a human reviewer rejected it${impact.jiraKey ? ` in Jira (${impact.jiraKey})` : ''}. No code was changed; the incident was handed to engineers.`
    case 'NEEDS_ENGINEER':
      return 'The AI agents could not agree on a safe fix, so nothing was changed and the incident was escalated to engineers.'
    default:
      return 'The repair is still in progress.'
  }
}

function lessons(inc: IncidentDetailDTO, impact: IncidentImpact): string[] {
  const out: string[] = []
  if (inc.learning && inc.learning.recurrenceCount > 1)
    out.push(
      `This error signature has now occurred ${inc.learning.recurrenceCount} times. BuildHub's repair memory stores the outcome (${inc.learning.outcome.toLowerCase().replace(/_/g, ' ')}), so the next occurrence starts from what worked.`,
    )
  else out.push('First occurrence of this error signature — the outcome has been stored in repair memory for next time.')
  out.push(`Add an automated regression test for ${inc.method} ${inc.endpoint} so this failure is caught before release.`)
  if (impact.outcome === 'REJECTED' || impact.outcome === 'NEEDS_ENGINEER')
    out.push('Engineers should review the AI analysis attached to this incident and record the manual fix so the AI can learn it.')
  if (impact.outcome === 'AUTO_FIXED')
    out.push('Low-risk automatic repair worked as designed; keep this surface in the auto-fix tier.')
  if (impact.outcome === 'APPROVED_FIX')
    out.push('The human-approval gate worked as designed for a risky surface; consider whether a faster on-call rotation would shorten the approval wait.')
  out.push(`Keep monitoring the ${impact.service.toLowerCase()} error rate for 24 hours after the fix.`)
  return out
}

function Postmortem({ incident: inc, impact, settings }: { incident: IncidentDetailDTO; impact: IncidentImpact; settings: BusinessSettings }) {
  const [downloading, setDownloading] = useState(false)
  const cur = settings.currency
  const analyzer = latestRun(inc.agentRuns, 'ANALYZER')
  const coder = latestRun(inc.agentRuns, 'CODER') ?? latestRun(inc.agentRuns, 'FIXER')
  const critic = latestRun(inc.agentRuns, 'CRITIC')
  const judge = latestRun(inc.agentRuns, 'JUDGE')
  // The validated incident summary is the fullest account; the Analyzer's
  // output summary is a capped excerpt, so it is the fallback.
  const rootCause =
    inc.summary?.replace(/^(Approved & validated|Resolved|Validated):\s*/i, '') ??
    analyzer?.outputSummary ??
    inc.expectedRootCause ??
    inc.description
  const decision = inc.approvals.find((a) => a.decision) ?? inc.approvals[0] ?? null
  const start = new Date(inc.createdAt).getTime()
  const fixed = impact.outcome === 'AUTO_FIXED' || impact.outcome === 'APPROVED_FIX'
  const value = impact.revenueProtected + impact.engineerCostSaved - impact.aiCost

  const facts: Array<{ icon: IconName; label: string; value: string; hint?: string; good?: boolean }> = [
    { icon: 'history', label: 'Time to recover', value: duration(impact.fixMinutes), hint: `manual baseline ${duration(impact.manualMinutes)}`, good: fixed },
    { icon: 'activity', label: 'Revenue protected', value: money(impact.revenueProtected, cur), hint: `${Math.round(settings.revenueAtRisk[impact.severity as keyof BusinessSettings['revenueAtRisk']] * 100 || 0)}% of revenue at risk`, good: fixed },
    { icon: 'users', label: 'Engineer hours freed', value: `${impact.engineerHoursSaved} h`, hint: money(impact.engineerCostSaved, cur), good: fixed },
    { icon: 'sparkles', label: 'AI cost', value: money(impact.aiCost, cur), hint: `${impact.tokens.toLocaleString('en-IN')} tokens` },
  ]

  return (
    <article className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/ai/incidents/${inc.id}`} className="flex items-center gap-2 text-sm text-bh-muted hover:text-bh-ink">
          <Icon name="arrowLeft" size={16} /> Back to incident
        </Link>
        <div className="flex flex-wrap gap-2.5">
          <button
            onClick={async () => {
              setDownloading(true)
              try {
                await downloadIncidentReport(inc.id)
              } finally {
                setDownloading(false)
              }
            }}
            className="flex h-10 items-center gap-2 rounded-lg border border-bh-line bg-bh-surface px-4 text-sm font-medium text-bh-ink hover:border-bh-accent/60"
          >
            <Icon name="download" size={16} /> {downloading ? 'Preparing…' : 'Technical PDF'}
          </button>
          <button
            onClick={() => window.print()}
            className="flex h-10 items-center gap-2 rounded-lg bg-bh-accent px-4 text-sm font-semibold text-white hover:bg-bh-accent-strong"
          >
            <Icon name="file" size={16} /> Print / Save as PDF
          </button>
        </div>
      </div>

      <Card className="command-hero relative overflow-hidden p-6 sm:p-8">
        <div className="command-hero-glow print:hidden" aria-hidden="true" />
        <div className="relative">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-bh-accent-ink">Blameless postmortem · auto-generated</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-bh-ink sm:text-4xl">
            {inc.ref}: {impact.service} failure
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Pill tone="neutral" className={severityTone(inc.severity)}>{inc.severity} risk</Pill>
            <Pill tone="neutral" className={statusTone(inc.status)}>{inc.status.replace(/_/g, ' ')}</Pill>
            <span className="text-sm text-bh-muted">
              {new Date(inc.createdAt).toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'medium' })}
            </span>
          </div>
          <div className="mt-6 rounded-2xl border border-bh-line bg-bh-bg/50 p-5">
            <p className="text-sm font-semibold uppercase tracking-wider text-bh-faint">Summary</p>
            <p className="mt-2 text-base leading-relaxed text-bh-ink">
              Users of <strong>{impact.service}</strong> started getting server errors ({inc.method} {inc.endpoint}).{' '}
              {outcomeSentence(inc, impact)}
              {fixed && value > 0 && (
                <>
                  {' '}Compared with a typical manual fix, this protected an estimated{' '}
                  <strong className="text-bh-success">{money(value, cur)}</strong>.
                </>
              )}
            </p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map((f) => (
          <Card key={f.label} className="p-5">
            <div className="flex items-center gap-2.5 text-sm text-bh-muted">
              <Icon name={f.icon} size={17} className="text-bh-accent-ink" /> {f.label}
            </div>
            <p className={cn('mt-3 text-2xl font-bold tabular-nums', f.good ? 'text-bh-success' : 'text-bh-ink')}>{f.value}</p>
            {f.hint && <p className="mt-1 text-sm text-bh-faint">{f.hint}</p>}
          </Card>
        ))}
      </div>

      <Section icon="search" title="Root cause">
        <p className="text-base leading-relaxed text-bh-ink">{rootCause}</p>
        {analyzer && (
          <p className="mt-2 text-sm text-bh-faint">
            Found by the Analyzer agent{analyzer.confidence ? ` · ${analyzer.confidence}% confidence` : ''}
            {analyzer.model ? ` · ${analyzer.model}` : ''}
          </p>
        )}
      </Section>

      <Section icon="code" title="The fix">
        {inc.patch ? (
          <p className="text-base text-bh-ink">
            Patch <span className="font-mono text-bh-accent-ink">{inc.patch.patchId}</span> on{' '}
            <span className="font-mono">{inc.patch.file ?? 'runtime configuration'}</span>
            {inc.patch.function ? ` (${inc.patch.function}${inc.patch.line ? `, line ${inc.patch.line}` : ''})` : ''} — status{' '}
            <strong>{inc.patch.status.toLowerCase().replace(/_/g, ' ')}</strong>.
          </p>
        ) : (
          <p className="text-base text-bh-muted">No patch was applied.</p>
        )}
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {[
            ['Coder', coder],
            ['Critic', critic],
            ['Judge', judge],
          ].map(([label, run]) => {
            const r = run as AgentRunDTO | null
            return (
              <div key={label as string} className="rounded-xl border border-bh-line bg-bh-bg/40 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-bh-ink">{label as string}</p>
                  {r && <Pill tone={r.status === 'COMPLETE' ? 'success' : r.status === 'REJECTED' || r.status === 'FAILED' ? 'danger' : 'neutral'}>{r.status.toLowerCase()}</Pill>}
                </div>
                <p className="mt-2 line-clamp-5 text-sm text-bh-muted">{r?.outputSummary ?? r?.error ?? 'Did not run.'}</p>
              </div>
            )
          })}
        </div>
      </Section>

      <Section icon="users" title="Human decision">
        {decision ? (
          <div className="flex flex-wrap items-center gap-3 text-base text-bh-ink">
            <Pill tone={decision.decision === 'APPROVED' ? 'success' : decision.decision === 'REJECTED' ? 'danger' : 'warning'}>
              {decision.decision ?? decision.status}
            </Pill>
            <span>
              {decision.reviewer ? `by ${decision.reviewer}` : 'awaiting reviewer'}
              {decision.reason ? ` — “${decision.reason}”` : ''}
            </span>
            {impact.jiraKey && impact.jiraUrl && (
              <a href={impact.jiraUrl} target="_blank" rel="noreferrer" className="font-mono text-bh-info hover:underline">
                Jira {impact.jiraKey} ↗
              </a>
            )}
          </div>
        ) : (
          <p className="text-base text-bh-muted">
            {impact.outcome === 'AUTO_FIXED'
              ? 'Not required — low-risk fixes are applied automatically by policy.'
              : 'No approval was requested.'}
          </p>
        )}
      </Section>

      {inc.terminalSummary && (
        <Section icon="check" title="Verification">
          <p className="text-base text-bh-ink">
            Result:{' '}
            <strong className={inc.terminalSummary.validation.result === 'pass' ? 'text-bh-success' : 'text-bh-warning'}>
              {inc.terminalSummary.validation.result.replace('_', ' ')}
            </strong>
            {inc.terminalSummary.validation.detail ? ` — ${inc.terminalSummary.validation.detail}` : ''}
          </p>
          {inc.terminalSummary.validation.probes.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {inc.terminalSummary.validation.probes.map((p) => (
                <li key={p.name}>
                  <Pill tone={p.ok ? 'success' : 'danger'}>
                    <Icon name={p.ok ? 'check' : 'x'} size={12} /> {p.name}
                  </Pill>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Section icon="history" title="Timeline">
        <ol className="relative space-y-4 border-l-2 border-bh-line pl-6">
          {inc.timeline.map((e) => {
            const offset = Math.max(0, (new Date(e.at).getTime() - start) / 1000)
            return (
              <li key={e.id} className="relative">
                <span className="bh-gradient-bar absolute -left-[31px] top-1.5 h-3 w-3 rounded-full ring-4 ring-bh-surface" aria-hidden="true" />
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-sm text-bh-accent-ink">
                    +{offset < 60 ? `${Math.round(offset)}s` : duration(offset / 60)}
                  </span>
                  <span className="text-base font-medium text-bh-ink">{e.label}</span>
                  <span className="text-xs uppercase tracking-wider text-bh-faint">{e.stage}</span>
                </div>
                {e.detail && <p className="mt-0.5 text-sm text-bh-muted">{e.detail}</p>}
              </li>
            )
          })}
          {inc.timeline.length === 0 && <li className="text-bh-muted">No timeline events recorded.</li>}
        </ol>
      </Section>

      <Section icon="sparkles" title="Lessons & follow-ups">
        <ul className="space-y-2.5">
          {lessons(inc, impact).map((l) => (
            <li key={l} className="flex gap-3 text-base text-bh-ink">
              <Icon name="check" size={18} className="mt-0.5 shrink-0 text-bh-success" /> {l}
            </li>
          ))}
        </ul>
      </Section>

      <p className="pb-4 text-center text-sm text-bh-faint">
        Blameless by design: this document describes systems and decisions, not people. Generated by BuildHub AI from
        recorded evidence on {new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.
      </p>
    </article>
  )
}

function Section({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <Card className="break-inside-avoid p-6">
      <h2 className="mb-3 flex items-center gap-3 text-lg font-semibold text-bh-ink">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-bh-accent-soft text-bh-accent-ink">
          <Icon name={icon} size={18} />
        </span>
        {title}
      </h2>
      {children}
    </Card>
  )
}
