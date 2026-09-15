import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { prisma } from '@/lib/server/db'
import { handleApiError } from '@/lib/server/response'

// GET /api/ai/experiences — recent normalized repair experiences (RL rows with
// incident context) for the Learning dashboard timeline.
export async function GET() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  try {
    const experiences = await prisma.repairExperience.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        incident: { select: { ref: true, severity: true, endpoint: true, method: true } },
      },
    })

    return NextResponse.json({
      ok: true,
      count: experiences.length,
      experiences: experiences.map((e) => ({
        id: e.id,
        incidentRef: e.incident?.ref ?? null,
        severity: e.incident?.severity ?? null,
        endpoint: e.incident?.endpoint ?? null,
        method: e.incident?.method ?? null,
        outcome: e.outcome,
        reward: e.reward,
        rewardBreakdown: (e.rewardBreakdown ?? null) as Record<string, number> | null,
        terminal: e.terminal,
        humanDecision: e.humanDecision,
        createdAt: e.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    return handleApiError(err)
  }
}