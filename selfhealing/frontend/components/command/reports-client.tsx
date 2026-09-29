'use client'

import { useCallback, useState } from 'react'
import Link from 'next/link'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { downloadIncidentReport, fetchIncidents } from '@/lib/api/observability'
import type { IncidentDTO } from '@/lib/api/observability'
import { useAsync } from '@/lib/hooks'
import { EmptyState, ErrorState, LoadingState, Pill, severityTone, statusTone } from './ui'

export function ReportsClient() {
  const [generating, setGenerating] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const fetcher = useCallback(() => fetchIncidents({ pageSize: 100 }), [])
  const { data, loading, error, refetch } = useAsync(fetcher)

  const generate = async (incident: IncidentDTO) => {
    setGenerating(incident.id)
    setNotice(null)
    try {
      const filename = await downloadIncidentReport(incident.id)
      setNotice(`Report downloaded as ${filename}.`)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not generate report.')
    } finally {
      setGenerating(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-bh-accent-ink">
            Mission Control
          </p>
          <h1 className="mt-1.5 text-3xl font-bold tracking-tight text-bh-ink sm:text-4xl">Reports</h1>
          <p className="mt-1 text-sm text-bh-muted">
            one-click PDF incident reports — observed facts + real pipeline analysis
          </p>
        </div>
      </div>

      {notice && (
        <p
          className="flex items-center gap-2 rounded-lg border border-bh-accent/30 bg-bh-accent-soft/40 px-3.5 py-2.5 text-xs text-bh-accent-ink"
          role="status"
        >
          <Icon name="check" size={14} /> {notice}
        </p>
      )}

      <div className="rounded-lg border border-bh-line bg-bh-surface p-4">
        <p className="text-sm font-medium text-bh-ink">What every report contains</p>
        <ul className="mt-2 grid grid-cols-1 gap-1.5 text-xs text-bh-muted sm:grid-cols-2">
          {[
            'Executive summary & observed context',
            'Timeline and related log events',
            'Risk score and cyber-safety impact',
            'AI pipeline status (real Groq run)',
            'Previous similar incidents',
            'Human approval history & current status',
          ].map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Icon name="document" size={13} className="shrink-0 text-bh-accent-ink" />
              {item}
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-bh-line pt-3 text-[11px] leading-relaxed text-bh-faint">
          OBSERVED FACTS and REAL AI ANALYSIS (Groq-backed, with failures surfaced as AI
          ANALYSIS UNAVAILABLE) are clearly separated in the generated document. Reports
          are served as application/pdf and never contain credentials, session data or
          secrets.
        </p>
      </div>

      {loading && !data ? <LoadingState label="Loading reports…" /> : null}
      {error && !data ? <ErrorState message={error} onRetry={refetch} /> : null}
      {data && data.incidents.length === 0 ? (
        <div className="rounded-lg border border-bh-line bg-bh-surface">
          <EmptyState icon="file" title="No reports" message="There are no incidents to report." />
        </div>
      ) : null}

      {data && data.incidents.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-bh-line bg-bh-surface">
          <ul className="divide-y divide-bh-line/60">
            {data.incidents.map((incident) => (
              <li key={incident.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/ai/incidents/${incident.id}`}
                    className="block font-medium text-bh-ink hover:underline"
                  >
                    <span className="mr-2 font-mono text-xs font-semibold text-bh-accent-ink">
                      {incident.ref}
                    </span>
                    {incident.title}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className={cn('font-mono text-xs font-semibold', severityTone(incident.severity))}>
                      {incident.severity}
                    </span>
                    <span className={cn('text-xs', statusTone(incident.status))}>
                      {incident.status}
                    </span>
                    <Pill tone="neutral" className="font-mono">
                      {incident.method} {incident.endpoint}
                    </Pill>
                  </div>
                </div>
                <button
                  onClick={() => void generate(incident)}
                  disabled={generating === incident.id}
                  className="flex h-9 items-center gap-2 rounded-md bg-bh-accent px-3.5 text-sm font-medium text-white hover:bg-bh-accent-strong disabled:opacity-60"
                >
                  {generating === incident.id ? (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                  ) : (
                    <Icon name="download" size={15} />
                  )}
                  {generating === incident.id ? 'Generating…' : 'Download PDF'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}