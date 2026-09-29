import 'server-only'

import { prisma } from '@/lib/server/db'
import { uxComponent } from '@/lib/server/ux/registry'

// UX Impact Proof: did an approved UI change actually help real users?
// Compares the SAME real behaviour signals the UX agent used to raise the
// suggestion (UxEvent rows: dead clicks, rage clicks, time-to-find) in the
// week BEFORE the change went live against everything AFTER it. Read-only.

const BEFORE_WINDOW_MS = 7 * 86_400_000
const MIN_AFTER_SESSIONS = 3
const MEANINGFUL_CHANGE = 0.2

export interface UxWindowMetrics {
  sessions: number
  targetClicks: number
  deadClicks: number
  rageClicks: number
  strugglePerVisitor: number
  findRate: number
  medianFindSeconds: number | null
}

export type UxVerdict = 'improved' | 'worse' | 'no-change' | 'collecting'

export interface UxImpactItem {
  id: string
  ref: string
  uxId: string
  component: string
  summary: string | null
  status: string
  appliedAt: string
  before: UxWindowMetrics
  after: UxWindowMetrics
  struggleChangePct: number | null
  findTimeChangePct: number | null
  verdict: UxVerdict
  headline: string
}

async function windowMetrics(uxId: string, from: Date, to: Date): Promise<UxWindowMetrics> {
  const events = await prisma.uxEvent.findMany({
    where: { uxId, createdAt: { gte: from, lt: to } },
    select: { sessionId: true, type: true, msSinceLoad: true },
  })
  const sessions = new Set(events.map((e) => e.sessionId))
  const finders = new Set(events.filter((e) => e.type === 'TARGET_CLICK').map((e) => e.sessionId))
  const dead = events.filter((e) => e.type === 'DEAD_CLICK').length
  const rage = events.filter((e) => e.type === 'RAGE_CLICK').length
  const findTimes = events
    .filter((e) => e.type === 'TARGET_CLICK' && typeof e.msSinceLoad === 'number')
    .map((e) => e.msSinceLoad as number)
    .sort((a, b) => a - b)
  return {
    sessions: sessions.size,
    targetClicks: events.filter((e) => e.type === 'TARGET_CLICK').length,
    deadClicks: dead,
    rageClicks: rage,
    strugglePerVisitor: sessions.size ? Math.round(((dead + rage) / sessions.size) * 100) / 100 : 0,
    findRate: sessions.size ? Math.round((finders.size / sessions.size) * 100) : 0,
    medianFindSeconds: findTimes.length
      ? Math.round(findTimes[Math.floor(findTimes.length / 2)] / 100) / 10
      : null,
  }
}

function pctChange(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null
  return Math.round(((after - before) / before) * 100)
}

export async function computeUxImpact(): Promise<UxImpactItem[]> {
  const applied = await prisma.uxSuggestion.findMany({
    where: { status: { in: ['APPLIED', 'VALIDATED'] }, appliedAt: { not: null }, uxId: { not: null } },
    orderBy: { appliedAt: 'asc' },
    take: 60,
    select: { id: true, ref: true, component: true, summary: true, status: true, appliedAt: true, uxId: true },
  })
  const now = new Date()

  const items = await Promise.all(
    applied.map(async (s, index) => {
      const appliedAt = s.appliedAt as Date
      // A later change to the same component ends this change's "after"
      // window, so every result measures exactly one change.
      const next = applied.slice(index + 1).find((later) => later.uxId === s.uxId)
      const afterEnd = next?.appliedAt ?? now
      const [before, after] = await Promise.all([
        windowMetrics(s.uxId as string, new Date(appliedAt.getTime() - BEFORE_WINDOW_MS), appliedAt),
        windowMetrics(s.uxId as string, appliedAt, afterEnd),
      ])
      const struggleChangePct = pctChange(before.strugglePerVisitor, after.strugglePerVisitor)
      const findTimeChangePct = pctChange(before.medianFindSeconds, after.medianFindSeconds)
      const label = uxComponent(s.uxId)?.label ?? s.component

      let verdict: UxVerdict = 'no-change'
      if (after.sessions < MIN_AFTER_SESSIONS) verdict = 'collecting'
      else if (
        (struggleChangePct !== null && struggleChangePct <= -MEANINGFUL_CHANGE * 100) ||
        (before.strugglePerVisitor > 0 && after.strugglePerVisitor === 0) ||
        (findTimeChangePct !== null && findTimeChangePct <= -MEANINGFUL_CHANGE * 100)
      )
        verdict = 'improved'
      else if (
        (struggleChangePct !== null && struggleChangePct >= MEANINGFUL_CHANGE * 100) ||
        (findTimeChangePct !== null && findTimeChangePct >= MEANINGFUL_CHANGE * 100)
      )
        verdict = 'worse'

      const headline =
        verdict === 'collecting'
          ? `Measuring real users — ${after.sessions}/${MIN_AFTER_SESSIONS} visitors seen since the change`
          : verdict === 'improved'
            ? struggleChangePct !== null && struggleChangePct < 0
              ? `Struggle fell ${Math.abs(struggleChangePct)}% for real users after the change`
              : before.strugglePerVisitor > 0 && after.strugglePerVisitor === 0
                ? 'Users stopped struggling completely after the change'
                : `Users now find it ${Math.abs(findTimeChangePct ?? 0)}% faster`
            : verdict === 'worse'
              ? 'Users are struggling more — consider rolling this change back'
              : 'No meaningful change in user behaviour yet'

      return {
        id: s.id,
        ref: s.ref,
        uxId: s.uxId as string,
        component: label,
        summary: s.summary,
        status: s.status,
        appliedAt: appliedAt.toISOString(),
        before,
        after,
        struggleChangePct,
        findTimeChangePct,
        verdict,
        headline,
      }
    }),
  )

  // One card per component: its most recent change that has a result, else
  // its most recent change (still measuring). Newest first.
  const byComponent = new Map<string, UxImpactItem>()
  for (const item of [...items].reverse()) {
    const current = byComponent.get(item.uxId)
    if (!current || (current.verdict === 'collecting' && item.verdict !== 'collecting')) byComponent.set(item.uxId, item)
  }
  return [...byComponent.values()]
    .sort((a, b) => b.appliedAt.localeCompare(a.appliedAt))
    .slice(0, 8)
}
