'use client'

import { useCallback, useEffect, useState } from 'react'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { fetchLogs } from '@/lib/api/observability'
import type { LogEventDTO } from '@/lib/api/observability'
import { useAsync } from '@/lib/hooks'
import { EmptyState, ErrorState, LoadingState, fullStamp, levelTone } from './ui'

const LEVEL_FILTERS = ['', 'INFO', 'WARN', 'ERROR', 'SECURITY']
const FROM_FILTERS = [
  ['', 'Any time'],
  ['1h', 'Last hour'],
  ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
]
const POLL_INTERVAL_MS = 5000

export function LogsClient() {
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [level, setLevel] = useState('')
  const [service, setService] = useState('')
  const [route, setRoute] = useState('')
  const [status, setStatus] = useState('')
  const [from, setFrom] = useState('')
  const [page, setPage] = useState(1)

  const fetcher = useCallback(
    () =>
      fetchLogs({
        q: query || undefined,
        level: level || undefined,
        service: service || undefined,
        route: route || undefined,
        status: status || undefined,
        from: from || undefined,
        page,
        pageSize: 25,
      }),
    [query, level, service, route, status, from, page],
  )

  const { data, loading, error, refetch } = useAsync(fetcher)

  useEffect(() => {
    const id = setInterval(() => refetch(), POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [refetch])

  const applySearch = () => {
    setQuery(draft.trim())
    setPage(1)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-bh-accent-ink">
            Mission Control
          </p>
          <h1 className="mt-1.5 text-3xl font-bold tracking-tight text-bh-ink sm:text-4xl">Live Logs</h1>
          <p className="mt-1 text-sm text-bh-muted">
            structured observability stream · request IDs correlate end-to-end
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 gap-2 rounded-lg border border-bh-line bg-bh-surface p-3 sm:grid-cols-2 lg:grid-cols-7">
        <label className="flex items-center gap-2 sm:col-span-2 lg:col-span-2">
          <span className="sr-only">Search message text</span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applySearch()
            }}
            placeholder="Search message text…"
            className="h-9 w-full rounded-md border border-bh-line bg-bh-surface-2 px-3 text-sm text-bh-ink placeholder:text-bh-faint"
          />
          <button
            onClick={applySearch}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-bh-surface-2 px-3 text-sm text-bh-muted hover:text-bh-ink"
            aria-label="Apply search"
          >
            <Icon name="search" size={15} />
          </button>
        </label>
        <label className="lg:col-span-1">
          <span className="sr-only">Level</span>
          <select
            value={level}
            onChange={(e) => {
              setLevel(e.target.value)
              setPage(1)
            }}
            className="h-9 w-full rounded-md border border-bh-line bg-bh-surface-2 px-2.5 text-sm text-bh-ink"
          >
            <option value="">Level — all</option>
            {LEVEL_FILTERS.slice(1).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="lg:col-span-1">
          <span className="sr-only">Service</span>
          <input
            value={service}
            onChange={(e) => {
              setService(e.target.value)
              setPage(1)
            }}
            placeholder="Service"
            className="h-9 w-full rounded-md border border-bh-line bg-bh-surface-2 px-2.5 text-sm text-bh-ink placeholder:text-bh-faint"
          />
        </label>
        <label className="lg:col-span-1">
          <span className="sr-only">Route</span>
          <input
            value={route}
            onChange={(e) => {
              setRoute(e.target.value)
              setPage(1)
            }}
            placeholder="Route"
            className="h-9 w-full rounded-md border border-bh-line bg-bh-surface-2 px-2.5 text-sm text-bh-ink placeholder:text-bh-faint"
          />
        </label>
        <div className="flex gap-2 lg:col-span-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">HTTP status</span>
            <input
              value={status}
              onChange={(e) => {
                setStatus(e.target.value.replace(/[^0-9]/g, ''))
                setPage(1)
              }}
              placeholder="Status"
              inputMode="numeric"
              className="h-9 w-full rounded-md border border-bh-line bg-bh-surface-2 px-2.5 text-sm text-bh-ink placeholder:text-bh-faint"
            />
          </label>
          <label className="min-w-0 flex-1">
            <span className="sr-only">Time window</span>
            <select
              value={from}
              onChange={(e) => {
                setFrom(e.target.value)
                setPage(1)
              }}
              className="h-9 w-full rounded-md border border-bh-line bg-bh-surface-2 px-2.5 text-sm text-bh-ink"
            >
              {FROM_FILTERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {loading && !data ? <LoadingState label="Streaming logs…" /> : null}
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : null}
      {data && data.logs.length === 0 ? (
        <div className="rounded-lg border border-bh-line bg-bh-surface">
          <EmptyState
            icon="terminal"
            title="No log events"
            message="No events match the current filters."
          />
        </div>
      ) : null}

      {data && data.logs.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-bh-line bg-bh-surface">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr className="border-b border-bh-line text-[11px] uppercase tracking-wider text-bh-faint">
                  <th className="px-4 py-3 font-medium">Time</th>
                  <th className="px-4 py-3 font-medium">Level</th>
                  <th className="px-4 py-3 font-medium">Service</th>
                  <th className="px-4 py-3 font-medium">Message</th>
                  <th className="px-4 py-3 font-medium">Route</th>
                  <th className="px-4 py-3 font-medium">ID</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bh-line/60">
                {data.logs.map((log) => (
                  <LogRow key={log.id} log={log} />
                ))}
              </tbody>
            </table>
          </div>
          <LogPagination page={page} totalPages={data.pagination.totalPages} total={data.pagination.total} onPage={setPage} />
        </div>
      ) : null}
    </div>
  )
}

function LogRow({ log }: { log: LogEventDTO }) {
  return (
    <tr className="align-top transition-colors hover:bg-bh-surface-2/50">
      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[11px] text-bh-faint">
        {fullStamp(log.createdAt)}
      </td>
      <td className="px-4 py-2.5">
        <span className={cn('font-mono text-[11px] font-bold uppercase', levelTone(log.level))}>
          {log.level}
        </span>
      </td>
      <td className="px-4 py-2.5 font-mono text-[11px] text-bh-muted">{log.service}</td>
      <td className="max-w-xs px-4 py-2.5 text-xs text-bh-ink">{log.message}</td>
      <td className="px-4 py-2.5 font-mono text-[11px] text-bh-faint">
        {log.method ? `${log.method} ` : ''}
        {log.route ?? '—'}
        {log.status ? ` · ${log.status}` : ''}
      </td>
      <td className="px-4 py-2.5">
        {log.incidentRef ? (
          <span className="font-mono text-[11px] text-bh-accent-ink">{log.incidentRef}</span>
        ) : (
          <span className="block max-w-[120px] truncate font-mono text-[10px] text-bh-faint" title={log.requestId ?? ''}>
            {log.requestId ?? '—'}
          </span>
        )}
      </td>
    </tr>
  )
}

function LogPagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number
  totalPages: number
  total: number
  onPage: (page: number) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-bh-line px-4 py-3">
      <p className="text-xs text-bh-faint">
        {total} event{total === 1 ? '' : 's'} · page {page} / {totalPages}
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="flex h-8 items-center gap-1 rounded-md border border-bh-line px-2.5 text-xs text-bh-muted disabled:opacity-40"
        >
          <Icon name="arrowLeft" size={13} /> Prev
        </button>
        <button
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          disabled={page >= totalPages}
          className="flex h-8 items-center gap-1 rounded-md border border-bh-line px-2.5 text-xs text-bh-muted disabled:opacity-40"
        >
          Next <Icon name="arrowRight" size={13} />
        </button>
      </div>
    </div>
  )
}