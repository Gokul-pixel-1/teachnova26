import 'server-only'

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import { draftUxSuggestion } from './draft'
import { createUxApproval } from './approval'
import { createUxApprovalTokens } from './approval-tokens'
import { sendUxSuggestionApprovalEmail } from './email'
import { approvalChannel } from '@/lib/server/jira/client'
import { openUxJiraApproval } from '@/lib/server/jira/approvals'
import { isTrackedUxId, uxComponent } from './registry'
import { sandboxEnabled } from './sandbox'
import { runSandboxTrials, type TrialOutcome, type TrialRound } from './trial'
import type { Expectation } from './simulate'
import type { UxDraftInput, UxDraftResult } from './types'
import type { UxSuggestion } from '@prisma/client'

// Orchestrates: draft → SANDBOX TRIALS (test environment, simulated users,
// retry with a different placement when not easy) → ONLY a placement that
// passed is offered for human approval by email → applied only on approval.
//
// This module never imports classifyPatchRisk (lib/server/repair/risk.ts) or
// the apply step — there is structurally no path from a drafted suggestion to
// a REAL file write except through a human approving it
// (app/api/ux/approvals/{proceed,email}/route.ts are the only callers of
// lib/server/ux/apply.ts). Sandbox trials write only into the sandbox copy.
//
// Statuses: SIMULATING → AWAITING_APPROVAL (passed) | NO_EASY_PLACEMENT
// (every tried placement failed) | SANDBOX_FAILED (test environment error);
// then APPLIED/VALIDATED/REJECTED/ROLLED_BACK/EXPIRED as before.

const OPEN_STATUSES = ['DRAFTED', 'SIMULATING', 'AWAITING_APPROVAL']
const STALE_TRIAL_MS = 20 * 60 * 1000

function approvalTtlMs(): number {
  const minutes = Number.parseInt(process.env.UX_APPROVAL_TTL_MINUTES ?? '', 10)
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60 * 1000
}

async function nextUxRef(): Promise<string> {
  const rows = await prisma.uxSuggestion.findMany({ select: { ref: true } })
  let max = 0
  for (const row of rows) {
    const match = row.ref.match(/^UX-(\d+)$/)
    if (match) max = Math.max(max, Number.parseInt(match[1], 10))
  }
  return `UX-${String(max + 1).padStart(6, '0')}`
}

/** A trial interrupted by a server restart would otherwise stay SIMULATING
 * forever and block new suggestions for that component. */
export async function expireStaleTrials(): Promise<void> {
  await prisma.uxSuggestion.updateMany({
    where: { status: 'SIMULATING', updatedAt: { lt: new Date(Date.now() - STALE_TRIAL_MS) } },
    data: { status: 'SANDBOX_FAILED', validationResult: 'The sandbox test was interrupted (server restarted). Use "Re-test in sandbox".' },
  })
}

export async function openSuggestionFor(uxId: string): Promise<UxSuggestion | null> {
  await expireStaleTrials()
  return prisma.uxSuggestion.findFirst({
    where: { uxId, status: { in: OPEN_STATUSES } },
    orderBy: { createdAt: 'desc' },
  })
}

export interface RequestUxSuggestionMeta {
  source?: 'AUTO' | 'MANUAL'
  evidence?: Prisma.InputJsonValue
  /** Real users' expected-click points, replayed by the sandbox simulation. */
  expectations?: Expectation[]
}

export interface RequestUxSuggestionResult {
  ok: boolean
  error?: string
  suggestion?: UxSuggestion
  approvalId?: string
  simulating?: boolean
  email?: { ok: boolean; error: string | null }
}

export async function requestUxSuggestion(
  input: UxDraftInput,
  operator: string,
  meta: RequestUxSuggestionMeta = {},
): Promise<RequestUxSuggestionResult> {
  const uxId = input.uxId ?? (isTrackedUxId(input.component) ? input.component : undefined)
  if (uxId) {
    const open = await openSuggestionFor(uxId)
    if (open) {
      return { ok: false, error: `${open.ref} is already in progress for ${uxId} (${open.status}).` }
    }
  }

  const draftInput: UxDraftInput = { ...input, uxId }
  let draft = await draftUxSuggestion(draftInput)
  // Free-tier AI plans cap tokens per minute: wait for the window to reset
  // instead of failing (same policy as the sandbox trial rounds).
  for (let wait = 0; wait < 2 && !draft.ok && /\b429\b|rate limit/i.test(draft.error ?? ''); wait += 1) {
    await new Promise((r) => setTimeout(r, 30_000))
    draft = await draftUxSuggestion(draftInput)
  }
  if (!draft.ok || !draft.currentCode || !draft.proposedCode) {
    return { ok: false, error: draft.error ?? 'Could not draft a UX suggestion.' }
  }

  const expectations = meta.expectations ?? []
  const evidence =
    meta.evidence && typeof meta.evidence === 'object' && !Array.isArray(meta.evidence)
      ? { ...(meta.evidence as Record<string, unknown>), expectations }
      : expectations.length > 0
        ? { expectations }
        : undefined
  const testable = sandboxEnabled() && !!uxId && !!uxComponent(uxId)

  const suggestion = await prisma.uxSuggestion.create({
    data: {
      ref: await nextUxRef(),
      status: testable ? 'SIMULATING' : 'DRAFTED',
      component: input.component,
      file: input.file,
      instruction: input.instruction?.trim() || `Improve the ${input.component} for usability.`,
      summary: draft.summary ?? null,
      line: draft.line ?? null,
      function: draft.function ?? null,
      currentCode: draft.currentCode,
      proposedCode: draft.proposedCode,
      model: draft.model ?? null,
      uxId: uxId ?? null,
      source: meta.source ?? 'MANUAL',
      evidence: (evidence as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      sandbox: testable
        ? Prisma.JsonNull
        : ({
            skipped: true,
            reason: sandboxEnabled()
              ? 'This component is not a tracked (data-ux-id) component, so the sandbox cannot locate it to test.'
              : 'Sandbox testing is disabled (UX_SANDBOX=false).',
          } as Prisma.InputJsonValue),
    },
  })

  if (!testable) {
    const offered = await offerForApproval(suggestion, operator)
    return { ok: true, suggestion: offered.suggestion, approvalId: offered.approvalId, email: offered.email }
  }

  enqueueTrial({ suggestionId: suggestion.id, input: draftInput, firstDraft: draft, expectations, operator })
  return { ok: true, suggestion, simulating: true }
}

/** Creates the approval + one-time links and emails the approver. */
async function offerForApproval(
  suggestion: UxSuggestion,
  operator: string,
): Promise<{ suggestion: UxSuggestion; approvalId: string; email: { ok: boolean; error: string | null }; jiraIssue?: string | null }> {
  const approval = await createUxApproval(suggestion.id, operator, approvalTtlMs())
  const tokens = await createUxApprovalTokens(approval.id, approval.expiresAt)
  const awaiting = await prisma.uxSuggestion.update({
    where: { id: suggestion.id },
    data: { status: 'AWAITING_APPROVAL' },
  })
  // Jira channel: the decision is a Jira card (falls back to email if Jira
  // cannot be reached, so an approval request is never silently lost).
  if (approvalChannel() === 'jira') {
    const jira = await openUxJiraApproval({ suggestion: awaiting, approvalId: approval.approvalId, expiresAt: approval.expiresAt })
    if (jira.ok) return { suggestion: awaiting, approvalId: approval.approvalId, email: { ok: true, error: null }, jiraIssue: jira.issueKey }
    const email = await sendUxSuggestionApprovalEmail(awaiting, tokens, approval.expiresAt)
    return { suggestion: awaiting, approvalId: approval.approvalId, email: { ok: email.ok, error: `Jira failed (${jira.error}); ${email.ok ? 'emailed instead' : email.error}` } }
  }
  const email = await sendUxSuggestionApprovalEmail(awaiting, tokens, approval.expiresAt)
  return { suggestion: awaiting, approvalId: approval.approvalId, email }
}

interface TrialJob {
  suggestionId: string
  input: UxDraftInput
  firstDraft: UxDraftResult | null
  expectations: Expectation[]
  previousRounds?: TrialRound[]
  operator: string
}

// One sandbox, one trial at a time (globalThis survives module duplication).
const QUEUE_KEY = '__buildhub_ux_trial_queue__'
const g = globalThis as unknown as Record<string, Promise<unknown> | undefined>

function enqueueTrial(job: TrialJob): void {
  const previous = g[QUEUE_KEY] ?? Promise.resolve()
  g[QUEUE_KEY] = previous.catch(() => undefined).then(() => runTrialJob(job)).catch(() => undefined)
}

async function runTrialJob(job: TrialJob): Promise<void> {
  const suggestion = await prisma.uxSuggestion.findUnique({ where: { id: job.suggestionId } })
  const spec = uxComponent(suggestion?.uxId)
  if (!suggestion || !spec || suggestion.status !== 'SIMULATING') return

  let outcome: TrialOutcome
  try {
    outcome = await runSandboxTrials({
      suggestionId: suggestion.id,
      ref: suggestion.ref,
      spec,
      input: job.input,
      firstDraft: job.firstDraft,
      expectations: job.expectations,
      previousRounds: job.previousRounds,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : 'sandbox error'
    await prisma.uxSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: 'SANDBOX_FAILED',
        validationResult: `Sandbox test could not run: ${message}`,
        // Keep earlier rounds so a re-test never repeats a failed placement.
        sandbox: { error: message, rounds: (job.previousRounds ?? []) as unknown as Prisma.InputJsonValue[] },
      },
    })
    await log(`UX ${suggestion.ref}: sandbox test could not run — ${message}`, 'warn')
    return
  }

  const sandbox = outcome as unknown as Prisma.InputJsonValue
  if (outcome.passed && outcome.winnerRound) {
    const winner = outcome.rounds[outcome.winnerRound - 1]
    const updated = await prisma.uxSuggestion.update({
      where: { id: suggestion.id },
      data: {
        currentCode: winner.currentCode,
        proposedCode: winner.proposedCode,
        summary: winner.summary,
        model: winner.model,
        sandbox,
        validationResult: `Passed the sandbox usability test in round ${winner.round}.`,
      },
    })
    const offered = await offerForApproval(updated, job.operator)
    await log(`UX ${suggestion.ref}: placement from round ${winner.round} passed the sandbox test → approval ${offered.approvalId} ${offered.jiraIssue ? `requested in Jira ${offered.jiraIssue}` : 'emailed'}`)
    return
  }

  const status = outcome.rounds.length === 0 && outcome.error ? 'SANDBOX_FAILED' : 'NO_EASY_PLACEMENT'
  await prisma.uxSuggestion.update({
    where: { id: suggestion.id },
    data: {
      status,
      sandbox,
      validationResult:
        status === 'SANDBOX_FAILED'
          ? `Sandbox test could not run: ${outcome.error}`
          : `No placement passed the sandbox usability test after ${outcome.rounds.length} attempt(s); the live site was not changed and no approval was requested.`,
    },
  })
  await log(`UX ${suggestion.ref}: ${status} after ${outcome.rounds.length} sandbox round(s)`)
}

/** Operator "Re-test in sandbox" for a suggestion whose test failed. */
export async function retestSuggestion(id: string, operator: string): Promise<{ ok: boolean; error?: string }> {
  const s = await prisma.uxSuggestion.findUnique({ where: { id } })
  if (!s) return { ok: false, error: 'Suggestion not found.' }
  if (!['NO_EASY_PLACEMENT', 'SANDBOX_FAILED'].includes(s.status)) {
    return { ok: false, error: `Only a suggestion whose sandbox test failed can be re-tested (this one is ${s.status}).` }
  }
  if (!sandboxEnabled() || !uxComponent(s.uxId)) return { ok: false, error: 'This suggestion cannot be tested in the sandbox.' }
  if (s.uxId) {
    const open = await openSuggestionFor(s.uxId)
    if (open && open.id !== s.id) return { ok: false, error: `${open.ref} is already in progress for ${s.uxId}.` }
  }
  const ev = (s.evidence ?? {}) as { expectations?: Expectation[]; direction?: UxDraftInput['direction']; hotspot?: UxDraftInput['hotspot'] }
  const previousRounds = ((s.sandbox as { rounds?: TrialRound[] } | null)?.rounds ?? []).filter((r) => r.proposedCode)
  // The stored proposal is the first draft; it counts as tried as well.
  if (!previousRounds.some((r) => r.proposedCode === s.proposedCode)) {
    previousRounds.unshift({
      round: 0,
      summary: s.summary ?? 'first draft',
      currentCode: s.currentCode,
      proposedCode: s.proposedCode,
      model: s.model,
      result: null,
      screenshot: null,
      error: 'tried in an earlier sandbox run that did not pass',
    })
  }
  await prisma.uxSuggestion.update({ where: { id }, data: { status: 'SIMULATING', sandbox: Prisma.JsonNull, validationResult: null } })
  enqueueTrial({
    suggestionId: id,
    input: {
      component: s.component,
      file: s.file,
      instruction: s.instruction,
      uxId: s.uxId ?? undefined,
      direction: ev.direction ?? undefined,
      hotspot: ev.hotspot ?? undefined,
      evidenceSummary: s.source === 'AUTO' ? s.instruction : undefined,
    },
    // Failed placements are passed on as "already tried": round 1 of the
    // re-test is a fresh idea, never a repeat.
    firstDraft: null,
    expectations: ev.expectations ?? [],
    previousRounds,
    operator,
  })
  return { ok: true }
}

async function log(message: string, level: 'info' | 'warn' = 'info'): Promise<void> {
  await logger[level]({ service: 'ux-sandbox', message, route: '/api/ux/suggestions', method: 'POST', status: 200 }).catch(() => undefined)
}
