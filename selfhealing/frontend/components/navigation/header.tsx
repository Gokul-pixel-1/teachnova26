'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/ui/icon'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Dropdown } from '@/components/ui/dropdown'
import { useAuth } from '@/components/auth/auth-provider'

interface HeaderProps {
  onMenuClick: () => void
}

export function Header({ onMenuClick }: HeaderProps) {
  const router = useRouter()
  const { user, logout } = useAuth()

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-bh-line bg-bh-surface/90 px-4 backdrop-blur sm:px-6">
      <button
        onClick={onMenuClick}
        aria-label="Open navigation"
        className="flex h-9 w-9 items-center justify-center rounded-md text-bh-muted hover:bg-bh-surface-2 hover:text-bh-ink lg:hidden"
      >
        <Icon name="menu" size={20} />
      </button>

      {!user && (
        <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
          <Link href="/login" data-ux-id="login-button">Log in</Link>
        </Button>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        {!user ? (
          <>
            <Button asChild variant="primary" size="sm">
              <Link href="/signup" data-ux-id="signup-button">Sign up</Link>
            </Button>
          </>
        ) : (
          <Dropdown
            menuLabel="User menu"
            align="right"
            trigger={
              <button
                className="ml-1 flex items-center gap-2 rounded-full p-1 transition-colors hover:bg-bh-surface-2"
                aria-label="Open user menu"
              >
                <Avatar
                  name={user?.name ?? 'Build'}
                  username={user?.username}
                  src={user?.avatar}
                  size={34}
                />
              </button>
            }
            items={[
              { id: 'profile', label: 'Your profile', icon: 'user' },
              { id: 'settings', label: 'Settings', icon: 'settings' },
              { id: 'divider1', divider: true },
              { id: 'logout', label: 'Log out', icon: 'logout', danger: true },
            ]}
            onSelect={(id) => {
              if (id === 'profile' && user) router.push(`/profile/${user.username}`)
              if (id === 'settings') router.push('/settings')
              if (id === 'logout') {
                void logout().then(() => router.push('/'))
              }
            }}
          />
        )}
      </div>
    </header>
  )
}