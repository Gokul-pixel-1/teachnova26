import 'server-only'

// Phase 10 — provider factory. Resolves the active AI provider.
//
// Resolution (highest priority first):
//   1. SELF_HEALING_TEST_MODE + AI_PROVIDER=test  → hermetic TEST provider
//   2. AI_PROVIDER=groq                            → Groq (REAL; requires GROQ_API_KEY)
//   3. AI_PROVIDER=ollama                          → Ollama (REAL; local)
//   4. No explicit choice:
//        GROQ_API_KEY present   → Groq (REAL)
//        otherwise              → Ollama (REAL, local-first)
//
// Normal operation therefore does NOT require a Groq key: a local Ollama server
// is the default real provider. The TEST provider is only selectable when
// explicitly enabled AND not in a production build.

import { createGroqProvider } from './providers/groq'
import { createTestProvider } from './providers/test'
import { createOllamaProvider } from './ai/ollama-provider'
import type { AIProvider, ProviderName } from './providers/types'

export function testModeEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  const flag = (process.env.SELF_HEALING_TEST_MODE ?? '').trim().toLowerCase()
  return flag === '1' || flag === 'true' || flag === 'yes'
}

export function resolveProviderName(): ProviderName {
  const env = (process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (env === 'test' && testModeEnabled()) return 'test'
  if (env === 'groq') return 'groq'
  if (env === 'ollama') return 'ollama'
  if (env === 'none' && !process.env.GROQ_API_KEY) return 'ollama'
  // No explicit choice → local-first: Groq only when a key is configured.
  if (process.env.GROQ_API_KEY) return 'groq'
  return 'ollama'
}

export function aiProviderName(): ProviderName {
  return resolveProviderName()
}

let cached: AIProvider | null = null

export function getProvider(): AIProvider {
  if (cached) return cached
  const name = resolveProviderName()
  if (name === 'test') {
    cached = createTestProvider()
  } else if (name === 'ollama') {
    cached = createOllamaProvider()
  } else {
    cached = createGroqProvider()
  }
  return cached
}

/** Test-only reset so verify scripts can switch providers per phase. */
export function resetProviderCache(): void {
  cached = null
}

export function providerConfiguredModel(): string {
  return getProvider().configuredModel()
}

export async function providerOfferedModels(): Promise<string[] | null> {
  return getProvider().probeModels()
}

export function providerModeLabel(): 'REAL' | 'TEST' {
  return getProvider().mode
}

export function providerName(): string {
  return getProvider().name
}