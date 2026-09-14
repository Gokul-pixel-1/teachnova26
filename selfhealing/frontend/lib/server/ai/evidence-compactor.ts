import 'server-only'

// Phase 11 — deterministic prompt-size control for the repair engine.
//
// The small on-demand Groq tier caps INPUT tokens per request (ITPM ~7000 for
// input). The pipeline therefore enforces a hard per-agent budget BEFORE every
// LLM call, and on an HTTP 413 the SAME agent is retried once with a reduced
// context (never a new incident, never a recursive restart). Truncation is
// deterministic and prioritised — never truncated: the exact error message, the
// affected file/function hint, or (for the Coder) the exact source lines the
// patch must quote.

import type { ChatMessage } from '@/lib/server/providers/types'

export type HeaderRole = 'ANALYZER' | 'CODER' | 'CRITIC' | 'JUDGE'

/** Hard input budget (estimated tokens) per agent, before any Groq request.
 * Every value keeps WIDE headroom below Groq's ~7000 input-token cap: the
 * estimator is conservative and dense code tokenizes heavier than prose, so
 * budgets sit at roughly half the provider limit. Near-budget prompts compact
 * a level before sending and an HTTP 413 triggers one same-agent retry with a
 * further-compacted context. */
export const ROLE_TOKEN_BUDGET: Record<HeaderRole, number> = {
  ANALYZER: 3200,
  CODER: 3500,
  CRITIC: 2800,
  JUDGE: 2500,
}

/** Conservative deterministic token estimate: ~1 token per 3.5 chars plus a
 * small per-message JSON overhead. Code and stack traces tokenize denser than
 * prose, so this deliberately over-estimates versus chars/4 — pre-flight
 * sizing then compacts earlier rather than risking a provider 413. Stable
 * across calls (no hashing, no sampling) so pre-flight sizing and
 * post-failure compaction always agree. */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const message of messages) chars += message.content.length
  return Math.max(1, Math.round(chars / 3.5) + messages.length * 8)
}

export function estimateTextTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 3.5) + 8)
}

/** A provider failure that means the prompt was too big to send — the only
 * kind the conversation engine may recover from by compacting + retrying once.
 * Rate-limit / per-minute quota errors (429, OTPM/TPM, "per minute") are
 * EXCLUDED: compacting cannot fix a quota rejection and would only mislabel
 * it — those are retried with backoff by the provider itself. */
export function isContextSizeFailure(error: string | null | undefined): boolean {
  const text = error ?? ''
  if (/per minute|output token|rate limit|quota|OTPM|TPM/i.test(text)) return false
  return /413|too many input tokens|context length|maximum context|token limit|input token|input_tokens/i.test(
    text,
  )
}