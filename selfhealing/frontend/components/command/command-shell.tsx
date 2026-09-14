'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { cn } from '@/lib/cn'
import { Icon, type IconName } from '@/components/ui/icon'
import { fetchSummary } from '@/lib/api/observability'
import { fetchSecurityStatus } from '@/lib/api/security'
import type { SafeUser } from '@/lib/server/auth'

type SafeUserShape = Pick<SafeUser, 'name' | 'username'>

const NAV: Array<{ href: string; label: string; icon: IconName; exact?: boolean }> = [
  { href: '/ai', label: 'Overview', icon: 'grid', exact: true },
  { href: '/ai/security', label: 'Security', icon: 'radar' },
  { href: '/ai/incidents', label: 'Incidents', icon: 'bug' },
  { href: '/ai/logs', label: 'Live Logs', icon: 'terminal' },
  { href: '/ai/pipeline', label: 'AI Pipeline', icon: 'gitBranch' },
  { href: '/ai/history', label: 'History', icon: 'history' },
  { href: '/ai/learning', label: 'Learning', icon: 'activity' },
  { href: '/ai/reports', label: 'Reports', icon: 'file' },
]

function ShellStatus({ className }: { className?: string }) {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof fetchSummary>> | null>(null)
  const [security, setSecurity] = useState<Awaited<ReturnType<typeof fetchSecurityStatus>> | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchSummary()
      .then((data) => {
        if (!cancelled) setSummary(data)
      })
      .catch(() => {
        // The Overview page reports errors; the shell stays quiet.
      })
    void fetchSecurityStatus()
      .then((data) => {
        if (!cancelled) setSecurity(data)
      })
      .catch(() => {
        // Status endpoint errors surface on the Security page, not the shell.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const hasUnavailable = summary?.components.some((c) => c.status === 'unavailable') ?? false
  const hasDegraded = summary?.components.some((c) => c.status === 'degraded') ?? false
  const protectedUp =
    (summary?.overview.cyberSafetyScore ?? 100) >= 80 && !hasUnavailable
  const aiOnline = security?.model.valid === true
  const aiKnown = security !== null && security.model.valid !== null
  const aiProvider = security?.model.provider ?? 'ai'
  const aiProviderLabel =
    aiProvider === 'groq' ? 'Groq' : aiProvider === 'ollama' ? 'Ollama' : aiProvider === 'test' ? 'Test' : 'AI'
  const aiText = aiOnline
    ? 'Online'
    : security === null
      ? '…'
      : aiKnown
        ? 'Model invalid'
        : 'Unavailable'
  const aiClass = aiOnline
    ? 'text-bh-success'
    : security === null
      ? 'text-bh-muted'
      : 'text-bh-danger'
  const dotClass = hasUnavailable
    ? 'bg-bh-danger'
    : hasDegraded
      ? 'bg-bh-warning'
      : 'bg-bh-success'

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-2 text-xs">
        <span
          className={cn('h-2 w-2 rounded-full', dotClass)}
          aria-hidden="true"
        />
        <span className="text-bh-muted">System </span>
        <span className="font-medium text-bh-ink">
          {hasUnavailable ? 'Offline' : hasDegraded ? 'Degraded' : 'Operational'}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <Icon
          name="shield"
          size={14}
          className={protectedUp ? 'text-bh-success' : 'text-bh-danger'}
        />
        <span className="text-bh-muted">Security </span>
        <span className={cn('font-medium', protectedUp ? 'text-bh-success' : 'text-bh-danger')}>
          {protectedUp ? 'Protected' : 'Attention'}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <Icon name="sparkles" size={14} className="text-bh-accent-ink" />
        <span className="text-bh-muted">AI </span>
        <span className={cn('font-medium', aiClass)}>
          {aiProviderLabel} {aiText}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <Icon
          name="bell"
          size={14}
          className={security?.telegram.configured ? 'text-bh-success' : 'text-bh-faint'}
        />
        <span className="text-bh-muted">Telegram </span>
        <span className={cn('font-medium', security?.telegram.configured ? 'text-bh-success' : 'text-bh-faint')}>
          {security === null ? '…' : security.telegram.configured ? 'Configured' : 'Off'}
        </span>
      </div>
    </div>
  )
}

function SidebarContent({
  active,
  user,
  onNavigate,
}: {
  active: string
  user: SafeUserShape
  onNavigate?: () => void
}) {
  return (
    <div className="flex h-full flex-col gap-6 px-4 py-5">
      <Link
        href="/ai"
        onClick={onNavigate}
        className="flex items-center gap-2.5"
        aria-label="BuildHub AI Command Center home"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-bh-line bg-bh-surface-2 text-bh-accent-ink">
          <Icon name="shield" size={18} />
        </span>
        <span className="leading-tight">
          <span className="block text-sm font-bold tracking-wide text-bh-ink">
            BUILDHUB <span className="text-bh-accent-ink">AI</span>
          </span>
          <span className="block text-[11px] text-bh-faint">Command Center</span>
        </span>
      </Link>

      <nav className="flex min-w-0 flex-1 flex-col gap-0.5" aria-label="Command center">
        {NAV.map((item) => {
          const isActive = item.exact
            ? active === item.href
            : active === item.href || active.startsWith(`${item.href}/`)
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-bh-accent-soft font-medium text-bh-accent-ink'
                  : 'text-bh-muted hover:bg-bh-surface-2 hover:text-bh-ink',
              )}
            >
              <Icon name={item.icon} size={17} />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="space-y-3 border-t border-bh-line pt-4">
        <ShellStatus />
        <div className="flex items-center gap-2 text-xs text-bh-faint">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-bh-accent-soft text-bh-accent-ink">
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate">{user.username}</span>
        </div>
        <Link
          href="/"
          className="flex items-center gap-2 text-xs text-bh-muted hover:text-bh-ink"
        >
          <Icon name="arrowRight" size={14} className="rotate-180" />
          Exit to app
        </Link>
      </div>
    </div>
  )
}

export function CommandShell({
  children,
  user,
}: {
  children: React.ReactNode
  user: SafeUserShape
}) {
  const pathname = usePathname()
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className="command-theme flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-bh-line bg-bh-surface/70 backdrop-blur lg:block">
        <SidebarContent active={pathname} user={user} />
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/60 transition-opacity lg:hidden',
          drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 border-r border-bh-line bg-bh-surface transition-transform lg:hidden',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-hidden={!drawerOpen}
      >
        <SidebarContent active={pathname} user={user} onNavigate={() => setDrawerOpen(false)} />
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-60">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-bh-line bg-bh-bg/85 px-4 py-3 backdrop-blur lg:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-bh-line text-bh-muted hover:text-bh-ink"
            aria-label="Open command center navigation"
            aria-expanded={drawerOpen}
          >
            <Icon name="menu" size={18} />
          </button>
          <span className="text-sm font-bold tracking-wide text-bh-ink">
            BUILDHUB <span className="text-bh-accent-ink">AI</span>
          </span>
        </header>

        <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</main>
      </div>
    </div>
  )
}