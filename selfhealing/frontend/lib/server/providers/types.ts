import 'server-only'

// ---------------------------------------------------------------------------
// Shared provider types for the Phase 9 iterative Coder/Critic/Judge engine.
// Providers are thin LLM-call adapters; all prompt building and JSON
// normalization lives in the self-healing engine so behavior is identical
// across Groq (REAL) and the test provider (TEST, hermetic).
// ---------------------------------------------------------------------------

export type AgentRole = 'ANALYZER' | 'CODER' | 'CRITIC' | 'JUDGE'
export type ProviderName = 'groq' | 'test' | 'ollama' | 'none'
export type ModeLabel = 'REAL' | 'TEST'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface EvidenceLog {
  level: string
  route: string | null
  method: string | null
  status: number | null
  message: string
  requestId: string | null
  errorCode: string | null
  createdAt: string
}

/**
 * Everything the agents may legitimately see. `sourceContext` is the REAL
 * defect-bearing source rendered from the stack trace's first app frame with
 * line numbers; it contains no fault ids or registry answers, so the model must
 * reason from the same evidence a real operator would have. `architectureDoc`
 * is a capped excerpt of docs/SELF_HEALING_ARCHITECTURE.md (the component map
 * the engine reads before repairing).
 */
export interface RepairEvidence {
  incidentRef: string
  incidentId: string
  severity: string
  title: string
  description: string
  endpoint: string
  method: string
  errorCode: string | null
  requestId: string | null
  expectedRootCause: string | null
  suspectSource: string
  detectedBy: string
  evidenceCount: number
  logs: EvidenceLog[]
  stackTrace: string | null
  sourceContext: string | null
  architectureDoc: string | null
  memoryHints: { rootCause: string; patchSummary: string; outcome: string }[]
}

export interface CoderOutput {
  diagnosis: string
  rootCause: string
  file: string
  line: number | null
  function: string
  affectedBehavior: string
  currentCode: string
  proposedCode: string
  validationPlan: string
  confidence: number
  /**
   * Runtime fault repair directive. When the REAL source is healthy but the
   * failure is produced by an active controlled runtime fault, the Coder
   * directs the engine to restore normal runtime behavior instead of applying
   * a file patch:
   *   'restore' → deactivate the runtime fault(s) for the incident endpoint.
   *   'none'    → behave as if no repair is applied (used by bad-fix tests so
   *               REAL validation probes fail and the engine rolls back).
   * Absent → an ordinary file-patch candidate (anchor-based apply).
   */
  runtimeRepair?: 'restore' | 'none'
}

export interface CriticOutput {
  verdict: 'ACCEPT' | 'REVISE' | 'REJECT'
  reasoning: string
  problems: string[]
  requiredChanges: string[]
  testsRequired: string[]
  securityConcerns: string[]
}

export interface JudgeOutput {
  decision: 'APPROVE' | 'REJECT'
  reasoning: string
  confidence: number
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  validationItems: string[]
}

export type AnyAgentOutput = CoderOutput | CriticOutput | JudgeOutput

/** Safe metadata the engine may pass to a provider. In TEST mode the real
 * repair evidence is included so the hermetic provider can reason deterministically
 * from the SAME evidence a real model would see. No fault answers exist anymore. */
export interface ProviderContext {
  role: AgentRole
  round: number
  scenario?: string
  evidence?: RepairEvidence
}

export interface ProviderCall {
  model: string
  messages: ChatMessage[]
  maxTokens: number
  temperature: number
  context: ProviderContext
}

export interface ProviderResponse {
  ok: boolean
  status: 'COMPLETE' | 'FAILED'
  provider: ProviderName
  mode: ModeLabel
  model: string
  content?: string
  promptTokens?: number | null
  completionTokens?: number | null
  error?: string
}

export interface AIProvider {
  name: ProviderName
  mode: ModeLabel
  call(req: ProviderCall): Promise<ProviderResponse>
  probeModels(): Promise<string[] | null>
  configuredModel(): string
}