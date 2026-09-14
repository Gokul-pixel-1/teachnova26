import 'server-only'

// Phase 10 — RL decision layer.
//
// A lightweight statistical policy over the persisted RepairExperience dataset.
// It does NOT tune weights, fine-tune models, or run gradient updates on-device.
// Instead it performs a tabular action-value estimate (bucket → action →
// mean reward) and recommends an action for the current gray-zone incident.
//
// SAFETY BOUNDARY — this layer is deliberately NON-ENFORCING:
//   • It never overrides HIGH-risk human approval.
//   • It never by-passes structural candidate verification.
//   • It never by-passes post-path validation / rollback.
//   • It never widens file-access or security policy.
// Its output is a RECOMMENDATION recorded on the incident and surfaced to
// operators; enforcement remains the deterministic risk/validation policy.
// This keeps the RL honest and safe while building real decision data.

import { prisma } from '@/lib/server/db'

export const REPAIR_ACTIONS = ['AUTO_REPAIR', 'REQUEST_HUMAN', 'RETRY_ANALYSIS', 'REJECT_REPAIR'] as const
export type RepairAction = (typeof REPAIR_ACTIONS)[number]

export const RL_MIN_SAMPLES = 5
export const RL_EPSILON = 0.1

export interface DecisionState {
  incidentType: string
  severity: string
  risk: string
  confidenceBucket: 'LOW' | 'MEDIUM' | 'HIGH'
}

export interface ActionEstimate {
  action: RepairAction
  meanReward: number
  samples: number
}

export interface DecisionRecommendation {
  action: RepairAction
  actionLabel: string
  meanReward: number
  samples: number
  epsilon: number
  conservative: boolean
  reason: string
  estimates: ActionEstimate[]
}

export function confidenceBucket(confidence: number | null | undefined): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (confidence === null || confidence === undefined) return 'MEDIUM'
  if (confidence >= 80) return 'HIGH'
  if (confidence >= 50) return 'MEDIUM'
  return 'LOW'
}

/** Deterministic grayscale bucket an experience row belongs to. */
export function bucketKey(state: DecisionState): string {
  const errorCode = (state.incidentType ?? 'runtime-failure').slice(0, 40).toUpperCase()
  return `${state.risk ?? 'UNKNOWN'}|${(state.severity ?? 'UNKNOWN').toUpperCase()}|${errorCode}`
}

/** Action label for an experience row, read from its recorded decision or
 * derived deterministically from outcome+risk for legacy rows. */
function actionForRow(row: {
  state: unknown
  action: unknown
  outcome: string
  risk?: string
}): RepairAction {
  const action = (row.action ?? {}) as Record<string, unknown>
  if (typeof action.decision === 'string' && (REPAIR_ACTIONS as readonly string[]).includes(action.decision)) {
    return action.decision as RepairAction
  }
  const risk = typeof row.risk === 'string' ? row.risk : 'LOW'
  const outcome = row.outcome
  if (risk === 'HIGH') return 'REQUEST_HUMAN'
  if (outcome === 'ROLLED_BACK' || outcome === 'AI_REPAIR_FAILED') return 'RETRY_ANALYSIS'
  if (outcome === 'REJECTED') return 'REJECT_REPAIR'
  return 'AUTO_REPAIR'
}

function deriveRowRisk(row: { state: unknown }): string {
  const state = (row.state ?? {}) as Record<string, unknown>
  return typeof state.risk === 'string' ? state.risk : 'LOW'
}

/**
 * Recommends an action from the empirical reward of prior experiences in the
 * same bucket. Conservative default (AUTO_REPAIR) when samples are too few,
 * so it never changes behavior off the back of noise.
 */
export async function recommendAction(
  state: DecisionState,
  epsilon: number = RL_EPSILON,
): Promise<DecisionRecommendation> {
  const bucket = bucketKey(state)
  const experiences = await prisma.repairExperience.findMany({
    orderBy: { createdAt: 'desc' },
    take: 2000,
    select: { state: true, action: true, reward: true, outcome: true },
  })

  const bucketRows = experiences.filter(
    (row) => bucketKey(row.state as unknown as DecisionState) === bucket,
  )

  const byAction = new Map<RepairAction, { total: number; samples: number }>()
  for (const row of bucketRows) {
    const action = actionForRow({
      state: row.state,
      action: row.action,
      outcome: row.outcome ?? '',
      risk: deriveRowRisk(row),
    })
    const acc = byAction.get(action) ?? { total: 0, samples: 0 }
    acc.total += row.reward
    acc.samples += 1
    byAction.set(action, acc)
  }

  const estimates: ActionEstimate[] = REPAIR_ACTIONS.map((action) => {
    const row = byAction.get(action)
    return {
      action,
      meanReward: row && row.samples > 0 ? Math.round((row.total / row.samples) * 10) / 10 : 0,
      samples: row?.samples ?? 0,
    }
  }).filter((e) => e.samples > 0)

  const hasFewSamples = bucketRows.length > 0 && bucketRows.length < RL_MIN_SAMPLES

  if (hasFewSamples || estimates.length === 0) {
    return {
      action: 'AUTO_REPAIR',
      actionLabel: 'AUTO_REPAIR (deploy the deterministic repair flow)',
      meanReward: 0,
      samples: bucketRows.length,
      epsilon,
      conservative: true,
      reason: `Only ${bucketRows.length} experience(s) in bucket "${bucket}" (< ${RL_MIN_SAMPLES}); conservative default AUTO_REPAIR used.`,
      estimates,
    }
  }

  let chosen: ActionEstimate
  if (Math.random() < epsilon) {
    chosen = estimates[Math.floor(Math.random() * estimates.length)] as ActionEstimate
  } else {
    chosen = estimates.reduce((best, e) => (e.meanReward > best.meanReward ? e : best), estimates[0])
  }

  const reason =
    `Bandit over ${bucketRows.length} experience(s) in bucket "${bucket}" picked ${chosen.action} ` +
    `(mean reward ${chosen.meanReward}, ${chosen.samples} sample(s)).`

  return {
    action: chosen.action,
    actionLabel: actionLabelFor(chosen.action),
    meanReward: chosen.meanReward,
    samples: chosen.samples,
    epsilon,
    conservative: false,
    reason,
    estimates,
  }
}

function actionLabelFor(action: RepairAction): string {
  switch (action) {
    case 'AUTO_REPAIR':
      return 'AUTO_REPAIR (deploy the deterministic repair flow)'
    case 'REQUEST_HUMAN':
      return 'REQUEST_HUMAN (raise for operator decision)'
    case 'RETRY_ANALYSIS':
      return 'RETRY_ANALYSIS (re-run analysis before patching)'
    case 'REJECT_REPAIR':
      return 'REJECT_REPAIR (do not patch; leave to operator)'
  }
}

export function decisionPolicy(): { minSamples: number; epsilon: number; actions: RepairAction[] } {
  return { minSamples: RL_MIN_SAMPLES, epsilon: RL_EPSILON, actions: [...REPAIR_ACTIONS] }
}