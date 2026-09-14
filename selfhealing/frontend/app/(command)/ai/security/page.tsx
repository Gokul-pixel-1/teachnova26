import type { Metadata } from 'next'
import { SecurityClient } from '@/components/command/security-client'

export const metadata: Metadata = {
  title: 'Command Center — Security',
  description: 'BuildHub live security posture: findings, incidents and the real AI self-healing pipeline.',
}

export default function AiSecurityPage() {
  return (
    <div className="relative mx-auto w-full max-w-6xl">
      <SecurityClient />
    </div>
  )
}