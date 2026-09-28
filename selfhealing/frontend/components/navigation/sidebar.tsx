'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'
import { isActive, mainNav, footerNav } from '@/lib/nav'
import { Icon } from '@/components/ui/icon'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/components/auth/auth-provider'

export function Sidebar() {
  const pathname = usePathname()
  const { user } = useAuth()
  const guest = !user

  const visibleMain = mainNav.filter((item) => !item.requiresAuth || !guest)
  const visibleFooter = footerNav.filter((item) => !item.requiresAuth || !guest)

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-bh-line bg-bh-surface lg:flex">
      <Link
        href="/"
        className="flex items-center gap-2.5 px-6 py-5"
        aria-label="BuildHub home"
      >
        <Icon name="code" size={26} className="text-bh-accent" />
        <span className="text-lg font-semibold tracking-tight text-bh-ink">
          Build<span className="text-bh-accent">Hub</span>
        </span>
      </Link>

      <nav className="mt-2 flex-1 space-y-0.5 px-3" aria-label="Main navigation">
        {visibleMain.map((item) => {
          const active = isActive(item.href, pathname)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-bh-accent-soft text-bh-accent-strong'
                  : 'text-bh-muted hover:bg-bh-surface-2 hover:text-bh-ink',
              )}
            >
              <Icon name={item.icon} size={18} />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="space-y-0.5 border-t border-bh-line p-3">
        {visibleFooter.map((item) => {
          const active = isActive(item.href, pathname)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-bh-accent-soft text-bh-accent-strong'
                  : 'text-bh-muted hover:bg-bh-surface-2 hover:text-bh-ink',
              )}
            >
              <Icon name={item.icon} size={18} />
              {item.label}
            </Link>
          )
        })}
        {guest ? (
          <div className="mt-3 space-y-2">
            <Button asChild variant="primary" size="sm" className="w-full">
              <Link href="/login" data-ux-id="sidebar-login">Log in</Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="w-full">
              <Link href="/signup" data-ux-id="sidebar-signup">Sign up</Link>
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-3 rounded-lg px-3 py-2.5">
            <Avatar name={user?.name ?? 'Build'} username={user?.username} src={user?.avatar} size={34} />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-bh-ink">{user?.name ?? '…'}</p>
              <p className="truncate text-xs text-bh-faint">@{user?.username ?? '…'}</p>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
