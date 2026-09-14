import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { logger, resolveRequestId } from '@/lib/server/logger'
import { errorResponse, handleApiError, firstZodIssue } from '@/lib/server/response'
import { 
  isFaultInjectionEnabled, 
  getFaultRegistry, 
  getFault, 
  activateFault, 
  deactivateFault, 
  deactivateAllFaults,
  getActiveFaults,
  reconcileActiveFaults,
} from '@/lib/server/fault-injection'
import { z } from 'zod'

export async function GET() {
  if (!isFaultInjectionEnabled()) {
    return NextResponse.json({ 
      enabled: false, 
      message: 'Fault injection not enabled. Set FAULT_INJECTION_ENABLED=true to use.' 
    })
  }

  // A real self-healing repair edits the file directly; the in-memory registry
  // must reflect what is actually present on disk.
  await reconcileActiveFaults()
  const faults = getFaultRegistry()
  const active = getActiveFaults()
  
  return NextResponse.json({
    enabled: true,
    total: faults.length,
    active: active.length,
    faults: faults.map(f => ({
      severity: f.riskLevel,
      difficulty: f.difficulty,
      trigger: `${f.trigger.method} ${f.trigger.endpoint}`,
      symptom: f.expectedError,
      active: f.active,
      id: f.id,
    }))
  })
}

const actionSchema = z.object({
  faultId: z.string().min(1).max(32).optional(),
  action: z.enum(['activate', 'deactivate', 'deactivate-all']).optional()
}).refine(data => {
  if (data.action === 'deactivate-all') return true
  return !!data.faultId
}, { message: 'faultId is required for activate/deactivate', path: ['faultId'] })

export async function POST(request: Request) {
  const requestId = resolveRequestId(request)

  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid request body.', 400)
  }

  const parsed = actionSchema.safeParse(body)
  if (!parsed.success) {
    return errorResponse(firstZodIssue(parsed.error), 400)
  }

  try {
    const { faultId, action = 'activate' } = parsed.data

    let result: { ok: boolean; error?: string }

    if (action === 'deactivate') {
      if (!faultId) return errorResponse('faultId required for deactivate', 400)
      result = await deactivateFault(faultId)
    } else if (action === 'deactivate-all') {
      await deactivateAllFaults()
      result = { ok: true }
    } else {
      if (!faultId) return errorResponse('faultId required for activate', 400)
      result = await activateFault(faultId)
      if (result.ok && getFault(faultId)) {
        const fault = getFault(faultId)!
        // The defect now lives in the real source file. No incident is
        // fabricated here: a real failed request must surface first, then the
        // log monitor turns the ERROR log into an incident.
        return NextResponse.json({
          success: true,
          faultId,
          action,
          defect: {
            file: fault.target.file,
            line: fault.target.line,
            function: fault.target.function,
          },
        })
      }
    }

    await logger.info({
      service: 'fault-injection',
      message: `Fault ${action}d: ${faultId ?? 'all'}`,
      route: '/api/faults',
      method: 'POST',
      status: result.ok ? 200 : 400,
      requestId,
      faultId,
      action,
    })

    if (!result.ok) {
      return errorResponse(result.error ?? 'Operation failed', 400)
    }

    return NextResponse.json({ success: true, faultId, action })
  } catch (err) {
    return handleApiError(err)
  }
}