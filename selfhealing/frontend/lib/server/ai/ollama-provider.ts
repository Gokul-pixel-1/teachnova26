import 'server-only'

// Phase 10 — REAL Ollama provider.
//
// A thin, honest LLM adapter over the local Ollama HTTP API
// (POST /api/chat). It serializes all inference through the FIFO queue so a
// low-RAM machine never runs concurrent model loads, applies a hard timeout,
// retries transient failures, and never fabricates success. Runtime stats
// (latency, counts, queue depth) are exposed for the /api/ai/status card.
//
// The provider never inspects or sanitizes prompt CONTENT — defense-in-depth
// (untrusted-data boundaries, strict schemas) lives in the prompt builders and
// the engine.

import { withInferenceQueue, inferenceQueueLength } from './queue'
import type {
  AIProvider,
  ChatMessage,
  ProviderCall,
  ProviderResponse,
  ProviderName,
  ModeLabel,
} from '@/lib/server/providers/types'

const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434')
  .trim()
  .replace(/\/+$/, '')
const MODEL = (process.env.AI_MODEL ?? 'qwen2.5-coder:1.5b').trim()

function intEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim()
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const TIMEOUT_MS = intEnv('OLLAMA_TIMEOUT_MS', 180_000)
const MAX_RETRIES = intEnv('OLLAMA_MAX_RETRIES', 2)
const CONTEXT_WINDOW = intEnv('OLLAMA_CONTEXT_WINDOW', 4096)
// qwen2.5-coder:1.5b is a small CPU-bound model: pin the thread count so the
// 2-core/4-thread demo host decodes at full speed instead of defaulting low.
const NUM_THREADS = intEnv('OLLAMA_NUM_THREADS', 4)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let lastLatencyMs: number | null = null
let totalCalls = 0
let failedCalls = 0

export interface OllamaRuntimeStats {
  model: string
  latencyMs: number | null
  totalCalls: number
  failedCalls: number
  queueLength: number
}

export function ollamaRuntimeStats(): OllamaRuntimeStats {
  return {
    model: MODEL,
    latencyMs: lastLatencyMs,
    totalCalls,
    failedCalls,
    queueLength: inferenceQueueLength(),
  }
}

async function chatCompletion(
  model: string,
  messages: ChatMessage[],
  req: ProviderCall,
): Promise<{ content: string; promptTokens?: number | null; completionTokens?: number | null }> {
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    format: 'json' as const,
    options: {
      temperature: req.temperature,
      num_predict: req.maxTokens,
      num_ctx: CONTEXT_WINDOW,
      num_thread: NUM_THREADS,
    },
  }

  let attempt = 0
  while (true) {
    attempt += 1
    const started = Date.now()
    try {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })

      if ((res.status === 429 || res.status >= 500) && attempt <= MAX_RETRIES) {
        await sleep(500 * attempt)
        continue
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300)}`)
      }

      const data: {
        message?: { content?: unknown }
        prompt_eval_count?: number
        eval_count?: number
      } = await res.json()

      const content = typeof data.message?.content === 'string' ? data.message.content : ''
      if (!content) {
        throw new Error('Ollama returned an empty completion.')
      }
      lastLatencyMs = Date.now() - started
      totalCalls += 1
      return {
        content,
        promptTokens: data.prompt_eval_count ?? null,
        completionTokens: data.eval_count ?? null,
      }
    } catch (err) {
      failedCalls += 1
      if (attempt <= MAX_RETRIES) {
        await sleep(1000 * attempt)
        continue
      }
      throw err
    }
  }
}

export function createOllamaProvider(): AIProvider {
  return {
    name: 'ollama' as ProviderName,
    mode: 'REAL' as ModeLabel,
    configuredModel: () => MODEL,

    async probeModels(): Promise<string[] | null> {
      try {
        const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
          signal: AbortSignal.timeout(2000),
        })
        if (!res.ok) return null
        const data: { models?: Array<{ name: string }> } = await res.json()
        return (data.models ?? []).map((m) => m.name).sort()
      } catch {
        return null
      }
    },

    async call(req: ProviderCall): Promise<ProviderResponse> {
      const model = req.model || MODEL
      return withInferenceQueue(async () => {
        try {
          const { content, promptTokens, completionTokens } = await chatCompletion(
            model,
            req.messages,
            req,
          )
          return {
            ok: true,
            status: 'COMPLETE',
            provider: 'ollama',
            mode: 'REAL',
            model,
            content,
            promptTokens: promptTokens ?? null,
            completionTokens: completionTokens ?? null,
          }
        } catch (err) {
          return {
            ok: false,
            status: 'FAILED',
            provider: 'ollama',
            mode: 'REAL',
            model,
            error: err instanceof Error ? err.message.slice(0, 400) : 'Ollama inference failed',
          }
        }
      })
    },
  }
}

export { MODEL }