import type { Metadata } from 'next'
import { IncidentsClient } from '@/components/command/incidents-client'

export const metadata: Metadata = {
  title: 'Command Center — History',
  description: 'BuildHub resolved and rolled-back incidents.',
}

export default function AiHistoryPage() {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <IncidentsClient
        title="History"
        hint="resolved and rolled-back incidents"
        forceStatus="RESOLVED,ROLLED_BACK,REJECTED"
      />
    </div>
  )
}