import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import {
  analyzeBehaviorNow,
  autoSuggestEnabled,
  computeFrictionReport,
  frictionThresholds,
  type ComponentFriction,
} from '@/lib/server/ux/behavior'
import { handleApiError } from '@/lib/server/response'

// Operator view of the behaviour analysis: per-component friction report
// (GET) and an explicit "analyze now" (POST) that raises suggestions for any
// component over threshold — exactly what the automatic background run does.

/** The raw click samples stay server-side (they feed the sandbox only). */
const forClient = (report: ComponentFriction[]) => report.map(({ expectations: _e, ...rest }) => rest)

export async function GET() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response
  try {
    return NextResponse.json({
      autoSuggest: autoSuggestEnabled(),
      thresholds: frictionThresholds(),
      report: forClient(await computeFrictionReport()),
    })
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response
  try {
    const result = await analyzeBehaviorNow(true)
    return NextResponse.json({
      autoSuggest: autoSuggestEnabled(),
      thresholds: frictionThresholds(),
      ...result,
      report: forClient(result.report),
    })
  } catch (err) {
    return handleApiError(err)
  }
}
