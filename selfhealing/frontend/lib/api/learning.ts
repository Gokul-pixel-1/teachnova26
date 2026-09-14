// Client-side access to the Phase 10 learning APIs.

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? 'Request failed')
  }
  return (await res.json()) as T
}

export type RepairOutcome = 'RESOLVED' | 'ROLLED_BACK' | 'AI_REPAIR_FAILED' | 'REJECTED'

export interface RewardPolicy {
  successfulRepair: number
  validationFailure: number
  rollback: number
  securityRegression: number
  rejection: number
  humanApproval: number
  humanRejection: number
}

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

export interface PolicyMetrics {
  accuracy: number
  safeRate: number
  correctAutomation: number
  avgReward: number
}

export interface EvalBucket {
  key: string
  samples: number
  beforeAccuracy: number
  afterAccuracy: number
}

export interface RlEvaluation {
  source: 'synthetic-evaluation'
  label: string
  seed: number
  total: number
  train: number
  eval: number
  splitFraction: number
  rewardModel: { correct: number; safeSuboptimal: number; unsafe: number }
  datasetPreview: Array<{
    state: { incidentType: string; severity: string; risk: string; confidenceBucket: string }
    optimal: string
    recordedAction: string
    recordedReward: number
  }>
  before: PolicyMetrics
  after: PolicyMetrics
  improvement: PolicyMetrics
  buckets: EvalBucket[]
}

export interface LearningResponse {
  ok: boolean
  metrics: LearningMetrics
  policy: RewardPolicy
  rl: { minSamples: number; epsilon: number; actions: string[] }
  evaluation: RlEvaluation
}

export interface EvaluationResponse {
  ok: boolean
  stats: EvaluationStats
}

export interface ExperienceRow {
  id: string
  incidentRef: string | null
  severity: string | null
  endpoint: string | null
  method: string | null
  outcome: RepairOutcome | null
  reward: number
  terminal: boolean
  humanDecision: string | null
  createdAt: string
}

export interface ExperiencesResponse {
  ok: boolean
  count: number
  experiences: ExperienceRow[]
}

export interface Neuron {
  id: string
  ref: string
  status: string
  severity: string
  endpoint: string
  createdAt: string
  resolvedAt: string | null
}

export interface VisualizationResponse {
  ok: boolean
  neurons: Neuron[]
  edges: Array<{ id: string; reward: number; outcome: string; createdAt: string }>
  metrics: LearningMetrics
  stats: EvaluationStats
  policy: RewardPolicy
  breakdown: {
    severity: Record<string, number>
    status: Record<string, number>
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

export interface RlDatasetResponse {
  ok: boolean
  count: number
  rows: RlRow[]
}

export const fetchLearning = () => getJson<LearningResponse>('/api/ai/learning')

export const fetchEvaluation = () => getJson<EvaluationResponse>('/api/ai/evaluate')

export const fetchExperiences = () => getJson<ExperiencesResponse>('/api/ai/experiences')

export const fetchVisualization = () => getJson<VisualizationResponse>('/api/ai/visualization')

export const fetchRlDataset = () => getJson<RlDatasetResponse>('/api/ai/rl-dataset')

export interface ChatResponse {
  ok: boolean
  mode: 'REAL' | 'TEST'
  model: string
  reply: string | null
  error?: string
}

export async function askAiChat(message: string): Promise<ChatResponse> {
  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) throw new Error('Could not reach the AI console.')
  if (!res.ok) {
    const errMsg = typeof body.error === 'string' ? body.error : `Request failed (${res.status})`
    throw new Error(errMsg)
  }
  return body as unknown as ChatResponse
}