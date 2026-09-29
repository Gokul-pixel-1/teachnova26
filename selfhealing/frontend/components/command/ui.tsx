'use client'

import { cn } from '@/lib/cn'
import { timeAgo } from '@/lib/format'
import { Icon, type IconName } from '@/components/ui/icon'
import type {
  AgentStatus,
  IncidentSeverity,
  IncidentStatus,
  LogLevel,
} from '@/lib/api/observability'

export function relativeTime(iso: string): string {
  return timeAgo(iso)
}

export function fullStamp(iso: string): string {
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// ---------------------------------------------------------------------------
// Status colour helpers (never used as the ONLY signal — always paired with
// text labels, per accessibility rules)
// ---------------------------------------------------------------------------

export function statusTone(status: IncidentStatus) {
  switch (status) {
    case 'RESOLVED':
      return 'text-bh-success'
    case 'ROLLED_BACK':
    case 'REJECTED':
      return 'text-bh-warning'
    case 'AWAITING_REVIEW':
      return 'text-bh-info'
    case 'INVESTIGATING':
      return 'text-bh-warning'
    default:
      return 'text-bh-danger'
  }
}

export function severityTone(severity: IncidentSeverity) {
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return 'text-bh-danger'
    case 'MEDIUM':
      return 'text-bh-warning'
    default:
      return 'text-bh-success'
  }
}

export function levelTone(level: LogLevel) {
  switch (level) {
    case 'ERROR':
    case 'SECURITY':
      return 'text-bh-danger'
    case 'WARN':
      return 'text-bh-warning'
    default:
      return 'text-bh-info'
  }
}

export function agentStatusTone(status: AgentStatus) {
  switch (status) {
    case 'COMPLETE':
      return 'text-bh-success'
    case 'REJECTED':
    case 'FAILED':
      return 'text-bh-danger'
    case 'ANALYZING':
    case 'GENERATING':
    case 'REVIEWING':
      return 'text-bh-accent-ink'
    default:
      return 'text-bh-muted'
  }
}

export function riskColor(score: number): string {
  if (score >= 60) return 'var(--bh-danger)'
  if (score >= 30) return 'var(--bh-warning)'
  return 'var(--bh-success)'
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

export function Card({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'bh-card rounded-2xl border border-bh-line bg-bh-surface/80 shadow-lg shadow-black/20 backdrop-blur-sm',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function PageHeader({
  eyebrow = 'Mission Control',
  title,
  description,
  actions,
}: {
  eyebrow?: string
  title: string
  description?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-bh-accent-ink">{eyebrow}</p>
        <h1 className="mt-1.5 text-3xl font-bold tracking-tight text-bh-ink sm:text-4xl">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-base leading-relaxed text-bh-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  )
}

export function CardHeader({
  icon,
  title,
  hint,
  extra,
}: {
  icon?: IconName
  title: string
  hint?: string
  extra?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-bh-line px-5 py-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bh-accent-soft text-bh-accent-ink">
            <Icon name={icon} size={18} />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-bh-ink">{title}</h2>
          {hint && <p className="text-sm text-bh-muted">{hint}</p>}
        </div>
      </div>
      {extra}
    </div>
  )
}

export function StatusDot({
  className,
  label,
}: {
  className?: string
  label?: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5" role="img" aria-label={label}>
      <span className={cn('h-2 w-2 rounded-full', className)} aria-hidden="true" />
    </span>
  )
}

export function Pill({
  tone,
  children,
  className,
}: {
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
  children: React.ReactNode
  className?: string
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-bh-surface-2 text-bh-muted border-bh-line',
    accent: 'bg-bh-accent-soft text-bh-accent-ink border-bh-line',
    success: 'bg-bh-success/10 text-bh-success border-bh-success/20',
    warning: 'bg-bh-warning/10 text-bh-warning border-bh-warning/20',
    danger: 'bg-bh-danger/10 text-bh-danger border-bh-danger/20',
    info: 'bg-bh-info/10 text-bh-info border-bh-info/20',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function ProgressBar({
  value,
  tone,
  className,
}: {
  value: number
  tone?: 'accent' | 'success' | 'warning' | 'danger'
  className?: string
}) {
  const tones: Record<string, string> = {
    accent: 'bg-bh-accent',
    success: 'bg-bh-success',
    warning: 'bg-bh-warning',
    danger: 'bg-bh-danger',
  }
  return (
    <div
      className={cn('h-2 w-full overflow-hidden rounded-full bg-bh-surface-2', className)}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${value}%`}
    >
      <div
        className={cn('h-full rounded-full transition-all', tones[tone ?? 'accent'])}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}

export function StatCard({
  label,
  value,
  sub,
  accent,
  icon,
}: {
  label: string
  value: React.ReactNode
  sub?: string
  accent?: string
  icon?: IconName
}) {
  return (
    <Card className="bh-card-hover p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-bh-muted">{label}</p>
          <p
            className="mt-2 text-3xl font-bold tabular-nums tracking-tight"
            style={accent ? { color: accent } : undefined}
          >
            {value}
          </p>
          {sub && <p className="mt-1.5 line-clamp-2 text-sm text-bh-muted">{sub}</p>}
        </div>
        {icon && (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bh-accent-soft text-bh-accent-ink">
            <Icon name={icon} size={20} />
          </span>
        )}
      </div>
    </Card>
  )
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-base text-bh-muted" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-bh-line-strong border-t-bh-accent" />
      {label}
    </div>
  )
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-lg border border-bh-danger/30 bg-bh-danger/5 p-4 text-sm text-bh-danger"
      role="alert"
    >
      <p className="font-medium">Failed to load data</p>
      <p className="text-bh-muted">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded border border-bh-danger/40 px-3 py-1 text-xs font-medium hover:bg-bh-danger/10"
        >
          Retry
        </button>
      )}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  message,
}: {
  icon: IconName
  title: string
  message: string
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-4 py-14 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bh-surface-2 text-bh-faint">
        <Icon name={icon} size={26} />
      </span>
      <p className="text-base font-semibold text-bh-ink">{title}</p>
      <p className="max-w-md text-sm text-bh-muted">{message}</p>
    </div>
  )
}

export function DetailGrid({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wider text-bh-faint">{label}</dt>
          <dd className="mt-1 truncate font-mono text-sm text-bh-ink" title={String(value ?? '')}>
            {value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function LiveBadge() {
  return (
    <Pill tone="success" className="uppercase tracking-wider">
      <Icon name="activity" size={12} />
      Live · Real
    </Pill>
  )
}