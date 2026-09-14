import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { scanForRuntimeIncidents } from '@/lib/server/repair/log-monitor'
import { handleApiError } from '@/lib/server/response'

// POST /api/incidents/scan — operator-gated. Groups unlinked real ERROR logs
// by signature and creates one incident per distinct runtime failure.
export async function POST(request: Request) {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  let limit = 200
  try {
    const body = (await request.json().catch(() => ({}))) as { limit?: unknown }
    if (typeof body.limit === 'number' && Number.isFinite(body.limit)) {
      limit = Math.min(500, Math.max(1, Math.trunc(body.limit)))
    }
  } catch {
    // default limit
  }

  try {
    const result = await scanForRuntimeIncidents({ limit })
    return NextResponse.json({
      ok: true,
      scanned: result.scanned,
      linked: result.linked,
      merged: result.openMerged,
      created: result.created.map((incident) => ({
        id: incident.id,
        ref: incident.ref,
        status: incident.status,
        severity: incident.severity,
        title: incident.title,
      })),
    })
  } catch (err) {
    return handleApiError(err)
  }
}