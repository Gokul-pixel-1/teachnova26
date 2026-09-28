import type { Metadata } from 'next'
import { UxLiveClient } from '@/components/command/ux-live-client'

export const metadata: Metadata = {
  title: 'Command Center — Live Sandbox',
  description: 'Watch the UX agent test its ideas in the sandbox, live.',
}

export default function AiUxLivePage() {
  return (
    <div className="relative w-full">
      <UxLiveClient />
    </div>
  )
}
