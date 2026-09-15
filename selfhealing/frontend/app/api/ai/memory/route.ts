import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { prisma } from '@/lib/server/db'
import { handleApiError } from '@/lib/server/response'

// GET /api/ai/memory — repair memory history (the "History" surface).
export async function GET() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  try {
    const memories = await prisma.repairMemory.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        incident: { select: { ref: true, severity: true, status: true, endpoint: true } },
      },
    })

    return NextResponse.json({
      ok: true,
      count: memories.length,
      memories: memories.map((m) => ({
        id: m.id,
        incidentRef: m.incident?.ref ?? null,
        severity: m.incident?.severity ?? null,
        incidentStatus: m.incident?.status ?? null,
        endpoint: m.incident?.endpoint ?? null,
        rootCause: m.rootCause,
        file: m.file,
        feature: m.feature,
        patchSummary: m.patchSummary,
        risk: m.risk,
        outcome: m.outcome,
        reward: m.reward,
        rewardBreakdown: (m.rewardBreakdown ?? null) as Record<string, number> | null,
        recurrenceCount: m.recurrenceCount,
        humanDecision: m.humanDecision,
        humanReason: m.humanReason,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleApiError(err)
  }
}