import 'server-only'

// Phase 9 — iterative repair conversation engine.
//
// One RepairAttempt runs the Analyzer → Coder/Critic loop (up to
// MAX_CODER_ROUNDS) with early acceptance, followed by a final Judge verdict.
// Every single agent call is persisted on AgentRun (round, kind, tokens,
// duration, context) with an honest status, so the dashboard state is a
// transcript of reality.
//
// Every prompt is sized against a hard per-agent token budget BEFORE the call
// (see evidence-compactor): the evidence header is built at the tightest level
// that still fits, and an HTTP 413 triggers one retry of the SAME agent with a
// further-compacted context — never a new incident or a recursive restart.

import { prisma } from '@/lib/server/db'
import { getProvider } from '@/lib/server/provider'
import { addIncidentEvent } from '@/lib/server/repair/events'
import { logger } from '@/lib/server/logger'
import { trace, type TraceStage } from '@/lib/server/repair/trace'
import {
  AnalyzerSchema,
  CoderSchema,
  CriticSchema,
  JudgeSchema,
  extractJsonObject,
  validateWith,
  type AnalyzerOutput,
} from '@/lib/ai/schemas'
import {
  ANALYZER_SYSTEM,
  CODER_SYSTEM,
  CRITIC_SYSTEM,
  JUDGE_SYSTEM,
  assembleUserPayload,
} from '@/lib/ai/prompts'
import {
  renderLogRows,
  focusedSourceWindow,
  renderMemoryHints,
  truncate,
} from '@/lib/server/ai/context-builder'
import {
  ROLE_TOKEN_BUDGET,
  estimateMessagesTokens,
  isContextSizeFailure,
  type HeaderRole,
} from '@/lib/server/ai/evidence-compactor'
import { architectureExtract } from '@/lib/server/repair/evidence'
import type {
  AgentRole,
  ChatMessage,
  CoderOutput,
  CriticOutput,
  JudgeOutput,
  ProviderCall,
  ProviderResponse,
  RepairEvidence,
} from '@/lib/server/providers/types'
import type { Incident, RepairAttempt } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { FAULT_REGISTRY, isFaultActive } from '@/lib/server/fault-injection'

export const MAX_CODER_ROUNDS = 2

export interface RepairOptions {
  maxRounds?: number
  scenario?: string
}

export interface TurnResult {
  role: AgentRole
  round: number
  agentRunId: string
  status: 'COMPLETE' | 'FAILED'
  output: CoderOutput | CriticOutput | JudgeOutput | AnalyzerOutput | null
  summary: string
  error?: string
  model: string
  mode: 'REAL' | 'TEST'
}

export interface ConversationResult {
  attempt: RepairAttempt
  converged: boolean
  roundsUsed: number
  stopReason:
    | 'CODER_ACCEPTED'
    | 'CODER_REJECTED'
    | 'ROUNDS_EXHAUSTED'
    | 'CODER_FAILED'
    | 'JUDGE_FAILED'
  candidate: CoderOutput | null
  judge: JudgeOutput | null
  turns: TurnResult[]
  coderCode: string | null
  humanBrief: string
}

export async function nextAttemptId(): Promise<string> {
  const rows = await prisma.repairAttempt.findMany({ select: { attemptId: true } })
  let max = 0
  for (const row of rows) {
    const match = row.attemptId.match(/^RPR-(\d+)$/)
    if (match) max = Math.max(max, Number.parseInt(match[1], 10))
  }
  return `RPR-${String(max + 1).padStart(5, '0')}`
}

export async function createRepairAttempt(incident: Incident): Promise<RepairAttempt> {
  return prisma.repairAttempt.create({
    data: { attemptId: await nextAttemptId(), incidentId: incident.id, status: 'INCIDENT_DETECTED' },
  })
}

export async function updateAttemptStatus(
  attemptId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await prisma.repairAttempt.update({ where: { id: attemptId }, data: { status, ...extra } })
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/** Evidence compaction levels: 0 = full (budget-checked), 1 = tightened
 * (drop most logs/memory, halve source/architecture), 2 = minimal core
 * (error + endpoint + file/function + small source window — never truncated). */
type HeaderLevel = 0 | 1 | 2

const LEVEL_CAPS = [
  { logs: 4, memory: 1, source: 1500, arch: 2500, stack: 10, error: 500 },
  { logs: 2, memory: 1, source: 1000, arch: 1600, stack: 8, error: 400 },
  { logs: 0, memory: 0, source: 700, arch: 1200, stack: 6, error: 300 },
] as const

/**
 * Builds the evidence header for ONE agent role at a given compaction level.
 * Every role starts from the SAME priority order: exact error → stack →
 * endpoint → architecture component → affected file/function → relevant source
 * → logs/memory. The Coder (the only agent that must write real code) sees the
 * source, logs and memory; the Critic sees the source to verify against; the
 * Analyzer and Judge only need the failure context. The architecture document
 * is injected as a compact component-map extract — never the full file — so
 * prompts stay far below the provider's input-token cap.
 */
function evidenceHeaderFor(evidence: RepairEvidence, role: HeaderRole, level: HeaderLevel = 0): string {
  const caps = LEVEL_CAPS[level]
  const lines: string[] = [
    `Incident ${evidence.incidentRef} (${evidence.severity})`,
    `Title: ${evidence.title}`,
    `Endpoint: ${evidence.method} ${evidence.endpoint}`,
    `Error code: ${evidence.errorCode ?? 'n/a'}`,
    `Suspect source (hint): ${evidence.suspectSource}`,
    ``,
    `## Error context`,
    truncate(evidence.description, role === 'ANALYZER' ? caps.error : role === 'CODER' ? caps.error : Math.min(caps.error, 400)),
  ]
  if (role === 'ANALYZER' || role === 'CODER') {
    const stack = evidence.stackTrace ? cappedLines(evidence.stackTrace, caps.stack) : null
    if (stack) lines.push(``, `## Stack trace`, stack)
  }
  const arch = architectureExtract(evidence.architectureDoc, evidence.method, evidence.endpoint, evidence.suspectSource)
  lines.push(``, `## System architecture map (single source of truth)`, truncate(arch, caps.arch))
  if (role === 'CODER') {
    if (caps.logs > 0 && evidence.logs.length > 0) {
      lines.push(``, `## Recent log evidence`, ...renderLogRows(evidence.logs, caps.logs))
    }
    if (caps.memory > 0 && evidence.memoryHints.length > 0) {
      lines.push(
        ``,
        `## Repair memory (outcomes from earlier incidents)`,
        ...renderMemoryHints(evidence.memoryHints, caps.memory),
      )
    }
    // The defect-bearing line must stay visible: focus on the error-text
    // defect site instead of head-truncating (which would cut the defect off
    // whenever it sits past the budget and leave the Coder guessing blindly).
    const source = focusedSourceWindow(evidence.sourceContext, caps.source, errorNeedles(evidence))
    if (source) {
      lines.push(``, `## Current source (environment view)`, source)
      // Factual reuse hint from the REAL source: if the file already imports
      // the fault-injection guard helper, the Coder must reuse that import
      // instead of adding one (a duplicate import would break typecheck).
      if ((evidence.sourceContext ?? '').includes('isFaultActive')) {
        lines.push(`Note: this file already imports isFaultActive from '@/lib/server/fault-injection' — reuse the existing import, do not add another.`)
      }
    }
  }
  if (role === 'CRITIC') {
    const source = focusedSourceWindow(evidence.sourceContext, caps.source, errorNeedles(evidence))
    if (source) lines.push(``, `## Current source (environment view)`, source)
    // The Critic judges against history too: prior failures/regressions for
    // this signature must weigh against the proposal.
    if (caps.memory > 0 && evidence.memoryHints.length > 0) {
      lines.push(
        ``,
        `## Repair memory (outcomes from earlier incidents)`,
        ...renderMemoryHints(evidence.memoryHints, Math.min(caps.memory, 2)),
      )
    }
  }
  return lines.join('\n')
}

/**
 * Distinctive error-text needles so the focused source window pivots on the
 * defect site instead of the file head. The incident description always
 * carries an `Error: <message>` line (see log-monitor describe()); the defect
 * site usually quotes that message verbatim (e.g. the unconditional LOW-01
 * throw). Short/empty messages yield no needles and the window falls back to
 * the marked stack-frame line, then the file head.
 */
function errorNeedles(evidence: RepairEvidence): string[] {
  const match = evidence.description.match(/^Error:\s*(.+)$/m)
  const msg = (match?.[1] ?? '').trim()
  if (msg.length < 12) return []
  const head = msg.slice(0, 32)
  const tail = msg.length > 32 ? msg.slice(-32) : ''
  return tail ? [head, tail] : [head]
}

function cappedLines(value: string, maxLines: number): string {
  const lines = value.split('\n')
  if (lines.length <= maxLines) return value
  return `${lines.slice(0, maxLines).join('\n')}\n…[${lines.length - maxLines} more lines]`
}

function transcriptBlock(coder: CoderOutput, critic: CriticOutput | null, level: HeaderLevel = 0): string {
  const codeCap = level === 0 ? 1500 : level === 1 ? 1000 : 600
  const lines = [
    `--- Proposal (Coder) ---`,
    `file: ${coder.file}${coder.line ? `:${coder.line}` : ''}`,
    `runtimeRepair: ${coder.runtimeRepair ?? 'null (ordinary source patch)'}`,
    `CURRENT (faulty):\n${truncate(coder.currentCode, codeCap)}`,
    ``,
    `PROPOSED (fix):\n${truncate(coder.proposedCode, codeCap)}`,
  ]
  if (critic) {
    const reasoningCap = level === 0 ? 600 : 300
    lines.push(
      ``,
      `--- Review (Critic: ${critic.verdict}) ---`,
      `Reasoning: ${truncate(critic.reasoning, reasoningCap)}`,
      `Problems: ${truncate(critic.problems.join('; ') || 'none', 200)}`,
      `Required changes: ${truncate(critic.requiredChanges.join('; ') || 'none', 200)}`,
    )
  }
  return lines.join('\n')
}

/** Compact current/proposed candidate for the Critic prompt (avoids the full
 * Coder JSON blob, which the small model mis-reads). */
function candidateDiff(coder: CoderOutput, level: HeaderLevel = 0): string {
  const codeCap = level === 0 ? 1500 : level === 1 ? 1000 : 600
  return [
    `file: ${coder.file}${coder.line ? `:${coder.line}` : ''}`,
    `runtimeRepair: ${coder.runtimeRepair ?? 'null (ordinary source patch)'}`,
    `CURRENT (faulty):`,
    truncate(coder.currentCode, codeCap),
    ``,
    `PROPOSED (fix):`,
    truncate(coder.proposedCode, codeCap),
  ].join('\n')
}

function analyzerPromptFor(header: string): ChatMessage[] {
  return [
    { role: 'system', content: ANALYZER_SYSTEM },
    { role: 'user', content: assembleUserPayload(header, [`## Task`, `Diagnose the incident and rank the suspected files.`]) },
  ]
}

// ---------------------------------------------------------------------------
// JSON normalization
// ---------------------------------------------------------------------------

// Strict schema-first parsing: a response that fails the contract becomes a
// FAILED agent run (never partially trusted). Post-processing only normalizes
// optional fields (e.g. rootCause defaults to diagnosis).

export function parseCoder(parsed: Record<string, unknown> | null): CoderOutput | null {
  const result = validateWith(CoderSchema, parsed)
  if (!result.ok) return null
  const v = result.value
  return {
    diagnosis: v.diagnosis,
    rootCause: v.rootCause.length > 0 ? v.rootCause : v.diagnosis,
    file: v.file,
    line: v.line,
    function: v.function,
    affectedBehavior: v.affectedBehavior,
    currentCode: v.currentCode,
    proposedCode: v.proposedCode,
    validationPlan: v.validationPlan,
    confidence: v.confidence,
    runtimeRepair: v.runtimeRepair ?? undefined,
  }
}

export function parseCritic(parsed: Record<string, unknown> | null): CriticOutput | null {
  const result = validateWith(CriticSchema, parsed)
  if (!result.ok) return null
  const v = result.value
  return {
    verdict: v.verdict,
    reasoning: v.reasoning,
    problems: v.problems,
    requiredChanges: v.requiredChanges,
    testsRequired: v.testsRequired,
    securityConcerns: v.securityConcerns,
  }
}

export function parseJudge(parsed: Record<string, unknown> | null): JudgeOutput | null {
  const result = validateWith(JudgeSchema, parsed)
  if (!result.ok) return null
  const v = result.value
  return {
    decision: v.decision,
    reasoning: v.reasoning,
    confidence: v.confidence,
    risk: v.risk,
    validationItems: v.validationItems,
  }
}

export function parseAnalyzer(parsed: Record<string, unknown> | null): AnalyzerOutput | null {
  const result = validateWith(AnalyzerSchema, parsed)
  if (!result.ok) return null
  return result.value
}

// ---------------------------------------------------------------------------
// Provider call + persistence per turn
// ---------------------------------------------------------------------------

interface StoredResult {
  agentRunId: string
  status: 'COMPLETE' | 'FAILED'
  output: CoderOutput | CriticOutput | JudgeOutput | AnalyzerOutput | null
  summary: string
  error?: string
  model: string
  mode: 'REAL' | 'TEST'
  durationMs: number
  promptTokens: number | null
  completionTokens: number | null
}

function stageLabelFor(role: AgentRole): TraceStage {
  if (role === 'ANALYZER') return 'AGENT-1 ANALYZER'
  if (role === 'CODER') return 'AGENT-2 CODER'
  if (role === 'CRITIC') return 'AGENT-3 CRITIC'
  return 'JUDGE'
}

function traceCall(
  role: AgentRole,
  message: string,
  incidentId: string,
  incidentRef: string,
  endpoint: string,
  method: string,
): void {
  trace(stageLabelFor(role), message, {
    incidentRef,
    incidentId,
    route: endpoint,
    method,
  })
}

/** Persists one agent turn. The messages are built lazily per compaction level
 * so the SAME agent/round can be re-invoked with a reduced context when the
 * provider rejects the prompt as too large (HTTP 413 / input-token cap) — once,
 * deterministically, never spawning a new incident or a recursive restart. */
async function callAndStore(
  incident: Incident,
  role: AgentRole,
  roleLabel: string,
  round: number,
  build: (level: HeaderLevel) => ChatMessage[],
  options: RepairOptions,
  evidence: RepairEvidence,
): Promise<StoredResult> {
  const provider = getProvider()
  const model = provider.configuredModel()
  const budget = ROLE_TOKEN_BUDGET[role as HeaderRole]
  const startedAt = Date.now()

  // Pre-flight: choose the tightest level whose estimated size fits the budget
  // so we never start a call the input-token cap would reject out of hand.
  let level: HeaderLevel = 0
  let messages = build(level)
  while (level < 2 && estimateMessagesTokens(messages) > budget) {
    level = (level + 1) as HeaderLevel
    messages = build(level)
  }
  const contextSize = estimateMessagesTokens(messages)

  const stored = await prisma.agentRun.create({
    data: {
      incidentId: incident.id,
      agent: role,
      role: roleLabel,
      status: 'ANALYZING',
      progress: 30,
      currentActivity: `Calling ${provider.name} (${role}) round ${round} — context ${contextSize} tok`,
      mode: provider.mode,
      model,
      round,
      kind: role,
    },
  })

  traceCall(role, `round ${round} context size: ${contextSize} tokens (budget ${budget})`, incident.id, evidence.incidentRef, evidence.endpoint, evidence.method)

  const call = (msgs: ChatMessage[]): ProviderCall => {
    return {
      model,
      messages: msgs,
      // Output-side provider cap: Groq's small on_demand tier enforces OTPM
      // 1000 — requesting more is rejected outright (429). 800 is plenty for
      // the strict small-JSON agent contracts.
      maxTokens: 800,
      temperature: 0.2,
      context: {
        role,
        round,
        scenario: options.scenario,
        // Real repair evidence is handed only to the hermetic TEST provider so it
        // can reason deterministically from the actual failure. LLM providers get
        // everything via the message content and receive no extra context.
        evidence: provider.name === 'test' ? evidence : undefined,
      },
    }
  }

  const safeCall = async (msgs: ChatMessage[]): Promise<ProviderResponse> => {
    try {
      return await provider.call(call(msgs))
    } catch (err) {
      return {
        ok: false,
        status: 'FAILED',
        provider: provider.name,
        mode: provider.mode,
        model,
        error: err instanceof Error ? err.message : 'provider threw',
      }
    }
  }
  // One bounded retry on provider rate limiting (Groq on_demand tiers reject
  // bursts with 429): wait, retry once, trace both attempts. Anything else
  // fails fast — no retry loops, no new incidents.
  const callWithRateLimitRetry = async (msgs: ChatMessage[], roleLabel: string): Promise<ProviderResponse> => {
    const first = await safeCall(msgs)
    const limited = !first.ok && /rate limit|429|rate_limit|too many requests/i.test(first.error ?? '')
    if (!limited) return first
    traceCall(role, `${roleLabel} rate-limited — waiting 25s for one retry`, incident.id, evidence.incidentRef, evidence.endpoint, evidence.method)
    await new Promise((r) => setTimeout(r, 25_000))
    return safeCall(msgs)
  }

  let response = await callWithRateLimitRetry(messages, `round ${round}`)
  let compacted: { from: number; to: number; level: HeaderLevel } | null = null
  if (!response.ok && isContextSizeFailure(response.error) && level < 2) {
    const fromTokens = estimateMessagesTokens(messages)
    level = (level + 1) as HeaderLevel
    messages = build(level)
    const toTokens = estimateMessagesTokens(messages)
    compacted = { from: fromTokens, to: toTokens, level }
    traceCall(role, `round ${round} failed (${response.error}) — 413/context-size`, incident.id, evidence.incidentRef, evidence.endpoint, evidence.method)
    trace('EVIDENCE', `${role} context compacted: ${fromTokens} → ${toTokens} tokens`, {
      incidentRef: evidence.incidentRef,
      incidentId: incident.id,
      route: evidence.endpoint,
      method: evidence.method,
    })
    traceCall(role, `round ${round} retry starting (compacted context, level ${level})`, incident.id, evidence.incidentRef, evidence.endpoint, evidence.method)
    response = await safeCall(messages)
  }

  const durationMs = Date.now() - startedAt

  const output = response.ok && response.content ? normalizeRoleOutput(role, response.content) : null
  const status: 'COMPLETE' | 'FAILED' = output !== null ? 'COMPLETE' : 'FAILED'
  const summary = output ? summarize(role, output) : (response.error ?? 'AI output unparseable')
  const error = status === 'FAILED' ? (response.error ?? 'unparseable AI output') : null

  await prisma.agentRun.update({
    where: { id: stored.id },
    data: {
      status,
      progress: 100,
      currentActivity: null,
      output: (output ? (output as unknown as Prisma.InputJsonValue) : Prisma.JsonNull) as Prisma.InputJsonValue | undefined,
      outputSummary: summary.slice(0, 300),
      confidence: output && 'confidence' in output && typeof output.confidence === 'number' ? output.confidence : null,
      model: response.model ?? model,
      error,
      durationMs,
      promptTokens: response.promptTokens ?? null,
      completionTokens: response.completionTokens ?? null,
      context: {
        provider: provider.name,
        scenario: options.scenario ?? null,
        contextSize,
        contextLevel: level,
        compacted,
        promptTail: messages[messages.length - 1].content.slice(-1400),
        rawOutput: response.content ? response.content.slice(0, 3000) : null,
        evidence: { incidentRef: evidence.incidentRef, endpoint: evidence.endpoint },
      },
      completedAt: new Date(),
    },
  })

  if (status === 'FAILED') {
    await logger.error({
      service: 'self-healing',
      message: `${role} round ${round} failed: ${error}`,
      route: evidence.endpoint,
      method: evidence.method,
      status: 503,
      requestId: evidence.requestId ?? undefined,
      incidentId: incident.id,
      errorCode: 'AGENT_CALL_FAILED',
    })
    await addIncidentEvent(incident.id, 'INVESTIGATING', `${role} round ${round} failed`, (error ?? '').slice(0, 300))
  } else {
    await addIncidentEvent(incident.id, 'INVESTIGATING', `${role} round ${round} completed`, summary.slice(0, 300))
  }

  return {
    agentRunId: stored.id,
    status,
    output,
    summary,
    error: error ?? undefined,
    model: response.model ?? model,
    mode: provider.mode,
    durationMs,
    promptTokens: response.promptTokens ?? null,
    completionTokens: response.completionTokens ?? null,
  }
}

// ---------------------------------------------------------------------------
// Conversation runner
// ---------------------------------------------------------------------------

/**
 * Deterministic no-op → restore bridge (provider-independent).
 *
 * A Coder that proposes byte-identical CURRENT/PROPOSED code is stating that
 * the source needs no change. When a WIRED runtime fault is simultaneously
 * active for the incident's exact endpoint+method, the only coherent repair
 * action is restoring normal runtime behavior — so the empty proposal is
 * normalized to an explicit `runtimeRepair: 'restore'` directive BEFORE the
 * Critic reviews it. The Critic (prompt-disciplined to verify the guard) and
 * the Judge still decide; real HTTP validation probes remain the backstop, so
 * a wrong restore can only end in honest ROLLBACK, never false RESOLVED.
 * The enriched output is re-persisted so the DB transcript matches the engine.
 */
async function enrichNoopRestoreDirective(
  coder: CoderOutput,
  agentRunId: string,
  incident: Incident,
  evidence: RepairEvidence,
): Promise<boolean> {
  if (coder.runtimeRepair) return false
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const proposed = (coder.proposedCode ?? '').trim()
  const current = (coder.currentCode ?? '').trim()
  if (!proposed || !current || normalize(proposed) !== normalize(current)) return false
  const method = (evidence.method ?? '').toUpperCase()
  const activeFault = Object.values(FAULT_REGISTRY).find(
    (f) => f.wired && f.trigger.method.toUpperCase() === method && f.trigger.endpoint === evidence.endpoint && isFaultActive(f.id),
  )
  if (!activeFault) return false
  coder.runtimeRepair = 'restore'
  await prisma.agentRun.update({
    where: { id: agentRunId },
    data: { output: coder as unknown as Prisma.InputJsonValue },
  })
  trace('AGENT-2 CODER', `no-op proposal + active wired fault ${activeFault.id} → deterministic runtime-restore directive`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: evidence.endpoint,
    method: evidence.method,
  })
  await addIncidentEvent(
    incident.id,
    'INVESTIGATING',
    'No-op proposal normalized to runtime restore',
    `wired fault ${activeFault.id} active for ${evidence.method} ${evidence.endpoint}; Critic reviews the restore directive`,
  )
  return true
}

export async function runRepairConversation(
  incident: Incident,
  attempt: RepairAttempt,
  evidence: RepairEvidence,
  options: RepairOptions = {},
): Promise<ConversationResult> {
  const provider = getProvider()
  const maxRounds = Math.min(MAX_CODER_ROUNDS, Math.max(1, options.maxRounds ?? MAX_CODER_ROUNDS))

  const turns: TurnResult[] = []
  const coderOutputs: CoderOutput[] = []
  const criticOutputs: CriticOutput[] = []
  let stopReason: ConversationResult['stopReason'] = 'ROUNDS_EXHAUSTED'
  let converged = false
  let roundsUsed = 0

  await updateAttemptStatus(attempt.id, 'MEMORY_SEARCH')
  await addIncidentEvent(
    incident.id,
    'INVESTIGATING',
    'Repair memory searched',
    `${evidence.memoryHints.length} match(es) returned`,
  )

  // Analyzer: the first-stage failure analyst. Runs in EVERY mode (TEST and
  // REAL) so the pipeline always shows Analyzer → Coder → Critic → Judge and
  // the Coder always has a root-cause hypothesis to verify.
  let analyzerOutput: AnalyzerOutput | null = null
  {
    trace('AGENT-1 ANALYZER', `starting: provider=${provider.name} model=${provider.configuredModel()}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: evidence.endpoint,
      method: evidence.method,
    })
    await addIncidentEvent(incident.id, 'INVESTIGATING', 'Analyzer started', `provider=${provider.name} model=${provider.configuredModel()}`)
    const analyzerTurn = await callAndStore(incident, 'ANALYZER', 'Failure analyst (Analyzer)', 1, (level) => analyzerPromptFor(evidenceHeaderFor(evidence, 'ANALYZER', level)), options, evidence)
    turns.push({ role: 'ANALYZER', round: 1, agentRunId: analyzerTurn.agentRunId, status: analyzerTurn.status, output: analyzerTurn.output, summary: analyzerTurn.summary, error: analyzerTurn.error, model: analyzerTurn.model, mode: analyzerTurn.mode })
    if (analyzerTurn.status === 'COMPLETE' && analyzerTurn.output && 'classification' in analyzerTurn.output) {
      analyzerOutput = analyzerTurn.output as unknown as AnalyzerOutput
    }
    trace('AGENT-1 ANALYZER', `analysis: ${analyzerOutput ? `${analyzerOutput.classification} · ${(analyzerOutput.rootCause ?? '').slice(0, 160)}` : 'FAILED'}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: evidence.endpoint,
      method: evidence.method,
    })
    await addIncidentEvent(incident.id, 'INVESTIGATING', 'Analyzer finished', `classification=${analyzerOutput?.classification ?? 'failed'} rootCause=${(analyzerOutput?.rootCause ?? '').slice(0, 200)}`)
  }

  await updateAttemptStatus(attempt.id, 'CODING')
  await addIncidentEvent(
    incident.id,
    'INVESTIGATING',
    'Coder/Critic conversation started',
    `provider=${provider.name} mode=${provider.mode} model=${provider.configuredModel()} maxRounds=${maxRounds}`,
  )

  for (let round = 1; round <= maxRounds; round += 1) {
    roundsUsed = round

    trace('AGENT-2 CODER', `round ${round}/${maxRounds} starting (analyzer hypothesis ${analyzerOutput ? 'available' : 'none'})`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: evidence.endpoint,
      method: evidence.method,
    })
    const coderResult = await callAndStore(incident, 'CODER', 'Candidate generation (Coder)', round, (level) => coderPromptFor(evidenceHeaderFor(evidence, 'CODER', level), round, coderOutputs, criticOutputs, analyzerOutput, level), options, evidence)
    turns.push({ role: 'CODER', round, agentRunId: coderResult.agentRunId, status: coderResult.status, output: coderResult.output, summary: coderResult.summary, error: coderResult.error, model: coderResult.model, mode: coderResult.mode })
    if (coderResult.status !== 'COMPLETE' || !coderResult.output) {
      trace('AGENT-2 CODER', `round ${round} FAILED: ${coderResult.error ?? 'unparseable output'}`, {
        incidentRef: incident.ref,
        incidentId: incident.id,
        route: evidence.endpoint,
        method: evidence.method,
      })
      stopReason = 'CODER_FAILED'
      break
    }
    const coder = coderResult.output as CoderOutput
    coderOutputs.push(coder)
    await enrichNoopRestoreDirective(coder, coderResult.agentRunId, incident, evidence)
    trace('AGENT-2 CODER', `round ${round} candidate: ${coder.file}${coder.line ? `:${coder.line}` : ''} · runtimeRepair=${coder.runtimeRepair ?? 'file-patch'}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: evidence.endpoint,
      method: evidence.method,
    })

    trace('AGENT-3 CRITIC', `round ${round} reviewing candidate`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: evidence.endpoint,
      method: evidence.method,
    })
    const criticResult = await callAndStore(incident, 'CRITIC', 'Candidate reviewer (Critic)', round, (level) => criticPromptFor(evidenceHeaderFor(evidence, 'CRITIC', level), coder, criticOutputs, level), options, evidence)
    turns.push({ role: 'CRITIC', round, agentRunId: criticResult.agentRunId, status: criticResult.status, output: criticResult.output, summary: criticResult.summary, error: criticResult.error, model: criticResult.model, mode: criticResult.mode })
    if (criticResult.status !== 'COMPLETE' || !criticResult.output) {
      trace('AGENT-3 CRITIC', `round ${round} FAILED: ${criticResult.error ?? 'unparseable output'}`, {
        incidentRef: incident.ref,
        incidentId: incident.id,
        route: evidence.endpoint,
        method: evidence.method,
      })
      stopReason = 'CODER_FAILED'
      break
    }
    const critic = criticResult.output as CriticOutput
    criticOutputs.push(critic)
    trace('AGENT-3 CRITIC', `round ${round} verdict: ${critic.verdict} · ${(critic.reasoning ?? '').slice(0, 140)}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: evidence.endpoint,
      method: evidence.method,
    })

    if (critic.verdict === 'ACCEPT') {
      converged = true
      stopReason = 'CODER_ACCEPTED'
      break
    }
    if (critic.verdict === 'REJECT') {
      // Round-1 REJECT is a request to REVISE: the Coder gets a second round
      // with the transcript. Only a REJECT on the final round is terminal.
      if (round < maxRounds) {
        trace('AGENT-3 CRITIC', `round ${round} REJECT → scheduling Coder revision round ${round + 1}`, {
          incidentRef: incident.ref,
          incidentId: incident.id,
          route: evidence.endpoint,
          method: evidence.method,
        })
        continue
      }
      stopReason = 'CODER_REJECTED'
      break
    }
  }

  await updateAttemptStatus(attempt.id, 'JUDGING')

  trace('JUDGE', `final verdict requested (stop=${stopReason}, ${roundsUsed} round(s) used)`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: evidence.endpoint,
    method: evidence.method,
  })
  const judgeResult = await callAndStore(incident, 'JUDGE', 'Final arbiter (Judge)', 1, (level) => judgePromptFor(evidenceHeaderFor(evidence, 'JUDGE', level), coderOutputs, criticOutputs, stopReason, level), options, evidence)
  turns.push({ role: 'JUDGE', round: 1, agentRunId: judgeResult.agentRunId, status: judgeResult.status, output: judgeResult.output, summary: judgeResult.summary, error: judgeResult.error, model: judgeResult.model, mode: judgeResult.mode })
  const judge = judgeResult.status === 'COMPLETE' && judgeResult.output ? (judgeResult.output as JudgeOutput) : null
  if (!judge && stopReason !== 'CODER_FAILED') stopReason = 'JUDGE_FAILED'
  trace('JUDGE', `verdict: ${judge ? `${judge.decision} · risk=${judge.risk} · ${judge.confidence}% confidence · ${(judge.reasoning ?? '').slice(0, 140)}` : 'FAILED'}`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: evidence.endpoint,
    method: evidence.method,
  })

  const candidate = converged ? coderOutputs[coderOutputs.length - 1] : null

  await updateAttemptStatus(attempt.id, stageAfterConversation(converged, judge), {
    summary: judge ? `${judge.decision}: ${judge.reasoning}` : null,
    completedAt: converged || judge ? new Date() : null,
  })

  await addIncidentEvent(
    incident.id,
    'INVESTIGATING',
    'Conversation finished',
    `stop=${stopReason} roundsUsed=${roundsUsed} verdicts=${criticOutputs.map((c) => c.verdict).join('>') || 'none'} judge=${judge?.decision ?? 'failed'}`,
  )

  return {
    attempt,
    converged,
    roundsUsed,
    stopReason,
    candidate,
    judge,
    turns,
    coderCode: candidate?.proposedCode ?? null,
    humanBrief: judge
      ? `${judge.decision} (${judge.confidence}%) · ${judge.reasoning}`
      : `No Judge verdict available after ${roundsUsed} Coder round(s).`,
  }
}

function stageAfterConversation(converged: boolean, judge: JudgeOutput | null): string {
  if (!converged) return 'JUDGED'
  if (!judge) return 'JUDGED_FAILED'
  return judge.decision === 'APPROVE' ? 'JUDGE_APPROVED' : 'JUDGE_REJECTED'
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function coderPromptFor(
  header: string,
  round: number,
  coderOutputs: CoderOutput[],
  criticOutputs: CriticOutput[],
  analyzer: AnalyzerOutput | null,
  level: HeaderLevel = 0,
): ChatMessage[] {
  const lines: string[] = []
  if (analyzer) {
    lines.push(
      ``,
      `## Analyzer hypothesis (VERIFY — it may be wrong)`,
      `Root cause: ${truncate(analyzer.rootCause, 300)}`,
      `Suspected files: ${analyzer.suspectedFiles.join(', ').slice(0, 200) || 'none'}`,
      `Confidence: ${analyzer.confidence}`,
    )
  }
  if (round > 1 && coderOutputs.length > 0) {
    lines.push(``, `## Earlier proposals and critique`)
    for (let i = 0; i < coderOutputs.length; i += 1) {
      lines.push(transcriptBlock(coderOutputs[i], criticOutputs[i] ?? null, level))
    }
    lines.push(`## Task`, `Address the Critic's required changes and produce an updated proposal (round ${round}).`)
  } else {
    lines.push(`## Task`, `Propose the minimal, evidence-backed fix.`)
  }
  lines.push(`## Output`, `STRICT JSON matching the Coder contract.`)
  return [
    { role: 'system', content: CODER_SYSTEM },
    { role: 'user', content: assembleUserPayload(header, lines) },
  ]
}

function criticPromptFor(
  header: string,
  coder: CoderOutput,
  criticOutputs: CriticOutput[],
  level: HeaderLevel = 0,
): ChatMessage[] {
  const lines = [`## Candidate to review`, candidateDiff(coder, level)]
  if (criticOutputs.length > 0) {
    lines.push(``, `## Prior reviews`, ...criticOutputs.map((c) => `${c.verdict}: ${truncate(c.reasoning, 200)}`))
  }
  lines.push(`## Output`, `STRICT JSON matching the Critic contract.`)
  return [
    { role: 'system', content: CRITIC_SYSTEM },
    { role: 'user', content: assembleUserPayload(header, lines) },
  ]
}

function judgePromptFor(
  header: string,
  coderOutputs: CoderOutput[],
  criticOutputs: CriticOutput[],
  stopReason: string,
  level: HeaderLevel = 0,
): ChatMessage[] {
  const lines: string[] = []
  if (coderOutputs.length === 0) {
    lines.push(`No repair candidate was produced (${stopReason}). As policy, the Judge MUST REJECT.`)
  } else {
    lines.push(`## Repair conversation transcript`)
    for (let i = 0; i < coderOutputs.length; i += 1) {
      lines.push(transcriptBlock(coderOutputs[i], criticOutputs[i] ?? null, level))
      lines.push(``)
    }
    lines.push(`Conversation ended: ${stopReason}.`, `## Output`, `STRICT JSON matching the Judge contract; cite evidence and recommend a risk tier.`)
  }
  return [
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user', content: assembleUserPayload(header, lines) },
  ]
}

function normalizeRoleOutput(role: AgentRole, content: string): CoderOutput | CriticOutput | JudgeOutput | AnalyzerOutput | null {
  const parsed = extractJsonObject(content)
  if (!parsed) return null
  if (role === 'ANALYZER') return parseAnalyzer(parsed)
  if (role === 'CODER') return parseCoder(parsed)
  if (role === 'CRITIC') return parseCritic(parsed)
  return parseJudge(parsed)
}

function summarize(role: AgentRole, output: CoderOutput | CriticOutput | JudgeOutput | AnalyzerOutput): string {
  if (role === 'ANALYZER') return `${(output as AnalyzerOutput).classification}: ${(output as AnalyzerOutput).rootCause}`
  if (role === 'CODER') return (output as CoderOutput).diagnosis
  if (role === 'CRITIC') return `${(output as CriticOutput).verdict}: ${(output as CriticOutput).reasoning}`
  return `${(output as JudgeOutput).decision}: ${(output as JudgeOutput).reasoning}`
}