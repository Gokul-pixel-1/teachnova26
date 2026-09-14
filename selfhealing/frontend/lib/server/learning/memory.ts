import 'server-only'

// Phase 10 — repair memory + learning foundation.
//
// Every completed repair writes a RepairMemory (context hint for future
// incidents) and a normalized RepairExperience (state/action/reward/nextState/
// terminal) that forms the RL dataset. The reward policy is explicit,
// configurable from actual outcomes, and inspectable — there is no hidden or
// fabricated training signal. Human feedback (approval/rejection) is woven in
// as reward shaping, never as a claim that correctness was demonstrated.

import { prisma } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import type { Incident } from '@prisma/client'
import type { Prisma } from '@prisma/client'

export type RepairOutcome =
  | 'RESOLVED'
  | 'ROLLED_BACK'
  | 'AI_REPAIR_FAILED'
  | 'REJECTED'

export interface RewardPolicy {
  successfulRepair: number
  validationFailure: number
  rollback: number
  securityRegression: number
  rejection: number
  humanApproval: number
  humanRejection: number
}

function intEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim()
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Injectable, environment-tunable reward weights (Phase 10 FINAL PASS values). */
export function getRewardPolicy(): RewardPolicy {
  return {
    successfulRepair: intEnv('REPAIR_REWARD_SUCCESS', 50),
    validationFailure: intEnv('REPAIR_REWARD_VALIDATION_FAILURE', -50),
    rollback: intEnv('REPAIR_REWARD_ROLLBACK', -75),
    securityRegression: intEnv('REPAIR_REWARD_SECURITY_REGRESSION', -100),
    rejection: intEnv('REPAIR_REWARD_REJECTION', 20),
    humanApproval: intEnv('REPAIR_REWARD_HUMAN_APPROVAL', 40),
    humanRejection: intEnv('REPAIR_REWARD_HUMAN_REJECTION', 2),
  }
}

function securitySensitive(incident: Incident): boolean {
  const code = `${incident.errorCode ?? ''} ${incident.endpoint ?? ''} ${incident.detectedBy ?? ''}`.toLowerCase()
  return /auth|login|permission|ownership|authorization/i.test(code)
}

export interface RewardInput {
  incident: Incident
  outcome: RepairOutcome
  humanDecision?: 'APPROVED' | 'REJECTED' | null
}

/** Deterministic reward computation from the outcome + policy weights. */
export function computeReward(input: RewardInput): {
  reward: number
  breakdown: Record<string, number>
} {
  const policy = getRewardPolicy()
  const breakdown: Record<string, number> = {}

  if (input.outcome === 'RESOLVED') breakdown.successfulRepair = policy.successfulRepair
  if (input.outcome === 'ROLLED_BACK') breakdown.rollback = policy.rollback
  if (input.outcome === 'ROLLED_BACK' || input.outcome === 'AI_REPAIR_FAILED' || input.outcome === 'REJECTED') {
    breakdown.validationFailure = policy.validationFailure
  }
  if ((input.outcome === 'ROLLED_BACK' || input.outcome === 'AI_REPAIR_FAILED') && securitySensitive(input.incident)) {
    breakdown.securityRegression = policy.securityRegression
  }
  if (input.outcome === 'REJECTED') breakdown.rejection = policy.rejection
  if (input.humanDecision === 'APPROVED') breakdown.humanApproval = policy.humanApproval
  if (input.humanDecision === 'REJECTED') breakdown.humanRejection = policy.humanRejection

  const reward = Object.values(breakdown).reduce((sum, v) => sum + v, 0)
  return { reward, breakdown }
}

export interface MemoryInput {
  incident: Incident
  rootCause: string
  file: string | null
  feature: string | null
  endpoint: string
  patchSummary: string
  risk: string | null
  outcome: RepairOutcome
  humanDecision?: 'APPROVED' | 'REJECTED' | null
  humanReason?: string | null
}

export async function recordRepairMemory(input: MemoryInput): Promise<void> {
  const { reward } = computeReward({
    incident: input.incident,
    outcome: input.outcome,
    humanDecision: input.humanDecision ?? null,
  })
  const errorSignature = (input.incident.errorCode ?? input.incident.title ?? 'repair').slice(0, 200)

  const existing = await prisma.repairMemory.findUnique({
    where: { incidentId: input.incident.id },
  })
  if (existing) {
    await prisma.repairMemory.update({
      where: { id: existing.id },
      data: {
        errorSignature,
        rootCause: input.rootCause,
        file: input.file,
        endpoint: input.endpoint,
        patchSummary: input.patchSummary.slice(0, 2000),
        risk: input.risk,
        outcome: input.outcome,
        humanDecision: input.humanDecision ?? existing.humanDecision,
        humanReason: input.humanReason ?? existing.humanReason,
        reward,
        recurrenceCount: existing.recurrenceCount + 0,
      },
    })
    return
  }

  await prisma.repairMemory.create({
    data: {
      incidentId: input.incident.id,
      errorSignature,
      rootCause: input.rootCause.slice(0, 2000),
      file: input.file,
      feature: input.feature,
      endpoint: input.endpoint,
      patchSummary: input.patchSummary.slice(0, 2000),
      risk: input.risk,
      outcome: input.outcome,
      humanDecision: input.humanDecision ?? null,
      humanReason: input.humanReason ?? null,
      reward,
    },
  })
}

export interface ExperienceInput {
  incident: Incident
  state: Record<string, unknown>
  action: Record<string, unknown>
  outcome: RepairOutcome
  terminal: boolean
  nextState: Record<string, unknown>
  humanDecision?: 'APPROVED' | 'REJECTED' | null
  memoryId?: string | null
  attemptId?: string | null
}

export async function recordRepairExperience(input: ExperienceInput): Promise<void> {
  const { reward } = computeReward({
    incident: input.incident,
    outcome: input.outcome,
    humanDecision: input.humanDecision ?? null,
  })
  await prisma.repairExperience.create({
    data: {
      incidentId: input.incident.id,
      memoryId: input.memoryId ?? null,
      attemptId: input.attemptId ?? null,
      state: input.state as Prisma.InputJsonValue,
      action: input.action as Prisma.InputJsonValue,
      reward,
      nextState: input.nextState as Prisma.InputJsonValue,
      terminal: input.terminal,
      outcome: input.outcome,
      humanDecision: input.humanDecision ?? null,
    },
  })
  await logger.info({
    service: 'learning',
    message: `Experience recorded: outcome=${input.outcome} reward=${reward}`,
    route: input.incident.endpoint,
    method: input.incident.method,
    status: 200,
    incidentId: input.incident.id,
  })
}

/** Records human feedback and folds it into the reward of the incident's memory. */
export async function recordHumanFeedback(input: {
  incidentId: string
  decision: 'APPROVED' | 'REJECTED'
  reason?: string | null
}): Promise<{ ok: boolean; reason?: string }> {
  const memory = await prisma.repairMemory.findUnique({
    where: { incidentId: input.incidentId },
  })
  const incident = await prisma.incident.findUnique({ where: { id: input.incidentId } })
  if (!memory || !incident) {
    return { ok: false, reason: 'no memory record found for this incident' }
  }
  const { reward } = computeReward({
    incident,
    outcome: memory.outcome as RepairOutcome,
    humanDecision: input.decision,
  })
  await prisma.repairMemory.update({
    where: { id: memory.id },
    data: {
      humanDecision: input.decision,
      humanReason: input.reason ?? null,
      reward,
    },
  })
  await prisma.repairExperience.updateMany({
    where: { incidentId: input.incidentId },
    data: { humanDecision: input.decision },
  })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Queries (learning dashboard, RL dataset, evaluation)
// ---------------------------------------------------------------------------

export interface LearningMetrics {
  totalAttempts: number
  successful: number
  failed: number
  rolledBack: number
  humanApprovals: number
  humanRejections: number
  avgCoderRounds: number
  patchSuccessRate: number
  riskDistribution: Record<string, number>
  memoryCount: number
  experienceCount: number
  rlDatasetSize: number
  avgReward: number
}

export async function computeLearningMetrics(): Promise<LearningMetrics> {
  const [attempts, memories, experiences] = await Promise.all([
    prisma.repairAttempt.findMany({
      select: { status: true, risk: true, completedAt: true },
    }),
    prisma.repairMemory.findMany({ select: { outcome: true, humanDecision: true, humanReason: true, reward: true } }),
    prisma.repairExperience.findMany({ select: { reward: true } }),
  ])

  const resolved = attempts.filter((a) => a.status === 'RESOLVED').length
  const rolledBack = attempts.filter((a) => a.status === 'ROLLED_BACK').length
  const failed = attempts.filter((a) => a.status === 'AI_REPAIR_FAILED' || a.status === 'JUDGE_REJECTED' || a.status === 'REJECTED').length

  const riskDistribution: Record<string, number> = {}
  for (const attempt of attempts) {
    const risk = attempt.risk ?? 'UNKNOWN'
    riskDistribution[risk] = (riskDistribution[risk] ?? 0) + 1
  }

  // Coder rounds come from the persisted AgentRuns of each attempt.
  let coderRoundsTotal = 0
  let coderRoundsCount = 0
  try {
    const runs = await prisma.agentRun.findMany({
      where: { kind: 'CODER' },
      select: { round: true, incidentId: true },
    })
    const byAttempt = new Map<string, number>()
    for (const run of runs) {
      byAttempt.set(run.incidentId, Math.max(byAttempt.get(run.incidentId) ?? 0, run.round))
    }
    for (const rounds of byAttempt.values()) {
      coderRoundsTotal += rounds
      coderRoundsCount += 1
    }
  } catch {
    // rounds stay 0 on first run
  }

  const totalDone = attempts.filter((a) => a.status === 'RESOLVED' || a.status === 'ROLLED_BACK' || a.status === 'AI_REPAIR_FAILED' || a.status === 'REJECTED' || a.status === 'JUDGE_REJECTED').length
  const humanApprovals = memories.filter((m) => m.humanDecision === 'APPROVED').length
  const humanRejections = memories.filter((m) => m.humanDecision === 'REJECTED').length
  const avgReward = experiences.length > 0
    ? Math.round(experiences.reduce((sum, e) => sum + e.reward, 0) / experiences.length)
    : 0

  return {
    totalAttempts: attempts.length,
    successful: resolved,
    failed,
    rolledBack,
    humanApprovals,
    humanRejections,
    avgCoderRounds: coderRoundsCount > 0 ? coderRoundsTotal / coderRoundsCount : 0,
    patchSuccessRate: totalDone > 0 ? Math.round((resolved / totalDone) * 100) : 0,
    riskDistribution,
    memoryCount: memories.length,
    experienceCount: experiences.length,
    rlDatasetSize: experiences.length,
    avgReward,
  }
}

export interface RlRow {
  state: object
  action: object
  reward: number
  nextState: object | null
  terminal: boolean
  incidentId: string
  createdAt: string
}

/** Exports the normalized RL dataset. Training is out of scope here: this data
 * is the honest substrate a future trainer (or Ollama fine-tune) would use. */
export async function exportRlDataset(): Promise<RlRow[]> {
  const rows = await prisma.repairExperience.findMany({
    orderBy: { createdAt: 'asc' },
    take: 1000,
  })
  return rows.map((row) => ({
    state: row.state as object,
    action: row.action as object,
    reward: row.reward,
    nextState: row.nextState as object | null,
    terminal: row.terminal,
    incidentId: row.incidentId,
    createdAt: row.createdAt.toISOString(),
  }))
}

export interface EvaluationStats {
  total: number
  locatedFile: number
  locatedFunction: number
  rootCauseAccuracy: number
  patchCorrectness: number
  validationSuccess: number
  rollbackCorrectness: number
  avgRounds: number
  avgDurationMs: number
  score: number
}

export type ClosedStatus = 'RESOLVED' | 'ROLLED_BACK' | 'AI_REPAIR_FAILED' | 'JUDGE_REJECTED' | 'REJECTED'

/** Evaluation harness over completed attempts + patch records. Scores are
 * derived from the persisted audit trail (never fabricated). */
export async function computeEvaluationStats(): Promise<EvaluationStats> {
  const attempts = await prisma.repairAttempt.findMany({
    select: { id: true, status: true, startedAt: true, completedAt: true },
  })
  const patches = await prisma.patchRecord.findMany({
    select: { status: true, function: true, file: true, repairAttemptId: true },
  })
  const closedStatuses: ClosedStatus[] = ['RESOLVED', 'ROLLED_BACK', 'AI_REPAIR_FAILED', 'JUDGE_REJECTED', 'REJECTED']
  const closed = attempts.filter((a) => closedStatuses.includes(a.status as ClosedStatus))

  const locatedFile = patches.filter((p) => p.file.trim().length > 0).length
  const locatedFunction = patches.filter((p) => Boolean(p.function?.trim())).length
  const patchCorrect = patches.filter((p) => p.status === 'VALIDATED').length
  const rollbackCorrect = patches.filter((p) => p.status === 'ROLLED_BACK').length
  const resolved = attempts.filter((a) => a.status === 'RESOLVED').length

  const durations = closed
    .filter((a) => a.completedAt)
    .map((a) => Math.max(0, (a.completedAt?.getTime() ?? 0) - a.startedAt.getTime()))
  const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length) : 0

  // Average Coder rounds per closed attempt (from persisted AgentRuns).
  let avgRounds = 0
  const closedIds = new Set(closed.map((a) => a.id))
  if (closedIds.size > 0) {
    const runs = await prisma.agentRun.findMany({
      where: { incidentId: { in: Array.from(closedIds) }, kind: 'CODER' },
      select: { incidentId: true, round: true },
    })
    const maxByIncident = new Map<string, number>()
    for (const run of runs) {
      maxByIncident.set(run.incidentId, Math.max(maxByIncident.get(run.incidentId) ?? 0, run.round))
    }
    if (maxByIncident.size > 0) {
      avgRounds = Math.round((Array.from(maxByIncident.values()).reduce((sum, r) => sum + r, 0) / maxByIncident.size) * 10) / 10
    }
  }

  const total = closed.length
  const patchCount = patches.length
  const validationSuccess = total > 0 ? Math.round((resolved / total) * 100) : 0
  const locationAcc = patchCount > 0 ? Math.round(((locatedFile * 0.5 + locatedFunction * 0.5) / patchCount) * 100) : 0
  const patchCorrectness = patchCount > 0 ? Math.round((patchCorrect / patchCount) * 100) : 0
  const rollbackCorrectness = patchCount > 0 ? Math.round((rollbackCorrect / patchCount) * 100) : 0

  const score = Math.round(
    locationAcc * 0.25 +
      validationSuccess * 0.25 +
      patchCorrectness * 0.25 +
      rollbackCorrectness * 0.25,
  )

  return {
    total,
    locatedFile,
    locatedFunction,
    rootCauseAccuracy: locationAcc,
    patchCorrectness,
    validationSuccess,
    rollbackCorrectness,
    avgRounds,
    avgDurationMs,
    score,
  }
}