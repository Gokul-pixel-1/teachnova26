import { NextResponse } from 'next/server'
import { z } from 'zod'

import { requireSecurityOperator } from '@/lib/server/security'
import { approveApproval, expireApproval, isExpired, getPendingApproval } from '@/lib/server/approval'
import { continueApprovedRepair, finalizeRejectedRepair } from '@/lib/server/repair/engine'
import { addIncidentEvent } from '@/lib/server/repair/events'
import { sendIncidentTerminalSummary } from '@/lib/server/notifications/summary'
import { sendFinalEmail } from '@/lib/server/gmail'
import { prisma } from '@/lib/server/db'
import { logger, resolveRequestId } from '@/lib/server/logger'
import { errorResponse, handleApiError, firstZodIssue } from '@/lib/server/response'

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

  // Support both { proceed: true } and plain "PROCEED APR-XXXXX" text
  let approvalId: string | undefined
  let action: 'proceed' | 'reject' | undefined

  if (typeof body === 'object' && body !== null) {
    const parsed = approvalProceedSchema.safeParse(body)
    if (!parsed.success) {
      return errorResponse(firstZodIssue(parsed.error), 400)
    }
    ;({ approvalId, action } = parsed.data)
  } else if (typeof body === 'string') {
    const text = body.trim()
    // Parse "PROCEED APR-XXXXX" or "REJECT APR-XXXXX"
    const match = text.match(/^(PROCEED|REJECT)\s+([A-Z0-9-]+)$/i)
    if (match) {
      action = match[1].toLowerCase() as 'proceed' | 'reject'
      approvalId = match[2]
    }
  }

  if (!approvalId || !action) {
    return errorResponse('Approval ID and action (PROCEED/REQUIRED) are required.', 400)
  }

  try {
    let result:
      | { approval: Approval; success: boolean; error?: string; note?: string; repair?: import('@/lib/server/repair/engine').RepairRunResult }
      | null = null

    if (action === 'proceed') {
      // First check if approval exists and is PENDING
      const existing = await getPendingApproval(approvalId)
      if (!existing) {
        // Check if already approved/rejected/expired
        const existingAny = await prisma.approval.findFirst({
          where: { approvalId },
          select: { status: true },
        })
        const status = existingAny?.status
        if (status === 'APPROVED') {
          return NextResponse.json({
            approved: true,
            message: 'This approval has already been applied.',
            status,
          })
        }
        if (status === 'REJECTED') {
          return NextResponse.json({
            rejected: true,
            message: 'This approval has already been rejected.',
            status,
          })
        }
        if (status === 'EXPIRED') {
          return NextResponse.json({
            expired: true,
            message: 'This approval has expired.',
            status,
          })
        }
        return errorResponse('Approval request not found or not pending.', 404)
      }

      // Check expiration
      if (isExpired(existing)) {
        await expireApproval(approvalId)
        const expiredRow = await prisma.approval.findUnique({
          where: { approvalId },
          include: { incident: true },
        })
        if (expiredRow?.incident) {
          await prisma.incident.update({
            where: { id: expiredRow.incidentId },
            data: {
              status: 'AI_REPAIR_FAILED',
              summary: `Approval ${approvalId} expired without a decision.`,
            },
          })
          await addIncidentEvent(expiredRow.incidentId, 'EXPIRED', 'Approval expired without decision', approvalId)
          await sendIncidentTerminalSummary(expiredRow.incident).catch(() => undefined)
          await sendFinalEmail({ incident: expiredRow.incident }).catch(() => undefined)
        }
        return NextResponse.json({
          expired: true,
          message: 'Approval has expired.',
          status: 'EXPIRED',
        })
      }

      // Approve the approval
      const approved = await approveApproval(approvalId)
      if (!approved) {
        return errorResponse('Failed to process approval.', 500)
      }

      result = { approval: approved, success: true }

      // If this approval is bound to a repair attempt, PROCEED immediately
      // continues: apply the stored candidate → real validation → RESOLVED or
      // ROLLED_BACK. The approval is consumed when the apply finishes.
      const bound = await prisma.approval.findUnique({
        where: { approvalId },
        select: { repairAttemptId: true },
      })
      if (bound?.repairAttemptId) {
        const repair = await continueApprovedRepair(approvalId, 'security-operator')
        result = {
          approval: { ...approved, status: 'CONSUMED' },
          success: repair.ok || repair.stage === 'ROLLED_BACK' ? true : false,
          repair,
        }
      } else {
        result = {
          approval: approved,
          success: true,
          note: 'Approval approved. No repair attempt is bound to this legacy analysis approval, so there is no code patch to apply.',
        }
      }
    } else if (action === 'reject') {
      // A human rejected the repair: shared finalizer freezes the incident
      // honestly (no code change), records REJECTED learning, and notifies
      // both channels once. Idempotent on repeat clicks.
      const finalized = await finalizeRejectedRepair(approvalId, 'security-operator')
      if (!finalized.ok) {
        return errorResponse('Failed to process rejection.', 500)
      }
      const rejected = await prisma.approval.findUnique({ where: { approvalId } })
      result = { approval: rejected as unknown as Approval, success: true }
    }

    await logger.info({
      service: 'approval',
      message: `Approval ${action}ed`,
      route: '/api/approvals/proceed',
      method: 'POST',
      status: 200,
      requestId,
      approvalId,
      action,
    })

    return NextResponse.json({ ...result, approvalId })
  } catch (err) {
    return handleApiError(err)
  }
}

export const approvalProceedSchema = z.object({
  approvalId: z.string().trim().min(1, 'approvalId is required.').max(32),
  action: z.enum(['proceed', 'reject']),
})

interface Approval {
  id: string
  approvalId: string
  incidentId: string
  patchId: string
  status: string
  operator: string
  createdAt: Date
  expiresAt: Date
  statusUpdatedAt: Date
}