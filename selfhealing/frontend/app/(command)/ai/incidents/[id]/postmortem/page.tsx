import type { Metadata } from 'next'
import { PostmortemClient } from '@/components/command/postmortem-client'

interface PageProps {
  params: Promise<{ id: string }>
}

export const metadata: Metadata = {
  title: 'Command Center — Postmortem',
  description: 'Auto-generated blameless postmortem for a BuildHub incident.',
}

export default async function AiPostmortemPage({ params }: PageProps) {
  const { id } = await params
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PostmortemClient id={id} />
    </div>
  )
}
