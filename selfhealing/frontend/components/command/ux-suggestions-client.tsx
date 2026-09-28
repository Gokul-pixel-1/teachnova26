'use client'

import { useEffect, useState } from 'react'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import {
  analyzeBehaviorNow,
  decideUxApproval,
  fetchBehaviorReport,
  fetchUxSuggestions,
  requestUxSuggestion,
  retestUxSuggestion,
  sandboxScreenshotUrl,
} from '@/lib/api/ux'
import type { ComponentFrictionDTO, SandboxRoundDTO, UxSuggestionDTO } from '@/lib/api/ux'
import { useAsync } from '@/lib/hooks'
import { Card, CardHeader, EmptyState, ErrorState, LoadingState, Pill, ProgressBar, relativeTime } from './ui'

const REFRESH_MS = 5000

function statusTone(status: UxSuggestionDTO['status']): 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'VALIDATED':
    case 'APPLIED':
      return 'success'
    case 'AWAITING_APPROVAL':
    case 'NO_EASY_PLACEMENT':
      return 'warning'
    case 'SIMULATING':
      return 'info'
    case 'REJECTED':
    case 'ROLLED_BACK':
    case 'EXPIRED':
    case 'SANDBOX_FAILED':
      return 'danger'
    default:
      return 'neutral'
  }
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-bh-faint">{label}</p>
      <pre className="mt-1 overflow-x-auto rounded-md border border-bh-line bg-bh-surface-2 p-2.5 text-[11px] leading-relaxed text-bh-ink">
        {value}
      </pre>
    </div>
  )
}

const DIRECTION_TEXT = { left: 'on the left', right: 'on the right', up: 'higher up', down: 'lower down' } as const

function hotspotText(h: ComponentFrictionDTO['hotspot']): string | null {
  if (!h) return null
  const parts: string[] = []
  if (Math.abs(h.dx) >= 8) parts.push(`${Math.abs(h.dx)}px ${h.dx < 0 ? 'left' : 'right'}`)
  if (Math.abs(h.dy) >= 8) parts.push(`${Math.abs(h.dy)}px ${h.dy < 0 ? 'up' : 'down'}`)
  return parts.length > 0 ? parts.join(', ') : 'on it'
}

function Screenshot({ id, name, caption }: { id: string; name: string; caption: string }) {
  return (
    <figure className="min-w-0">
      <a href={sandboxScreenshotUrl(id, name)} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element -- operator-only dynamic PNG from the sandbox */}
        <img
          src={sandboxScreenshotUrl(id, name)}
          alt={caption}
          className="w-full rounded-md border border-bh-line bg-white object-cover object-top"
          style={{ maxHeight: 170 }}
        />
      </a>
      <figcaption className="mt-1 text-[11px] text-bh-faint">{caption}</figcaption>
    </figure>
  )
}

function RoundLine({ r, winner }: { r: SandboxRoundDTO; winner: boolean }) {
  const x = r.result
  return (
    <li className="rounded-md border border-bh-line bg-bh-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] font-semibold text-bh-muted">Round {r.round}</span>
        {r.error ? (
          <Pill tone="danger">not testable</Pill>
        ) : x?.easy ? (
          <Pill tone="success">{winner ? 'PASSED · chosen' : 'PASSED'}</Pill>
        ) : (
          <Pill tone="warning">not easy</Pill>
        )}
        <span className="min-w-0 text-xs text-bh-ink">{r.summary || '—'}</span>
      </div>
      {x && (
        <p className="mt-1 text-[11px] text-bh-muted">
          {x.foundWhereExpected}/{x.simulatedUsers} simulated users found it where they looked
          {x.distanceImprovement !== null ? ` · ${Math.round(x.distanceImprovement * 100)}% closer` : ''}
          {x.avgDistanceBefore !== null && x.avgDistanceAfter !== null ? ` (${x.avgDistanceBefore}px → ${x.avgDistanceAfter}px away)` : ''}
          {x.predictedSecondsBefore !== null && x.predictedSecondsAfter !== null
            ? ` · predicted time to find ${x.predictedSecondsBefore}s → ${x.predictedSecondsAfter}s`
            : ''}
        </p>
      )}
      {(r.error || (x && !x.easy && x.reasons.length > 0)) && (
        <p className="mt-1 text-[11px] text-bh-danger">Why not: {r.error ?? x?.reasons.join('; ')}</p>
      )}
    </li>
  )
}

function SandboxPanel({ s, onRetest, retesting }: { s: UxSuggestionDTO; onRetest: () => void; retesting: boolean }) {
  const sb = s.sandbox
  if (s.status === 'SIMULATING') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-bh-info/30 bg-bh-info/5 px-3 py-2 text-xs text-bh-ink" role="status">
        <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-bh-info border-t-transparent" aria-hidden="true" />
        Testing this change in the sandbox (a separate copy of BuildHub) with simulated users. The live site is not
        touched. The first test can take 1–2 minutes while the sandbox starts.
      </div>
    )
  }
  if (!sb) return null
  if (sb.skipped) return <p className="text-[11px] text-bh-faint">Not tested in the sandbox: {sb.reason}</p>
  const rounds = sb.rounds ?? []
  const canRetest = s.status === 'NO_EASY_PLACEMENT' || s.status === 'SANDBOX_FAILED'
  const shots = rounds.filter((r) => r.screenshot)
  return (
    <div className="space-y-2 rounded-md border border-bh-line bg-bh-surface-2/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-bh-ink">
          Sandbox test{sb.simulatedUsers ? ` · ${sb.simulatedUsers} simulated users` : ''}
          {sb.viewports?.length ? ` · ${sb.viewports.map((v) => `${v.w}×${v.h}`).join(', ')}` : ''}
        </p>
        {sb.passed ? (
          <Pill tone="success">passed in round {sb.winnerRound}</Pill>
        ) : s.status === 'SANDBOX_FAILED' ? (
          <Pill tone="danger">test could not run</Pill>
        ) : (
          <Pill tone="warning">no easy placement found</Pill>
        )}
      </div>
      {sb.error && rounds.length === 0 && <p className="text-[11px] text-bh-danger">{sb.error}</p>}
      {rounds.length > 0 && (
        <ul className="space-y-1.5">
          {rounds.map((r) => (
            <RoundLine key={r.round} r={r} winner={sb.winnerRound === r.round} />
          ))}
        </ul>
      )}
      {(sb.baselineScreenshot || shots.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {sb.baselineScreenshot && <Screenshot id={s.id} name={sb.baselineScreenshot} caption="Before (live layout)" />}
          {shots.map((r) => (
            <Screenshot
              key={r.round}
              id={s.id}
              name={r.screenshot as string}
              caption={`Round ${r.round}${sb.winnerRound === r.round ? ' — chosen' : r.result?.easy ? '' : ' — not easy'}`}
            />
          ))}
        </div>
      )}
      {(sb.baselineScreenshot || shots.length > 0) && (
        <p className="text-[11px] text-bh-faint">Red dots = where simulated users looked for it · green box = where it is in that layout.</p>
      )}
      {canRetest && (
        <button
          onClick={onRetest}
          disabled={retesting}
          className="flex h-8 items-center gap-1.5 rounded-md border border-bh-line px-3 text-xs font-medium text-bh-ink hover:bg-bh-surface-2 disabled:opacity-60"
        >
          <Icon name="refresh" size={13} /> {retesting ? 'Starting…' : 'Re-test in sandbox'}
        </button>
      )}
    </div>
  )
}

function FrictionRow({ f, minScore }: { f: ComponentFrictionDTO; minScore: number }) {
  const pct = Math.min(100, Math.round((f.score / Math.max(1, minScore)) * 100))
  const tone = f.openSuggestion ? 'warning' : f.flagged || pct >= 100 ? 'danger' : pct >= 50 ? 'warning' : 'accent'
  return (
    <li className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-bh-ink">{f.label}</p>
        <p className="truncate font-mono text-[11px] text-bh-faint">{f.uxId} · {f.file}</p>
      </div>
      <div className="min-w-0">
        <div className="flex items-center justify-between text-[11px] text-bh-muted">
          <span>friction {f.score}/{minScore}</span>
          <span>{f.strugglingSessions} struggling session{f.strugglingSessions === 1 ? '' : 's'}</span>
        </div>
        <ProgressBar value={pct} tone={tone} className="mt-1" />
        <p className="mt-1 text-[11px] text-bh-faint">
          dead clicks {f.deadClicks}
          {f.deadClicks > 0
            ? ` (left ${f.deadClicksBySide.LEFT}, right ${f.deadClicksBySide.RIGHT}, above ${f.deadClicksBySide.ABOVE}, below ${f.deadClicksBySide.BELOW})`
            : ''}{' '}
          · rage {f.rageClicks} · slow finds {f.slowFinds}
          {f.avgFindMs !== null ? ` · avg find ${(f.avgFindMs / 1000).toFixed(1)}s` : ''}
        </p>
        {(f.direction || f.hotspot) && (
          <p className="mt-0.5 text-[11px] text-bh-muted">
            {f.direction ? `Users look for it ${DIRECTION_TEXT[f.direction]}` : 'No clear direction yet'}
            {f.hotspot ? ` · most clicks ${hotspotText(f.hotspot)} of it` : ''}
          </p>
        )}
      </div>
      <div className="sm:text-right">
        {f.openSuggestion ? (
          <Pill tone={f.openSuggestion.status === 'SIMULATING' ? 'info' : 'warning'}>
            {f.openSuggestion.ref} {f.openSuggestion.status === 'SIMULATING' ? 'testing in sandbox' : 'awaiting approval'}
          </Pill>
        ) : f.flagged ? (
          <Pill tone="danger">threshold reached</Pill>
        ) : (
          <Pill tone="neutral">monitoring</Pill>
        )}
      </div>
    </li>
  )
}

export function UxSuggestionsClient() {
  const suggestions = useAsync(fetchUxSuggestions)
  const behavior = useAsync(fetchBehaviorReport)
  const [component, setComponent] = useState('')
  const [file, setFile] = useState('')
  const [instruction, setInstruction] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [deciding, setDeciding] = useState<string | null>(null)
  const [retesting, setRetesting] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refetchSuggestions = suggestions.refetch
  const refetchBehavior = behavior.refetch
  useEffect(() => {
    const timer = window.setInterval(() => {
      refetchSuggestions()
      refetchBehavior()
    }, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refetchSuggestions, refetchBehavior])

  const refreshAll = () => {
    refetchSuggestions()
    refetchBehavior()
  }

  const analyze = async () => {
    setAnalyzing(true)
    setNotice(null)
    try {
      const result = await analyzeBehaviorNow()
      const created = result.created ?? []
      const failed = result.failed ?? []
      setNotice(
        created.length > 0
          ? `Raised ${created.map((c) => `${c.ref} (${c.uxId})`).join(', ')} from user behaviour — now testing it in the sandbox. You get an approval email only if a placement passes. Nothing changes until approved.`
          : failed.length > 0
            ? `Threshold reached but drafting failed: ${failed.map((f) => `${f.uxId}: ${f.error}`).join('; ')}`
            : 'No component is over the friction threshold right now.',
      )
      refreshAll()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Analysis failed.')
    } finally {
      setAnalyzing(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setNotice(null)
    try {
      const result = await requestUxSuggestion({
        component: component.trim(),
        file: file.trim(),
        instruction: instruction.trim() || undefined,
      })
      if (result.ok && result.suggestion) {
        setNotice(
          result.simulating
            ? `${result.suggestion.ref}: drafted — now testing it in the sandbox. An approval email follows only if it passes.`
            : `${result.suggestion.ref}: drafted and an approval email was sent. Nothing was changed yet.`,
        )
        setComponent('')
        setFile('')
        setInstruction('')
        refreshAll()
      } else {
        setNotice(result.error ?? 'Could not draft a suggestion.')
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not draft a suggestion.')
    } finally {
      setSubmitting(false)
    }
  }

  const retest = async (id: string) => {
    setRetesting(id)
    setNotice(null)
    try {
      await retestUxSuggestion(id)
      setNotice('Re-testing in the sandbox. This page updates when the test finishes.')
      refreshAll()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not start the re-test.')
    } finally {
      setRetesting(null)
    }
  }

  const decide = async (approvalId: string, action: 'proceed' | 'reject') => {
    setDeciding(approvalId)
    setNotice(null)
    try {
      const result = await decideUxApproval(approvalId, action)
      setNotice(result.reason ?? (action === 'proceed' ? 'Approved.' : `Rejected (${result.status ?? 'REJECTED'}). No file was changed.`))
      refreshAll()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not record decision.')
    } finally {
      setDeciding(null)
    }
  }

  const minScore = behavior.data?.thresholds.minScore ?? 12

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-bh-faint">Mission Control</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-bh-ink">UX Suggestions</h1>
          <p className="mt-1 max-w-2xl text-sm text-bh-muted">
            The UX agent watches how real users interact with the app — clicks on empty space where they
            expected a control, rage clicks, and how long it takes to find things. When a component
            crosses the friction threshold it drafts a fix, tests it first in a sandbox copy of BuildHub with
            simulated users (trying other placements if it is not easy), and only emails you a placement
            that passed. Nothing changes until you approve.
          </p>
        </div>
        <button
          onClick={() => void analyze()}
          disabled={analyzing}
          className="flex h-9 items-center gap-2 rounded-md bg-bh-accent px-3.5 text-sm font-medium text-white hover:bg-bh-accent-strong disabled:opacity-60"
        >
          {analyzing ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
          ) : (
            <Icon name="activity" size={15} />
          )}
          {analyzing ? 'Analyzing…' : 'Analyze behaviour now'}
        </button>
      </div>

      {notice && (
        <p className="rounded-lg border border-bh-accent/30 bg-bh-accent-soft/40 px-3.5 py-2.5 text-xs text-bh-accent-ink" role="status">
          {notice}
        </p>
      )}

      <Card>
        <CardHeader
          icon="activity"
          title="User behaviour analysis"
          hint={
            behavior.data
              ? `Auto-suggest ${behavior.data.autoSuggest ? 'ON' : 'OFF'} · threshold: friction ≥ ${behavior.data.thresholds.minScore} from ≥ ${behavior.data.thresholds.minSessions} struggling sessions · slow find ≥ ${behavior.data.thresholds.slowFindMs / 1000}s · refreshes every ${REFRESH_MS / 1000}s`
              : 'Live friction per tracked component'
          }
        />
        {behavior.loading && !behavior.data ? <div className="px-4"><LoadingState label="Loading behaviour…" /></div> : null}
        {behavior.error && !behavior.data ? <div className="p-4"><ErrorState message={behavior.error} onRetry={refetchBehavior} /></div> : null}
        {behavior.data ? (
          <ul className="divide-y divide-bh-line/60">
            {behavior.data.report.map((f) => (
              <FrictionRow key={f.uxId} f={f} minScore={minScore} />
            ))}
          </ul>
        ) : null}
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-bh-ink">Suggestions</h2>
        {suggestions.loading && !suggestions.data ? <LoadingState label="Loading suggestions…" /> : null}
        {suggestions.error && !suggestions.data ? <ErrorState message={suggestions.error} onRetry={refetchSuggestions} /> : null}
        {suggestions.data && suggestions.data.suggestions.length === 0 ? (
          <Card>
            <EmptyState
              icon="sparkles"
              title="No suggestions yet"
              message="When users struggle with a component, the agent drafts a suggestion here and emails you for approval."
            />
          </Card>
        ) : null}

        <div className="space-y-3">
          {suggestions.data?.suggestions.map((s) => {
            const approval = s.approvals[0]
            const canDecide = s.status === 'AWAITING_APPROVAL' && approval?.status === 'PENDING'
            return (
              <Card key={s.id}>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-bh-line px-4 py-3">
                  <div className="min-w-0">
                    <span className="mr-2 font-mono text-xs font-semibold text-bh-accent-ink">{s.ref}</span>
                    <span className="font-medium text-bh-ink">{s.component}</span>
                    <span className="ml-2 font-mono text-xs text-bh-faint">{s.file}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={s.source === 'AUTO' ? 'info' : 'neutral'}>
                      {s.source === 'AUTO' ? 'AUTO · user behaviour' : 'MANUAL'}
                    </Pill>
                    <Pill tone={statusTone(s.status)}>{s.status}</Pill>
                    <span className="text-xs text-bh-faint">{relativeTime(s.createdAt)}</span>
                  </div>
                </div>
                <div className="space-y-3 p-4">
                  <div
                    className={cn(
                      'rounded-md border px-3 py-2 text-xs leading-relaxed',
                      s.source === 'AUTO' ? 'border-bh-info/30 bg-bh-info/5 text-bh-ink' : 'border-bh-line bg-bh-surface-2 text-bh-muted',
                    )}
                  >
                    <span className="font-semibold">Why: </span>
                    {s.instruction}
                  </div>
                  {s.summary && <p className="text-sm text-bh-muted"><span className="font-medium text-bh-ink">Proposed: </span>{s.summary}</p>}
                  <SandboxPanel s={s} onRetest={() => void retest(s.id)} retesting={retesting === s.id} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <CodeBlock label="Current" value={s.currentCode} />
                    <CodeBlock label="Proposed" value={s.proposedCode} />
                  </div>
                  {s.validationResult && <p className="text-xs text-bh-faint">{s.validationResult}</p>}
                  {canDecide && approval && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        onClick={() => void decide(approval.approvalId, 'proceed')}
                        disabled={deciding === approval.approvalId}
                        className="flex h-8 items-center gap-1.5 rounded-md bg-bh-accent px-3 text-xs font-medium text-white hover:bg-bh-accent-strong disabled:opacity-60"
                      >
                        <Icon name="check" size={13} /> Approve
                      </button>
                      <button
                        onClick={() => void decide(approval.approvalId, 'reject')}
                        disabled={deciding === approval.approvalId}
                        className="flex h-8 items-center gap-1.5 rounded-md border border-bh-line px-3 text-xs font-medium text-bh-muted hover:bg-bh-surface-2 disabled:opacity-60"
                      >
                        <Icon name="x" size={13} /> Reject
                      </button>
                      {approval.jira?.issueUrl && (
                        <a
                          href={approval.jira.issueUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="flex h-8 items-center gap-1.5 rounded-md border border-bh-line px-3 text-xs font-medium text-bh-accent hover:bg-bh-surface-2"
                        >
                          Open Jira {approval.jira.issueKey}
                        </a>
                      )}
                      <span className="text-[11px] text-bh-faint">
                        {approval.approvalId} ·{' '}
                        {approval.jira?.issueKey
                          ? `or move Jira ${approval.jira.issueKey} to Done (approve) / To Do (reject)`
                          : 'or use the Approve/Reject links in the email'}{' '}
                        · expires at{' '}
                        {new Date(approval.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      </div>

      <details className="rounded-lg border border-bh-line bg-bh-surface/80">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-bh-ink">
          Manual request (optional) — ask the agent about a specific component
        </summary>
        <form onSubmit={submit} className="grid gap-3 border-t border-bh-line p-4 sm:grid-cols-2">
          <label className="block text-xs font-medium text-bh-muted">
            Component
            <input
              value={component}
              onChange={(e) => setComponent(e.target.value)}
              placeholder="login-button"
              required
              className="mt-1 w-full rounded-md border border-bh-line bg-bh-surface px-3 py-2 text-sm text-bh-ink outline-none focus:border-bh-accent"
            />
          </label>
          <label className="block text-xs font-medium text-bh-muted">
            File
            <input
              value={file}
              onChange={(e) => setFile(e.target.value)}
              placeholder="components/navigation/header.tsx"
              required
              className="mt-1 w-full rounded-md border border-bh-line bg-bh-surface px-3 py-2 text-sm text-bh-ink outline-none focus:border-bh-accent"
            />
          </label>
          <label className="block text-xs font-medium text-bh-muted sm:col-span-2">
            Hint (optional)
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="The login button is hard to find in the top-right; move it left."
              rows={2}
              className="mt-1 w-full resize-none rounded-md border border-bh-line bg-bh-surface px-3 py-2 text-sm text-bh-ink outline-none focus:border-bh-accent"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={submitting}
              className="flex h-9 items-center gap-2 rounded-md border border-bh-line px-3.5 text-sm font-medium text-bh-ink hover:bg-bh-surface-2 disabled:opacity-60"
            >
              <Icon name="sparkles" size={15} />
              {submitting ? 'Drafting…' : 'Draft suggestion'}
            </button>
          </div>
        </form>
      </details>
    </div>
  )
}
