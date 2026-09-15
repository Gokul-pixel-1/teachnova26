import 'server-only'

// Phase 10 — bounded context building for local, low-RAM LLM providers.
//
// Local models (qwen2.5-coder:1.5b) have a small context window and slow
// decoding. Everything an agent sees is truncated to hard budgets so prompts
// stay responsive and memory stays flat. Truncation is explicit and honest —
// nothing is silently summarized by the model.

import type { EvidenceLog } from '@/lib/server/providers/types'

export const MAX_LOG_ROWS = 6
export const MAX_STACK_LINES = 12
export const MAX_SOURCE_CHARS = 2000
export const MAX_LOG_LINE = 300
export const MAX_MEMORY_HINTS = 2
export const MAX_MEMORY_HINT = 200

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
}

export function cappedLines(value: string, maxLines: number): string {
  const lines = value.split('\n')
  if (lines.length <= maxLines) return value
  return `${lines.slice(0, maxLines).join('\n')}\n…[${lines.length - maxLines} more lines]`
}

export function renderLogRows(logs: EvidenceLog[], max = MAX_LOG_ROWS): string[] {
  return logs.slice(0, max).map((l) => {
    const message = truncate(l.message, MAX_LOG_LINE)
    return `[${l.createdAt}] ${l.level} ${l.method ?? ''} ${l.route ?? ''} ${l.status ?? ''} ${message}${l.errorCode ? ` (${l.errorCode})` : ''}`
  })
}

export function renderStack(stackTrace: string | null): string | null {
  if (!stackTrace) return null
  return cappedLines(stackTrace, MAX_STACK_LINES)
}

export function renderSource(sourceContext: string | null): string | null {
  if (!sourceContext) return null
  return truncate(sourceContext, MAX_SOURCE_CHARS)
}

/**
 * Defect-focused source window for agent prompts. Three pivots, in order:
 *   1. a source line containing distinctive error text (the thrown message is
 *      usually quoted verbatim at the defect site — e.g. the unconditional
 *      `throw new Error('LOW-01: …')` line);
 *   2. the `>`-marked stack-frame line rendered by buildSourceWindow;
 *   3. the file head (fallback).
 * The window expands symmetrically with whole lines within maxChars and always
 * keeps the file header line. Small files are sent whole. Without this, a head
 * truncation cuts the defect off whenever it sits past the budget and the
 * Coder guesses blindly (e.g. a throw on line 59 with a 1500-char budget that
 * ends at line 42). Deterministic: no sampling, no model summarization.
 */
export function focusedSourceWindow(
  sourceContext: string | null,
  maxChars: number,
  needles: string[] = [],
): string | null {
  if (!sourceContext) return null
  if (sourceContext.length <= maxChars) return sourceContext
  const lines = sourceContext.split('\n')
  let pivot = -1
  for (const raw of needles) {
    const needle = raw.trim().toLowerCase()
    if (needle.length < 12) continue
    const idx = lines.findIndex((l, i) => i > 0 && l.toLowerCase().includes(needle))
    if (idx > 0) {
      pivot = idx
      break
    }
  }
  if (pivot === -1) {
    const marked = lines.findIndex((l) => l.startsWith('>'))
    pivot = marked === -1 ? 1 : marked
  }
  let lo = pivot
  let hi = pivot
  // Reserve room for the header + omission note so the result stays in budget.
  const budget = Math.max(200, maxChars - 120)
  const size = () => lines.slice(0, 1).concat(lines.slice(lo, hi + 1)).join('\n').length
  for (;;) {
    let grew = false
    if (lo > 1 && size() < budget) {
      const next = lines.slice(0, 1).concat(lines.slice(lo - 1, hi + 1)).join('\n').length
      if (next <= budget) {
        lo -= 1
        grew = true
      }
    }
    if (hi < lines.length - 1 && size() < budget) {
      const next = lines.slice(0, 1).concat(lines.slice(lo, hi + 2)).join('\n').length
      if (next <= budget) {
        hi += 1
        grew = true
      }
    }
    if (!grew) break
  }
  const head = lines[0]
  const window = lines.slice(lo, hi + 1)
  const omittedBefore = lo - 1
  const omittedAfter = lines.length - 1 - hi
  const note = `…[${omittedBefore} line(s) above, ${omittedAfter} line(s) below omitted — defect line kept]`
  return [head, note, ...window].join('\n')
}

/**
 * Frame-centered variant (no error-text needles). Kept for callers that only
 * have the rendered source.
 */
export function centerSourceWindow(sourceContext: string | null, maxChars: number): string | null {
  return focusedSourceWindow(sourceContext, maxChars, [])
}

export function renderMemoryHints(
  memoryHints: {
    rootCause: string
    patchSummary: string
    outcome: string
    reward?: number
    recurrenceCount?: number
    humanDecision?: string | null
    signatureMatch?: boolean
  }[],
  max = MAX_MEMORY_HINTS,
): string[] {
  return memoryHints.slice(0, max).map((m) => {
    const rc = truncate(m.rootCause, MAX_MEMORY_HINT)
    const ps = truncate(m.patchSummary, MAX_MEMORY_HINT)
    const meta: string[] = []
    if (typeof m.reward === 'number') meta.push(`reward ${m.reward >= 0 ? '+' : ''}${m.reward}`)
    if ((m.recurrenceCount ?? 0) > 0) meta.push(`error returned ${m.recurrenceCount}× after this`)
    if (m.humanDecision) meta.push(`human ${m.humanDecision}`)
    if (m.signatureMatch) meta.push('same error signature')
    const head = `- ${m.outcome}${meta.length ? ` (${meta.join(', ')})` : ''}: ${rc} -> ${ps}`
    // Failed strategies must be named honestly so the agent reasons from
    // evidence, not slogans. ROLLED_BACK means a patch was actually applied
    // and then failed real validation — a strong do-not-repeat signal.
    // AI_REPAIR_FAILED means the attempt ended BEFORE any patch was validated
    // (rejected in review, or failed early) — it is NOT evidence that the
    // strategy fails validation, so it must not be cited as such; evaluate
    // current evidence independently. Regressed "successes" are suspect.
    if (m.outcome === 'ROLLED_BACK') {
      return `${head}\n  WARNING: this prior strategy was applied and FAILED real validation (rollback followed) — do NOT repeat it; inspect the current source and propose a different fix.`
    }
    if (m.outcome === 'AI_REPAIR_FAILED') {
      return `${head}\n  NOTE: this prior attempt ended before any patch was validated (rejected in review or failed early) — this is NOT evidence the strategy fails; evaluate the current evidence independently.`
    }
    if ((m.recurrenceCount ?? 0) > 0) {
      return `${head}\n  WARNING: this fix was marked resolved but the same error returned — treat the old patch as suspect and verify the current failure independently.`
    }
    return head
  })
}