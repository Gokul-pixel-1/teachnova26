import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { computeLearningMetrics, getRewardPolicy } from '@/lib/server/learning/memory'
import { decisionPolicy } from '@/lib/server/learning/decision'
import { runRlEvaluation } from '@/lib/server/learning/evaluation'
import { handleApiError } from '@/lib/server/response'

// GET /api/ai/learning — learning metrics + the explicit reward policy and the
// deterministic RL decision-policy evaluation (synthetic holdout).
export async function GET() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  try {
    const [metrics, policy, rl, evaluation] = await Promise.all([
      computeLearningMetrics(),
      getRewardPolicy(),
      decisionPolicy(),
      runRlEvaluation(),
    ])
    return NextResponse.json({ ok: true, metrics, policy, rl, evaluation })
  } catch (err) {
    return handleApiError(err)
  }
}