import { NextResponse } from 'next/server'

import { jiraLinksFor } from '@/lib/server/jira/approvals'
import { z } from 'zod'

import { requireSecurityOperator } from '@/lib/server/security'
import { prisma } from '@/lib/server/db'
import { expireStaleTrials, requestUxSuggestion } from '@/lib/server/ux/engine'
import { errorResponse, handleApiError, firstZodIssue } from '@/lib/server/response'

// Demo trigger for the UX Suggestion Agent, analogous to POST /api/faults
// activating a fault: an operator names a component + file (+ optional hint)
// and the agent drafts a candidate change. It is NEVER applied here — see
// app/api/ux/approvals/{proceed,email}/route.ts for the only apply path.

const requestSchema = z.object({
  component: z.string().trim().min(1).max(120),
  file: z.string().trim().min(1).max(300),
  instruction: z.string().trim().max(500).optional(),
})

export async function GET() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  try {
    await expireStaleTrials()
    const suggestions = await prisma.uxSuggestion.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { approvals: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })
    // Attach the Jira card (if the approval was requested in Jira).
    const jira = await jiraLinksFor(suggestions.flatMap((x) => x.approvals.map((a) => a.approvalId)))
    return NextResponse.json({
      suggestions: suggestions.map((x) => ({
        ...x,
        approvals: x.approvals.map((a) => ({ ...a, jira: jira.get(a.approvalId) ?? null })),
      })),
    })
  } catch (err) {
    return handleApiError(err)
  }
}

export async function POST(request: Request) {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Invalid request body.', 400)
  }

  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return errorResponse(firstZodIssue(parsed.error), 400)
  }

  try {
    const result = await requestUxSuggestion(parsed.data, guard.user.username)
    if (!result.ok) {
      return errorResponse(result.error ?? 'Could not draft a UX suggestion.', 422)
    }
    return NextResponse.json({
      ok: true,
      suggestion: result.suggestion,
      approvalId: result.approvalId,
      simulating: result.simulating ?? false,
      email: result.email,
    })
  } catch (err) {
    return handleApiError(err)
  }
}
