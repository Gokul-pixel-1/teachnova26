import type { Metadata } from 'next'
import { UxSuggestionsClient } from '@/components/command/ux-suggestions-client'

export const metadata: Metadata = {
  title: 'Command Center — UX Suggestions',
  description: 'AI UX/UI improvement agent: proposed component changes, always gated by human email approval.',
}

export default function AiUxSuggestionsPage() {
  return (
    <div className="relative mx-auto w-full max-w-6xl">
      <UxSuggestionsClient />
    </div>
  )
}
