'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { fetchStatus, type ServiceState, type StatusReport } from '@/lib/api/business'

// Public customer status page. Refreshes itself every 15 s so customers see
// "AI repair in progress" → "Resolved" without reloading.

const REFRESH_MS = 15_000

const STATE: Record<ServiceState, { label: string; banner: string; dot: string; text: string; bg: string }> = {
  operational: {
    label: 'Operational',
    banner: 'All systems operational',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    bg: 'from-emerald-500 to-teal-500',
  },
  repairing: {
    label: 'Auto-repair in progress',
    banner: 'A problem was detected — BuildHub AI is repairing it now',
    dot: 'bg-sky-500',
    text: 'text-sky-600 dark:text-sky-400',
    bg: 'from-sky-500 to-indigo-500',
  },
  awaiting: {
    label: 'Fix ready, awaiting approval',
    banner: 'A fix is ready and waiting for an engineer to approve it',
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'from-amber-500 to-orange-500',
  },
  investigating: {
    label: 'Engineers investigating',
    banner: 'Some services are degraded — engineers are investigating',
    dot: 'bg-rose-500',
    text: 'text-rose-600 dark:text-rose-400',
    bg: 'from-rose-500 to-pink-500',
  },
}

function human(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m} min`
  return `${Math.round((m / 60) * 10) / 10} h`
}

function barColor(minutes: number): string {
  if (minutes <= 0) return 'bg-emerald-500'
  if (minutes < 5) return 'bg-emerald-400'
  if (minutes < 30) return 'bg-amber-400'
  return 'bg-rose-500'
}

export function StatusPageClient() {
  const [data, setData] = useState<StatusReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetchStatus()
        .then((d) => {
          if (!cancelled) {
            setData(d)
            setError(null)
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load status')
        })
    void load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const overall = data ? STATE[data.overall] : null

  return (
    <div className="min-h-screen bg-bh-bg">
      <header className="border-b border-bh-line bg-bh-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4">
          <Link href="/" className="flex items-center gap-2.5 text-lg font-bold text-bh-ink">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-bh-accent text-white">
              <Icon name="code" size={18} />
            </span>
            BuildHub <span className="font-medium text-bh-muted">Status</span>
          </Link>
          <span className="flex items-center gap-2 text-sm text-bh-muted">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
            </span>
            Live
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 px-5 py-10">
        {error && !data && (
          <p className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        )}
        {!data && !error && <p className="py-20 text-center text-lg text-bh-muted">Checking every service…</p>}

        {data && overall && (
          <>
            <section className={cn('overflow-hidden rounded-3xl bg-gradient-to-r p-[1px] shadow-xl', overall.bg)}>
              <div className={cn('rounded-3xl bg-gradient-to-r px-7 py-8 text-white', overall.bg)}>
                <div className="flex items-center gap-4">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/20">
                    <Icon name={data.overall === 'operational' ? 'check' : data.overall === 'repairing' ? 'sparkles' : 'warning'} size={28} />
                  </span>
                  <div>
                    <h1 className="text-2xl font-bold sm:text-3xl">{overall.banner}</h1>
                    <p className="mt-1 text-base text-white/85">
                      Updated {new Date(data.generatedAt).toLocaleTimeString('en-IN')} · refreshes automatically
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {[
                { label: 'Uptime (30 days)', value: `${data.stats.uptime30d.toFixed(2)}%` },
                {
                  label: 'Typical recovery time',
                  value: data.stats.medianRecoverySeconds !== null ? human(data.stats.medianRecoverySeconds) : '—',
                },
                {
                  label: 'Fixed automatically',
                  value: `${data.stats.autoFixed30d} of ${data.stats.incidents30d}`,
                },
              ].map((s) => (
                <div key={s.label} className="rounded-2xl border border-bh-line bg-bh-surface p-5 shadow-sm">
                  <p className="text-sm font-medium text-bh-muted">{s.label}</p>
                  <p className="mt-2 text-3xl font-bold tabular-nums text-bh-ink">{s.value}</p>
                </div>
              ))}
            </section>

            <section className="rounded-2xl border border-bh-line bg-bh-surface shadow-sm">
              <div className="flex items-center justify-between border-b border-bh-line px-6 py-4">
                <h2 className="text-lg font-semibold text-bh-ink">Services</h2>
                <span className="text-sm text-bh-muted">Last 30 days</span>
              </div>
              <ul className="divide-y divide-bh-line">
                {data.services.map((svc) => {
                  const st = STATE[svc.state]
                  return (
                    <li key={svc.id} className="px-6 py-5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="text-base font-semibold text-bh-ink">{svc.label}</p>
                          <p className="text-sm text-bh-muted">{svc.description}</p>
                        </div>
                        <span className={cn('flex items-center gap-2 text-sm font-semibold', st.text)}>
                          <span className={cn('h-2.5 w-2.5 rounded-full', st.dot, svc.state !== 'operational' && 'animate-pulse')} />
                          {st.label}
                        </span>
                      </div>
                      <div className="mt-3 flex h-9 gap-[3px]" role="img" aria-label={`${svc.label} daily availability`}>
                        {svc.days.map((d) => (
                          <span
                            key={d.date}
                            title={`${new Date(d.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} — ${
                              d.downtimeMinutes > 0 ? `${d.downtimeMinutes} min disrupted` : 'no issues'
                            }`}
                            className={cn('flex-1 rounded-[3px] transition-opacity hover:opacity-70', barColor(d.downtimeMinutes))}
                          />
                        ))}
                      </div>
                      <div className="mt-1.5 flex justify-between text-xs text-bh-faint">
                        <span>30 days ago</span>
                        <span>{svc.uptime.toFixed(2)}% uptime</span>
                        <span>Today</span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>

            <section>
              <h2 className="mb-4 text-lg font-semibold text-bh-ink">Recent incidents</h2>
              {data.incidents.length === 0 ? (
                <p className="rounded-2xl border border-bh-line bg-bh-surface p-6 text-bh-muted">No incidents in the last 30 days.</p>
              ) : (
                <ol className="space-y-3">
                  {data.incidents.map((inc) => {
                    const st = inc.state === 'resolved' ? null : STATE[inc.state]
                    return (
                      <li key={inc.id} className="rounded-2xl border border-bh-line bg-bh-surface p-5 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-base font-semibold text-bh-ink">{inc.headline}</p>
                          {st ? (
                            <span className={cn('rounded-full px-3 py-1 text-sm font-semibold', st.text, 'bg-bh-surface-2')}>{st.label}</span>
                          ) : (
                            <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                              Resolved{inc.automatic ? ' automatically' : ''}
                            </span>
                          )}
                        </div>
                        <p className="mt-2 text-base text-bh-muted">{inc.resolution}</p>
                        <p className="mt-2 text-sm text-bh-faint">
                          {new Date(inc.startedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}
                          {inc.endedAt ? ` · lasted ${human(inc.durationSeconds)}` : ` · ongoing for ${human(inc.durationSeconds)}`}
                        </p>
                      </li>
                    )
                  })}
                </ol>
              )}
            </section>
          </>
        )}

        <footer className="pt-4 text-center text-sm text-bh-faint">
          Incidents on this page are detected, repaired and reported automatically by BuildHub AI.
        </footer>
      </main>
    </div>
  )
}
