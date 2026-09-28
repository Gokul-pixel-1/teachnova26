import 'server-only'

import { readRealFile, repoRelativeFile } from '@/lib/server/repair/evidence'
import { verifyCandidate } from '@/lib/server/repair/patch-engine'
import { getProvider, providerConfiguredModel, testModeEnabled } from '@/lib/server/provider'
import { buildUxReviewerMessages } from './prompts'
import type { ChatMessage } from '@/lib/server/providers/types'
import type { UxDraftInput, UxDraftResult } from './types'

// Parses a single JSON object out of a model completion, tolerating an
// optional ```json fence and a leading <think>…</think> block.
function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''),
    trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1),
  ]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/** Locates currentCode in the file: EVERY line must appear, contiguously and in
 * order (whitespace-trimmed). Returns the matched line range, or null. */
export function findAnchor(content: string, currentCode: string): { start: number; length: number } | null {
  const fileLines = content.split('\n').map((l) => l.trim())
  const cur = currentCode.split('\n').map((l) => l.trim())
  while (cur.length > 0 && cur[0] === '') cur.shift()
  while (cur.length > 0 && cur[cur.length - 1] === '') cur.pop()
  if (cur.length === 0) return null
  for (let i = 0; i + cur.length <= fileLines.length; i += 1) {
    let ok = true
    for (let j = 0; j < cur.length; j += 1) {
      if (fileLines[i + j] !== cur[j]) {
        ok = false
        break
      }
    }
    if (ok) return { start: i, length: cur.length }
  }
  return null
}

export function anchorFullyPresent(content: string, currentCode: string): boolean {
  return findAnchor(content, currentCode) !== null
}

/** Replaces exactly the anchored lines with proposedCode, keeping the proposal's
 * own relative indentation re-based onto the first matched line's indent (UI
 * restructures change line counts, so positional re-indentation would garble
 * nesting). Returns null when the anchor is not fully present. */
export function applyUxPatch(content: string, currentCode: string, proposedCode: string): string | null {
  const anchor = findAnchor(content, currentCode)
  if (!anchor) return null
  const fileLines = content.split('\n')
  const baseIndent = fileLines[anchor.start].match(/^\s*/)?.[0] ?? ''
  const prop = proposedCode.replace(/\r/g, '').split('\n')
  while (prop.length > 0 && prop[0].trim() === '') prop.shift()
  while (prop.length > 0 && prop[prop.length - 1].trim() === '') prop.pop()
  const minIndent = Math.min(
    ...prop.filter((l) => l.trim() !== '').map((l) => (l.match(/^[ \t]*/)?.[0].length ?? 0)),
  )
  const rebased = prop.map((l) => (l.trim() === '' ? '' : `${baseIndent}${l.slice(Number.isFinite(minIndent) ? minIndent : 0)}`))
  return [
    ...fileLines.slice(0, anchor.start),
    ...rebased,
    ...fileLines.slice(anchor.start + anchor.length),
  ].join('\n')
}

// Deterministic, offline fallback used only in TEST mode (no network call,
// no API key needed) so the suggestion flow is hermetically testable. Scans
// the real file for a common Tailwind alignment/position utility class and
// proposes flipping it toward the side users expected — a genuine, generic
// transformation, honest about failing when no such class is found.
const DIRECTIONAL_PAIRS: Array<[string, string]> = [
  ['justify-end', 'justify-start'],
  ['items-end', 'items-start'],
  ['self-end', 'self-start'],
  ['text-right', 'text-left'],
  ['ml-auto', 'mr-auto'],
  ['float-right', 'float-left'],
  ['right-0', 'left-0'],
  ['right-4', 'left-4'],
  ['right-6', 'left-6'],
]

function directionFor(input: UxDraftInput): 'left' | 'right' | 'up' | 'down' {
  if (input.direction) return input.direction
  const text = (input.instruction ?? '').toLowerCase()
  return /\bright\b/.test(text) && !/\bleft\b/.test(text) ? 'right' : 'left'
}

const norm = (code: string) => code.replace(/\s+/g, ' ').trim()

function hasToken(line: string, token: string): boolean {
  return new RegExp(`(^|[\\s"'\`])${token}($|[\\s"'\`])`).test(line)
}

/** Ordered candidate placements for the deterministic TEST-mode drafter:
 * swap an alignment class toward the expected side first, then remove the
 * spacer that pushes it away. One candidate per sandbox round. */
function deterministicCandidates(input: UxDraftInput, lines: string[]) {
  const direction = directionFor(input)
  const out: Array<{ line: number; currentCode: string; proposedCode: string; summary: string }> = []
  if (direction === 'up' || direction === 'down') return out
  const rightward = direction === 'right'
  const pairs = rightward ? DIRECTIONAL_PAIRS.map(([a, b]) => [b, a] as [string, string]) : DIRECTIONAL_PAIRS
  lines.forEach((line, i) => {
    for (const [from, to] of pairs) {
      if (hasToken(line, from)) {
        out.push({
          line: i + 1,
          currentCode: line.trim(),
          proposedCode: line.trim().split(from).join(to),
          summary: `Move ${input.component} toward the ${direction} by swapping \`${from}\` for \`${to}\`.`,
        })
      }
    }
  })
  const spacer = rightward ? 'mr-auto' : 'ml-auto'
  lines.forEach((line, i) => {
    if (hasToken(line, spacer)) {
      out.push({
        line: i + 1,
        currentCode: line.trim(),
        proposedCode: line
          .trim()
          .replace(new RegExp(`\\s*\\b${spacer}\\b`), '')
          .replace(/className="\s+/, 'className="'),
        summary: `Move ${input.component} toward the ${direction} by removing the \`${spacer}\` spacer that pushes it away.`,
      })
    }
  })
  return out
}

function deterministicDraft(input: UxDraftInput, fileContent: string): UxDraftResult {
  const tried = new Set((input.triedProposals ?? []).map(norm))
  const next = deterministicCandidates(input, fileContent.split('\n')).find((c) => !tried.has(norm(c.proposedCode)))
  if (next) return { ok: true, ...next, function: '', model: 'ux-deterministic-test' }
  return {
    ok: false,
    error: `TEST mode: no further placement to try for "${input.component}" in ${repoRelativeFile(input.file)} (${tried.size} already tried).`,
  }
}

/**
 * Drafts one UX improvement candidate for a component. In TEST mode this is
 * deterministic and offline; otherwise it calls the configured AI provider
 * (Groq) with a UX-reviewer prompt. Either way the result is structurally
 * re-checked with the existing verifyCandidate and a strict full-anchor check
 * before the caller persists it — never trusted blindly.
 */
export async function draftUxSuggestion(input: UxDraftInput): Promise<UxDraftResult> {
  const real = readRealFile(input.file)
  if (!real.ok) {
    return { ok: false, error: real.error ?? `could not read ${input.file}` }
  }

  const draft = testModeEnabled()
    ? deterministicDraft(input, real.content)
    : await realDraft(input, real.content)

  if (!draft.ok || !draft.currentCode || !draft.proposedCode) {
    return draft
  }
  return checkDraft(input, real.content, draft)
}

function checkDraft(input: UxDraftInput, content: string, draft: UxDraftResult): UxDraftResult {
  const verified = verifyCandidate({
    file: input.file,
    currentCode: draft.currentCode ?? '',
    proposedCode: draft.proposedCode ?? '',
  })
  if (!verified.ok) {
    return { ok: false, error: verified.error ?? 'candidate failed structural verification' }
  }
  if (!anchorFullyPresent(content, draft.currentCode ?? '')) {
    return { ok: false, error: 'currentCode is not an exact excerpt of the real file (the patch could not be applied).' }
  }
  if ((input.triedProposals ?? []).some((p) => norm(p) === norm(draft.proposedCode ?? ''))) {
    return { ok: false, error: 'this placement was already tested in the sandbox and was not easy for users — propose a different one.' }
  }
  if (input.uxId && content.includes(`data-ux-id="${input.uxId}"`) && !(draft.proposedCode ?? '').includes('data-ux-id') && (draft.currentCode ?? '').includes('data-ux-id')) {
    return { ok: false, error: 'proposedCode dropped the data-ux-id marker (behaviour tracking would break).' }
  }
  return draft
}

async function realDraft(input: UxDraftInput, fileContent: string): Promise<UxDraftResult> {
  const provider = getProvider()
  const model = providerConfiguredModel()
  const messages: ChatMessage[] = buildUxReviewerMessages(input, fileContent)
  let lastError = 'AI provider returned no usable draft.'

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await provider.call({
      model,
      messages,
      maxTokens: 1500,
      // Later sandbox rounds need a genuinely different idea: allow more variety.
      temperature: (input.attempt ?? 0) > 0 ? 0.6 : 0.2,
      context: { role: 'CODER', round: attempt },
    })
    if (!response.ok || !response.content) {
      return { ok: false, error: response.error ?? 'AI provider returned no content.' }
    }
    const parsed = parseJsonObject(response.content)
    const currentCode = typeof parsed?.currentCode === 'string' ? parsed.currentCode : ''
    const proposedCode = typeof parsed?.proposedCode === 'string' ? parsed.proposedCode : ''
    const draft: UxDraftResult = {
      ok: true,
      summary: typeof parsed?.summary === 'string' ? parsed.summary : `Suggested change to ${input.component}`,
      line: typeof parsed?.line === 'number' ? parsed.line : null,
      function: typeof parsed?.function === 'string' ? parsed.function : '',
      currentCode,
      proposedCode,
      model,
    }
    const checked = parsed && currentCode && proposedCode
      ? checkDraft(input, fileContent, draft)
      : { ok: false, error: 'AI response was not a JSON object with currentCode/proposedCode.' }
    if (checked.ok) return checked
    lastError = checked.error ?? lastError
    // One corrective round: tell the model exactly what was wrong.
    messages.push({ role: 'assistant', content: response.content.slice(0, 4000) })
    messages.push({
      role: 'user',
      content: `That draft was rejected: ${lastError} Copy currentCode EXACTLY from the numbered file lines (without the "NNNN | " prefix), keep data-ux-id attributes, and reply with only the JSON object.`,
    })
  }
  return { ok: false, error: lastError }
}
