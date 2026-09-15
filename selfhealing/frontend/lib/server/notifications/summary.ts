import 'server-only'

// Phase 8.5 — canonical incident notification content.
//
// EVERY Telegram message an incident can produce is built here from ONE
// persisted source of truth: `buildIncidentBrief(incidentId)`. The dashboard,
// PDF report and AI chat read the same facts, so "what is in the UI" === "what
// Telegram received". Nothing here ever fabricates a stage: if a step never
// ran it renders as "n/a" or "Pending AI analysis…", never as a made-up value.
//
// Message budget per incident (flood control):
//   INCIDENT                 → 1 brief (attack-aware)
//   ESCALATION (LOW)         → 1 auto-apply repair-plan brief, or for attack
//                              incidents 1 AI-assessment brief
//   HIGH_RISK_APPROVAL_REQUIRED   → 1 (replaces the repair-plan for HIGH)
//   MEDIUM_RISK_APPROVAL_REQUIRED → 1 (replaces the repair-plan for MEDIUM)
//   FINAL_SUMMARY            → 1 terminal summary
// Concrete dedupe is enforced by the delivery layer (one SENT per
// (incident, type)).

import { prisma } from '@/lib/server/db'
import { sendTelegram, escapeTelegramText } from '@/lib/server/telegram'
import type { SendTelegramResult } from '@/lib/server/telegram'
import {
  buildIncidentBrief,
  finalStateOf,
  type IncidentBrief,
} from './brief'
import type { Incident, NotificationType } from '@prisma/client'

export type FinalState = 'RESOLVED' | 'ROLLED_BACK' | 'AI_REPAIR_FAILED' | 'REJECTED' | 'EXPIRED'

export interface ValidationSummary {
  result: 'pass' | 'fail' | 'not_run'
  detail: string | null
  probes: Array<{ name: string; ok: boolean }>
  validatedAt: string | null
}

export interface TerminalSummaryFacts {
  incidentRef: string
  title: string
  severity: string
  status: string
  riskScore: number
  endpoint: string
  method: string
  resolvedAt: string | null
  detectedBy: string | null
  finalState: FinalState
  attack: boolean
  validation: ValidationSummary
  rootCause: string | null
  codeChange: { before: string | null; after: string | null } | null
  validationPlan: string | null
  patch: {
    patchId: string
    file: string | null
    line: number | null
    function: string | null
    risk: string | null
    requiresApproval: boolean
    status: string
    appliedAt: string | null
    rolledBackAt: string | null
  } | null
  approval: {
    approvalId: string
    status: string
    operator: string
    decision: string | null
    reason: string | null
    outcome: string | null
    expiry: string | null
  } | null
  attempt: {
    attemptId: string
    status: string
    risk: string | null
    summary: string | null
  } | null
  system: {
    activeIncidents: number
    siteRisk: number
    cyberSafetyScore: number
    health: '🟢 Operational' | '🟡 Degraded' | '🔴 Critical'
  }
}

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

function shield(value: string | null | undefined, fallback = 'n/a'): string {
  const v = value?.trim() || ''
  return v ? escapeTelegramText(v) : fallback
}

function utcStamp(value: string | null | undefined, fallback = 'n/a'): string {
  if (!value) return fallback
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return shield(value, fallback)
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function fit(value: string, max: number): string {
  const v = value.trim()
  return v.length > max ? `${v.slice(0, max)}…` : v
}

function codeBlock(value: string, max: number): string {
  return `<pre>${escapeTelegramText(fit(value, max))}</pre>`
}

function tierEmoji(tier: string | null): string {
  if (tier === 'HIGH') return '🔴'
  if (tier === 'MEDIUM') return '🟡'
  if (tier === 'LOW') return '🟢'
  return '⚫'
}

function tierWord(tier: string | null): string {
  if (tier === 'HIGH') return 'high'
  if (tier === 'MEDIUM') return 'medium'
  if (tier === 'LOW') return 'low'
  return 'elevated'
}

// ---------------------------------------------------------------------------
// Attack telemetry (honest — never claims a defensive action that did not run)
// ---------------------------------------------------------------------------

function attackTelemetry(brief: IncidentBrief, variant: 'incident' | 'assessment'): string[] {
  const applied =
    brief.patch?.status === 'APPLIED' &&
    (brief.incident.status === 'RESOLVED' || brief.incident.status === 'ROLLED_BACK')
  const mitigations: string[] = []
  if (brief.patch?.appliedContent) mitigations.push('code patch checkpointed & applied')
  if (brief.incident.status === 'RESOLVED') mitigations.push('live validation passed')
  if (brief.incident.status === 'ROLLED_BACK') mitigations.push('change rolled back — system at known-good state')
  if (!applied) mitigations.push('no code change auto-applied — human review required')

  const healing =
    brief.incident.status === 'RESOLVED'
      ? 'self-healed and validated (RESOLVED)'
      : brief.incident.status === 'ROLLED_BACK'
        ? 'returned to known-good state (ROLLED_BACK)'
        : variant === 'assessment'
          ? 'pending human approval — nothing auto-applied'
          : 'analysis in progress'

  return [
    '🧭 ATTACK TELEMETRY',
    `DETECTION ✓ correlated by the Security Log Analyzer`,
    `MITIGATION — ${mitigations.join('; ')}`,
    `SELF-HEALING — ${healing}`,
  ]
}

// ---------------------------------------------------------------------------
// Full briefing (Ten required sections)
// ---------------------------------------------------------------------------

interface BriefingOptions {
  header: string
  heading1: string
  showApprovalActions?: boolean
  attack?: boolean
}

function aiAnalysisLines(brief: IncidentBrief): string[] {
  const lines: string[] = []
  if (brief.aiAnalysis.judge) {
    const judge = brief.aiAnalysis.judge
    const confidence = judge.confidence != null ? ` · confidence ${judge.confidence}%` : ''
    lines.push(`Judge: ${shield(judge.decision)}${confidence}`)
    if (judge.reasoning) lines.push(`Judge reasoning: ${fit(shield(judge.reasoning), 300)}`)
  } else if (brief.aiAnalysis.roundsUsed === 0) {
    lines.push('Analysis is pending…')
    return lines
  }
  const mode = brief.aiAnalysis.providerMode ? ` · provider ${shield(brief.aiAnalysis.providerMode)}` : ''
  lines.push(`Round${brief.aiAnalysis.roundsUsed === 1 ? '' : 's'}: ${brief.aiAnalysis.roundsUsed}${mode}`)
  for (const round of brief.aiAnalysis.rounds.slice(0, 3)) {
    const coder = round.coder.diagnosis ? fit(shield(round.coder.diagnosis), 180) : 'n/a'
    const critic = round.critic.verdict
      ? `${shield(round.critic.verdict)} — ${fit(shield(round.critic.reasoning), 120)}`
      : 'n/a'
    lines.push(`R${round.round} · Coder: ${coder}`)
    lines.push(`R${round.round} · Critic: ${critic}`)
  }
  return lines
}

function validationLines(brief: IncidentBrief): string[] {
  const lines: string[] = []
  if (brief.validationPlan) lines.push(`Plan: ${fit(shield(brief.validationPlan), 240)}`)
  if (brief.validation.result === 'pass') {
    const n = brief.validation.probes.length
    lines.push(`Result: ✓ PASS${n > 0 ? ` (${n}/${n} probes OK)` : ''}`)
  } else if (brief.validation.result === 'fail') {
    lines.push(`Result: ✗ FAIL — ${shield(brief.validation.detail)}`)
  } else {
    lines.push('Result: not run')
  }
  return lines
}

function riskPolicyLines(brief: IncidentBrief): string[] {
  const tier = brief.risk.tier
  const emoji = tierEmoji(tier)
  const tierLabel = tier ?? 'UNDETERMINED'
  const lines = [`Policy: ${emoji} ${escapeTelegramText(tierLabel)} RISK`]
  if (brief.risk.reason) lines.push(`Why: ${fit(shield(brief.risk.reason), 260)}`)
  if (brief.incident.status === 'WAITING_APPROVAL' || brief.risk.requiresApproval) {
    lines.push('Action: human approval required — nothing auto-applied.')
  } else if (tier === 'LOW') {
    lines.push('Action: auto-apply → validate → keep if PASS → rollback if FAIL.')
  }
  return lines
}

function briefing(brief: IncidentBrief, opts: BriefingOptions): string {
  const lines: string[] = [`<b>${escapeTelegramText(opts.header)}</b>`]

  lines.push(
    `Incident: ${shield(brief.incident.ref)} · ${shield(brief.incident.severity)} · Risk ${brief.incident.riskScore}/100`,
    `📟 ${opts.heading1}`,
    `${fit(shield(brief.incident.title), 240)}`,
    `${fit(shield(brief.incident.description), 500) || 'n/a'}`,
  )

  lines.push('📍 TRIGGER')
  lines.push(
    `Endpoint: ${shield(brief.incident.method)} ${shield(brief.incident.endpoint)}`,
    `Detected by: ${shield(brief.incident.detectedBy)}`,
    `Error: ${shield(brief.incident.errorCode) === 'n/a' ? 'n/a' : shield(brief.incident.errorCode)} · Request: ${shield(brief.incident.requestId)}`,
  )

  lines.push('🔎 ROOT CAUSE')
  lines.push(
    brief.rootCause
      ? fit(shield(brief.rootCause), 600)
      : brief.aiAnalysis.roundsUsed === 0
        ? 'Pending AI analysis…'
        : 'n/a',
  )

  lines.push('📁 LOCATION')
  const loc = brief.location
  lines.push(
    loc?.file
      ? `${shield(loc.file)}${loc.line ? `:${loc.line}` : ''} · ${shield(loc.function)}`
      : brief.aiAnalysis.roundsUsed === 0
        ? 'Pending AI analysis…'
        : 'n/a',
  )

  lines.push('🤖 AI ANALYSIS')
  lines.push(...aiAnalysisLines(brief))

  lines.push('🔧 PROPOSED FIX')
  lines.push(
    brief.proposedFix
      ? fit(shield(brief.proposedFix), 600)
      : brief.aiAnalysis.roundsUsed === 0
        ? 'Pending AI analysis…'
        : 'n/a',
  )

  lines.push('📝 CODE CHANGE')
  if (
    brief.codeChange &&
    brief.codeChange.before !== null &&
    brief.codeChange.after !== null
  ) {
    lines.push('Before:')
    lines.push(codeBlock(brief.codeChange.before, 1200))
    lines.push('After:')
    lines.push(codeBlock(brief.codeChange.after, 1200))
  } else {
    lines.push(
      brief.aiAnalysis.roundsUsed === 0
        ? 'Pending AI analysis…'
        : 'Exact code diff is available in BuildHub /ai.',
    )
  }

  lines.push('🧪 VALIDATION')
  lines.push(...validationLines(brief))

  lines.push('⚙️ RISK POLICY')
  lines.push(...riskPolicyLines(brief))

  if (opts.attack) {
    lines.push('')
    lines.push(...attackTelemetry(brief, 'incident'))
  }

  if (opts.showApprovalActions && brief.approval) {
    const approval = brief.approval
    lines.push('')
    lines.push('⚠️ HUMAN ACTION REQUIRED')
    if (brief.risk.reason) lines.push(`Why ${tierWord(brief.risk.tier)} risk: ${fit(shield(brief.risk.reason), 300)}`)
    lines.push(`Approval: ${shield(approval.approvalId)}`)
    lines.push(`Expires: ${utcStamp(approval.expiresAt, 'n/a')} (5 minutes)`)
    lines.push('')
    lines.push(`Reply PROCEED ${shield(approval.approvalId, '')}`)
    lines.push(`Reply REJECT ${shield(approval.approvalId, '')}`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Public builders (each loads the canonical brief from the persisted facts)
// ---------------------------------------------------------------------------

/** Initial INCIDENT alert — attack-aware, all ten briefing sections. */
export async function buildIncidentAlertMessage(incident: Incident): Promise<string> {
  const brief = await buildIncidentBrief(incident.id)
  if (!brief) return `<b>🚨 BUILDHUB INCIDENT</b>\nIncident: ${escapeTelegramText(incident.ref)}`
  return briefing(brief, {
    header: brief.attack ? '🛡️ BUILDHUB ATTACK DETECTED' : '🚨 BUILDHUB INCIDENT DETECTED',
    heading1: '🔴 PROBLEM',
    attack: brief.attack,
  })
}

/** LOW auto-repair plan (ESCALATION after analysis + risk classification). Only
 *  LOW repairs auto-apply — MEDIUM/HIGH stop at WAITING_APPROVAL instead. */
export async function buildRepairPlanMessage(incident: Incident): Promise<string> {
  const brief = await buildIncidentBrief(incident.id)
  const tier = brief?.risk.tier ?? null
  const header =
    tier === 'HIGH'
      ? '🔴 BUILDHUB HIGH-RISK REPAIR — APPROVAL REQUIRED'
      : tier === 'MEDIUM'
        ? '🟡 BUILDHUB MEDIUM-RISK REPAIR — APPROVAL REQUIRED'
        : tier === 'LOW'
          ? '🟢 BUILDHUB LOW-RISK REPAIR — AUTO-APPLY'
          : '⚙️ BUILDHUB REPAIR PLAN'
  if (!brief) return `<b>${escapeTelegramText(header)}</b>\nIncident: ${escapeTelegramText(incident.ref)}`
  return briefing(brief, { header, heading1: '🔨 REPAIR PLAN' })
}

/** Legacy security-analysis completion update (attack incidents). */
export async function buildAttackAnalysisMessage(incident: Incident): Promise<string> {
  const brief = await buildIncidentBrief(incident.id)
  if (!brief) return '<b>🛡️ BUILDHUB ATTACK — AI ASSESSMENT</b>'
  return briefing(brief, {
    header: '🛡️ BUILDHUB ATTACK — AI ASSESSMENT',
    heading1: '🔴 PROBLEM',
    attack: true,
  })
}

/** MEDIUM/HIGH-risk repair approval request. MEDIUM uses
 *  MEDIUM_RISK_APPROVAL_REQUIRED, HIGH keeps HIGH_RISK_APPROVAL_REQUIRED. */
export async function buildApprovalRequiredMessage(
  incident: Incident,
  risk: 'MEDIUM' | 'HIGH' = 'HIGH',
): Promise<string> {
  const brief = await buildIncidentBrief(incident.id)
  const header =
    risk === 'MEDIUM'
      ? '🟡 BUILDHUB MEDIUM-RISK REPAIR — APPROVAL REQUIRED'
      : '🔴 BUILDHUB HIGH-RISK REPAIR — APPROVAL REQUIRED'
  if (!brief) {
    return [
      `<b>${escapeTelegramText(header)}</b>`,
      `Incident: ${escapeTelegramText(incident.ref)}`,
    ].join('\n')
  }
  return briefing(brief, {
    header,
    heading1: '🔴 PROBLEM',
    showApprovalActions: true,
  })
}

// ---------------------------------------------------------------------------
// Terminal summary facts + FINAL_SUMMARY message
// ---------------------------------------------------------------------------

/** Mirror of observability.computeOverview terms, derived locally to keep the
 *  summary module dependency-free (avoids an import cycle). Used ONLY to render
 *  the terminal "System Health" line from the same stored facts Telegram sees. */
async function systemSnapshot(): Promise<TerminalSummaryFacts['system']> {
  const active = await prisma.incident.findMany({
    where: { status: { in: ['DETECTED', 'INVESTIGATING', 'AWAITING_REVIEW', 'WAITING_APPROVAL'] } },
    select: { riskScore: true, cyberSafetyImpact: true },
  })
  const siteRisk = Math.min(
    Math.round(active.reduce((sum, row) => sum + row.riskScore, 0)),
    100,
  )
  const cyberImpact = active.reduce((sum, row) => sum + row.cyberSafetyImpact, 0)
  const cyberSafetyScore = Math.max(0, Math.min(100, Math.round(100 - cyberImpact)))
  const health: TerminalSummaryFacts['system']['health'] =
    active.length === 0
      ? '🟢 Operational'
      : active.length <= 2
        ? '🟡 Degraded'
        : '🔴 Critical'
  return { activeIncidents: active.length, siteRisk, cyberSafetyScore, health }
}

export async function loadTerminalSummaryFacts(incident: Incident): Promise<TerminalSummaryFacts> {
  const brief = await buildIncidentBrief(incident.id)
  const system = await systemSnapshot()

  const fallback: TerminalSummaryFacts = {
    incidentRef: incident.ref,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    riskScore: incident.riskScore,
    endpoint: `${incident.method} ${incident.endpoint}`,
    method: incident.method,
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    detectedBy: incident.detectedBy,
    finalState: 'AI_REPAIR_FAILED',
    attack: false,
    validation: { result: 'not_run', detail: null, probes: [], validatedAt: null },
    rootCause: null,
    codeChange: null,
    validationPlan: null,
    patch: null,
    approval: null,
    attempt: null,
    system,
  }
  if (!brief) return fallback

  const finalState: FinalState = finalStateOf(brief)
  const validation: ValidationSummary =
    finalState === 'ROLLED_BACK'
      ? {
          result: 'fail',
          detail: brief.patch?.validationResult ?? brief.patch?.status ?? 'validation failed',
          probes: brief.validation.probes,
          validatedAt: brief.patch?.rolledBackAt ?? brief.validation.validatedAt,
        }
      : {
          result: brief.validation.result,
          detail: brief.validation.detail,
          probes: brief.validation.probes,
          validatedAt: brief.validation.validatedAt,
        }

  return {
    incidentRef: brief.incident.ref,
    title: brief.incident.title,
    severity: brief.incident.severity,
    status: brief.incident.status,
    riskScore: brief.incident.riskScore,
    endpoint: `${brief.incident.method} ${brief.incident.endpoint}`,
    method: brief.incident.method,
    resolvedAt: brief.incident.resolvedAt,
    detectedBy: brief.incident.detectedBy,
    finalState,
    attack: brief.attack,
    validation,
    rootCause: brief.rootCause,
    codeChange: brief.codeChange,
    validationPlan: brief.validationPlan,
    patch: brief.patch
      ? {
          patchId: brief.patch.patchId,
          file: brief.patch.file,
          line: brief.patch.line,
          function: brief.patch.function,
          risk: brief.patch.risk,
          requiresApproval: brief.patch.requiresApproval,
          status: brief.patch.status,
          appliedAt: brief.patch.appliedAt,
          rolledBackAt: brief.patch.rolledBackAt,
        }
      : null,
    approval: brief.approval
      ? {
          approvalId: brief.approval.approvalId,
          status: brief.approval.status,
          operator: brief.approval.operator ?? 'unknown',
          decision: brief.approval.decision ?? brief.approval.status,
          reason: null,
          outcome: null,
          expiry: brief.approval.expiresAt,
        }
      : null,
    attempt: brief.attempt
      ? {
          attemptId: brief.attempt.attemptId,
          status: brief.attempt.status,
          risk: brief.attempt.risk,
          summary: brief.attempt.summary,
        }
      : null,
    system,
  }
}

function terminalHeader(finalState: FinalState): string {
  switch (finalState) {
    case 'RESOLVED':
      return '✅ BUILDHUB REPAIR SUCCESSFUL'
    case 'ROLLED_BACK':
      return '🔄 REPAIR FAILED — ROLLBACK'
    case 'REJECTED':
      return '🛑 HIGH-RISK REPAIR REJECTED'
    case 'EXPIRED':
      return '⏰ APPROVAL EXPIRED'
    default:
      return '⚠️ AI REPAIR FAILED'
  }
}

export function buildTerminalSummaryText(facts: TerminalSummaryFacts): string {
  const lines = [`<b>${terminalHeader(facts.finalState)}</b>`]
  lines.push(
    `Incident: ${escapeTelegramText(facts.incidentRef)}`,
    `Title: ${escapeTelegramText(facts.title)}`,
    `Severity: ${facts.severity} · Risk ${facts.riskScore}/100 · Status: ${facts.status}`,
    `Endpoint: ${escapeTelegramText(facts.endpoint)}`,
  )
  if (facts.rootCause) lines.push(`Root cause: ${fit(escapeTelegramText(facts.rootCause), 300)}`)
  if (facts.patch) {
    const patch = facts.patch
    lines.push(
      `Patch: ${escapeTelegramText(patch.patchId)}${patch.risk ? ` · ${escapeTelegramText(patch.risk)} risk` : ''} · ${escapeTelegramText(patch.file ?? '?')}${patch.line ? `:${patch.line}` : ''}`,
    )
  }
  if (facts.approval) {
    lines.push(
      `Approval: ${escapeTelegramText(facts.approval.approvalId)} · ${escapeTelegramText(facts.approval.decision ?? facts.approval.status)}${facts.approval.operator ? ` by ${escapeTelegramText(facts.approval.operator)}` : ''}`,
    )
  }
  if (facts.validation.result === 'pass') {
    const probeLine =
      facts.validation.probes.length > 0
        ? ` ✓ ${facts.validation.probes.length}/${facts.validation.probes.length} probes OK`
        : ' ✓'
    lines.push(`Validation: PASS${probeLine}`)
  } else if (facts.validation.result === 'fail') {
    lines.push(`Validation: ✗ FAIL — ${escapeTelegramText(fit(facts.validation.detail ?? 'validation failed', 200))}`)
  } else {
    lines.push('Validation: not run')
  }
  if (facts.validationPlan) lines.push(`Validation plan: ${fit(escapeTelegramText(facts.validationPlan), 200)}`)

  lines.push(
    '',
    `System Health: ${facts.system.health} — ${facts.system.activeIncidents} active`,
    `Cyber Score: ${facts.system.cyberSafetyScore}/100 · Site Risk: ${facts.system.siteRisk}/100`,
  )

  switch (facts.finalState) {
    case 'RESOLVED':
      lines.push('Outcome: patch applied, validated and the incident is resolved.')
      break
    case 'ROLLED_BACK':
      lines.push('Outcome: patch applied but validation FAILED — rolled back to the checkpointed original; the system is restored to known-good state.')
      break
    case 'REJECTED':
      lines.push('Outcome: the HIGH-risk repair was rejected by a human operator — no code change was applied.')
      break
    case 'EXPIRED':
      lines.push('Outcome: the approval expired without a decision — no code change was applied. Re-run the repair to refresh the approval request.')
      break
    default:
      lines.push('Outcome: AI repair failed — no safe patch could be produced. The incident remains open for manual review.')
  }
  if (facts.attempt?.summary) lines.push(`Attempt: ${fit(escapeTelegramText(facts.attempt.summary), 240)}`)
  if (facts.attack) lines.push('Note: security-log-analyzer incident (attack telemetry).')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Senders
// ---------------------------------------------------------------------------

/** Sends the canonical terminal FINAL_SUMMARY (dedupe: 1 per incident). */
export async function sendIncidentTerminalSummary(incident: Incident): Promise<SendTelegramResult> {
  const facts = await loadTerminalSummaryFacts(incident)
  const message = buildTerminalSummaryText(facts)
  return sendTelegram({
    type: 'FINAL_SUMMARY',
    message,
    incidentId: incident.id,
    severity: incident.severity,
  })
}

/** Sends the initial `INCIDENT` alert for a newly created incident. */
export async function sendIncidentAlert(incident: Incident): Promise<SendTelegramResult> {
  return sendTelegram({
    type: 'INCIDENT',
    message: await buildIncidentAlertMessage(incident),
    incidentId: incident.id,
    severity: incident.severity,
  })
}

/** Sends the auto-repair plan (ESCALATION) for a LOW incident (the only tier
 *  that auto-applies). */
export async function sendRepairPlanMessage(incident: Incident): Promise<SendTelegramResult> {
  return sendTelegram({
    type: 'ESCALATION',
    message: await buildRepairPlanMessage(incident),
    incidentId: incident.id,
    severity: incident.severity,
  })
}

/** Retry target used by the status/realtime layers to reload terminal facts. */
export function summaryNotificationType(): NotificationType {
  return 'FINAL_SUMMARY'
}