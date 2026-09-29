import type { Metadata } from 'next'
import { StatusPageClient } from '@/components/status/status-page-client'

export const metadata: Metadata = {
  title: 'System Status',
  description: 'Live status of BuildHub services, kept up to date automatically by BuildHub AI.',
}

// Public (no login) customer status page.
export default function StatusPage() {
  return <StatusPageClient />
}
