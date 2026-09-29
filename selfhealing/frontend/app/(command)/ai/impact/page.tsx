import type { Metadata } from 'next'
import { ImpactClient } from '@/components/command/impact-client'

export const metadata: Metadata = {
  title: 'Command Center — Business Impact',
  description: 'Money, downtime and engineer hours saved by BuildHub self-healing.',
}

export default function AiImpactPage() {
  return (
    <div className="mx-auto w-full max-w-7xl">
      <ImpactClient />
    </div>
  )
}
