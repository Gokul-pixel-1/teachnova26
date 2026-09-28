import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { IncidentSeverity, IncidentStatus } from '@prisma/client'

import { prisma } from '@/lib/server/db'
import { getSessionUser } from '@/lib/server/auth'
import { errorResponse, handleApiError } from '@/lib/server/response'
import { logger } from '@/lib/server/logger'
import { serializeIncident } from '@/lib/server/observability'

const VALID_STATUSES = [
  'DETECTED',
  'INVESTIGATING',
  'AWAITING_REVIEW',
  'RESOLVED',
  'ROLLED_BACK',
  'REJECTED',
] as const satisfies readonly IncidentStatus[]
const VALID_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const satisfies readonly IncidentSeverity[]

const incidentQuerySchema = z.object({
  status: z.string().trim().max(120).optional(),
  severity: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

function toList(value: string | undefined, valid: readonly string[]): string[] | undefined {
  if (!value) return undefined
  const items = value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
    .filter((item) => valid.includes(item))
  return items.length > 0 ? items : undefined
}

export async function GET(request: Request) {
  const user = await getSessionUser()
  if (!user) {
    return errorResponse('Not authenticated.', 401)
  }

  const parsed = incidentQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  )
  if (!parsed.success) {
    return errorResponse('Invalid query parameters.', 400)
  }

  const { status, severity, page, pageSize } = parsed.data
  const statusList = toList(status, VALID_STATUSES) as IncidentStatus[] | undefined
  const severityList = toList(severity, VALID_SEVERITIES) as IncidentSeverity[] | undefined
  const where: NonNullable<Parameters<typeof prisma.incident.findMany>[0]>['where'] = {
    ...(statusList ? { status: { in: statusList } } : {}),
    ...(severityList ? { severity: { in: severityList } } : {}),
  }
  const requestId = request.headers.get('x-request-id') ?? undefined

  try {
    const [incidents, total] = await Promise.all([
      prisma.incident.findMany({
        where,
        include: { _count: { select: { logs: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.incident.count({ where }),
    ])

    await logger.info({
      service: 'api',
      message: `Incident list fetched: ${incidents.length} returned`,
      route: '/api/incidents',
      method: 'GET',
      status: 200,
      requestId,
    })

    return NextResponse.json({
      incidents: incidents.map(serializeIncident),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    })
  } catch (err) {
    return handleApiError(err)
  }
}