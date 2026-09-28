import 'server-only'

import { prisma } from '@/lib/server/db'
import { logger } from '@/lib/server/logger'
import { UX_COMPONENTS, type UxComponentSpec } from './registry'
import { openSuggestionFor, requestUxSuggestion } from './engine'
import type { UxDirection } from './types'

// Behaviour analysis for the UX Suggestion Agent — the UI counterpart of the
// log monitor in the bug pipeline. Where the log monitor turns ERROR logs into
// incidents, this turns anonymous interaction signals (UxEvent rows from
// components/ux/behavior-tracker.tsx) into per-component friction scores, and
// when a component crosses the threshold it AUTOMATICALLY drafts a suggestion
// — which then waits for human email approval like every UX change.
//
// Friction signals per tracked component:
//   dead clicks   clicks on empty space next to it (users expected it there);
//                 the side they land on tells us where users look for it
//   rage clicks   3+ rapid clicks in one spot on/near it
//   slow finds    it was clicked, but only after UX_SLOW_FIND_MS on the page
// score = 2·dead + 3·rage + 2·slow. A component is flagged when its score and
// the number of distinct struggling sessions both reach their thresholds.
// Counting restarts after every suggestion for that component, so one bout
// of struggle raises at most one suggestion and a rejected idea is not
// re-proposed from the same evidence.

function intEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function frictionThresholds() {
  return {
    windowHours: intEnv('UX_BEHAVIOR_WINDOW_HOURS', 24),
    slowFindMs: intEnv('UX_SLOW_FIND_MS', 8000),
    minScore: intEnv('UX_FRICTION_MIN_SCORE', 12),
    minSessions: intEnv('UX_FRICTION_MIN_SESSIONS', 3),
  }
}

export function autoSuggestEnabled(): boolean {
  const raw = (process.env.UX_AUTO_SUGGEST ?? '').trim().toLowerCase()
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no')
}

export type { UxDirection }

export interface UxExpectation {
  dx: number
  dy: number
  viewportW: number | null
  viewportH: number | null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return Math.round(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2)
}

/** The side most struggle clicks landed on — only when it clearly dominates. */
function dominantDirection(bySide: { LEFT: number; RIGHT: number; ABOVE: number; BELOW: number }): UxDirection | null {
  const ranked = (
    [
      ['left', bySide.LEFT],
      ['right', bySide.RIGHT],
      ['up', bySide.ABOVE],
      ['down', bySide.BELOW],
    ] as Array<[UxDirection, number]>
  ).sort((a, b) => b[1] - a[1])
  if (ranked[0][1] === 0 || ranked[0][1] === ranked[1][1]) return null
  return ranked[0][0]
}

export function describeHotspot(h: { dx: number; dy: number } | null): string | null {
  if (!h) return null
  const parts: string[] = []
  if (Math.abs(h.dx) >= 8) parts.push(`${Math.abs(h.dx)}px to the ${h.dx < 0 ? 'left' : 'right'}`)
  if (Math.abs(h.dy) >= 8) parts.push(`${Math.abs(h.dy)}px ${h.dy < 0 ? 'above' : 'below'}`)
  return parts.length > 0 ? `${parts.join(' and ')} of where it is now` : 'right where it is now'
}

export interface ComponentFriction {
  uxId: string
  label: string
  file: string
  since: string
  sessions: number
  strugglingSessions: number
  targetClicks: number
  deadClicks: number
  deadClicksBySide: { LEFT: number; RIGHT: number; ABOVE: number; BELOW: number }
  rageClicks: number
  slowFinds: number
  avgFindMs: number | null
  score: number
  flagged: boolean
  direction: UxDirection | null
  /** Median spot (offset from the element's centre, px) where users clicked
   * looking for it — null when there are no positioned struggle clicks. */
  hotspot: { dx: number; dy: number; samples: number } | null
  /** Individual "expected here" points replayed by the sandbox simulation. */
  expectations: UxExpectation[]
  reason: string
  openSuggestion: { ref: string; status: string } | null
}

async function frictionFor(spec: UxComponentSpec): Promise<ComponentFriction> {
  const t = frictionThresholds()
  const windowStart = new Date(Date.now() - t.windowHours * 3600_000)
  // Counting restarts at the last suggestion's latest update (its decision, for
  // a decided one): struggle observed on the OLD UI, or already answered by a
  // human, never re-raises the same idea.
  const lastSuggestion = await prisma.uxSuggestion.findFirst({
    where: { uxId: spec.uxId },
    orderBy: { createdAt: 'desc' },
    select: { updatedAt: true },
  })
  const since =
    lastSuggestion && lastSuggestion.updatedAt > windowStart ? lastSuggestion.updatedAt : windowStart

  const events = await prisma.uxEvent.findMany({
    where: { uxId: spec.uxId, createdAt: { gt: since } },
    select: {
      sessionId: true,
      type: true,
      side: true,
      msSinceLoad: true,
      dx: true,
      dy: true,
      viewportW: true,
      viewportH: true,
    },
  })
  const expectations: UxExpectation[] = []

  const sessions = new Set<string>()
  const struggling = new Set<string>()
  const bySide = { LEFT: 0, RIGHT: 0, ABOVE: 0, BELOW: 0 }
  let dead = 0
  let rage = 0
  let slow = 0
  let targetClicks = 0
  let findTotal = 0
  let findCount = 0

  for (const e of events) {
    sessions.add(e.sessionId)
    if (e.type === 'DEAD_CLICK') {
      dead += 1
      struggling.add(e.sessionId)
      if (e.side && e.side in bySide) bySide[e.side as keyof typeof bySide] += 1
      if (typeof e.dx === 'number' && typeof e.dy === 'number') {
        expectations.push({ dx: e.dx, dy: e.dy, viewportW: e.viewportW ?? null, viewportH: e.viewportH ?? null })
      }
    } else if (e.type === 'RAGE_CLICK') {
      rage += 1
      struggling.add(e.sessionId)
      if (typeof e.dx === 'number' && typeof e.dy === 'number') {
        expectations.push({ dx: e.dx, dy: e.dy, viewportW: e.viewportW ?? null, viewportH: e.viewportH ?? null })
      }
    } else if (e.type === 'TARGET_CLICK') {
      targetClicks += 1
      if (typeof e.msSinceLoad === 'number') {
        findTotal += e.msSinceLoad
        findCount += 1
        if (e.msSinceLoad >= t.slowFindMs) {
          slow += 1
          struggling.add(e.sessionId)
        }
      }
    }
  }

  const score = dead * 2 + rage * 3 + slow * 2
  const direction = dominantDirection(bySide)
  const hotspot =
    expectations.length > 0
      ? { dx: median(expectations.map((x) => x.dx)), dy: median(expectations.map((x) => x.dy)), samples: expectations.length }
      : null
  const open = await openSuggestionFor(spec.uxId)
  const crossed = score >= t.minScore && struggling.size >= t.minSessions
  const reason = open
    ? open.status === 'SIMULATING'
      ? `${open.ref} is being tested in the sandbox`
      : `${open.ref} is awaiting a decision`
    : crossed
      ? 'friction threshold reached'
      : `below threshold (score ${score}/${t.minScore}, struggling sessions ${struggling.size}/${t.minSessions})`

  return {
    uxId: spec.uxId,
    label: spec.label,
    file: spec.file,
    since: since.toISOString(),
    sessions: sessions.size,
    strugglingSessions: struggling.size,
    targetClicks,
    deadClicks: dead,
    deadClicksBySide: bySide,
    rageClicks: rage,
    slowFinds: slow,
    avgFindMs: findCount > 0 ? Math.round(findTotal / findCount) : null,
    score,
    flagged: crossed && !open,
    direction,
    hotspot,
    expectations: expectations.slice(-60),
    reason,
    openSuggestion: open ? { ref: open.ref, status: open.status } : null,
  }
}

export async function computeFrictionReport(): Promise<ComponentFriction[]> {
  const report: ComponentFriction[] = []
  for (const spec of UX_COMPONENTS) report.push(await frictionFor(spec))
  return report.sort((a, b) => b.score - a.score)
}

/** Plain-language evidence given to the reviewer agent and shown in the email. */
export function describeFriction(f: ComponentFriction): string {
  const t = frictionThresholds()
  const parts = [`Across ${f.strugglingSessions} user sessions users struggled with the ${f.label}.`]
  if (f.deadClicks > 0) {
    const sides = (['LEFT', 'RIGHT', 'ABOVE', 'BELOW'] as const)
      .filter((s) => f.deadClicksBySide[s] > 0)
      .map((s) => `${f.deadClicksBySide[s]} ${s.toLowerCase()} of it`)
      .join(', ')
    parts.push(`${f.deadClicks} clicks landed on empty space next to it (${sides}) — where users expected it to be.`)
  }
  if (f.rageClicks > 0) parts.push(`${f.rageClicks} rage-click bursts (3+ rapid clicks) on or near it.`)
  if (f.slowFinds > 0) {
    parts.push(
      `${f.slowFinds} users needed more than ${Math.round(t.slowFindMs / 1000)}s to find and click it` +
        (f.avgFindMs !== null ? ` (average ${(f.avgFindMs / 1000).toFixed(1)}s).` : '.'),
    )
  }
  const spot = describeHotspot(f.hotspot)
  if (spot && f.hotspot && f.hotspot.samples >= 2) parts.push(`Most of those clicks cluster about ${spot}.`)
  const toward: Record<UxDirection, string> = {
    left: 'toward the left',
    right: 'toward the right',
    up: 'higher up',
    down: 'lower down',
  }
  parts.push(
    f.direction
      ? `Users look for it ${toward[f.direction]}: move it ${toward[f.direction]}, as close as practical to where they clicked, and make it easier to find.`
      : 'Make it more prominent and easier to find.',
  )
  return parts.join(' ')
}

// One analysis at a time per process (globalThis survives dev-server module
// duplication), so concurrent event batches can never raise duplicates.
const LOCK_KEY = '__buildhub_ux_behavior_lock__'
const TIMER_KEY = '__buildhub_ux_behavior_timer__'
const g = globalThis as unknown as Record<string, unknown>

export interface BehaviorRunResult {
  created: Array<{ uxId: string; ref: string; approvalId: string | undefined }>
  failed: Array<{ uxId: string; error: string }>
  report: ComponentFriction[]
}

const FAILED_KEY = '__buildhub_ux_behavior_failed__'
const FAILED_COOLDOWN_MS = 10 * 60 * 1000
if (!g[FAILED_KEY]) g[FAILED_KEY] = new Map<string, number>()
const failedAt = g[FAILED_KEY] as Map<string, number>

async function runAnalysis(force = false): Promise<BehaviorRunResult> {
  const created: BehaviorRunResult['created'] = []
  const failed: BehaviorRunResult['failed'] = []
  const report = await computeFrictionReport()
  for (const f of report.filter((r) => r.flagged)) {
    // A draft that just failed is not retried on every incoming event batch.
    const lastFail = failedAt.get(f.uxId)
    if (!force && lastFail && Date.now() - lastFail < FAILED_COOLDOWN_MS) continue
    const spec = UX_COMPONENTS.find((c) => c.uxId === f.uxId)!
    const instruction = describeFriction(f)
    const result = await requestUxSuggestion(
      {
        component: f.uxId,
        uxId: f.uxId,
        file: spec.file,
        instruction,
        direction: f.direction ?? undefined,
        hotspot: f.hotspot ?? undefined,
        evidenceSummary: instruction,
      },
      'ux-behavior-monitor',
      {
        source: 'AUTO',
        expectations: f.expectations,
        evidence: {
          sessions: f.sessions,
          strugglingSessions: f.strugglingSessions,
          deadClicks: f.deadClicks,
          deadClicksBySide: f.deadClicksBySide,
          rageClicks: f.rageClicks,
          slowFinds: f.slowFinds,
          avgFindMs: f.avgFindMs,
          score: f.score,
          direction: f.direction,
          hotspot: f.hotspot,
          since: f.since,
        },
      },
    )
    if (result.ok && result.suggestion) {
      failedAt.delete(f.uxId)
      created.push({ uxId: f.uxId, ref: result.suggestion.ref, approvalId: result.approvalId })
    } else {
      failedAt.set(f.uxId, Date.now())
      failed.push({ uxId: f.uxId, error: result.error ?? 'draft failed' })
    }
    await logger
      .info({
        service: 'ux-behavior',
        message: result.ok
          ? `UX friction on ${f.uxId} (score ${f.score}) → ${result.suggestion?.ref} drafted, testing in sandbox`
          : `UX friction on ${f.uxId} (score ${f.score}) → draft failed: ${result.error}`,
        route: '/api/ux/events',
        method: 'POST',
        status: 200,
      })
      .catch(() => undefined)
  }
  return { created, failed, report: created.length > 0 ? await computeFrictionReport() : report }
}

/** Runs one analysis now, serialized behind any in-progress run. `force`
 * (operator "Analyze now") ignores the failed-draft cooldown. */
export function analyzeBehaviorNow(force = false): Promise<BehaviorRunResult> {
  const previous = (g[LOCK_KEY] as Promise<unknown> | undefined) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => runAnalysis(force))
  g[LOCK_KEY] = next.catch(() => undefined)
  return next
}

/** Debounced background analysis after new events arrive (never blocks ingest). */
export function scheduleBehaviorAnalysis(delayMs = 1500): void {
  if (!autoSuggestEnabled()) return
  if (g[TIMER_KEY]) return
  g[TIMER_KEY] = setTimeout(() => {
    g[TIMER_KEY] = undefined
    analyzeBehaviorNow().catch((err) =>
      logger
        .warn({
          service: 'ux-behavior',
          message: `behaviour analysis failed: ${err instanceof Error ? err.message : 'unknown'}`,
          route: '/api/ux/events',
          method: 'POST',
          status: 200,
        })
        .catch(() => undefined),
    )
  }, delayMs)
}
