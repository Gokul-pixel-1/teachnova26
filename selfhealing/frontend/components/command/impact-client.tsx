'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { useAsync } from '@/lib/hooks'
import {
  duration,
  fetchImpact,
  money,
  saveBusinessSettings,
  type BusinessSettings,
  type ImpactOutcome,
  type ImpactReport,
  type Severity,
  type UxImpactItem,
} from '@/lib/api/business'
import { Card, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader, Pill } from './ui'

const WINDOWS = [7, 30, 90] as const

const OUTCOMES: Record<ImpactOutcome, { label: string; color: string; tone: 'success' | 'info' | 'warning' | 'danger' | 'neutral' }> = {
  AUTO_FIXED: { label: 'Fixed automatically', color: 'var(--bh-success)', tone: 'success' },
  APPROVED_FIX: { label: 'Fixed after approval', color: 'var(--bh-info)', tone: 'info' },
  REJECTED: { label: 'Rejected by a human', color: 'var(--bh-warning)', tone: 'warning' },
  NEEDS_ENGINEER: { label: 'Handed to engineers', color: 'var(--bh-danger)', tone: 'danger' },
  OPEN: { label: 'In progress', color: 'var(--bh-accent)', tone: 'neutral' },
}

export function ImpactClient() {
  const [days, setDays] = useState<number>(30)
  const [editing, setEditing] = useState(false)
  const fetcher = useCallback(() => fetchImpact(days), [days])
  const { data, loading, error, refetch } = useAsync(fetcher)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Business"
        title="Business Impact"
        description="What self-healing is worth in money and hours — computed from real incident timings and your own business numbers."
        actions={
          <>
            <div className="flex rounded-lg border border-bh-line bg-bh-surface p-1" role="group" aria-label="Time window">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  onClick={() => setDays(w)}
                  aria-pressed={days === w}
                  className={cn(
                    'rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors',
                    days === w ? 'bg-bh-accent text-white shadow' : 'text-bh-muted hover:text-bh-ink',
                  )}
                >
                  {w} days
                </button>
              ))}
            </div>
            <button
              onClick={() => setEditing(true)}
              disabled={!data}
              className="flex h-10 items-center gap-2 rounded-lg border border-bh-line bg-bh-surface px-4 text-sm font-medium text-bh-ink hover:border-bh-accent/60 disabled:opacity-50"
            >
              <Icon name="settings" size={16} /> Business numbers
            </button>
          </>
        }
      />

      {loading && !data && <LoadingState label="Calculating impact…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}
      {data && (
        <>
          <ValueHero report={data.report} />
          <KpiRow report={data.report} />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-5">
            <ValueChart report={data.report} className="xl:col-span-3" />
            <OutcomeBreakdown report={data.report} className="xl:col-span-2" />
          </div>
          <UxImpactSection items={data.ux} />
          <Ledger report={data.report} />
        </>
      )}

      {editing && data && (
        <SettingsDialog
          initial={data.report.settings}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            refetch()
          }}
        />
      )}
    </div>
  )
}

function ValueHero({ report }: { report: ImpactReport }) {
  const { totals, settings } = report
  const cur = settings.currency
  const ai = totals.avgAiFixMinutes
  const manual = totals.avgManualMinutes
  const speedup = ai && manual ? Math.max(1, Math.round(manual / Math.max(ai, 0.05))) : null
  return (
    <Card className="command-hero relative overflow-hidden p-6 sm:p-8">
      <div className="command-hero-glow" aria-hidden="true" />
      <div className="relative grid gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-center">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-bh-accent-ink">
            Value protected · last {report.windowDays} days
          </p>
          <p className="bh-gradient-text mt-3 text-5xl font-bold tracking-tight tabular-nums sm:text-6xl">
            {money(totals.netValue, cur)}
          </p>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-bh-muted">
            <span className="font-semibold text-bh-ink">{money(totals.revenueProtected, cur)}</span> of revenue kept
            flowing, plus <span className="font-semibold text-bh-ink">{money(totals.engineerCostSaved, cur)}</span> of
            engineer time freed — for just{' '}
            <span className="font-semibold text-bh-ink">{money(totals.aiCost, cur)}</span> of AI.
          </p>
        </div>
        <div className="rounded-2xl border border-bh-line bg-bh-bg/50 p-5">
          <p className="text-sm font-medium text-bh-muted">Average time to fix</p>
          <SpeedBar label="BuildHub AI" minutes={ai} max={manual} tone="accent" />
          <SpeedBar label="Manual (your team)" minutes={manual} max={manual} tone="muted" />
          {speedup && (
            <p className="mt-4 flex items-center gap-2 text-base font-semibold text-bh-success">
              <Icon name="sparkles" size={18} /> {speedup.toLocaleString('en-IN')}× faster recovery
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

function SpeedBar({
  label,
  minutes,
  max,
  tone,
}: {
  label: string
  minutes: number | null
  max: number | null
  tone: 'accent' | 'muted'
}) {
  const pct = minutes !== null && max ? Math.max(2, Math.min(100, (minutes / max) * 100)) : 0
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-bh-ink">{label}</span>
        <span className="font-mono font-semibold text-bh-ink">{minutes === null ? '—' : duration(minutes)}</span>
      </div>
      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-bh-surface-2">
        <div
          className={cn('h-full rounded-full', tone === 'accent' ? 'bh-gradient-bar' : 'bg-bh-faint/60')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function KpiRow({ report }: { report: ImpactReport }) {
  const { totals, settings } = report
  const cur = settings.currency
  const fixes = Math.max(1, totals.fixed)
  const aiPerFix = totals.aiCost / fixes
  const manualPerFix = totals.fixed ? (totals.engineerCostSaved + totals.revenueProtected) / totals.fixed : 0
  const cards = [
    {
      icon: 'activity' as const,
      label: 'Revenue protected',
      value: money(totals.revenueProtected, cur),
      sub: `${duration(totals.downtimeAvoidedMinutes)} of downtime avoided`,
    },
    {
      icon: 'users' as const,
      label: 'Engineer hours freed',
      value: `${Math.round(totals.engineerHoursSaved).toLocaleString('en-IN')} h`,
      sub: `${money(totals.engineerCostSaved, cur)} of team time`,
    },
    {
      icon: 'shield' as const,
      label: 'Incidents fixed',
      value: `${totals.fixed}/${totals.incidents}`,
      sub: `${totals.autoFixed} automatic · ${totals.approvedFixes} approved`,
    },
    {
      icon: 'sparkles' as const,
      label: 'AI cost per fix',
      value: money(aiPerFix, cur),
      sub: totals.fixed ? `vs ${money(manualPerFix, cur)} cost of a manual outage` : 'no fixes yet',
    },
  ]
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label} className="bh-card-hover p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bh-accent-soft text-bh-accent-ink">
              <Icon name={c.icon} size={20} />
            </span>
            <p className="text-sm font-medium text-bh-muted">{c.label}</p>
          </div>
          <p className="mt-4 text-3xl font-bold tracking-tight text-bh-ink tabular-nums">{c.value}</p>
          <p className="mt-1.5 text-sm text-bh-muted">{c.sub}</p>
        </Card>
      ))}
    </div>
  )
}

function ValueChart({ report, className }: { report: ImpactReport; className?: string }) {
  const cur = report.settings.currency
  const max = Math.max(1, ...report.days.map((d) => d.value))
  const labelEvery = report.days.length > 30 ? 15 : report.days.length > 7 ? 5 : 1
  return (
    <Card className={className}>
      <CardHeader icon="activity" title="Value protected per day" hint="Revenue protected + engineer time freed − AI cost" />
      <div className="p-5">
        <div className="flex h-56 items-end gap-[3px]" role="img" aria-label="Daily value protected chart">
          {report.days.map((d) => (
            <div key={d.date} className="group relative flex h-full flex-1 flex-col justify-end">
              <div
                className={cn(
                  'w-full rounded-t-md transition-all',
                  d.value > 0 ? 'bh-gradient-bar-v group-hover:brightness-125' : 'bg-bh-surface-2',
                )}
                style={{ height: d.value > 0 ? `${Math.max(4, (d.value / max) * 100)}%` : '3px' }}
              />
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-bh-line bg-bh-surface px-3 py-2 text-sm shadow-xl group-hover:block">
                <p className="font-semibold text-bh-ink">{money(d.value, cur)}</p>
                <p className="text-bh-muted">
                  {new Date(d.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · {d.fixed}/
                  {d.incidents} fixed
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-[3px] text-xs text-bh-faint">
          {report.days.map((d, i) => (
            <span key={d.date} className="flex-1 text-center">
              {i % labelEvery === 0 ? new Date(d.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : ''}
            </span>
          ))}
        </div>
      </div>
    </Card>
  )
}

function OutcomeBreakdown({ report, className }: { report: ImpactReport; className?: string }) {
  const t = report.totals
  const rows: Array<[ImpactOutcome, number]> = [
    ['AUTO_FIXED', t.autoFixed],
    ['APPROVED_FIX', t.approvedFixes],
    ['REJECTED', t.rejected],
    ['NEEDS_ENGINEER', t.needsEngineer],
    ['OPEN', t.open],
  ]
  const total = Math.max(1, t.incidents)
  return (
    <Card className={className}>
      <CardHeader icon="gitBranch" title="What happened to every incident" hint={`${t.incidents} incidents in ${report.windowDays} days`} />
      <div className="space-y-5 p-5">
        <div className="flex h-4 overflow-hidden rounded-full bg-bh-surface-2">
          {rows.map(([key, n]) =>
            n > 0 ? (
              <div key={key} style={{ width: `${(n / total) * 100}%`, background: OUTCOMES[key].color }} title={OUTCOMES[key].label} />
            ) : null,
          )}
        </div>
        <ul className="space-y-3">
          {rows.map(([key, n]) => (
            <li key={key} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2.5 text-bh-ink">
                <span className="h-3 w-3 rounded-full" style={{ background: OUTCOMES[key].color }} aria-hidden="true" />
                {OUTCOMES[key].label}
              </span>
              <span className="font-mono text-bh-muted">
                <span className="font-semibold text-bh-ink">{n}</span> · {Math.round((n / total) * 100)}%
              </span>
            </li>
          ))}
        </ul>
        <p className="rounded-xl border border-bh-line bg-bh-bg/40 p-3.5 text-sm leading-relaxed text-bh-muted">
          Humans stay in control: every MEDIUM and HIGH risk fix waited for a Jira approval, and{' '}
          <span className="font-semibold text-bh-ink">{t.rejected}</span> AI fixes were rejected without touching code.
        </p>
      </div>
    </Card>
  )
}

function UxImpactSection({ items }: { items: UxImpactItem[] }) {
  return (
    <Card>
      <CardHeader
        icon="sparkles"
        title="UX Impact Proof"
        hint="Did approved UI changes really help? Real user behaviour one week before vs. after each change."
        extra={
          <Link href="/ai/ux-suggestions" className="text-sm font-medium text-bh-accent-ink hover:underline">
            UX Suggestions →
          </Link>
        }
      />
      {items.length === 0 ? (
        <EmptyState icon="sparkles" title="No approved UX changes yet" message="Once a UX suggestion is approved in Jira, its before/after effect on real users appears here." />
      ) : (
        <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-2">
          {items.map((item) => (
            <UxImpactCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </Card>
  )
}

const VERDICT: Record<UxImpactItem['verdict'], { label: string; tone: 'success' | 'danger' | 'neutral' | 'info' }> = {
  improved: { label: 'Improved', tone: 'success' },
  worse: { label: 'Got worse', tone: 'danger' },
  'no-change': { label: 'No change', tone: 'neutral' },
  collecting: { label: 'Measuring', tone: 'info' },
}

function UxImpactCard({ item }: { item: UxImpactItem }) {
  const v = VERDICT[item.verdict]
  const metric = (label: string, before: string, after: string, better: boolean | null) => (
    <div className="rounded-xl border border-bh-line bg-bh-bg/40 p-3">
      <p className="text-xs font-medium uppercase tracking-wider text-bh-faint">{label}</p>
      <p className="mt-1.5 flex items-baseline gap-2 font-mono text-sm">
        <span className="text-bh-muted line-through decoration-bh-faint/60">{before}</span>
        <Icon name="arrowRight" size={13} className="self-center text-bh-faint" />
        <span className={cn('text-lg font-semibold', better === null ? 'text-bh-ink' : better ? 'text-bh-success' : 'text-bh-danger')}>
          {after}
        </span>
      </p>
    </div>
  )
  const b = item.before
  const a = item.after
  const hasAfter = a.sessions > 0
  return (
    <div className="bh-card-hover rounded-2xl border border-bh-line bg-bh-surface-2/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm text-bh-accent-ink">{item.ref}</p>
          <p className="mt-0.5 text-base font-semibold text-bh-ink">{item.component}</p>
        </div>
        <Pill tone={v.tone}>{v.label}</Pill>
      </div>
      {item.summary && <p className="mt-2 line-clamp-2 text-sm text-bh-muted">{item.summary}</p>}
      <p className="mt-3 text-base font-medium text-bh-ink">{item.headline}</p>
      <div className="mt-4 grid grid-cols-3 gap-2.5">
        {metric('Struggles / visitor', b.strugglePerVisitor.toFixed(1), hasAfter ? a.strugglePerVisitor.toFixed(1) : '—', hasAfter ? a.strugglePerVisitor <= b.strugglePerVisitor : null)}
        {metric('Time to find', b.medianFindSeconds !== null ? `${b.medianFindSeconds}s` : '—', a.medianFindSeconds !== null ? `${a.medianFindSeconds}s` : '—', a.medianFindSeconds !== null && b.medianFindSeconds !== null ? a.medianFindSeconds <= b.medianFindSeconds : null)}
        {metric('Visitors', String(b.sessions), String(a.sessions), null)}
      </div>
      <p className="mt-3 text-xs text-bh-faint">
        Applied {new Date(item.appliedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
      </p>
    </div>
  )
}

const LEDGER_PREVIEW = 12

function Ledger({ report }: { report: ImpactReport }) {
  const cur = report.settings.currency
  const [showAll, setShowAll] = useState(false)
  const rows = showAll ? report.incidents : report.incidents.slice(0, LEDGER_PREVIEW)
  return (
    <Card>
      <CardHeader icon="file" title="Incident value ledger" hint="Every incident, its fix time against your manual baseline, and what it was worth" />
      {report.incidents.length === 0 ? (
        <EmptyState icon="shield" title="No incidents in this window" message="Nothing broke — or nothing has been detected yet." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead>
              <tr className="border-b border-bh-line text-xs uppercase tracking-wider text-bh-faint">
                <th className="px-5 py-3 font-medium">Incident</th>
                <th className="px-5 py-3 font-medium">Service</th>
                <th className="px-5 py-3 font-medium">Outcome</th>
                <th className="px-5 py-3 font-medium">AI fix vs manual</th>
                <th className="px-5 py-3 text-right font-medium">Value</th>
                <th className="px-5 py-3 font-medium">Approval</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const o = OUTCOMES[i.outcome]
                const value = i.revenueProtected + i.engineerCostSaved - i.aiCost
                return (
                  <tr key={i.id} className="border-b border-bh-line/70 transition-colors last:border-0 hover:bg-bh-surface-2/50">
                    <td className="px-5 py-3.5">
                      <Link href={`/ai/incidents/${i.id}`} className="font-mono font-semibold text-bh-accent-ink hover:underline">
                        {i.ref}
                      </Link>
                      <p className="text-xs text-bh-faint">{new Date(i.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</p>
                    </td>
                    <td className="px-5 py-3.5 text-bh-ink">{i.service}</td>
                    <td className="px-5 py-3.5">
                      <Pill tone={o.tone}>{o.label}</Pill>
                    </td>
                    <td className="px-5 py-3.5 font-mono text-bh-muted">
                      {i.outcome === 'AUTO_FIXED' || i.outcome === 'APPROVED_FIX' ? (
                        <>
                          <span className="font-semibold text-bh-ink">{duration(i.fixMinutes)}</span> vs {duration(i.manualMinutes)}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={cn('px-5 py-3.5 text-right font-mono font-semibold', value > 0 ? 'text-bh-success' : 'text-bh-muted')}>
                      {value > 0 ? `+${money(value, cur)}` : money(value, cur)}
                    </td>
                    <td className="px-5 py-3.5">
                      {i.jiraKey && i.jiraUrl ? (
                        <a href={i.jiraUrl} target="_blank" rel="noreferrer" className="font-mono text-bh-info hover:underline">
                          {i.jiraKey} ↗
                        </a>
                      ) : (
                        <span className="text-bh-faint">{i.outcome === 'AUTO_FIXED' ? 'Auto (low risk)' : '—'}</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <Link
                        href={`/ai/incidents/${i.id}/postmortem`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-bh-line px-3 py-1.5 text-sm text-bh-ink hover:border-bh-accent/60"
                      >
                        <Icon name="document" size={14} /> Postmortem
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {report.incidents.length > LEDGER_PREVIEW && (
            <div className="border-t border-bh-line p-3 text-center">
              <button
                onClick={() => setShowAll((v) => !v)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-bh-accent-ink hover:bg-bh-surface-2"
              >
                {showAll ? 'Show fewer' : `Show all ${report.incidents.length} incidents`}
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

const SEVERITIES: Severity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

function SettingsDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: BusinessSettings
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<BusinessSettings>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const num = (v: string) => (v === '' ? 0 : Number(v))
  const setSev = (field: 'manualMttrMinutes' | 'revenueAtRisk' | 'engineersPerIncident', sev: Severity, value: number) =>
    setForm((f) => ({ ...f, [field]: { ...f[field], [sev]: value } }))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await saveBusinessSettings(form)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.')
    } finally {
      setSaving(false)
    }
  }

  const input = 'h-10 w-full rounded-lg border border-bh-line bg-bh-bg px-3 text-sm text-bh-ink focus:border-bh-accent focus:outline-none'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="bn-title">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-bh-line bg-bh-surface shadow-2xl" style={{ animation: 'modalIn .2s ease-out' }}>
        <div className="flex items-center justify-between border-b border-bh-line px-6 py-4">
          <div>
            <h2 id="bn-title" className="text-lg font-semibold text-bh-ink">Business numbers</h2>
            <p className="text-sm text-bh-muted">Every money figure is computed from these — change them to match your company.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-2 text-bh-muted hover:bg-bh-surface-2 hover:text-bh-ink">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="space-y-6 px-6 py-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-bh-ink">Company name</span>
              <input className={input} value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-bh-ink">Currency symbol</span>
              <input className={input} value={form.currency} maxLength={4} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-bh-ink">Revenue per hour</span>
              <input type="number" min={0} className={input} value={form.revenuePerHour} onChange={(e) => setForm({ ...form, revenuePerHour: num(e.target.value) })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium text-bh-ink">Engineer cost per hour</span>
              <input type="number" min={0} className={input} value={form.engineerCostPerHour} onChange={(e) => setForm({ ...form, engineerCostPerHour: num(e.target.value) })} />
            </label>
            <label className="space-y-1.5 text-sm sm:col-span-2">
              <span className="font-medium text-bh-ink">AI cost per 1M tokens</span>
              <input type="number" min={0} step="0.1" className={input} value={form.aiCostPerMillionTokens} onChange={(e) => setForm({ ...form, aiCostPerMillionTokens: num(e.target.value) })} />
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-bh-faint">
                  <th className="pb-2 font-medium">Severity</th>
                  <th className="pb-2 font-medium">Manual fix time (min)</th>
                  <th className="pb-2 font-medium">Revenue at risk (%)</th>
                  <th className="pb-2 font-medium">Engineers pulled in</th>
                </tr>
              </thead>
              <tbody>
                {SEVERITIES.map((sev) => (
                  <tr key={sev}>
                    <td className="py-1.5 pr-3 font-mono font-semibold text-bh-ink">{sev}</td>
                    <td className="py-1.5 pr-3">
                      <input type="number" min={0} className={input} value={form.manualMttrMinutes[sev]} onChange={(e) => setSev('manualMttrMinutes', sev, num(e.target.value))} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input type="number" min={0} max={100} className={input} value={Math.round(form.revenueAtRisk[sev] * 100)} onChange={(e) => setSev('revenueAtRisk', sev, Math.min(100, num(e.target.value)) / 100)} />
                    </td>
                    <td className="py-1.5">
                      <input type="number" min={0} className={input} value={form.engineersPerIncident[sev]} onChange={(e) => setSev('engineersPerIncident', sev, num(e.target.value))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="text-sm text-bh-danger" role="alert">{error}</p>}
        </div>
        <div className="flex justify-end gap-3 border-t border-bh-line px-6 py-4">
          <button onClick={onClose} className="h-10 rounded-lg border border-bh-line px-4 text-sm font-medium text-bh-ink hover:bg-bh-surface-2">
            Cancel
          </button>
          <button onClick={save} disabled={saving} className="h-10 rounded-lg bg-bh-accent px-5 text-sm font-semibold text-white hover:bg-bh-accent-strong disabled:opacity-60">
            {saving ? 'Saving…' : 'Save & recalculate'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Compact business-value banner for the Overview page. */
export function ImpactStrip() {
  const fetcher = useCallback(() => fetchImpact(30), [])
  const { data } = useAsync(fetcher)
  if (!data) return null
  const { totals, settings } = data.report
  const speedup =
    totals.avgAiFixMinutes && totals.avgManualMinutes
      ? Math.max(1, Math.round(totals.avgManualMinutes / Math.max(totals.avgAiFixMinutes, 0.05)))
      : null
  const items = [
    { label: 'value protected (30 days)', value: money(totals.netValue, settings.currency) },
    { label: 'engineer hours freed', value: `${Math.round(totals.engineerHoursSaved).toLocaleString('en-IN')} h` },
    { label: 'faster than manual recovery', value: speedup ? `${speedup.toLocaleString('en-IN')}×` : '—' },
    { label: 'incidents fixed', value: `${totals.fixed}/${totals.incidents}` },
  ]
  return (
    <Link
      href="/ai/impact"
      className="bh-gradient-border bh-card-hover group block rounded-2xl px-6 py-5"
    >
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2.5 text-sm font-semibold uppercase tracking-[0.14em] text-bh-accent-ink">
          <Icon name="compass" size={18} /> Business impact
        </span>
        <span className="flex items-center gap-1.5 text-sm font-medium text-bh-accent-ink group-hover:underline">
          Open dashboard <Icon name="arrowRight" size={15} />
        </span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {items.map((i) => (
          <div key={i.label} className="min-w-0">
            <p className="bh-gradient-text text-3xl font-bold tabular-nums">{i.value}</p>
            <p className="mt-0.5 text-sm text-bh-muted">{i.label}</p>
          </div>
        ))}
      </div>
    </Link>
  )
}
