import { NextResponse } from 'next/server'

import { getSessionUser } from '@/lib/server/auth'
import { prisma } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import { errorResponse, handleApiError } from '@/lib/server/response'
import { continueApprovedRepair } from '@/lib/server/repair/engine'

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: incidentId } = await ctx.params
  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  const requestId = request.headers.get('x-request-id') ?? undefined

  try {
    // Check for an existing pending approval
    const pendingApproval = await prisma.approval.findFirst({
      where: { incidentId, status: 'PENDING' },
      select: {
        approvalId: true,
        patchId: true,
        status: true,
        operator: true,
        createdAt: true,
        expiresAt: true,
      },
    })

    if (!pendingApproval) {
      return errorResponse('No pending approval for this incident.', 404)
    }

    // Check expiration
    if (pendingApproval.expiresAt && new Date() > pendingApproval.expiresAt) {
      await prisma.approval.update({
        where: { approvalId: pendingApproval.approvalId },
        data: { status: 'EXPIRED', statusUpdatedAt: new Date() },
      })
      return NextResponse.json({
        expired: true,
        message: 'Approval has expired.',
        status: 'EXPIRED',
      })
    }

    // Verify the approval is APPROVED (not just pending)
    if (pendingApproval.status !== 'APPROVED') {
      return errorResponse('Approval is not APPROVED.', 400)
    }

    // Run the real approved repair: apply the candidate to the real file,
    // re-run the failing request, resolve or roll back.
    const repair = await continueApprovedRepair(pendingApproval.approvalId, 'security-operator')

    const eventDetail = `Patch ${repair.candidateFile ?? pendingApproval.patchId} applied with approval ${pendingApproval.approvalId} (${repair.stage})`
    await prisma.incidentEvent.create({
      data: {
        incidentId,
        stage: 'PATCH_APPLIED',
        label: 'Patch applied via approval',
        detail: eventDetail,
      },
    })

    await logger.info({
      service: 'incident',
      message: `Approved patch applied: ${repair.stage}`,
      route: '/api/incidents/[id]/apply-patch',
      method: 'POST',
      status: 200,
      requestId,
      incidentId,
      approvalId: pendingApproval.approvalId,
    })

    return NextResponse.json({
      approved: true,
      approvalId: pendingApproval.approvalId,
      patchId: repair.candidateFile ?? pendingApproval.patchId,
      status: repair.stage,
      message: `Patch applied. ${repair.stage}.`,
      rollback: repair.rollback,
    })
  } catch (err) {
    return handleApiError(err)
  }
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: incidentId } = await ctx.params
  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  const approval = await prisma.approval.findFirst({
    where: { incidentId },
    select: {
      id: true,
      approvalId: true,
      status: true,
      operator: true,
      createdAt: true,
      expiresAt: true,
      patchId: true,
    },
  })

  if (!approval) {
    return NextResponse.json({ hasApproval: false })
  }

  return NextResponse.json({
    hasApproval: true,
    approvalId: approval.approvalId,
    status: approval.status,
    patchId: approval.patchId,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
  })
}