import { NextResponse } from 'next/server'
import { z } from 'zod'

import { prisma } from '@/lib/server/db'
import { isTrackedUxId } from '@/lib/server/ux/registry'
import { scheduleBehaviorAnalysis } from '@/lib/server/ux/behavior'
import { errorResponse, handleRouteError } from '@/lib/server/response'

// Public ingest for anonymous UI-friction signals from
// components/ux/behavior-tracker.tsx. Deliberately unauthenticated: the users
// who struggle most (e.g. to find "Log in") are signed out. Only interaction
// shape is accepted — no free text beyond the page path — and only for
// registered components. Ingest never drafts synchronously; it schedules a
// debounced analysis (lib/server/ux/behavior.ts), and any resulting
// suggestion still requires human approval before a file changes.

const eventSchema = z.object({
  type: z.enum(['TARGET_CLICK', 'DEAD_CLICK', 'RAGE_CLICK']),
  uxId: z.string().trim().max(64).optional(),
  path: z.string().trim().max(300),
  x: z.number().int().min(-10000).max(100000).optional(),
  y: z.number().int().min(-10000).max(100000).optional(),
  viewportW: z.number().int().min(0).max(100000).optional(),
  viewportH: z.number().int().min(0).max(100000).optional(),
  side: z.enum(['LEFT', 'RIGHT', 'ABOVE', 'BELOW']).optional(),
  dx: z.number().int().min(-5000).max(5000).optional(),
  dy: z.number().int().min(-5000).max(5000).optional(),
  targetW: z.number().int().min(0).max(5000).optional(),
  targetH: z.number().int().min(0).max(5000).optional(),
  msSinceLoad: z.number().int().min(0).max(3_600_000).optional(),
})

const batchSchema = z.object({
  sessionId: z.string().trim().min(1).max(64),
  events: z.array(eventSchema).max(50),
})

export async function POST(request: Request) {
  let body: unknown
  try {
    // sendBeacon may deliver without a JSON content-type, so parse text.
    body = JSON.parse(await request.text())
  } catch {
    return errorResponse('Invalid request body.', 400)
  }
  const parsed = batchSchema.safeParse(body)
  if (!parsed.success) return errorResponse('Invalid event batch.', 400)

  // The sandbox copy of the app (lib/server/ux/sandbox.ts) shares the database;
  // its simulated visits must never count as real user behaviour.
  if (process.env.UX_SANDBOX_MODE === 'true') return NextResponse.json({ accepted: 0 })

  try {
    const rows = parsed.data.events
      .filter((e) => isTrackedUxId(e.uxId))
      .map((e) => ({ ...e, sessionId: parsed.data.sessionId }))
    if (rows.length > 0) {
      await prisma.uxEvent.createMany({ data: rows })
      scheduleBehaviorAnalysis()
    }
    return NextResponse.json({ accepted: rows.length })
  } catch (err) {
    return handleRouteError(err, request, { service: 'ux-behavior' })
  }
}
