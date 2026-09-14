import 'server-only'

// Phase 11 — automatic self-healing trigger.
//
// A real runtime ERROR log → log monitor → incident is only half the loop. This
// module closes it: as soon as `scanForRuntimeIncidents` creates OR merges an
// incident, the existing self-healing engine is enqueued automatically — no
// operator button required.
//
// Guarantees:
//   * A diagnosis never reads a fault id. The engine collects the SAME real
//     evidence (ERROR log, stack, source window, request id) either way.
//   * Duplicate repair runs for one incident are prevented:
//       - the incident must still be DETECTED and have ZERO RepairAttempt rows;
//       - an in-process in-flight Set rejects re-entry while a run is live.
//   * No infinite repair loop: RESOLVED / ROLLED_BACK / AI_REPAIR_FAILED are
//     terminal, so a failed validation is never retried automatically.
//   * HIGH risk still stops at WAITING_APPROVAL and waits for a human.
//   * Runs are serialized through a single FIFO queue so a low-RAM machine
//     never starts two repair conversations at once (Ollama itself also
//     serializes inference; this keeps the whole pipeline ordered).
//
// Gating: enabled by default in REAL mode, disabled in hermetic TEST mode so
// existing scripted tests keep driving `POST /api/security/run` explicitly.
// Override with AUTO_REPAIR=true|false. AUTO_REPAIR_SCENARIO is a test-only
// hook forwarded to the hermetic TEST provider (REAL providers ignore it).

import { prisma } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import { testModeEnabled } from '@/lib/server/provider'
import { addIncidentEvent } from './events'
import { runSelfHealingRepair } from './engine'

const LOG_MONITOR_SOURCE = 'log-monitor'

const inFlight = new Set<string>()
let queue: Promise<unknown> = Promise.resolve()

function truthy(value: string | undefined): boolean | null {
  const raw = (value ?? '').trim().toLowerCase()
  if (raw === '') return null
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
  return null
}

/** Auto-repair is on in REAL mode; hermetic TEST mode stays manual. */
export function autoRepairEnabled(): boolean {
  const explicit = truthy(process.env.AUTO_REPAIR)
  if (explicit !== null) return explicit
  return !testModeEnabled()
}

/** Test-only scenario forwarded to the hermetic provider (never to a real one). */
export function autoRepairScenario(): string | undefined {
  const raw = (process.env.AUTO_REPAIR_SCENARIO ?? '').trim()
  return raw === '' ? undefined : raw
}

export function isRepairInFlight(incidentId: string): boolean {
  return inFlight.has(incidentId)
}

/**
 * The single admission check. Returns a reason when the incident must NOT be
 * started (already running, already attempted, terminal, or not a log-monitor
 * incident). Keeps repeated scans/polls idempotent.
 */
async function shouldAutoStartRepair(
  incidentId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // NOTE: re-entry is prevented at enqueue-time via `inFlight` (this id is
  // already reserved when the job runs), so the gate only checks state. A
  // separate in-flight guard rejects manual runs while an auto-run is active.

  const [incident, attempts] = await Promise.all([
    prisma.incident.findUnique({
      where: { id: incidentId },
      select: { id: true, status: true, metadata: true },
    }),
    prisma.repairAttempt.count({ where: { incidentId } }),
  ])

  if (!incident) return { ok: false, reason: 'incident not found' }
  if (incident.status !== 'DETECTED') return { ok: false, reason: `status=${incident.status}` }
  if (attempts > 0) return { ok: false, reason: `attempt already exists (${attempts})` }

  const metadata = (incident.metadata ?? null) as { source?: string } | null
  if (metadata?.source !== LOG_MONITOR_SOURCE) {
    return { ok: false, reason: 'not a log-monitor incident' }
  }

  return { ok: true }
}

/** Serializes background repair runs through one FIFO chain. */
function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  // Swallow the chain result so a failed run never poisons the queue.
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/**
 * Fire-and-forget enqueue. Never throws and never blocks the scan response;
 * the dev server process stays alive while the engine runs in the background.
 */
export function enqueueAutoRepair(incidentId: string): void {
  if (!autoRepairEnabled()) return
  if (inFlight.has(incidentId)) return

  inFlight.add(incidentId)
  void runSerialized(async () => {
    try {
      const gate = await shouldAutoStartRepair(incidentId)
      if (!gate.ok) {
        await logger.info({
          service: 'auto-repair',
          message: `Auto-repair skipped for ${incidentId}: ${gate.reason}`,
          method: 'REPAIR',
          status: 200,
          incidentId,
        })
        return
      }

      await addIncidentEvent(
        incidentId,
        'INVESTIGATING',
        'Auto-repair triggered by log monitor',
        'self-healing pipeline started automatically from a real runtime ERROR log',
      )
      await logger.info({
        service: 'auto-repair',
        message: 'Auto-repair starting (no operator action)',
        method: 'REPAIR',
        status: 200,
        incidentId,
      })

      const result = await runSelfHealingRepair(incidentId, {
        scenario: autoRepairScenario(),
      })
      await logger.info({
        service: 'auto-repair',
        message: `Auto-repair finished: ${result.stage} (risk=${result.risk ?? 'n/a'}, rollback=${result.rollback})`,
        method: 'REPAIR',
        status: result.ok ? 200 : 500,
        incidentId,
        errorCode: result.ok ? null : result.stage,
      })
    } catch (err) {
      // The engine persists its own terminal failure; a hard crash here (e.g. DB
      // unavailable) is logged and left DETECTED so the next scan can retry.
      await logger.error({
        service: 'auto-repair',
        message: `Auto-repair crashed: ${err instanceof Error ? err.message : 'unknown error'}`,
        method: 'REPAIR',
        status: 503,
        incidentId,
        errorCode: 'AUTO_REPAIR_CRASHED',
      })
    } finally {
      inFlight.delete(incidentId)
    }
  })
}
