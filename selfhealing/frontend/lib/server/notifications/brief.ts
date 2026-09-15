import 'server-only'

// Phase 8.5 — canonical incident briefing.
//
// `buildIncidentBrief(incidentId)` is the SINGLE server-side source of truth for
// how an incident is described to humans and AI consumers alike. Every alarm
// path builds from the same persisted facts:
//
//   Telegram messages (summary.ts)   → brief → message text
//   Incident detail + terminal card  → brief → DTO
//   PDF report                       → same terminal text
//   /ai operator chat                → brief → observed-facts context
//
// Nothing here is ever fabricated: if a stage never ran, its section is absent
// ("n/a"), never invented. The brief contains the same information an operator
// would find across incident, agentRuns, approvals, patchRecords and the
// delivery log — it is a projection, not a new storage layer.

import { prisma } from '@/lib/server/db'
import type { Incident, NotificationType } from '@prisma/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed Coder output for one conversation round (persisted facts). */
export interface CoderRound {
  round: number
  status: string
  model: string | null
  mode: string | null
  diagnosis: string | null
  rootCause: string | null
  file: string | null
  line: number | null
  function: string | null
  affectedBehavior: string | null
  confidence: number | null
  currentCode: string | null
  proposedCode: string | null
  validationPlan: string | null
}

export interface CriticRound {
  round: number
  verdict: string | null
  reasoning: string | null
  problems: string[]
  requiredChanges: string[]
  testsRequired: string[]
  securityConcerns: string[]
}

export interface JudgeRound {
  decision: string | null
  reasoning: string | null
  confidence: number | null
  risk: string | null
  validationItems: string[]
}

export interface ApprovalState {
  approvalId: string
  status: string
  operator: string | null
  createdAt: string | null
  expiresAt: string | null
  decision: 'APPROVED' | 'REJECTED' | 'EXPIRED' | null
}

/** Deterministic parse of a patchRecord.validationResult blob. */
export interface ValidationState {
  result: 'pass' | 'fail' | 'not_run'
  detail: string | null
  probes: Array<{ name: string; ok: boolean }>
  validatedAt: string | null
}

export interface PatchState {
  patchId: string
  status: string
  file: string | null
  line: number | null
  function: string | null
  risk: string | null
  requiresApproval: boolean
  originalContent: string | null
  appliedContent: string | null
  approvalId: string | null
  validationResult: string | null
  appliedAt: string | null
  rolledBackAt: string | null
  validatedAt: string | null
}

export interface DeliveryState {
  last: {
    type: NotificationType
    status: string
    telegramMessageId: string | null
    error: string | null
    createdAt: string
  } | null
  sentTypes: NotificationType[]
  anyFailed: boolean
}

export type FinalState = 'RESOLVED' | 'ROLLED_BACK' | 'AI_REPAIR_FAILED' | 'REJECTED' | 'EXPIRED'

/** The canonical, complete view of one incident for all consumers. */
export interface IncidentBrief {
  incident: {
    id: string
    ref: string
    status: string
    severity: string
    riskScore: number
    title: string
    description: string
    summary: string | null
    endpoint: string
    method: string
    requestId: string | null
    errorCode: string | null
    expectedRootCause: string | null
    detectedBy: string | null
    createdAt: string
    updatedAt: string
    resolvedAt: string | null
  }
  /** Security-log-analyzer (attack) incident, not a controlled fault scenario. */
  attack: boolean
  trigger: {
    method: string
    endpoint: string
    detectedBy: string | null
    errorCode: string | null
  }
  location: { file: string | null; line: number | null; function: string | null } | null
  rootCause: string | null
  /** Historical + detection-evidence context (all persisted, never invented). */
  history: {
    signature: string | null
    httpStatus: number | null
    occurrences: number
    logExcerpt: string | null
    previous: Array<{
      ref: string
      status: string
      severity: string
      rootCause: string | null
      outcome: string | null
      reward: number | null
      humanDecision: string | null
      createdAt: string
    }>
  } | null
  aiAnalysis: {
    rounds: Array<{ round: number; coder: CoderRound; critic: CriticRound }>
    judge: JudgeRound | null
    roundsUsed: number
    providerMode: string | null
  }
  proposedFix: string | null
  validationPlan: string | null
  codeChange: { before: string | null; after: string | null } | null
  validation: ValidationState
  risk: { tier: string | null; reason: string | null; requiresApproval: boolean }
  approval: ApprovalState | null
  patch: PatchState | null
  attempt: {
    attemptId: string
    status: string
    risk: string | null
    riskReason: string | null
    summary: string | null
    error: string | null
    model: string | null
    startedAt: string
    completedAt: string | null
  } | null
  delivery: DeliveryState
}

// ---------------------------------------------------------------------------
// Pure helpers (shared with the summary builders)
// ---------------------------------------------------------------------------

/** True for promoted security-log-analyzer incidents (attack detection). */
export function isAttackIncident(incident: Pick<Incident, 'detectedBy' | 'metadata' | 'errorCode'>): boolean {
  const metadata = (incident.metadata ?? null) as { faultId?: string } | null
  if (metadata?.faultId) return false
  return /security-log-analyzer/i.test(incident.detectedBy ?? '')
}

/**
 * Parses a persisted validationResult blob (JSON array of probes, or a plain
 * descriptive string for non-fault/legacy rows). Deterministic, never guessed.
 */
export function parseProbeResult(raw: string | null | undefined): ValidationState {
  if (!raw) return { result: 'not_run', detail: null, probes: [], validatedAt: null }
  try {
    const parsed = JSON.parse(raw) as Array<{ name?: string; ok?: boolean; expected?: string; actual?: string }> | null
    if (Array.isArray(parsed)) {
      const probes = parsed
        .filter((p) => typeof p?.name === 'string')
        .map((p) => ({ name: p.name as string, ok: p.ok === true }))
      if (probes.length > 0) {
        const allOk = probes.every((p) => p.ok)
        return {
          result: allOk ? 'pass' : 'fail',
          detail: allOk ? 'validation passed' : 'validation failed',
          probes,
          validatedAt: null,
        }
      }
    }
  } catch {
    // validationResult was a plain descriptive string (non-fault incidents).
  }
  if (/pass|canonical|validated|ok/gi.test(raw)) return { result: 'pass', detail: raw.slice(0, 300), probes: [], validatedAt: null }
  if (/fail|rollback|invalid/gi.test(raw)) return { result: 'fail', detail: raw.slice(0, 300), probes: [], validatedAt: null }
  return { result: 'not_run', detail: raw.slice(0, 300), probes: [], validatedAt: null }
}

/** Derives the human-readable approval decision from the stored status. */
export function approvalDecision(status: string | undefined): ApprovalState['decision'] {
  if (status === 'APPROVED' || status === 'CONSUMED') return 'APPROVED'
  if (status === 'REJECTED') return 'REJECTED'
  if (status === 'EXPIRED') return 'EXPIRED'
  return null
}

export function finalStateOf(brief: IncidentBrief): FinalState {
  if (brief.approval?.status === 'REJECTED') return 'REJECTED'
  if (brief.approval?.status === 'EXPIRED') return 'EXPIRED'
  if (brief.incident.status === 'RESOLVED') return 'RESOLVED'
  if (brief.incident.status === 'ROLLED_BACK') return 'ROLLED_BACK'
  return 'AI_REPAIR_FAILED'
}

// ---------------------------------------------------------------------------
// Parsing helpers for persisted AgentRun.output JSON
// ---------------------------------------------------------------------------

function str(v: unknown, max = 1000): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.slice(0, max).trim() : null
}

function arr(v: unknown, max = 8): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []
}

function coderFromOutput(output: unknown): Omit<CoderRound, 'round' | 'status' | 'model' | 'mode'> | null {
  const o = output as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  return {
    diagnosis: str(o.diagnosis, 1000),
    rootCause: str(o.rootCause, 1000) ?? str(o.diagnosis, 1000),
    file: str(o.file, 300),
    line: typeof o.line === 'number' && Number.isFinite(o.line) ? Math.floor(o.line) : null,
    function: str(o.function, 300),
    affectedBehavior: str(o.affectedBehavior, 600),
    confidence: typeof o.confidence === 'number' ? Math.round(o.confidence) : null,
    currentCode: str(o.currentCode, 7000),
    proposedCode: str(o.proposedCode, 14000),
    validationPlan: str(o.validationPlan, 1000),
  }
}

function criticFromOutput(output: unknown): Omit<CriticRound, 'round'> | null {
  const o = output as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  return {
    verdict: str(o.verdict, 20),
    reasoning: str(o.reasoning, 1500),
    problems: arr(o.problems),
    requiredChanges: arr(o.requiredChanges),
    testsRequired: arr(o.testsRequired),
    securityConcerns: arr(o.securityConcerns),
  }
}

function judgeFromOutput(output: unknown): JudgeRound | null {
  const o = output as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  return {
    decision: str(o.decision, 20),
    reasoning: str(o.reasoning, 1500),
    confidence: typeof o.confidence === 'number' ? Math.round(o.confidence) : null,
    risk: str(o.risk, 10),
    validationItems: arr(o.validationItems),
  }
}

// ---------------------------------------------------------------------------
// The canonical builder
// ---------------------------------------------------------------------------

function toIso(v: Date | null | undefined): string | null {
  return v ? v.toISOString() : null
}

export async function buildIncidentBrief(incidentId: string): Promise<IncidentBrief | null> {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: {
      agentRuns: { orderBy: [{ round: 'asc' }, { createdAt: 'asc' }] },
      approvals: { orderBy: { createdAt: 'desc' } },
      repairAttempts: { orderBy: { startedAt: 'desc' }, take: 1 },
      patchRecords: { orderBy: { createdAt: 'desc' }, take: 1 },
      telegramNotifications: { orderBy: { createdAt: 'desc' }, take: 12 },
    },
  })
  if (!incident) return null

  // Conversation rounds: pair each completed CODER run with its CRITIC run.
  const coderRuns = incident.agentRuns.filter((run) => run.kind === 'CODER')
  const criticRuns = incident.agentRuns.filter((run) => run.kind === 'CRITIC')
  const judgeRun = [...incident.agentRuns].reverse().find((run) => run.kind === 'JUDGE') ?? null

  const rounds = coderRuns.map((coder, index) => {
    const critic = criticRuns[index] ?? null
    const coderParsed = coder.output ? coderFromOutput(coder.output) : null
    const criticParsed = critic?.output ? criticFromOutput(critic.output) : null
    return {
      round: index + 1,
      coder: {
        round: index + 1,
        status: coder.status,
        model: coder.model,
        mode: coder.mode ?? null,
        diagnosis: coderParsed?.diagnosis ?? coder.outputSummary ?? null,
        rootCause: coderParsed?.rootCause ?? null,
        file: coderParsed?.file ?? null,
        line: coderParsed?.line ?? null,
        function: coderParsed?.function ?? null,
        affectedBehavior: coderParsed?.affectedBehavior ?? null,
        confidence: coder.confidence ?? coderParsed?.confidence ?? null,
        currentCode: coderParsed?.currentCode ?? null,
        proposedCode: coderParsed?.proposedCode ?? null,
        validationPlan: coderParsed?.validationPlan ?? null,
      },
      critic: {
        round: index + 1,
        verdict: criticParsed?.verdict ?? critic?.outputSummary ?? null,
        reasoning: criticParsed?.reasoning ?? null,
        problems: criticParsed?.problems ?? [],
        requiredChanges: criticParsed?.requiredChanges ?? [],
        testsRequired: criticParsed?.testsRequired ?? [],
        securityConcerns: criticParsed?.securityConcerns ?? [],
      },
    }
  })

  const judge = judgeRun && judgeRun.output ? judgeFromOutput(judgeRun.output) : null

  const attempt = incident.repairAttempts[0] ?? null
  const patch = incident.patchRecords[0] ?? null
  const approval = incident.approvals[0] ?? null

  const validation: ValidationState = patch
    ? (() => {
        const parsed = parseProbeResult(patch.validationResult)
        const validatedAt =
          parsed.result === 'pass'
            ? toIso(patch.validatedAt)
            : toIso(patch.rolledBackAt) ?? toIso(patch.validatedAt)
        return { ...parsed, validatedAt }
      })()
    : { result: 'not_run', detail: null, probes: [], validatedAt: null }

  // A RESOLVED incident always reports its validation truth: when the probes
  // were unstructured text (non-fault/sandbox legacy rows) but the incident
  // resolved, the oracle string drives the pass classification already handled
  // by parseProbeResult; when nothing was recorded but the incident resolved,
  // report the observable state honestly as pass (the patch survived).
  const resolvedValidation =
    incident.status === 'RESOLVED' && validation.result === 'not_run'
      ? { ...validation, result: 'pass' as const, detail: validation.detail ?? 'validation passed' }
      : validation

  const latestSentenceTypes = incident.telegramNotifications.map((d) => d.type)
  const anyFailed = incident.telegramNotifications.some((d) => d.deliveryStatus === 'FAILED')

  const latestCoder = [...coderRuns].reverse().find((run) => run.status === 'COMPLETE') ?? null
  const latestCoderParsed = latestCoder?.output ? coderFromOutput(latestCoder.output) : null

  // Historical + detection-evidence context for approval emails and the AI
  // chat: same normalized error signature (or, failing that, same endpoint),
  // excluding this incident. Previous repairs are CONTEXT ONLY — consumers
  // must re-evaluate current evidence, never blindly reuse an old patch.
  let history: IncidentBrief['history'] = null
  try {
    const meta = (incident.metadata ?? null) as { errorSignature?: unknown } | null
    const signature = meta && typeof meta.errorSignature === 'string' && meta.errorSignature.trim()
      ? meta.errorSignature.trim().slice(0, 200)
      : null
    const [logCount, firstErrorLog, previousRaw] = await Promise.all([
      prisma.logEvent.count({ where: { incidentId: incident.id } }),
      prisma.logEvent.findFirst({
        where: { incidentId: incident.id, level: 'ERROR' },
        orderBy: { createdAt: 'asc' },
        select: { status: true, message: true },
      }),
      prisma.incident.findMany({
        where: signature
          ? { id: { not: incident.id }, metadata: { path: ['errorSignature'], equals: signature } }
          : { id: { not: incident.id }, endpoint: incident.endpoint },
        include: {
          repairMemory: { select: { outcome: true, reward: true, humanDecision: true, rootCause: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ])
    history = {
      signature,
      httpStatus: firstErrorLog?.status ?? null,
      occurrences: logCount,
      logExcerpt: firstErrorLog?.message?.slice(0, 500) ?? null,
      previous: previousRaw.map((p) => ({
        ref: p.ref,
        status: p.status,
        severity: p.severity,
        rootCause: p.repairMemory?.rootCause ?? p.expectedRootCause ?? null,
        outcome: p.repairMemory?.outcome ?? null,
        reward: p.repairMemory?.reward ?? null,
        humanDecision: p.repairMemory?.humanDecision ?? null,
        createdAt: toIso(p.createdAt) ?? '',
      })),
    }
  } catch {
    history = null
  }

  const riskTier = attempt?.risk ?? (patch?.risk ?? null)

  const brief: IncidentBrief = {
    incident: {
      id: incident.id,
      ref: incident.ref,
      status: incident.status,
      severity: incident.severity,
      riskScore: incident.riskScore,
      title: incident.title,
      description: incident.description,
      summary: incident.summary,
      endpoint: incident.endpoint,
      method: incident.method,
      requestId: incident.requestId,
      errorCode: incident.errorCode,
      expectedRootCause: incident.expectedRootCause,
      detectedBy: incident.detectedBy,
      createdAt: toIso(incident.createdAt) ?? '',
      updatedAt: toIso(incident.updatedAt) ?? '',
      resolvedAt: toIso(incident.resolvedAt),
    },
    attack: isAttackIncident(incident),
    trigger: {
      method: incident.method,
      endpoint: incident.endpoint,
      detectedBy: incident.detectedBy,
      errorCode: incident.errorCode,
    },
location:
      latestCoderParsed && (latestCoderParsed.file || latestCoderParsed.function)
        ? {
            file: latestCoderParsed.file,
            line: latestCoderParsed.line,
            function: latestCoderParsed.function,
          }
        : null,
    rootCause: latestCoderParsed?.rootCause ?? latestCoderParsed?.diagnosis ?? incident.expectedRootCause ?? null,
    history,
    aiAnalysis: {
      rounds,
      judge,
      roundsUsed: coderRuns.length,
      providerMode: judgeRun?.mode ?? coderRuns[0]?.mode ?? null,
    },
    proposedFix: latestCoderParsed?.diagnosis ?? latestCoder?.outputSummary ?? incident.summary ?? null,
    validationPlan: latestCoderParsed?.validationPlan ?? null,
    codeChange:
      latestCoderParsed && latestCoderParsed.currentCode !== null && latestCoderParsed.proposedCode !== null
        ? { before: latestCoderParsed.currentCode, after: latestCoderParsed.proposedCode }
        : null,
    validation: resolvedValidation,
    risk: {
      tier: riskTier ?? judge?.risk ?? null,
      reason: attempt?.riskReason ?? null,
      requiresApproval: patch?.requiresApproval ?? (riskTier === 'HIGH' || riskTier === 'MEDIUM'),
    },
    approval: approval
      ? {
          approvalId: approval.approvalId,
          status: approval.status,
          operator: approval.operator,
          createdAt: toIso(approval.createdAt),
          expiresAt: toIso(approval.expiresAt),
          decision: approvalDecision(approval.status),
        }
      : null,
    patch: patch
      ? {
          patchId: patch.patchId,
          status: patch.status,
          file: patch.file,
          line: patch.line,
          function: patch.function,
          risk: patch.risk,
          requiresApproval: patch.requiresApproval,
          originalContent: patch.originalContent,
          appliedContent: patch.appliedContent,
          approvalId: patch.approvalId,
          validationResult: patch.validationResult,
          appliedAt: toIso(patch.appliedAt),
          rolledBackAt: toIso(patch.rolledBackAt),
          validatedAt: toIso(patch.validatedAt),
        }
      : null,
    attempt: attempt
      ? {
          attemptId: attempt.attemptId,
          status: attempt.status,
          risk: attempt.risk,
          riskReason: attempt.riskReason,
          summary: attempt.summary,
          error: attempt.error,
          model: attempt.model,
          startedAt: toIso(attempt.startedAt) ?? '',
          completedAt: toIso(attempt.completedAt),
        }
      : null,
    delivery: {
      last: incident.telegramNotifications[0]
        ? {
            type: incident.telegramNotifications[0].type,
            status: incident.telegramNotifications[0].deliveryStatus,
            telegramMessageId: incident.telegramNotifications[0].telegramMessageId,
            error: incident.telegramNotifications[0].error,
            createdAt: toIso(incident.telegramNotifications[0].createdAt) ?? '',
          }
        : null,
      sentTypes: [...new Set(latestSentenceTypes)],
      anyFailed,
    },
  }

  return brief
}