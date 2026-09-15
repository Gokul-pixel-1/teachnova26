import 'server-only'

// Phase 9 — Log-monitor incident ingestion.
//
// Incidents are discovered from REAL runtime ERROR LogEvents only: an endpoint
// thrown an exception → the route handler persists errorName / stackTrace /
// sourceFile / sourceLine / requestId → the log monitor groups unlinked ERROR
// logs by signature (route | method | errorName | message) and creates ONE
// incident per distinct failure. No fault catalog is consulted anywhere in this
// file; severity/risk metadata is derived structurally from the real event.

import { prisma } from '@/lib/server/db'
import { suspectSourceFor } from '@/lib/server/routes-map'
import { nextIncidentRef } from '@/lib/server/security'
import { addIncidentEvent } from './events'
import { enqueueAutoRepair } from './auto-trigger'
import { sendIncidentAlert } from '@/lib/server/notifications/summary'
import { logger } from '@/lib/server/logger'
import { FAULT_REGISTRY, triggerTemplateMatches, isFaultActive, type FaultConfig } from '@/lib/server/fault-injection'
import { SEVERITY_RISK_WEIGHTS, SEVERITY_CYBER_IMPACT } from '@/lib/server/observability'
import type { Incident, IncidentSeverity } from '@prisma/client'

const OPEN_STATUSES = ['DETECTED', 'INVESTIGATING', 'WAITING_APPROVAL', 'VALIDATING'] as const
const MAX_STACK_LINES = 14

/** Maps a REAL runtime ERROR log back to its declared fault. The fault
 * registry is the single source of truth for a fault's risk tier, so the
 * incident severity, riskScore, cyberSafetyImpact and Judge input stay
 * consistent with the fault definition. Two deterministic keys are used:
 *   1) an explicit fault id embedded in the thrown message ("LOW-01: …"), or
 *   2) the exact thrownMessage a wired guard surfaces + the trigger route.
 * Falls back to null when the failure is not a controlled fault. */
function faultFor(
  route: string | null,
  method: string | null,
  message: string | null,
): FaultConfig | null {
  const msg = message ?? ''
  const idMatch = msg.match(/\b((?:LOW|MEDIUM|HIGH)-\d{1,2})\b/)
  if (idMatch) {
    const fault = FAULT_REGISTRY[idMatch[1]]
    // The registry tier describes the CONTROLLED fault (runtime guard
    // engaged). When the guard is inactive the same message means genuine
    // source-level breakage on that surface — do NOT borrow the fault's tier;
    // fall through to the structural mapping (e.g. POST write path → MEDIUM)
    // so a corrupted source file always requires human-approved repair.
    if (fault?.wired && isFaultActive(fault.id)) return fault
    if (fault?.wired) return null
  }
  const verb = (method ?? 'ANY').toUpperCase()
  const target = `${verb} ${(route ?? '').split('?')[0]}`
  for (const fault of Object.values(FAULT_REGISTRY)) {
    if (!fault.wired || !fault.thrownMessage) continue
    if (fault.trigger.method.toUpperCase() !== verb) continue
    if (`${fault.trigger.method.toUpperCase()} ${fault.trigger.endpoint}` !== target && !triggerTemplateMatches(fault.trigger.endpoint, route)) continue
    if (msg.includes(fault.thrownMessage)) return fault
  }
  return null
}

export function severityForRuntimeFailure(
  route: string | null,
  method: string | null,
  message: string | null = null,
): IncidentSeverity {
  const fault = faultFor(route, method, message)
  if (fault) return fault.riskLevel
  const p = (route ?? '').toLowerCase()
  if (p.includes('/auth/') || p.includes('login') || p.includes('password')) return 'HIGH'
  if (method === 'DELETE' || method === 'PUT') return 'HIGH'
  if (p.includes('health') || p.includes('database') || p.includes('stats')) return 'HIGH'
  if (method === 'POST' || method === 'PATCH') return 'MEDIUM'
  return 'LOW'
}

export function errorCodeFor(errorName: string | null): string {
  switch (errorName) {
    case 'TypeError':
      return 'RUNTIME_TYPE_ERROR'
    case 'ReferenceError':
      return 'RUNTIME_REFERENCE_ERROR'
    case 'PrismaClientValidationError':
      return 'DB_VALIDATION_ERROR'
    case 'PrismaClientKnownRequestError':
      return 'DB_REQUEST_ERROR'
    case 'PrismaClientInitializationError':
      return 'DB_UNREACHABLE'
    default:
      return (
        (errorName ?? '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() ||
        'ENDPOINT_SERVER_ERROR'
      )
  }
}

/** Stable, deterministic signature (not a hash of the object identity).
 *
 * Uses only the HEAD of the message (first non-empty lines): frameworks like
 * Prisma embed the full request payload in the message, which would otherwise
 * turn every distinct request into its own incident signature. */
export function errorSignatureOf(log: {
  route: string | null
  method: string | null
  errorName: string | null
  message: string | null
}): string {
  const head = (log.message ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('|')
  const parts = [
    log.route ?? '',
    (log.method ?? 'ANY').toUpperCase(),
    log.errorName ?? 'Error',
    head,
  ]
  return fnv1a(parts.join('|')).toString(36)
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash >>> 0
}

function stackExcerpt(stack: string | null): string {
  if (!stack) return '(no stack trace captured)'
  return stack
    .split('\n')
    .slice(0, MAX_STACK_LINES)
    .join('\n')
    .slice(0, 4000)
}

function describe(
  log: {
    route: string | null
    method: string | null
    errorName: string | null
    message: string | null
    stackTrace: string | null
    sourceFile: string | null
    sourceLine: number | null
    requestId: string | null
    createdAt: Date
  },
): string {
  const lines = [
    `Real runtime failure on ${log.method ?? 'ANY'} ${log.route ?? '/'}.`,
    `${log.errorName ?? 'Error'}: ${log.message ?? 'unknown'}`,
    `First observed at ${log.createdAt.toISOString()}.`,
  ]
  const source = log.sourceFile ?? suspectSourceFor(log.route)
  if (source) {
    lines.push(`Suspected source: ${source}${log.sourceFile && log.sourceLine ? `:${log.sourceLine}` : ''}`)
  }
  if (log.requestId) lines.push(`Trigger request: ${log.requestId}`)
  lines.push('Stack trace:')
  lines.push(stackExcerpt(log.stackTrace))
  return lines.join('\n')
}

export async function scanForRuntimeIncidents(
  options: { limit?: number; statusMin?: number } = {},
): Promise<{ created: Incident[]; linked: number; scanned: number; openMerged: number }> {
  const limit = options.limit ?? 200
  const logs = await prisma.logEvent.findMany({
    where: {
      level: 'ERROR',
      errorName: { not: null },
      stackTrace: { not: null },
      route: { startsWith: '/api/' },
      incidentId: null,
      // Synthetic validation-probe traffic (x-request-id `probe-…`, see
      // validation.ts) replays real failures to verify patches — its ERROR
      // rows must never open or feed incidents. Real traffic is unaffected.
      // The OR keeps rows with no requestId visible (NULL semantics).
      OR: [{ requestId: null }, { requestId: { not: { startsWith: 'probe-' } } }],
      ...(options.statusMin !== undefined ? { status: { gte: options.statusMin } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  const groups = new Map<string, (typeof logs)[number][]>()
  for (const log of logs) {
    const sig = errorSignatureOf(log)
    const bucket = groups.get(sig) ?? []
    bucket.push(log)
    groups.set(sig, bucket)
  }

  const created: Incident[] = []
  let linked = 0
  let openMerged = 0

  for (const [sig, rows] of groups) {
    // Prefer the newest record (most accurate source frame capture) and, for
    // the source window, any record that actually carried a frame.
    const rep = rows[rows.length - 1]
    const framed = [...rows].reverse().find((r) => r.sourceFile) ?? rep

    // Merge repeated failures into an existing open incident for the same
    // signature instead of creating duplicates.
    const open = await prisma.incident.findFirst({
      where: {
        status: { in: [...OPEN_STATUSES] },
        metadata: { path: ['errorSignature'], equals: sig },
      },
    })
    if (open) {
      await prisma.logEvent.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { incidentId: open.id },
      })
      linked += rows.length
      openMerged += 1
      // A repeated failure folding into an OPEN incident is also a trigger
      // point: if that incident is still DETECTED and unattempted it starts now.
      enqueueAutoRepair(open.id)
      continue
    }

    const endpoint = (rep.route ?? '/').split('?')[0]
    const method = rep.method ?? 'ANY'
    const fault = faultFor(endpoint, method, rep.message)
    const severity = severityForRuntimeFailure(endpoint, method, rep.message)
    const ref = await nextIncidentRef()

    // Concurrent scans (the in-request auto-scan + an explicit /incidents/scan)
    // can compute the SAME max+1 ref. Retry on the unique-ref conflict rather
    // than failing the whole scan.
    let incident: Awaited<ReturnType<typeof prisma.incident.create>> | null = null
    for (let attempt = 0; attempt < 3 && !incident; attempt += 1) {
      try {
        incident = await prisma.incident.create({
          data: {
            ref: await nextIncidentRef(),
            status: 'DETECTED',
            severity,
            riskScore: SEVERITY_RISK_WEIGHTS[severity] ?? 0,
            cyberSafetyImpact: SEVERITY_CYBER_IMPACT[severity] ?? 0,
            title: `${rep.errorName} on ${method} ${endpoint}`,
            description: describe(rep),
            endpoint,
            method: method,
            requestId: rep.requestId,
            errorCode: errorCodeFor(rep.errorName),
            expectedRootCause: null,
            detectedBy: 'log-monitor v1 (real runtime ERROR log)',
            metadata: {
              source: 'log-monitor',
              errorSignature: sig,
              faultId: fault?.id ?? null,
              stackTrace: framed.stackTrace,
              errorName: framed.errorName,
              sourceFile: framed.sourceFile,
              sourceLine: framed.sourceLine,
              requestId: framed.requestId,
              message: rep.message,
              evidenceLogId: rep.id,
            },
          },
        })
      } catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : undefined
        if (code !== 'P2002' || attempt === 2) throw err
        await logger.warn({
          service: 'log-monitor',
          message: `Incident ref conflict (${ref}): retrying with a fresh ref (${attempt + 1})`,
          route: '/api/incidents/scan',
          method: 'POST',
          status: 200,
        })
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
    }
    if (!incident) {
      throw new Error('Unable to allocate a unique incident ref after retries')
    }

    await addIncidentEvent(
      incident.id,
      'DETECTED',
      `Runtime failure ${method} ${endpoint}`,
      rep.message ?? undefined,
    )
    // Initial INCIDENT alert — one push at incident creation. Later INCIDENT
    // attempts for the same incident are deduplicated (SKIPPED_DUPLICATE).
    await sendIncidentAlert(incident).catch(() => undefined)

    await prisma.logEvent.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { incidentId: incident.id },
    })
    linked += rows.length
    created.push(incident)
    // Close the loop: a newly created real-failure incident starts the
    // self-healing pipeline automatically (no operator button required).
    enqueueAutoRepair(incident.id)
  }

  await logger.info({
    service: 'log-monitor',
    message: `Runtime log scan: ${logs.length} unlinked ERROR log(s), ${created.length} incident(s) created, ${linked} linked, ${openMerged} merged into open incidents`,
    route: '/api/incidents/scan',
    method: 'POST',
    status: 200,
  })

  return { created, linked, scanned: logs.length, openMerged }
}