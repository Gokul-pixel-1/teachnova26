import 'server-only'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Incident, UxSuggestion } from '@prisma/client'

import { prisma } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import { approveApproval, expireApproval } from '@/lib/server/approval'
import { buildIncidentBrief } from '@/lib/server/notifications/brief'
import { sendIncidentTerminalSummary } from '@/lib/server/notifications/summary'
import { sendFinalEmail } from '@/lib/server/gmail'
import { continueApprovedRepair, finalizeRejectedRepair } from '@/lib/server/repair/engine'
import { addIncidentEvent } from '@/lib/server/repair/events'
import { approveUxApproval, consumeUxApproval, expireUxApproval } from '@/lib/server/ux/approval'
import { applyUxSuggestion } from '@/lib/server/ux/apply'
import { sendUxSuggestionOutcomeEmail } from '@/lib/server/ux/email'
import {
  adf,
  addComment,
  attachFile,
  createIssue,
  getIssueState,
  jiraConfig,
  transitionTo,
  type AdfNode,
  type JiraConfig,
} from './client'

// Jira approval channel for BOTH pipelines. A decision request becomes one
// Jira issue; BuildHub polls it (this app runs on localhost, so Jira cannot
// call a webhook back) and decides the linked approval with the SAME
// functions the dashboard and the one-click email links use:
//   card moved to JIRA_APPROVE_STATUS (Done)   → approve
//   card moved to JIRA_REJECT_STATUS (To Do)   → reject
//   a comment starting with "approve"/"reject" → the same
// Only a status CHANGE counts (a card that never reached "In Review" is not
// rejected just because it was created in "To Do"). Every guard stays in the
// approval layer: a non-PENDING or expired approval is never executed.

function appBaseUrl(): string {
  return (process.env.COMMAND_CENTER_URL ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

function howToDecide(cfg: JiraConfig, expiresAt: Date, what: string): AdfNode {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60000))
  return adf.panel('warning', [
    adf.p(adf.text('HUMAN DECISION REQUIRED', ['strong'])),
    adf.bullets([
      `APPROVE: move this card to "${cfg.approveStatus}" (or comment "approve").`,
      `REJECT: move this card to "${cfg.rejectStatus}" (or comment "reject").`,
      `Nothing is ${what} until you approve. This request expires in ${minutes} minutes.`,
    ]),
  ])
}

async function logInfo(message: string, level: 'info' | 'warn' = 'info'): Promise<void> {
  await logger[level]({ service: 'jira-approval', message, route: 'jira', method: 'POLL', status: 200 }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Opening an approval issue

export interface OpenJiraResult {
  ok: boolean
  issueKey: string | null
  issueUrl: string | null
  error: string | null
}

async function openIssue(
  kind: 'REPAIR' | 'UX',
  approvalId: string,
  summary: string,
  description: AdfNode,
  labels: string[],
  after?: (cfg: JiraConfig, key: string) => Promise<void>,
): Promise<OpenJiraResult> {
  const conf = jiraConfig()
  if (!conf.ok) return { ok: false, issueKey: null, issueUrl: null, error: conf.reason }
  const cfg = conf.config
  const row = await prisma.jiraApproval.upsert({
    where: { approvalId },
    create: { kind, approvalId },
    update: { state: 'OPEN', error: null },
  })
  try {
    const issue = await createIssue(cfg, { summary, description, labels })
    await transitionTo(cfg, issue.key, cfg.waitingStatus)
    const state = await getIssueState(cfg, issue.key).catch(() => null)
    await prisma.jiraApproval.update({
      where: { id: row.id },
      data: { issueKey: issue.key, issueUrl: issue.url, lastStatus: state?.status ?? null },
    })
    if (after) await after(cfg, issue.key).catch(() => undefined)
    await logInfo(`${approvalId}: approval requested in Jira ${issue.key}`)
    return { ok: true, issueKey: issue.key, issueUrl: issue.url, error: null }
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 400) : 'Jira request failed'
    await prisma.jiraApproval.update({ where: { id: row.id }, data: { state: 'ERROR', error } })
    await logInfo(`${approvalId}: could not open a Jira approval — ${error}`, 'warn')
    return { ok: false, issueKey: null, issueUrl: null, error }
  }
}

export async function openRepairJiraApproval(args: {
  incident: Incident
  risk: 'MEDIUM' | 'HIGH'
  approvalId: string
}): Promise<OpenJiraResult> {
  const { incident, risk, approvalId } = args
  const conf = jiraConfig()
  if (!conf.ok) return { ok: false, issueKey: null, issueUrl: null, error: conf.reason }
  const [brief, approval] = await Promise.all([
    buildIncidentBrief(incident.id),
    prisma.approval.findUnique({ where: { approvalId }, select: { expiresAt: true } }),
  ])
  const judge = brief?.aiAnalysis.judge ?? null
  const rounds = brief?.aiAnalysis.rounds ?? []
  const critic = rounds.length > 0 ? rounds[rounds.length - 1].critic : null
  const loc = brief?.location
  const or = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? 'Not recorded' : String(v))
  const description = adf.doc([
    adf.panel(risk === 'HIGH' ? 'error' : 'warning', [
      adf.p(adf.text(`${risk}-risk repair needs your approval`, ['strong']), ` — ${incident.ref}: ${incident.title}`),
    ]),
    adf.h(3, '1. Incident'),
    adf.bullets([
      `What happened: ${or(brief?.incident.summary ?? incident.summary ?? incident.description)}`,
      `Endpoint: ${incident.method} ${incident.endpoint} (HTTP ${or(brief?.history?.httpStatus)})`,
      `Error: ${or(incident.errorCode ?? brief?.history?.signature)}`,
      `Detected: ${or(brief?.incident.createdAt ?? incident.createdAt.toISOString())}`,
    ]),
    adf.h(3, '2. AI root cause'),
    adf.p(or(brief?.rootCause ?? incident.expectedRootCause)),
    adf.p(`File: ${or(loc?.file)}  ·  line ${or(loc?.line)}  ·  ${or(loc?.function)}`),
    adf.h(3, '3. Proposed patch (Coder)'),
    adf.p(or(brief?.proposedFix)),
    adf.p(adf.text('Before', ['strong'])),
    adf.code(brief?.codeChange?.before ?? '', 'typescript'),
    adf.p(adf.text('After', ['strong'])),
    adf.code(brief?.codeChange?.after ?? '', 'typescript'),
    adf.h(3, '4. Critic + Judge'),
    adf.bullets([
      `Critic: ${or(critic?.verdict)} — ${or(critic?.reasoning)}`,
      `Judge: ${or(judge?.decision)} (confidence ${or(judge?.confidence)}) — ${or(judge?.reasoning ?? brief?.risk.reason)}`,
    ]),
    adf.h(3, '5. Validation and rollback'),
    adf.bullets([
      ...(judge?.validationItems ?? []),
      ...(brief?.validationPlan ? [brief.validationPlan] : []),
      `Re-run ${incident.method} ${incident.endpoint} and verify the expected success response.`,
      'If validation fails, the original file bytes are restored (SHA-256 verified) and the incident becomes ROLLED_BACK.',
    ]),
    howToDecide(conf.config, approval?.expiresAt ?? new Date(Date.now() + 30 * 60_000), 'changed in the code'),
    adf.p('Incident in BuildHub: ', adf.link(`${appBaseUrl()}/ai/incidents/${incident.id}`, `${appBaseUrl()}/ai/incidents/${incident.id}`)),
    adf.p(`Approval ${approvalId}`),
  ])
  return openIssue(
    'REPAIR',
    approvalId,
    `[BuildHub][${risk}] Repair approval ${incident.ref}: ${incident.title}`,
    description,
    ['buildhub', 'buildhub-approval', 'self-healing'],
  )
}

interface SandboxRoundLike {
  round: number
  summary: string
  error: string | null
  result: {
    easy: boolean
    foundWhereExpected: number
    simulatedUsers: number
    distanceImprovement: number | null
    reasons: string[]
  } | null
}

export async function openUxJiraApproval(args: {
  suggestion: UxSuggestion
  approvalId: string
  expiresAt: Date
}): Promise<OpenJiraResult> {
  const { suggestion, approvalId, expiresAt } = args
  const conf = jiraConfig()
  if (!conf.ok) return { ok: false, issueKey: null, issueUrl: null, error: conf.reason }
  const sb = suggestion.sandbox as { passed?: boolean; winnerRound?: number | null; simulatedUsers?: number; rounds?: SandboxRoundLike[] } | null
  const rounds = (sb?.rounds ?? []).map((r) =>
    r.error || !r.result
      ? `Round ${r.round}: ${r.summary || 'placement'} — could not be tested (${r.error ?? 'no result'})`
      : `Round ${r.round}: ${r.summary} — ${r.result.easy ? 'PASSED' : 'failed'} (${r.result.foundWhereExpected}/${r.result.simulatedUsers} simulated users found it where they looked` +
        (r.result.distanceImprovement !== null ? `, ${Math.round(r.result.distanceImprovement * 100)}% closer` : '') +
        ')' +
        (!r.result.easy && r.result.reasons.length ? ` — ${r.result.reasons.join('; ')}` : ''),
  )
  const description = adf.doc([
    adf.panel('info', [
      adf.p(adf.text(`${suggestion.ref}: UX change for "${suggestion.component}" needs your approval`, ['strong'])),
    ]),
    adf.h(3, suggestion.source === 'AUTO' ? 'Why — observed user behaviour' : 'Why — operator request'),
    adf.p(suggestion.instruction),
    adf.h(3, 'Proposed change'),
    adf.p(suggestion.summary ?? suggestion.instruction),
    adf.p(`File: ${suggestion.file}`),
    ...(sb?.passed
      ? [
          adf.h(3, 'Tested in the sandbox first'),
          adf.p(
            `Tested in a sandbox copy of BuildHub with ${sb.simulatedUsers ?? 0} simulated users (each replays where a real user clicked looking for it). ` +
              `The placement below passed in round ${sb.winnerRound}. Before/after screenshots are attached (red dots = where users looked, green box = the element).`,
          ),
          adf.bullets(rounds),
        ]
      : []),
    adf.p(adf.text('Current', ['strong'])),
    adf.code(suggestion.currentCode),
    adf.p(adf.text('Proposed', ['strong'])),
    adf.code(suggestion.proposedCode),
    howToDecide(conf.config, expiresAt, 'changed on the website'),
    adf.p('UX Suggestions in BuildHub: ', adf.link(`${appBaseUrl()}/ai/ux-suggestions`, `${appBaseUrl()}/ai/ux-suggestions`)),
    adf.p(`Approval ${approvalId}`),
  ])
  const attachScreens = async (cfg: JiraConfig, key: string) => {
    const dir = join(process.cwd(), '.data', 'ux-sandbox', suggestion.id)
    const files = ['baseline.png', sb?.winnerRound ? `round-${sb.winnerRound}.png` : ''].filter(Boolean)
    for (const f of files) {
      const path = join(dir, f)
      if (existsSync(path)) {
        await attachFile(cfg, key, `${suggestion.ref}-${f === 'baseline.png' ? 'before' : 'after'}.png`, readFileSync(path))
      }
    }
  }
  return openIssue(
    'UX',
    approvalId,
    `[BuildHub][UX] ${suggestion.ref}: move "${suggestion.component}" — approval needed`,
    description,
    ['buildhub', 'buildhub-approval', 'ux-suggestion'],
    attachScreens,
  )
}

// ---------------------------------------------------------------------------
// Deciding (shared by the poller and the tests)

export interface DecisionResult {
  ok: boolean
  outcome: string
  /** Final approval/suggestion state, for the Jira comment. */
  state: 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CLOSED'
}

async function expireRepair(approvalId: string): Promise<boolean> {
  const expired = await expireApproval(approvalId)
  if (!expired || expired.status !== 'EXPIRED') return false
  const row = await prisma.approval.findUnique({ where: { approvalId }, include: { incident: true } })
  if (!row) return true
  await prisma.incident.update({
    where: { id: row.incidentId },
    data: { status: 'AI_REPAIR_FAILED', summary: `Approval ${approvalId} expired without a decision.` },
  })
  await addIncidentEvent(row.incidentId, 'EXPIRED', 'Approval expired without decision', approvalId)
  await sendIncidentTerminalSummary(row.incident).catch(() => undefined)
  await sendFinalEmail({ incident: row.incident }).catch(() => undefined)
  return true
}

export async function decideRepair(approvalId: string, action: 'APPROVE' | 'REJECT', actor: string): Promise<DecisionResult> {
  const row = await prisma.approval.findUnique({ where: { approvalId }, include: { incident: true } })
  if (!row) return { ok: false, outcome: `Approval ${approvalId} not found.`, state: 'CLOSED' }
  if (row.status === 'PENDING' && new Date() > row.expiresAt) {
    await expireRepair(approvalId)
    return { ok: false, outcome: `Approval ${approvalId} had already expired — nothing was changed.`, state: 'EXPIRED' }
  }
  if (row.status !== 'PENDING') {
    return { ok: false, outcome: `Approval ${approvalId} is already ${row.status} — nothing was executed twice.`, state: 'CLOSED' }
  }
  if (action === 'REJECT') {
    const done = await finalizeRejectedRepair(approvalId, actor)
    return {
      ok: done.ok,
      outcome: `Repair rejected by ${actor}. No patch was applied — ${done.incidentRef ?? row.incident.ref} is ${done.status}.`,
      state: 'REJECTED',
    }
  }
  const approved = await approveApproval(approvalId)
  if (!approved) return { ok: false, outcome: `Approval ${approvalId} is no longer pending — nothing was executed twice.`, state: 'CLOSED' }
  if (!row.repairAttemptId) {
    return { ok: true, outcome: 'Approval recorded. No repair attempt is bound to it, so there is no patch to apply.', state: 'APPROVED' }
  }
  const repair = await continueApprovedRepair(approvalId, actor)
  const outcome =
    repair.stage === 'RESOLVED'
      ? `Approved by ${actor}. Patch applied and validation passed — ${repair.incidentRef} is RESOLVED.`
      : repair.stage === 'ROLLED_BACK'
        ? `Approved by ${actor}. Patch applied but validation failed, so the original code was restored — ${repair.incidentRef} is ROLLED_BACK.`
        : `Approved by ${actor}. Repair stage: ${repair.stage}.`
  return { ok: repair.ok || repair.stage === 'ROLLED_BACK', outcome, state: 'APPROVED' }
}

async function expireUx(approvalId: string): Promise<boolean> {
  const expired = await expireUxApproval(approvalId)
  if (!expired || expired.status !== 'EXPIRED') return false
  await prisma.uxSuggestion.update({ where: { id: expired.uxSuggestionId }, data: { status: 'EXPIRED' } })
  return true
}

export async function decideUx(approvalId: string, action: 'APPROVE' | 'REJECT', actor: string): Promise<DecisionResult> {
  const row = await prisma.uxApproval.findUnique({ where: { approvalId }, include: { uxSuggestion: true } })
  if (!row) return { ok: false, outcome: `Approval ${approvalId} not found.`, state: 'CLOSED' }
  const ref = row.uxSuggestion.ref
  if (row.status === 'PENDING' && new Date() > row.expiresAt) {
    await expireUx(approvalId)
    return { ok: false, outcome: `${ref}: the approval had already expired — the website was not changed.`, state: 'EXPIRED' }
  }
  if (row.status !== 'PENDING') {
    return { ok: false, outcome: `${ref}: approval is already ${row.status} — nothing was executed twice.`, state: 'CLOSED' }
  }
  if (action === 'REJECT') {
    await prisma.uxApproval.update({ where: { id: row.id }, data: { status: 'REJECTED', statusUpdatedAt: new Date() } })
    const rejected = await prisma.uxSuggestion.update({ where: { id: row.uxSuggestionId }, data: { status: 'REJECTED' } })
    // Same Gmail result notice the dashboard / email decision paths send.
    await sendUxSuggestionOutcomeEmail(rejected, 'REJECTED').catch(() => undefined)
    return { ok: true, outcome: `${ref} rejected by ${actor}. No file was changed.`, state: 'REJECTED' }
  }
  const approved = await approveUxApproval(approvalId)
  if (!approved) return { ok: false, outcome: `${ref}: approval is no longer pending — nothing was executed twice.`, state: 'CLOSED' }
  const suggestion = await prisma.uxSuggestion.findUniqueOrThrow({ where: { id: approved.uxSuggestionId } })
  const decision = await applyUxSuggestion(suggestion)
  await consumeUxApproval(approvalId)
  if (decision.ok) {
    const updated = await prisma.uxSuggestion.findUniqueOrThrow({ where: { id: suggestion.id } })
    await sendUxSuggestionOutcomeEmail(updated, 'APPLIED').catch(() => undefined)
  }
  return {
    ok: decision.ok,
    outcome: decision.ok
      ? `${ref} approved by ${actor}. The change was applied to ${suggestion.file} and the page check passed (${decision.status}).`
      : `${ref} approved by ${actor}, but applying it did not succeed (${decision.status}): ${decision.reason}`,
    state: 'APPROVED',
  }
}

// ---------------------------------------------------------------------------
// Polling

const APPROVE_WORDS = /^\s*(approve|approved)\b/i
const REJECT_WORDS = /^\s*(reject|rejected)\b/i

type ApprovalRowState = { status: string; expiresAt: Date } | null

async function approvalState(kind: string, approvalId: string): Promise<ApprovalRowState> {
  return kind === 'UX'
    ? prisma.uxApproval.findUnique({ where: { approvalId }, select: { status: true, expiresAt: true } })
    : prisma.approval.findUnique({ where: { approvalId }, select: { status: true, expiresAt: true } })
}

async function comment(cfg: JiraConfig, key: string, text: string): Promise<void> {
  await addComment(cfg, key, adf.doc([adf.p(adf.text('BuildHub: ', ['strong']), text)])).catch(() => undefined)
}

export interface PollSummary {
  checked: number
  decided: Array<{ approvalId: string; issueKey: string; state: string; outcome: string }>
  errors: string[]
}

const LOCK = '__buildhub_jira_poll_lock__'
const g = globalThis as unknown as Record<string, boolean | undefined>

/** One pass over every OPEN Jira approval. Never runs twice at once. */
export async function pollJiraApprovals(): Promise<PollSummary> {
  const summary: PollSummary = { checked: 0, decided: [], errors: [] }
  const conf = jiraConfig()
  if (!conf.ok || g[LOCK]) return summary
  const cfg = conf.config
  g[LOCK] = true
  try {
    const open = await prisma.jiraApproval.findMany({ where: { state: 'OPEN', issueKey: { not: null } }, orderBy: { createdAt: 'asc' } })
    for (const link of open) {
      const key = link.issueKey as string
      summary.checked += 1
      try {
        const approval = await approvalState(link.kind, link.approvalId)
        const decide = link.kind === 'UX' ? decideUx : decideRepair
        const close = async (state: string, outcome: string, decidedBy: string | null, moveTo: string | null) => {
          await prisma.jiraApproval.update({
            where: { id: link.id },
            data: { state, outcome, decidedBy, decidedAt: new Date() },
          })
          await comment(cfg, key, outcome)
          if (moveTo) await transitionTo(cfg, key, moveTo)
          summary.decided.push({ approvalId: link.approvalId, issueKey: key, state, outcome })
          await logInfo(`${link.approvalId} (${key}): ${outcome}`)
        }

        // Decided somewhere else (dashboard / email link) — mirror it in Jira.
        if (!approval || approval.status !== 'PENDING') {
          const s = approval?.status ?? 'MISSING'
          const moveTo = s === 'APPROVED' || s === 'CONSUMED' ? cfg.approveStatus : s === 'REJECTED' ? cfg.rejectStatus : null
          await close('CLOSED', `This approval was already decided in BuildHub (${s}); this card is closed.`, null, moveTo)
          continue
        }
        if (new Date() > approval.expiresAt) {
          const r = await decide(link.approvalId, 'REJECT', 'jira-expiry') // expires (never executes) when past expiry
          await close('EXPIRED', r.state === 'EXPIRED' ? r.outcome : 'The approval expired without a decision — nothing was changed.', null, null)
          continue
        }

        const issue = await getIssueState(cfg, key)
        let action: 'APPROVE' | 'REJECT' | null = null
        let actor = ''
        const changed = issue.status && issue.status !== link.lastStatus
        if (changed && issue.status.toLowerCase() === cfg.approveStatus.toLowerCase()) action = 'APPROVE'
        else if (changed && issue.status.toLowerCase() === cfg.rejectStatus.toLowerCase()) action = 'REJECT'
        if (action) actor = `Jira (${key} moved to "${issue.status}")`
        if (!action) {
          const since = link.createdAt.getTime()
          const c = issue.comments.find(
            (x) => (!x.created || new Date(x.created).getTime() >= since - 60_000) && (APPROVE_WORDS.test(x.text) || REJECT_WORDS.test(x.text)),
          )
          if (c) {
            action = APPROVE_WORDS.test(c.text) ? 'APPROVE' : 'REJECT'
            actor = `Jira comment by ${c.author} on ${key}`
          }
        }
        if (changed && !action) {
          await prisma.jiraApproval.update({ where: { id: link.id }, data: { lastStatus: issue.status } })
        }
        if (!action) continue

        const result = await decide(link.approvalId, action, actor)
        const moveTo = result.state === 'APPROVED' ? cfg.approveStatus : result.state === 'REJECTED' ? cfg.rejectStatus : null
        await close(result.state, result.outcome, actor, issue.status.toLowerCase() === (moveTo ?? '').toLowerCase() ? null : moveTo)
      } catch (err) {
        const error = err instanceof Error ? err.message.slice(0, 300) : 'poll failed'
        summary.errors.push(`${key}: ${error}`)
        await prisma.jiraApproval.update({ where: { id: link.id }, data: { error } }).catch(() => undefined)
      }
    }
  } finally {
    g[LOCK] = false
  }
  return summary
}

const TIMER = '__buildhub_jira_poll_timer__'
const gt = globalThis as unknown as Record<string, ReturnType<typeof setInterval> | undefined>

/** Starts the background poller once per server process (JIRA_POLL_SECONDS, default 15). */
export function startJiraPoller(): void {
  if (gt[TIMER] || !jiraConfig().ok) return
  const seconds = Number.parseInt(process.env.JIRA_POLL_SECONDS ?? '', 10)
  const every = (Number.isFinite(seconds) && seconds >= 5 ? seconds : 15) * 1000
  gt[TIMER] = setInterval(() => {
    void pollJiraApprovals().catch(() => undefined)
  }, every)
  gt[TIMER].unref?.()
  console.log(`[jira-approval] checking Jira approval cards every ${every / 1000}s`)
}

/** Jira issue links for approvals (for the dashboards). */
export async function jiraLinksFor(approvalIds: string[]): Promise<Map<string, { issueKey: string | null; issueUrl: string | null; state: string; error: string | null }>> {
  if (approvalIds.length === 0) return new Map()
  const rows = await prisma.jiraApproval.findMany({ where: { approvalId: { in: approvalIds } } })
  return new Map(rows.map((r) => [r.approvalId, { issueKey: r.issueKey, issueUrl: r.issueUrl, state: r.state, error: r.error }]))
}
