import { NextResponse } from 'next/server'

import { getSessionUser } from '@/lib/server/auth'
import { errorResponse, handleApiError } from '@/lib/server/response'
import {
  aiProviderName,
  providerConfiguredModel,
  providerModeLabel,
  providerOfferedModels,
} from '@/lib/server/provider'
import { ollamaRuntimeStats } from '@/lib/server/ai/ollama-provider'
import { testModeEnabled } from '@/lib/server/provider'

// GET /api/ai/status — live AI runtime status for the dashboard.
// No secrets are returned: provider name, resolved model, mode, catalog
// reachability and (for Ollama) measured latency + queue depth.
export async function GET() {
  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  try {
    const name = aiProviderName()
    const model = providerConfiguredModel()
    const mode = providerModeLabel()
    const offered = await providerOfferedModels()
    const ollama = name === 'ollama' ? ollamaRuntimeStats() : null

    return NextResponse.json({
      ok: true,
      provider: name,
      mode,
      model,
      available: offered === null ? null : offered.includes(model),
      offered,
      latencyMs: ollama?.latencyMs ?? null,
      totalCalls: ollama?.totalCalls ?? 0,
      failedCalls: ollama?.failedCalls ?? 0,
      queueDepth: ollama?.queueLength ?? 0,
      testMode: testModeEnabled(),
    })
  } catch (err) {
    return handleApiError(err)
  }
}