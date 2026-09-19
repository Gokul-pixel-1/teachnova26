'use client'

import { useCallback, useState } from 'react'

import { cn } from '@/lib/cn'
import { Icon } from '@/components/ui/icon'
import { useAsync } from '@/lib/hooks'
import {
  fetchLearning,
  fetchEvaluation,
  fetchExperiences,
  fetchRlDataset,
} from '@/lib/api/learning'
import type {
  EvaluationStats,
  LearningMetrics,
  RepairOutcome,
  RewardPolicy,
} from '@/lib/api/learning'
import {
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingState,
  Pill,
  ProgressBar,
  StatCard,
  relativeTime,
} from './ui'

const POLICY_LABELS: Array<[keyof RewardPolicy, string]> = [
  ['successfulRepair', 'Successful repair'],
  ['validationFailure', 'Validation failure (probing)'],
  ['rollback', 'Rollback'],
  ['securityRegression', 'Security regression'],
  ['rejection', 'Patch outcome REJECTED'],
  ['humanApproval', 'Human approval'],
  ['humanRejection', 'Human rejection'],
]

const outcomeTone = (outcome: RepairOutcome | null) => {
  switch (outcome) {
    case 'RESOLVED':
      return 'success' as const
    case 'ROLLED_BACK':
      return 'warning' as const
    case 'AI_REPAIR_FAILED':
    case 'REJECTED':
      return 'danger' as const
    default:
      return 'info' as const
  }
}

function MetricBar({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-bh-muted">{label}</span>
        <span className="font-mono font-semibold text-bh-ink">{value}</span>
      </div>
      <ProgressBar value={max > 0 ? (value / max) * 100 : 0} tone="accent" className="mt-1.5" />
    </div>
  )
}

function DeltaBadge({ value }: { value: number }) {
  const positive = value > 0
  const neutral = value === 0
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold',
        neutral
          ? 'bg-bh-surface-2 text-bh-muted'
          : positive
            ? 'bg-bh-success/15 text-bh-success'
            : 'bg-bh-danger/15 text-bh-danger',
      )}
    >
      {positive ? '+' : ''}
      {value}
    </span>
  )
}

function BeforeAfterBar({
  label,
  before,
  after,
}: {
  label: string
  before: number
  after: number
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-bh-muted">{label}</span>
        <span className="flex items-center gap-2">
          <span className="font-mono text-bh-muted">{before}%</span>
          <span className="text-bh-line-strong">→</span>
          <span className="font-mono font-semibold text-bh-accent-ink">{after}%</span>
          <DeltaBadge value={after - before} />
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <div className="h-1.5 flex-1 rounded-full bg-bh-line" aria-hidden="true">
          <div
            className="h-1.5 rounded-full bg-bh-faint"
            style={{ width: `${Math.min(100, before)}%` }}
          />
        </div>
        <div className="h-1.5 flex-1 rounded-full bg-bh-line" aria-hidden="true">
          <div
            className="h-1.5 rounded-full bg-bh-accent"
            style={{ width: `${Math.min(100, after)}%` }}
          />
        </div>
      </div>
    </div>
  )
}

export function LearningClient() {
  const [datasetOpen, setDatasetOpen] = useState(false)

  const learningFetcher = useCallback(() => fetchLearning().then((r) => r), [])
  const { data: learning, loading, error, refetch } = useAsync(learningFetcher)

  const statsFetcher = useCallback(() => fetchEvaluation().then((r) => r), [])
  const { data: evaluation, loading: statsLoading, error: statsError } = useAsync(statsFetcher)

  const experiencesFetcher = useCallback(() => fetchExperiences().then((r) => r), [])
  const { data: experiences, loading: expLoading } = useAsync(experiencesFetcher)

  const datasetFetcher = useCallback(() => fetchRlDataset().then((r) => r), [])
  const { data: dataset, loading: datasetLoading, error: datasetError, refetch: refetchDataset } = useAsync(datasetFetcher)

  if (loading && !learning) return <LoadingState label="Loading learning metrics…" />
  if (error && !learning) return <ErrorState message={error} onRetry={refetch} />

  if (!learning?.ok || !learning.metrics) return null

  const metrics: LearningMetrics = learning.metrics
  const policy: RewardPolicy = learning.policy
  const stats: EvaluationStats | null = evaluation?.stats ?? null
  const maxRisk = Math.max(1, ...Object.values(metrics.riskDistribution))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-bh-faint">
            Phase 10 · Learning Loop
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-bh-ink">Learning</h1>
          <p className="mt-1 text-sm text-bh-muted">
            Repair memory, RL experience, reward policy and evaluation — all derived from the
            persisted audit trail.
          </p>
        </div>
        <Pill tone="accent">Deterministic</Pill>
      </div>

      {statsError && (
        <p className="text-xs text-bh-danger" role="alert">
          Evaluation unavailable: {statsError}
        </p>
      )}

      {/* Metrics */}
      <section aria-label="Learning metrics" className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          label="Patch success rate"
          value={`${metrics.patchSuccessRate}%`}
          sub={`${metrics.successful} of ${metrics.totalAttempts} attempts resolved`}
          accent={metrics.patchSuccessRate >= 80 ? 'var(--bh-success)' : 'var(--bh-warning)'}
          icon="check"
        />
        <StatCard
          label="Avg coder rounds"
          value={metrics.avgCoderRounds.toFixed(1)}
          sub="per completed repair conversation"
          accent="var(--bh-accent)"
          icon="gitBranch"
        />
        <StatCard
          label="Avg reward"
          value={String(metrics.avgReward)}
          sub={`${metrics.rolledBack} rolled back · ${metrics.failed} failed`}
          accent={metrics.avgReward >= 0 ? 'var(--bh-success)' : 'var(--bh-danger)'}
          icon="activity"
        />
        <StatCard
          label="RL dataset"
          value={String(metrics.rlDatasetSize)}
          sub={`${metrics.memoryCount} memory records · ${metrics.experienceCount} experiences`}
          accent="var(--bh-accent)"
          icon="grid"
        />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Reward policy */}
        <Card>
          <CardHeader
            icon="settings"
            title="Reward Policy"
            hint="explicit, inspectable, env-tunable"
          />
          <ul className="space-y-2.5 px-4 py-4">
            {POLICY_LABELS.map(([key, label]) => (
              <li key={key} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-bh-muted">{label}</span>
                <span className="rounded bg-bh-surface-2 px-2 py-0.5 font-mono font-semibold text-bh-accent-ink">
                  {policy[key] > 0 ? `+${policy[key]}` : policy[key]}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        {/* Evaluation harness */}
        <Card>
          <CardHeader
            icon="asterisk"
            title="Evaluation"
            hint={`${stats?.total ?? 0} closed attempt${stats?.total === 1 ? '' : 's'}`}
            extra={stats ? <Pill tone="accent">score {stats.score}</Pill> : null}
          />
          {!stats || statsLoading ? (
            <EmptyState icon="asterisk" title="No closed attempts" message="Run failed-incident repairs to produce an evaluation." />
          ) : (
            <div className="space-y-3 px-4 py-4">
              <MetricBar label="Root cause location" value={stats.rootCauseAccuracy} max={100} />
              <MetricBar label="Patch correctness" value={stats.patchCorrectness} max={100} />
              <MetricBar label="Validation success" value={stats.validationSuccess} max={100} />
              <MetricBar label="Rollback correctness" value={stats.rollbackCorrectness} max={100} />
              <p className="mt-2 text-[11px] text-bh-faint">
                avg {stats.avgRounds} rounds · avg {Math.round(stats.avgDurationMs / 1000)}s per repair ·
                score = unweighted mean of the four axes
              </p>
            </div>
          )}
        </Card>

        {/* Risk distribution */}
        <Card>
          <CardHeader icon="radar" title="Risk Distribution" hint="classified patch risk by attempt" />
          {Object.keys(metrics.riskDistribution).length === 0 ? (
            <EmptyState icon="radar" title="No classifications yet" message="Attempts will appear once repairs run." />
          ) : (
            <div className="space-y-3 px-4 py-4">
              {Object.entries(metrics.riskDistribution)
                .sort(([a], [b]) => (b < a ? -1 : 1))
                .map(([risk, count]) => (
                  <MetricBar key={risk} label={risk} value={count} max={maxRisk} />
                ))}
            </div>
          )}
        </Card>
      </div>

      {learning.evaluation && (
        <section aria-label="RL decision policy evaluation">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-widest text-bh-faint">
                RL Decision Policy · before → after
              </p>
              <h2 className="mt-1 text-lg font-bold tracking-tight text-bh-ink">
                Evaluation harness
              </h2>
            </div>
            <Pill tone="info">synthetic holdout · seeded eval</Pill>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                icon="asterisk"
                title="Before → After"
                hint="same held-out eval split, same reward model"
              />
              <div className="space-y-4 px-4 py-4">
                <BeforeAfterBar
                  label="Action accuracy"
                  before={learning.evaluation.before.accuracy}
                  after={learning.evaluation.after.accuracy}
                />
                <BeforeAfterBar
                  label="Safe decision rate"
                  before={learning.evaluation.before.safeRate}
                  after={learning.evaluation.after.safeRate}
                />
                <BeforeAfterBar
                  label="Correct automation"
                  before={learning.evaluation.before.correctAutomation}
                  after={learning.evaluation.after.correctAutomation}
                />
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-bh-muted">Avg reward</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-bh-muted">
                      {learning.evaluation.before.avgReward}
                    </span>
                    <span className="text-bh-line-strong">→</span>
                    <span className="font-mono font-semibold text-bh-accent-ink">
                      {learning.evaluation.after.avgReward}
                    </span>
                    <DeltaBadge value={learning.evaluation.improvement.avgReward} />
                  </span>
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader
                icon="grid"
                title="Holdout split"
                hint={`seeded ${learning.evaluation.seed} · reproducible`}
              />
              <div className="space-y-2.5 px-4 py-4">
                <p className="text-xs leading-relaxed text-bh-muted">{learning.evaluation.label}</p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <span className="rounded bg-bh-surface-2 px-2 py-1 font-mono text-[11px] text-bh-muted">
                    {learning.evaluation.total} rows
                  </span>
                  <span className="rounded bg-bh-surface-2 px-2 py-1 font-mono text-[11px] text-bh-muted">
                    {learning.evaluation.train} train ({Math.round(learning.evaluation.splitFraction * 100)}%)
                  </span>
                  <span className="rounded bg-bh-surface-2 px-2 py-1 font-mono text-[11px] text-bh-muted">
                    {learning.evaluation.eval} eval
                  </span>
                  <span className="rounded bg-bh-surface-2 px-2 py-1 font-mono text-[11px] text-bh-muted">
                    reward model +{learning.evaluation.rewardModel.correct} / −{Math.abs(learning.evaluation.rewardModel.unsafe)}
                  </span>
                </div>
                {learning.evaluation.buckets.length > 0 && (
                  <div className="mt-2 max-w-full overflow-x-auto">
                  <table className="w-full min-w-[420px] text-left">
                    <thead>
                      <tr className="border-b border-bh-line text-[11px] uppercase tracking-wider text-bh-faint">
                        <th className="py-2 font-medium">Bucket (risk|severity|type)</th>
                        <th className="py-2 font-medium">Samples</th>
                        <th className="py-2 font-medium">Before</th>
                        <th className="py-2 font-medium">After</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-bh-line/60">
                      {learning.evaluation.buckets.slice(0, 6).map((bucket) => (
                        <tr key={bucket.key}>
                          <td className="py-2 font-mono text-[11px] text-bh-muted">{bucket.key}</td>
                          <td className="py-2 font-mono text-[11px] text-bh-ink">{bucket.samples}</td>
                          <td className="py-2 font-mono text-[11px] text-bh-muted">{bucket.beforeAccuracy}%</td>
                          <td className="py-2">
                            <span className="flex items-center gap-1.5">
                              <span className="font-mono text-[11px] font-semibold text-bh-accent-ink">
                                {bucket.afterAccuracy}%
                              </span>
                              <DeltaBadge value={bucket.afterAccuracy - bucket.beforeAccuracy} />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Experience timeline */}
        <Card>
          <CardHeader
            icon="history"
            title="Experience Timeline"
            hint="normalized state → action → reward → terminal"
          />
          {expLoading || !experiences ? (
            <EmptyState icon="history" title="No experiences" message="Completed repairs write one experience each." />
          ) : experiences.experiences.length === 0 ? (
            <EmptyState icon="history" title="No experiences" message="Completed repairs write one experience each." />
          ) : (
            <ul className="divide-y divide-bh-line/60">
              {experiences.experiences.slice(0, 12).map((exp) => (
                <li key={exp.id} className="flex items-center gap-3 px-4 py-3">
                  <span
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold',
                      exp.reward > 0
                        ? 'bg-bh-success/15 text-bh-success'
                        : 'bg-bh-danger/15 text-bh-danger',
                    )}
                    aria-hidden="true"
                  >
                    {exp.reward > 0 ? `+${exp.reward}` : exp.reward}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-bh-ink">
                      <span className="font-mono text-xs text-bh-faint">{exp.incidentRef}</span>
                      <span className="mx-2 text-bh-line-strong">/</span>
                      {exp.endpoint ?? '—'}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-bh-faint">
                      {exp.method ?? ''} · reward {exp.reward} · {relativeTime(exp.createdAt)}
                    </p>
                  </div>
                  <Pill tone={outcomeTone(exp.outcome)}>{exp.outcome ?? '—'}</Pill>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* RL dataset */}
        <Card>
          <CardHeader
            icon="grid"
            title="RL Dataset"
            hint={`${metrics.rlDatasetSize} rows · normalized (state, action, reward, nextState, terminal)`}
            extra={
              <button
                onClick={() => {
                  if (!dataset) void refetchDataset()
                  setDatasetOpen((open) => !open)
                }}
                className="flex items-center gap-1.5 text-xs font-medium text-bh-accent-ink hover:underline"
              >
                {datasetOpen ? 'Hide' : 'Preview'} dataset
                <Icon name="chevronDown" size={12} className={cn('transition-transform', datasetOpen && 'rotate-180')} />
              </button>
            }
          />
          <div className="border-t border-bh-line px-4 py-3">
            <p className="text-xs leading-relaxed text-bh-muted">
              One experience per completed repair attempt stores the evidence snapshot (state),
              the applied candidate (action), the persisted reward, the resulting incident state
              (nextState) and the terminal flag. This is the honest substrate a future trainer
              would consume — no fabricated trajectories.
            </p>
          </div>
          {datasetOpen &&
            (datasetLoading ? (
              <div className="px-4 py-4">
                <LoadingState label="Fetching dataset…" />
              </div>
            ) : datasetError ? (
              <p className="px-4 py-4 text-xs text-bh-danger">{datasetError}</p>
            ) : dataset ? (
              <pre className="max-h-80 overflow-auto border-t border-bh-line bg-bh-surface-2/40 px-4 py-3 font-mono text-[10px] leading-relaxed text-bh-muted">
                {JSON.stringify(dataset.rows.slice(-8), null, 2)}
              </pre>
            ) : null)}
        </Card>
      </div>
    </div>
  )
}
