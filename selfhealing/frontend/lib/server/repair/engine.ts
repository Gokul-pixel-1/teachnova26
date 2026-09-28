import 'server-only'

// Phase 9 — self-healing orchestration.
//
//   evidence → memory → Coder/Critic conversation → Judge → deterministic risk →
//   patch (auto or approval) → real validation → RESOLVED | ROLLED_BACK |
//   AI_REPAIR_FAILED. Every stage is persisted; nothing is random.
//
// Flow by risk tier (FINAL POLICY):
//   LOW             → auto-apply with live validation (rollback on failure)
//   MEDIUM / HIGH   → human approval first (same approval state machine,
//                     Gmail + Telegram approval request), then the SAME
//                     apply/validate/rollback path

import { prisma } from '@/lib/server/db'
import { collectEvidence } from './evidence'
import {
  createRepairAttempt,
  updateAttemptStatus,
  runRepairConversation,
} from './conversation'
import type { RepairOptions } from './conversation'
import { classifyPatchRisk, type PatchRisk } from './risk'
import { verifyCandidate, applyCandidate, applyRuntimeRepair } from './patch-engine'
import { deactivateFaultsForEndpoint } from '@/lib/server/fault-injection'
import { createApproval, consumeApproval, rejectApproval } from '@/lib/server/approval'
import { sendTelegram } from '@/lib/server/telegram'
import { sendApprovalEmail, sendFinalEmail } from '@/lib/server/gmail'
import { approvalChannel, jiraApprovalTtlMs } from '@/lib/server/jira/client'
import { openRepairJiraApproval } from '@/lib/server/jira/approvals'
import {
  sendIncidentTerminalSummary,
  sendRepairPlanMessage,
  buildApprovalRequiredMessage,
} from '@/lib/server/notifications/summary'
import { recordRepairMemory, recordRepairExperience, recordHumanFeedback } from '@/lib/server/learning/memory'
import { recommendAction, confidenceBucket } from '@/lib/server/learning/decision'
import { providerModeLabel } from '@/lib/server/provider'
import { addIncidentEvent } from './events'
import { logger } from '@/lib/server/logger'
import { trace } from '@/lib/server/repair/trace'
import { computeOverview } from '@/lib/server/observability'
import type { Incident, RepairAttempt } from '@prisma/client'
import { Prisma } from '@prisma/client'
import type { CoderOutput } from '@/lib/server/providers/types'

export interface RepairRunResult {
  ok: boolean
  incidentRef: string | null
  attemptId: string | null
  stage: string
  risk: PatchRisk | null
  requiresApproval: boolean
  approvalId?: string
  candidateFile: string | null
  judgeDecision: string | null
  conversationStop: string
  roundsUsed: number
  rollback: boolean
  telegram: { sent: boolean; reason: string }
  gmail: { sent: boolean; reason: string }
}

export async function runSelfHealingRepair(
  incidentId: string,
  options: RepairOptions = {},
): Promise<RepairRunResult> {
  const incident = await prisma.incident.findUnique({ where: { id: incidentId } })
  if (!incident) {
    return {
      ok: false,
      incidentRef: null,
      attemptId: null,
      stage: 'NOT_FOUND',
      risk: null,
      requiresApproval: false,
      candidateFile: null,
      judgeDecision: null,
      conversationStop: 'incident not found',
      roundsUsed: 0,
      rollback: false,
      telegram: { sent: false, reason: 'incident not found' },
      gmail: { sent: false, reason: 'incident not found' },
    }
  }

  const metadata = (incident.metadata ?? null) as { faultId?: string } | null
  void metadata

  const attempt: RepairAttempt = await createRepairAttempt(incident)
  await prisma.incident.update({
    where: { id: incident.id },
    data: { status: 'INVESTIGATING', summary: `Self-healing repair started (attempt ${attempt.attemptId}).` },
  })
  await addIncidentEvent(incident.id, 'INVESTIGATING', 'Self-healing repair started', `attempt ${attempt.attemptId}`)
  trace('SELF-HEALING', `repair started for ${incident.ref} (${incident.severity}, ${incident.errorCode ?? 'no code'}) — collecting real evidence`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: incident.endpoint,
    method: incident.method,
  })
  await logger.info({
    service: 'self-healing',
    message: `Repair started for ${incident.ref}`,
    route: incident.endpoint,
    method: incident.method,
    status: 200,
    incidentId: incident.id,
  })

  const evidence = await collectEvidence(incident)
  await updateAttemptStatus(attempt.id, 'EVIDENCE_READY')

  const conversationOptions: RepairOptions = {
    maxRounds: options.maxRounds,
    scenario: options.scenario,
  }

  const conversation = await runRepairConversation(incident, attempt, evidence, conversationOptions)
  const candidate = conversation.candidate
  const judgeDecision = conversation.judge?.decision ?? null

  await updateAttemptStatus(attempt.id, 'RISK_CLASSIFIED', {
    summary: conversation.humanBrief,
  })

  // The Judge is the FINAL gate before any repair: only an explicit APPROVE
  // may reach PATCH. A REJECT, a FAILED/missing verdict, or a missing
  // candidate ends honestly in AI_REPAIR_FAILED with NO patch attempted and
  // NO validation run. Never execute PATCH unless the Judge approved.
  if (!candidate || judgeDecision !== 'APPROVE') {
    trace('JUDGE', `verdict=${judgeDecision ?? 'FAILED/MISSING'} — PATCH skipped because Judge did not approve`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
    const failure = await finalizeFailure(incident, attempt, conversation, evidence)
    return {
      ok: false,
      incidentRef: incident.ref,
      attemptId: attempt.attemptId,
      stage: 'AI_REPAIR_FAILED',
      risk: null,
      requiresApproval: false,
      candidateFile: candidate?.file ?? null,
      judgeDecision,
      conversationStop: conversation.stopReason,
      roundsUsed: conversation.roundsUsed,
      rollback: false,
      telegram: failure.telegram,
      gmail: failure.gmail,
    }
  }

  const risk: PatchRisk = classifyPatchRisk(incident, candidate.file).risk
  await updateAttemptStatus(attempt.id, 'RISK_CLASSIFIED', { risk })
  trace('SELF-HEALING', `risk classified: ${risk} for ${candidate.file} (judge confidence ${conversation.judge?.confidence ?? 'n/a'})`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: incident.endpoint,
    method: incident.method,
  })

  // A runtime-repair candidate (healthy source + controlled runtime fault) is
  // applied by restoring normal runtime behavior — real source files are never
  // touched, so the source-anchor structural checks do not apply.
  if (!candidate.runtimeRepair) {
    // Candidate structural verification before any apply/approval.
    const verified = verifyCandidate(candidate)
    if (!verified.ok) {
      const failure = await finalizeFailure(incident, attempt, conversation, evidence, undefined, `unsafe candidate: ${verified.error}`)
      return {
        ok: false,
        incidentRef: incident.ref,
        attemptId: attempt.attemptId,
        stage: 'AI_REPAIR_FAILED',
        risk,
        requiresApproval: false,
        candidateFile: candidate.file,
        judgeDecision: conversation.judge?.decision ?? null,
        conversationStop: conversation.stopReason,
        roundsUsed: conversation.roundsUsed,
        rollback: false,
        telegram: failure.telegram,
        gmail: failure.gmail,
      }
    }
  }

  // RL decision layer (REAL mode only). The recommendation is RECORDED on the
  // incident — it never overrides HIGH-risk approval, candidate verification,
  // validation or rollback, and never widens file/security policy.
  if (providerModeLabel() === 'REAL') {
    const recommendation = await recommendAction({
      incidentType: incident.errorCode ?? incident.title ?? 'runtime-failure',
      severity: incident.severity,
      risk,
      confidenceBucket: confidenceBucket(conversation.judge?.confidence),
    })
    const meta = (incident.metadata ?? {}) as Record<string, unknown>
    await prisma.incident.update({
      where: { id: incident.id },
      data: { metadata: { ...meta, rlRecommendation: recommendation } as unknown as Prisma.InputJsonValue },
    })
    await addIncidentEvent(incident.id, 'INVESTIGATING', 'RL decision layer', recommendation.reason)
    await logger.info({
      service: 'learning',
      message: `RL recommendation ${recommendation.action}: ${recommendation.reason}`,
      route: incident.endpoint,
      method: incident.method,
      status: 200,
      incidentId: incident.id,
    })
  }

  // MEDIUM / HIGH: STOP before PATCH. Create a one-time human approval,
  // notify on both channels (Telegram + Gmail with one-click tokens), and
  // return WAITING_APPROVAL. No apply, no validation until a human decides.
  if (risk === 'HIGH' || risk === 'MEDIUM') {
    const approval = await createApproval({
      incidentId: incident.id,
      patchId: `PATCH-${candidate.file.replace(/\//g, '-')}`,
      operator: 'system',
      repairAttemptId: attempt.id,
      // A Jira card is decided on a board, not a one-click link: give it
      // JIRA_APPROVAL_TTL_MINUTES (default 30) instead of the 5-minute email window.
      ...(approvalChannel() === 'jira' ? { expiresInMs: jiraApprovalTtlMs() } : {}),
    })
    await updateAttemptStatus(attempt.id, 'WAITING_APPROVAL', { risk, riskReason: `${risk} risk: human approval required (${approval.approvalId})` })
    await prisma.incident.update({
      where: { id: incident.id },
      data: { status: 'WAITING_APPROVAL', summary: `Awaiting human approval ${approval.approvalId} for ${risk}-risk patch.` },
    })
    await addIncidentEvent(incident.id, 'AWAITING_REVIEW', `${risk}-risk patch awaiting approval`, approval.approvalId)
    trace('APPROVAL', `${risk}-risk patch ${candidate.file} requires human approval ${approval.approvalId}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
    const telegram = await notifyApproval(incident, risk)
    const gmail = await notifyApprovalEmail(incident, risk, approval.approvalId)

    return {
      ok: true,
      incidentRef: incident.ref,
      attemptId: attempt.attemptId,
      stage: 'WAITING_APPROVAL',
      risk,
      requiresApproval: true,
      approvalId: approval.approvalId,
      candidateFile: candidate.file,
      judgeDecision: conversation.judge?.decision ?? null,
      conversationStop: conversation.stopReason,
      roundsUsed: conversation.roundsUsed,
      rollback: false,
      telegram,
      gmail,
    }
  }

  // LOW: announce the auto-repair plan (risk policy) then apply + real
  // validation + rollback. One ESCALATION per incident. Runtime-repair
  // candidates restore normal runtime behavior; file candidates are patched.
  await sendRepairPlanMessage(incident)
  const decision = candidate.runtimeRepair
    ? await applyRuntimeRepair(attempt, incident, {
        file: candidate.file,
        directive: candidate.runtimeRepair,
      })
    : await applyCandidate(attempt, {
        incident,
        file: candidate.file,
        line: candidate.line,
        function: candidate.function,
        currentCode: candidate.currentCode,
        proposedCode: candidate.proposedCode,
      })

  if (decision.ok) {
    // File patched → deactivate any stale runtime faults on this surface so
    // the observable state returns to healthy (repaired, not leaked).
    if (!candidate.runtimeRepair) {
      const cleared = await deactivateFaultsForEndpoint(incident.endpoint, incident.method)
      if (cleared.length) trace('PATCH', `runtime faults cleared post-patch: ${cleared.join(', ')}`, { incidentRef: incident.ref, incidentId: incident.id })
    }

    await prisma.incident.update({
      where: { id: incident.id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), summary: `Auto-repaired (${risk}): ${candidate.diagnosis}` },
    })
    await updateAttemptStatus(attempt.id, 'RESOLVED', {
      risk,
      summary: `RESOLVED: ${candidate.diagnosis}`,
      completedAt: new Date(),
      patchState: { patchId: decision.record.patchId, validation: decision.validation.probes.map((p) => p.name) },
    })
    await addIncidentEvent(incident.id, 'RESOLVED', 'Patch validated — incident resolved', `${decision.record.patchId} (${risk} risk)`)

    await persistLearning(incident, attempt, candidate, risk, 'RESOLVED', evidence, decision.validation.probes.every((p) => p.ok) ? 'validation passed' : null)

    const telegram = await notifyTerminal(incident)
    await traceScores(decision.validation.probes);
    trace('FINAL', `${incident.ref} RESOLVED via auto-repair (${decision.record.patchId}) — telegram ${telegram.telegram.sent ? 'sent' : `not sent: ${telegram.telegram.reason}`}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })

    return {
      ok: true,
      incidentRef: incident.ref,
      attemptId: attempt.attemptId,
      stage: 'RESOLVED',
      risk,
      requiresApproval: false,
      candidateFile: candidate.file,
      judgeDecision: conversation.judge?.decision ?? null,
      conversationStop: conversation.stopReason,
      roundsUsed: conversation.roundsUsed,
      rollback: false,
      telegram: telegram.telegram,
      gmail: telegram.gmail,
    }
  }

  // Validation failed → rollback happened.
  await prisma.incident.update({
    where: { id: incident.id },
    data: { status: 'ROLLED_BACK', summary: `Patch rolled back: ${decision.reason}` },
  })
  await updateAttemptStatus(attempt.id, 'ROLLED_BACK', {
    risk,
    summary: `ROLLED_BACK: ${decision.reason}`,
    completedAt: new Date(),
    patchState: { patchId: decision.record.patchId, reason: decision.reason },
  })
  await addIncidentEvent(incident.id, 'VALIDATING', 'Patch failed validation — rolled back', decision.reason)

  await persistLearning(incident, attempt, candidate, risk, 'ROLLED_BACK', evidence, decision.reason)

  const telegram = await notifyTerminal(incident)
  await traceScores(decision.validation.probes)
  // Report only what the rollback proved: `restoreVerified` is true when the
  // read-back SHA-256 matched the backup, false when the restore was skipped
  // or unverified, undefined when no file edit existed to restore.
  const restoreNote =
    decision.restoreVerified === true
      ? 'original bytes restored and hash-verified'
      : decision.restoreVerified === false
        ? 'rollback restore UNVERIFIED — see ROLLBACK traces for details'
        : 'no file changes to restore'
  trace('FINAL', `${incident.ref} ROLLED_BACK — validation failed after apply; ${restoreNote}`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: incident.endpoint,
    method: incident.method,
  })

  return {
    ok: false,
    incidentRef: incident.ref,
    attemptId: attempt.attemptId,
    stage: 'ROLLED_BACK',
    risk,
    requiresApproval: false,
    candidateFile: candidate.file,
    judgeDecision: conversation.judge?.decision ?? null,
    conversationStop: conversation.stopReason,
    roundsUsed: conversation.roundsUsed,
    rollback: true,
    telegram: telegram.telegram,
    gmail: telegram.gmail,
  }
}

async function finalizeFailure(
  incident: Incident,
  attempt: RepairAttempt,
  conversation: Awaited<ReturnType<typeof runRepairConversation>>,
  evidence: Awaited<ReturnType<typeof collectEvidence>>,
  risk?: PatchRisk,
  detail?: string,
): Promise<{ telegram: { sent: boolean; reason: string }; gmail: { sent: boolean; reason: string } }> {
  const stage = conversation.stopReason === 'CODER_REJECTED' ? 'REJECTED' : 'AI_REPAIR_FAILED'
  await prisma.incident.update({
    where: { id: incident.id },
    data: {
      status: stage === 'REJECTED' ? 'AI_REPAIR_FAILED' : 'AI_REPAIR_FAILED',
      summary: `${stage}: ${detail ?? conversation.humanBrief}`,
    },
  })
  await updateAttemptStatus(attempt.id, stage, {
    risk: risk ?? null,
    summary: detail ?? conversation.humanBrief,
    error: detail ?? conversation.stopReason,
    completedAt: new Date(),
  })
  await addIncidentEvent(incident.id, 'INVESTIGATING', stage, (detail ?? conversation.humanBrief).slice(0, 400))
  await persistLearning(incident, attempt, null, risk ?? 'LOW', stage as 'AI_REPAIR_FAILED', evidence, detail ?? conversation.humanBrief)

  const terminal = await notifyTerminal(incident)
  trace('FINAL', `${incident.ref} AI_REPAIR_FAILED (stop=${conversation.stopReason}, ${conversation.roundsUsed} round(s)) — no safe candidate produced`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: incident.endpoint,
    method: incident.method,
  })
  await traceScores([])
  return { telegram: terminal.telegram, gmail: terminal.gmail }
}

/** Prints the recomputed score set (cyber safety / app reliability / total)
 * after a terminal state so a judge can see that the score recovered (RESOLVED)
 * and never recovered through a bare rollback. Best-effort, never throws. */
async function traceScores(probes: Array<{ name: string; ok: boolean; expected: string; actual: string }>): Promise<void> {
  try {
    const overview = await computeOverview()
    trace('SCORE', `post-terminal scores → risk ${overview.riskScore} · cyber ${overview.cyberSafetyScore} · reliability ${overview.applicationReliabilityScore} · health ${overview.systemHealth} · total ${overview.totalHealthScore} (active incidents ${overview.activeIncidents})`)
    void probes
  } catch (err) {
    await logger.warn({
      service: 'self-healing',
      message: `Score recompute after repair failed: ${err instanceof Error ? err.message : 'unknown'}`,
      status: 500,
      errorCode: 'SCORE_RECOMPUTE_FAILED',
    })
  }
}

async function persistLearning(
  incident: Incident,
  attempt: RepairAttempt,
  candidate: CoderOutput | null,
  risk: PatchRisk,
  outcome: 'RESOLVED' | 'ROLLED_BACK' | 'AI_REPAIR_FAILED',
  evidence: Awaited<ReturnType<typeof collectEvidence>>,
  detail: string | null,
  humanDecision: 'APPROVED' | 'REJECTED' | null = null,
): Promise<void> {
  try {
    const rootCause = candidate?.rootCause ?? detail ?? 'no candidate produced'
    await recordRepairMemory({
      incident,
      rootCause,
      file: candidate?.file ?? evidence.suspectSource,
      feature: incident.endpoint.split('/').filter(Boolean).slice(0, 2).join('/') || null,
      endpoint: incident.endpoint,
      patchSummary: candidate
        ? `risk=${risk} · ${candidate.diagnosis}`
        : `no patch (${detail ?? 'failed'})`,
      risk,
      outcome,
      humanDecision,
    })
    const memory = await prisma.repairMemory.findUnique({ where: { incidentId: incident.id } })
    await recordRepairExperience({
      incident,
      memoryId: memory?.id ?? null,
      attemptId: attempt.id,
      state: {
        incidentRef: incident.ref,
        severity: incident.severity,
        endpoint: incident.endpoint,
        errorCode: incident.errorCode,
        evidenceCount: evidence.evidenceCount,
        risk,
      },
      action: candidate
        ? {
            file: candidate.file,
            line: candidate.line,
            function: candidate.function,
            currentCode: candidate.currentCode,
            proposedCode: candidate.proposedCode,
            risk,
            decision: decisionLabelFor(risk, outcome),
          }
        : { decision: 'no-candidate', stopReason: outcome },
      nextState: { incidentStatus: incident.status, resolvedAt: incident.resolvedAt?.toISOString() ?? null },
      terminal: true,
      outcome,
      humanDecision,
    })
  } catch (err) {
    await logger.warn({
      service: 'learning',
      message: `Learning record failed: ${err instanceof Error ? err.message : 'unknown'}`,
      route: incident.endpoint,
      method: incident.method,
      status: 500,
      incidentId: incident.id,
    })
  }
}

interface ChannelResult {
  sent: boolean
  reason: string
}

/** Terminal lifecycle notification on BOTH channels (Telegram + Gmail). */
async function notifyTerminal(incident: Incident): Promise<{ telegram: ChannelResult; gmail: ChannelResult }> {
  const result = await sendIncidentTerminalSummary(incident)
  const telegram: ChannelResult = result.ok
    ? { sent: true, reason: 'sent (FINAL_SUMMARY)' }
    : !result.configured
      ? { sent: false, reason: 'Telegram not configured' }
      : { sent: false, reason: `send failed: ${result.error}` }
  const gmail = await sendTerminalEmail(incident)
  return { telegram, gmail }
}

async function notifyApproval(
  incident: Incident,
  risk: 'MEDIUM' | 'HIGH',
): Promise<{ sent: boolean; reason: string }> {
  const type = risk === 'MEDIUM' ? 'MEDIUM_RISK_APPROVAL_REQUIRED' : 'HIGH_RISK_APPROVAL_REQUIRED'
  const message = await buildApprovalRequiredMessage(incident, risk)
  const result = await sendTelegram({
    type,
    message,
    incidentId: incident.id,
    severity: incident.severity,
  })
  if (result.ok) return { sent: true, reason: `sent (${type})` }
  if (!result.configured) return { sent: false, reason: 'Telegram not configured' }
  return { sent: false, reason: `send failed: ${result.error}` }
}

/** Approval request: a Jira issue when the Jira channel is active (falling
 * back to email if Jira cannot be reached), else the Gmail email with
 * one-click tokens. Never throws. */
async function notifyApprovalEmail(
  incident: Incident,
  risk: 'MEDIUM' | 'HIGH',
  approvalId: string,
): Promise<{ sent: boolean; reason: string }> {
  let jiraError: string | null = null
  if (approvalChannel() === 'jira') {
    const jira = await openRepairJiraApproval({ incident, risk, approvalId }).catch((err: unknown) => ({
      ok: false,
      issueKey: null,
      error: err instanceof Error ? err.message : 'Jira failed',
    }))
    if (jira.ok) {
      await addIncidentEvent(incident.id, 'AWAITING_REVIEW', `Approval requested in Jira ${jira.issueKey}`, approvalId).catch(() => undefined)
      return { sent: true, reason: `jira issue ${jira.issueKey}` }
    }
    jiraError = jira.error
  }
  try {
    const result = await sendApprovalEmail({ incident, risk, approvalId })
    const fallback = jiraError ? ` (Jira failed: ${jiraError})` : ''
    return result.ok
      ? { sent: true, reason: `sent (${result.deliveryStatus})${fallback}` }
      : { sent: false, reason: (result.error ?? 'gmail send failed') + fallback }
  } catch (err) {
    return { sent: false, reason: `gmail failed: ${err instanceof Error ? err.message : 'unknown'}` }
  }
}

/** Terminal lifecycle email (Gmail). Never throws. */
async function sendTerminalEmail(incident: Incident): Promise<{ sent: boolean; reason: string }> {
  try {
    const result = await sendFinalEmail({ incident })
    return result.ok
      ? { sent: true, reason: `sent (${result.deliveryStatus})` }
      : { sent: false, reason: result.error ?? 'gmail send failed' }
  } catch (err) {
    return { sent: false, reason: `gmail failed: ${err instanceof Error ? err.message : 'unknown'}` }
  }
}

/**
 * Continuation after a human approves a MEDIUM/HIGH-risk patch: applies the
 * SAME candidate (checkpoint → validate → rollback) and resolves/rolls back.
 */
export async function continueApprovedRepair(
  approvalId: string,
  approvalOperator: string,
): Promise<RepairRunResult> {
  const approval = await prisma.approval.findUnique({
    where: { approvalId },
    include: { incident: true, repairAttempt: true },
  })
  if (!approval || approval.status !== 'APPROVED') {
    return {
      ok: false,
      incidentRef: null,
      attemptId: null,
      stage: approval ? approval.status : 'NOT_FOUND',
      risk: null,
      requiresApproval: false,
      candidateFile: null,
      judgeDecision: null,
      conversationStop: 'approval not APPROVED',
      roundsUsed: 0,
      rollback: false,
      telegram: { sent: false, reason: 'no approved patch to apply' },
      gmail: { sent: false, reason: 'no approved patch to apply' },
    }
  }
  const incident = approval.incident
  const attempt = approval.repairAttempt
  if (!attempt) {
    return {
      ok: false,
      incidentRef: incident.ref,
      attemptId: null,
      stage: 'NO_ATTEMPT',
      risk: null,
      requiresApproval: false,
      candidateFile: null,
      judgeDecision: null,
      conversationStop: 'attempt missing for approval',
      roundsUsed: 0,
      rollback: false,
      telegram: { sent: false, reason: 'attempt missing' },
      gmail: { sent: false, reason: 'attempt missing' },
    }
  }

  const candidate = await loadFinalCandidate(incident)
  if (!candidate) {
    return {
      ok: false,
      incidentRef: incident.ref,
      attemptId: attempt.attemptId,
      stage: 'NO_CANDIDATE',
      risk: null,
      requiresApproval: false,
      candidateFile: null,
      judgeDecision: null,
      conversationStop: 'no stored candidate',
      roundsUsed: 0,
      rollback: false,
      telegram: { sent: false, reason: 'no candidate stored' },
      gmail: { sent: false, reason: 'no candidate stored' },
    }
  }

  const risk = (attempt.risk ?? classifyPatchRisk(incident, candidate.file).risk) as PatchRisk

  await prisma.incident.update({ where: { id: incident.id }, data: { status: 'VALIDATING' } })
  await updateAttemptStatus(attempt.id, 'APPLYING', { summary: `approved by ${approvalOperator}` })

  const decision = candidate.runtimeRepair
    ? await applyRuntimeRepair(attempt, incident, {
        file: candidate.file,
        directive: candidate.runtimeRepair,
      })
    : await applyCandidate(attempt, {
        incident,
        file: candidate.file,
        line: candidate.line,
        function: candidate.function,
        currentCode: candidate.currentCode,
        proposedCode: candidate.proposedCode,
      })

  if (decision.ok) {
    if (!candidate.runtimeRepair) {
      const cleared = await deactivateFaultsForEndpoint(incident.endpoint, incident.method)
      if (cleared.length) trace('PATCH', `runtime faults cleared post-approval-patch: ${cleared.join(', ')}`, { incidentRef: incident.ref, incidentId: incident.id })
    }

    await prisma.incident.update({
      where: { id: incident.id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), summary: `Approved & validated: ${candidate.diagnosis}` },
    })
    await updateAttemptStatus(attempt.id, 'RESOLVED', { risk, summary: `RESOLVED: ${candidate.diagnosis}`, completedAt: new Date(), patchState: { patchId: decision.record.patchId } })
    await consumeApproval(approval.approvalId)
    // Human-approved repairs record learning with the APPROVED decision so
    // reward shaping (+approval) and the RL dataset stay honest.
    await persistLearning(incident, attempt, candidate, risk, 'RESOLVED', await collectEvidence(incident), 'human-approved repair validated', 'APPROVED')
    const terminalApproved = await notifyTerminal(incident)
    return {
      ok: true,
      incidentRef: incident.ref,
      attemptId: attempt.attemptId,
      stage: 'RESOLVED',
      risk,
      requiresApproval: false,
      candidateFile: candidate.file,
      judgeDecision: null,
      conversationStop: 'approved-apply',
      roundsUsed: 0,
      rollback: false,
      telegram: terminalApproved.telegram,
      gmail: terminalApproved.gmail,
    }
  }

  await prisma.incident.update({
    where: { id: incident.id },
    data: { status: 'ROLLED_BACK', summary: `Approved patch rolled back: ${decision.reason}` },
  })
  await updateAttemptStatus(attempt.id, 'ROLLED_BACK', { risk, summary: `ROLLED_BACK: ${decision.reason}`, completedAt: new Date(), patchState: { patchId: decision.record.patchId, reason: decision.reason } })
  await consumeApproval(approval.approvalId)
  await persistLearning(incident, attempt, candidate, risk, 'ROLLED_BACK', await collectEvidence(incident), decision.reason, 'APPROVED')
  const terminalRolledBack = await notifyTerminal(incident)
  return {
    ok: false,
    incidentRef: incident.ref,
    attemptId: attempt.attemptId,
    stage: 'ROLLED_BACK',
    risk,
    requiresApproval: false,
    candidateFile: candidate.file,
    judgeDecision: null,
    conversationStop: 'approved-apply-rollback',
    roundsUsed: 0,
    rollback: true,
    telegram: terminalRolledBack.telegram,
    gmail: terminalRolledBack.gmail,
  }
}

/** Action label persisted on each RepairExperience so the RL decision layer
 * can group by the action actually taken (and for outcome/risk → label). */
function decisionLabelFor(risk: PatchRisk, outcome: string): string {
  if (risk === 'HIGH') return 'REQUEST_HUMAN'
  if (outcome === 'RESOLVED') return 'AUTO_REPAIR'
  if (outcome === 'ROLLED_BACK' || outcome === 'AI_REPAIR_FAILED') return 'RETRY_ANALYSIS'
  return 'REJECT_REPAIR'
}

/**
 * Shared human-rejection finalizer (one-click email + dashboard PROCEED/REJECT
 * flows converge here): marks the approval REJECTED, freezes the incident
 * honestly with NO code change, records REJECTED learning (reward 0 — a
 * rejection is information, never a coding success), and notifies both
 * channels once. Idempotent: a non-PENDING approval returns its current state
 * without re-executing anything.
 */
export async function finalizeRejectedRepair(
  approvalId: string,
  operatorLabel: string,
): Promise<{ ok: boolean; status: string; incidentRef: string | null; telegram: ChannelResult; gmail: ChannelResult }> {
  const existing = await prisma.approval.findUnique({
    where: { approvalId },
    include: { incident: true },
  })
  if (!existing) return { ok: false, status: 'NOT_FOUND', incidentRef: null, telegram: { sent: false, reason: 'approval not found' }, gmail: { sent: false, reason: 'approval not found' } }
  if (existing.status !== 'PENDING') {
    return { ok: true, status: existing.status, incidentRef: existing.incident.ref, telegram: { sent: false, reason: `already ${existing.status}` }, gmail: { sent: false, reason: `already ${existing.status}` } }
  }
  const rejected = await rejectApproval(approvalId)
  if (!rejected) {
    return { ok: false, status: 'PENDING', incidentRef: existing.incident.ref, telegram: { sent: false, reason: 'rejection failed' }, gmail: { sent: false, reason: 'rejection failed' } }
  }
  const riskWord = existing.incident.severity === 'HIGH' ? 'HIGH-risk' : existing.incident.severity === 'MEDIUM' ? 'MEDIUM-risk' : 'repair'
  const attempt = await prisma.repairAttempt.findFirst({
    where: { id: existing.repairAttemptId ?? undefined },
  })
  await prisma.incident.update({
    where: { id: existing.incidentId },
    data: {
      status: 'REJECTED',
      summary: `${riskWord} repair rejected by ${operatorLabel} (${approvalId}) — no code changed.`,
    },
  })
  await prisma.repairAttempt.updateMany({
    where: { incidentId: existing.incidentId, status: 'WAITING_APPROVAL' },
    data: {
      status: 'REJECTED',
      summary: `${riskWord} repair rejected by ${operatorLabel} (${approvalId})`,
      completedAt: new Date(),
    },
  })
  await addIncidentEvent(existing.incidentId, 'REJECTED', `${riskWord} repair rejected by ${operatorLabel}`, `approval ${approvalId}`)
  try {
    await recordRepairMemory({
      incident: existing.incident,
      rootCause: existing.incident.expectedRootCause ?? 'human rejected the proposed repair',
      file: null,
      feature: existing.incident.endpoint.split('/').filter(Boolean).slice(0, 2).join('/') || null,
      endpoint: existing.incident.endpoint,
      patchSummary: `no patch applied (rejected ${approvalId})`,
      risk: attempt?.risk ?? null,
      outcome: 'REJECTED',
      humanDecision: 'REJECTED',
      humanReason: `rejected by ${operatorLabel}`,
    })
    const memory = await prisma.repairMemory.findUnique({ where: { incidentId: existing.incidentId } })
    await recordRepairExperience({
      incident: existing.incident,
      memoryId: memory?.id ?? null,
      attemptId: existing.repairAttemptId,
      state: { incidentRef: existing.incident.ref, severity: existing.incident.severity, endpoint: existing.incident.endpoint, risk: attempt?.risk ?? null },
      action: { decision: 'REJECT_REPAIR', humanDecision: 'REJECTED' },
      nextState: { incidentStatus: 'AI_REPAIR_FAILED' },
      terminal: true,
      outcome: 'REJECTED',
      humanDecision: 'REJECTED',
    })
    await recordHumanFeedback({ incidentId: existing.incidentId, decision: 'REJECTED', reason: `rejected by ${operatorLabel} (${approvalId})` })
  } catch (err) {
    await logger.warn({
      service: 'learning',
      message: `Rejection learning record failed: ${err instanceof Error ? err.message : 'unknown'}`,
      route: existing.incident.endpoint,
      method: existing.incident.method,
      status: 500,
      incidentId: existing.incidentId,
    })
  }
  const refreshed = (await prisma.incident.findUnique({ where: { id: existing.incidentId } })) ?? existing.incident
  const terminal = await notifyTerminal(refreshed)
  return { ok: true, status: 'REJECTED', incidentRef: existing.incident.ref, telegram: terminal.telegram, gmail: terminal.gmail }
}

/** Pulls the accepted candidate back out of the attempt's last CODER AgentRun. */
async function loadFinalCandidate(incident: Incident): Promise<CoderOutput | null> {
  const lastCoder = await prisma.agentRun.findFirst({
    where: { incidentId: incident.id, kind: 'CODER', status: 'COMPLETE' },
    orderBy: { round: 'desc' },
  })
  if (!lastCoder?.output) return null
  const parsed = lastCoder.output as Partial<CoderOutput> | null
  if (!parsed || typeof parsed.file !== 'string' || typeof parsed.currentCode !== 'string' || typeof parsed.proposedCode !== 'string') return null
  return {
    diagnosis: parsed.diagnosis ?? 'approved candidate',
    rootCause: parsed.rootCause ?? '',
    file: parsed.file,
    line: typeof parsed.line === 'number' ? parsed.line : null,
    function: parsed.function ?? '',
    affectedBehavior: parsed.affectedBehavior ?? '',
    currentCode: parsed.currentCode,
    proposedCode: parsed.proposedCode,
    validationPlan: parsed.validationPlan ?? '',
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 50,
    runtimeRepair: parsed.runtimeRepair === 'restore' || parsed.runtimeRepair === 'none' ? parsed.runtimeRepair : undefined,
  }
}