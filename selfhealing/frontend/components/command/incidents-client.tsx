'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { fetchIncidents } from '@/lib/api/observability'
import type { IncidentDTO } from '@/lib/api/observability'
import { useAsync } from '@/lib/hooks'
import {
  EmptyState,
  ErrorState,
  LoadingState,
  relativeTime,
  severityTone,
  statusTone,
} from './ui'

const PRESETS: Array<{ key: string; label: string; status?: string; severity?: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active', status: 'DETECTED,INVESTIGATING,AWAITING_REVIEW' },
  { key: 'resolved', label: 'Resolved', status: 'RESOLVED' },
  { key: 'rolled-back', label: 'Rolled back', status: 'ROLLED_BACK' },
  { key: 'rejected', label: 'Rejected', status: 'REJECTED' },
]

const SEVERITY_OPTIONS = ['', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

export function IncidentsClient({
  title = 'Incidents',
  hint = 'investigations across the platform',
  initialStatus,
  forceStatus,
}: {
  title?: string
  hint?: string
  initialStatus?: string
  /** Locks the status filter (used by History). */
  forceStatus?: string
}) {
  const [preset, setPreset] = useState(initialStatus ? PRESETS.find((p) => p.key === 'all')! : PRESETS[0])
  const [severity, setSeverity] = useState('')
  const [page, setPage] = useState(1)

  const statusValue = forceStatus ?? preset.status

  const fetcher = useCallback(() => {
    return fetchIncidents({
      status: statusValue,
      severity: severity || undefined,
      page,
      pageSize: 12,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset.key, severity, page, statusValue])

  const { data, loading, error, refetch } = useAsync(fetcher)

  const changePreset = (presetKey: string) => {
    const next = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[0]
    setPreset(next)
    setPage(1)
  }

  const severityTabsVisible = !forceStatus

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-bh-accent-ink">
            Mission Control
          </p>
          <h1 className="mt-1.5 text-3xl font-bold tracking-tight text-bh-ink sm:text-4xl">{title}</h1>
          <p className="mt-1 text-sm text-bh-muted">{hint}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {!forceStatus && (
          <div className="flex flex-wrap items-center gap-1 rounded-lg border border-bh-line bg-bh-surface p-1">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => changePreset(p.key)}
                aria-pressed={preset.key === p.key}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                  preset.key === p.key
                    ? 'bg-bh-accent-soft text-bh-accent-ink'
                    : 'text-bh-muted hover:text-bh-ink',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
        {severityTabsVisible && (
          <label className="flex items-center gap-2 text-xs text-bh-muted">
            Severity
            <select
              value={severity}
              onChange={(e) => {
                setSeverity(e.target.value)
                setPage(1)
              }}
              className="rounded-md border border-bh-line bg-bh-surface px-2.5 py-1.5 text-xs text-bh-ink"
            >
              {SEVERITY_OPTIONS.map((s) => (
                <option key={s || 'all'} value={s}>
                  {s || 'All'}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {loading && !data ? <LoadingState label="Loading incidents…" /> : null}
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : null}
      {data && data.incidents.length === 0 ? (
        <div className="rounded-lg border border-bh-line bg-bh-surface">
          <EmptyState
            icon="bug"
            title="No incidents"
            message="No incidents match the current filters."
          />
        </div>
      ) : null}

      {data && data.incidents.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-bh-line bg-bh-surface">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-bh-line text-[11px] uppercase tracking-wider text-bh-faint">
                  <th className="px-4 py-3 font-medium">Ref</th>
                  <th className="px-4 py-3 font-medium">Incident</th>
                  <th className="px-4 py-3 font-medium">Severity</th>
                  <th className="px-4 py-3 font-medium">Risk</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Age</th>
                  <th className="px-4 py-3 font-medium">Logs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bh-line/60">
                {data.incidents.map((incident) => (
                  <Row key={incident.id} incident={incident} />
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={data.pagination.page}
            totalPages={data.pagination.totalPages}
            total={data.pagination.total}
            onPage={setPage}
          />
        </div>
      ) : null}
    </div>
  )
}

function Row({ incident }: { incident: IncidentDTO }) {
  return (
    <tr className="transition-colors hover:bg-bh-surface-2/60">
      <td className="px-4 py-3">
        <Link
          href={`/ai/incidents/${incident.id}`}
          className="font-mono text-xs font-semibold text-bh-accent-ink hover:underline"
        >
          {incident.ref}
        </Link>
      </td>
      <td className="max-w-xs px-4 py-3">
        <Link
          href={`/ai/incidents/${incident.id}`}
          className="block font-medium text-bh-ink hover:underline"
        >
          {incident.title}
        </Link>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-bh-faint">
          {incident.method} {incident.endpoint}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className={cn('font-mono text-xs font-semibold', severityTone(incident.severity))}>
          {incident.severity}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-bh-muted">{incident.riskScore}</td>
      <td className="px-4 py-3">
        <span className={cn('text-xs font-medium', statusTone(incident.status))}>
          {incident.status}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-bh-muted">{relativeTime(incident.createdAt)}</td>
      <td className="px-4 py-3 font-mono text-xs text-bh-faint">{incident.logCount}</td>
    </tr>
  )
}

function Pagination({
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
        {total} incident{total === 1 ? '' : 's'} · page {page} / {totalPages}
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