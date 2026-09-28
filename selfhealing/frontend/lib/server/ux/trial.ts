import 'server-only'

import { join } from 'node:path'

import { readRealFile, repoRelativeFile } from '@/lib/server/repair/evidence'
import { applyUxPatch, draftUxSuggestion } from './draft'
import { ensureSandbox, restoreSandboxFile, sandboxBaseUrl, sandboxDataDir, waitForSandboxStable, writeSandboxFile } from './sandbox'
import {
  expectedPoints,
  launchSimBrowser,
  measureLayout,
  openSimSession,
  scoreLayout,
  screenshotLayout,
  simulationThresholds,
  viewportsFor,
  type Expectation,
  type LayoutMeasure,
  type LayoutScore,
  type SimSession,
} from './simulate'
import { getLiveBrowser, getLivePage, liveEnabled, liveIdle, livePause, liveReplay, liveStatus, type LiveRound, type LiveState } from './live'
import type { UxComponentSpec } from './registry'
import type { UxDraftInput, UxDraftResult } from './types'

// Sandbox trial loop: try a placement in the test environment, measure it
// with simulated users, and — when it is not easy — ask for a DIFFERENT
// placement, up to UX_SIM_MAX_ROUNDS. Only a placement that passes is ever
// offered for human approval; the real source is never written here.

export interface TrialRound {
  round: number
  summary: string
  currentCode: string
  proposedCode: string
  model: string | null
  result: LayoutScore | null
  screenshot: string | null
  error: string | null
  /** Element box in the original layout and in this candidate (first viewport). */
  before?: { x: number; y: number; w: number; h: number } | null
  after?: { x: number; y: number; w: number; h: number } | null
  /** Median point where the simulated users looked (page coordinates). */
  lookedAt?: { x: number; y: number } | null
  pageWidth?: number
}

export interface TrialOutcome {
  passed: boolean
  winnerRound: number | null
  rounds: TrialRound[]
  viewports: Array<{ w: number; h: number }>
  simulatedUsers: number
  baselineScreenshot: string | null
  sandboxUrl: string
  startedAt: string
  finishedAt: string
  error: string | null
}

const sameLayout = (a: LayoutMeasure, b: LayoutMeasure) =>
  a.found === b.found &&
  a.visible === b.visible &&
  JSON.stringify(a.rect && [Math.round(a.rect.x), Math.round(a.rect.y), Math.round(a.rect.w), Math.round(a.rect.h)]) ===
    JSON.stringify(b.rect && [Math.round(b.rect.x), Math.round(b.rect.y), Math.round(b.rect.w), Math.round(b.rect.h)])

/** After a sandbox file write, re-measures until the dev server has recompiled
 * and the element's layout differs from the original (or the wait ends —
 * a change with no visible effect then scores as "not easier"). */
async function measureAfterChange(
  session: SimSession,
  uxId: string,
  baseline: LayoutMeasure[],
  allPoints: Array<{ x: number; y: number; viewport: { w: number; h: number } }>,
): Promise<LayoutMeasure[]> {
  const pointsFor = (vp: { w: number; h: number }) => allPoints.filter((p) => p.viewport.w === vp.w && p.viewport.h === vp.h)
  const first = baseline[0]
  const deadline = Date.now() + 25_000
  let probe = await measureLayout(session, uxId, first.viewport, pointsFor(first.viewport))
  while (sameLayout(probe, first) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    probe = await measureLayout(session, uxId, first.viewport, pointsFor(first.viewport))
  }
  const out = [probe]
  for (const b of baseline.slice(1)) out.push(await measureLayout(session, uxId, b.viewport, pointsFor(b.viewport)))
  return out
}

const box = (b: { x: number; y: number; w: number; h: number }) =>
  `x=${Math.round(b.x)}..${Math.round(b.x + b.w)}, y=${Math.round(b.y)}..${Math.round(b.y + b.h)}`

function describeRound(r: TrialRound): string {
  if (r.error) return `Round ${r.round}: ${r.summary || 'draft'} — could not be tested (${r.error}).`
  const s = r.result
  if (!s) return `Round ${r.round}: ${r.summary} — no result.`
  const moved =
    r.before && r.after
      ? Math.abs(r.before.x - r.after.x) < 2 && Math.abs(r.before.y - r.after.y) < 2
        ? ` Measured: the element did NOT move (still at ${box(r.after)}); restyling it in place does not help.`
        : ` Measured: the element moved from ${box(r.before)} to ${box(r.after)}.`
      : ''
  const looked = r.lookedAt
    ? ` Simulated users looked for it around x=${Math.round(r.lookedAt.x)}, y=${Math.round(r.lookedAt.y)}${r.pageWidth ? ` (page is ${r.pageWidth}px wide)` : ''}.`
    : ''
  const blocked =
    s.misclicks > 0 && r.lookedAt
      ? ` In this layout "${s.misclickTargets.join('", "')}" sits exactly where users click, so they would press it by mistake: ` +
        `put THIS element at that spot (x≈${Math.round(r.lookedAt.x)}) and keep other controls away from it — e.g. move only this element (not its whole group), or reorder so it comes first.`
      : ''
  return (
    `Round ${r.round}: ${r.summary} — ${s.easy ? 'EASY' : 'NOT easy'}: ` +
    `${s.foundWhereExpected}/${s.simulatedUsers} simulated users found it where they looked` +
    (s.distanceImprovement !== null ? `, ${Math.round(s.distanceImprovement * 100)}% closer` : '') +
    (s.reasons.length > 0 ? `; problems: ${s.reasons.join('; ')}` : '') +
    '.' +
    moved +
    looked +
    blocked
  )
}

export function describeTrial(outcome: TrialOutcome): string {
  return outcome.rounds.map(describeRound).join('\n')
}

export async function runSandboxTrials(args: {
  suggestionId: string
  /** Suggestion ref ("UX-000057"), shown in the live window. */
  ref?: string
  spec: UxComponentSpec
  input: UxDraftInput
  /** Round-1 candidate; null = draft a fresh one inside the loop. */
  firstDraft: UxDraftResult | null
  expectations: Expectation[]
  /** Rounds from an earlier test of this suggestion (never re-tried). */
  previousRounds?: TrialRound[]
}): Promise<TrialOutcome> {
  const { suggestionId, spec, input, expectations } = args
  const t = simulationThresholds()
  const startedAt = new Date().toISOString()
  const rel = repoRelativeFile(spec.file)
  const shotDir = join(sandboxDataDir(), suggestionId)
  const viewports = viewportsFor(expectations)
  const rounds: TrialRound[] = []
  const outcome = (extra: Partial<TrialOutcome>): TrialOutcome => ({
    passed: false,
    winnerRound: null,
    rounds,
    viewports,
    simulatedUsers: 0,
    baselineScreenshot: null,
    sandboxUrl: sandboxBaseUrl(),
    startedAt,
    finishedAt: new Date().toISOString(),
    error: null,
    ...extra,
  })

  const real = readRealFile(spec.file)
  if (!real.ok) return outcome({ error: real.error ?? `cannot read ${spec.file}` })

  await ensureSandbox()
  restoreSandboxFile(rel)
  // Live mode: the same simulation, shown step by step in a visible window.
  const live = liveEnabled()
  const browser = live ? await getLiveBrowser() : await launchSimBrowser()
  const livePage = live ? await getLivePage(browser) : undefined
  const liveRounds: LiveRound[] = Array.from({ length: t.maxRounds }, (_, i) => ({ label: `Round ${i + 1}`, status: 'pending' }))
  const liveTitle = `${args.ref ?? 'UX test'} · "${spec.label}"`
  const say = (step: string, detail?: string, tone: LiveState['tone'] = 'work') =>
    liveStatus(livePage, { title: liveTitle, step, detail, tone, rounds: liveRounds })
  let liveLast = ''
  let session: SimSession | null = null
  /** Live only: re-open the current layout and replay the users on it. */
  const showUsers = async (vp: { w: number; h: number }, pts: Array<{ x: number; y: number }>) => {
    if (!live || !session || pts.length === 0) return null
    const shown = await measureLayout(session, spec.uxId, vp, pts)
    await liveReplay(livePage, spec.uxId, pts, shown.pointHits)
    return shown.pointHits.filter((h) => h.target).length
  }
  try {
    session = await openSimSession(browser, sandboxBaseUrl(), spec, livePage)
    const simPath = session.url.replace(sandboxBaseUrl(), '')
    await say('Opening the sandbox copy of BuildHub…', `Test page ${simPath} — the real website is not touched.`)
    await waitForSandboxStable(simPath)
    const baseline: LayoutMeasure[] = []
    for (const vp of viewports) baseline.push(await measureLayout(session, spec.uxId, vp))
    if (!baseline[0].found) {
      return outcome({
        error:
          baseline[0].status === 0 || baseline[0].status >= 500
            ? `The sandbox page ${simPath} did not load (status ${baseline[0].status || 'none'}); try "Re-test in sandbox".`
            : `"${spec.label}" was not found on ${simPath} in the sandbox.`,
      })
    }
    const allPoints = expectedPoints(expectations, baseline)
    const points = allPoints.filter(
      (p) => p.viewport.w === baseline[0].viewport.w && p.viewport.h === baseline[0].viewport.h,
    )
    const baselineScreenshot = await screenshotLayout(session, spec.uxId, baseline[0], points, shotDir, 'baseline')
    if (live) {
      if (points.length === 0) {
        await say('Original layout', 'No click positions were recorded (users were only slow), so each idea is checked for a working, visible, clickable layout.')
      } else {
        await say(
          'Step 1 — replaying real users on the ORIGINAL layout',
          `The cursor visits the spots where ${points.length} real clicks landed while people looked for "${spec.label}". ✓ = found it there, ✗ = nothing there.`,
        )
        const found = (await showUsers(baseline[0].viewport, points)) ?? 0
        await say(`Original layout: ${found}/${points.length} found it where they looked`, 'Now the AI will propose a better place and test it here.', 'bad')
        await livePause(3000)
      }
    }

    const previous = args.previousRounds ?? []
    const tried: string[] = previous.map((r) => r.proposedCode).filter(Boolean)
    const earlier = previous.map((r) => `Earlier test — ${describeRound(r)}`)
    let draft: UxDraftResult | null = args.firstDraft
    for (let round = 1; round <= t.maxRounds; round += 1) {
      liveRounds[round - 1].status = 'running'
      if (round > 1 || !draft) {
        await say(`Round ${round}: asking the AI for a placement idea…`, round > 1 ? 'It is told why the earlier ideas failed, so it must try a different place.' : undefined)
        const next = () =>
          draftUxSuggestion({
            ...input,
            attempt: previous.length + round - 1,
            triedProposals: tried,
            feedback: [...earlier, ...rounds.map(describeRound)].join('\n') || undefined,
          })
        draft = await next()
        // Free-tier AI plans cap tokens per minute: wait for the window to
        // reset instead of spending a round on "rate limit reached".
        for (let wait = 0; wait < 2 && !draft.ok && /\b429\b|rate limit/i.test(draft.error ?? ''); wait += 1) {
          await new Promise((r) => setTimeout(r, 30_000))
          draft = await next()
        }
      }
      if (!draft.ok || !draft.currentCode || !draft.proposedCode) {
        rounds.push({ round, summary: '', currentCode: '', proposedCode: '', model: draft.model ?? null, result: null, screenshot: null, error: draft.error ?? 'no draft' })
        liveRounds[round - 1].status = 'failed'
        await say(`Round ${round}: no usable idea from the AI`, (draft.error ?? 'no draft').slice(0, 160), 'bad')
        if (live) await livePause(2500)
        // A deterministic drafter with nothing left to try cannot improve.
        if (draft.model === 'ux-deterministic-test' || /no further placement/.test(draft.error ?? '')) break
        continue
      }
      tried.push(draft.proposedCode)
      const entry: TrialRound = {
        round,
        summary: draft.summary ?? `Placement ${round}`,
        currentCode: draft.currentCode,
        proposedCode: draft.proposedCode,
        model: draft.model ?? null,
        result: null,
        screenshot: null,
        error: null,
      }
      rounds.push(entry)
      const patched = applyUxPatch(real.content, draft.currentCode, draft.proposedCode)
      if (patched === null) {
        entry.error = 'the proposed code no longer matches the file'
        liveRounds[round - 1].status = 'failed'
        await say(`Round ${round}: the idea does not fit the file`, entry.error, 'bad')
        continue
      }
      await say(`Round ${round}: AI idea — ${entry.summary}`, 'Applying it to the sandbox copy only… watch the page reload with the new layout.')
      writeSandboxFile(rel, patched)
      try {
        const candidate = await measureAfterChange(session, spec.uxId, baseline, allPoints)
        entry.result = scoreLayout(baseline, candidate, expectations)
        entry.before = baseline[0].rect
        entry.after = candidate[0].rect
        entry.pageWidth = baseline[0].viewport.w
        entry.lookedAt =
          points.length > 0
            ? {
                x: [...points].sort((a, b) => a.x - b.x)[Math.floor(points.length / 2)].x,
                y: [...points].sort((a, b) => a.y - b.y)[Math.floor(points.length / 2)].y,
              }
            : null
        entry.screenshot = await screenshotLayout(session, spec.uxId, candidate[0], points, shotDir, `round-${round}`)
        if (live) {
          const s = entry.result
          const moved = !!entry.before && !!entry.after && (Math.abs(entry.before.x - entry.after.x) > 2 || Math.abs(entry.before.y - entry.after.y) > 2)
          await say(`Round ${round}: replaying the same users on the NEW layout`, moved ? 'The green box shows where the element is now.' : 'Note: the element did not move with this idea.')
          await showUsers(candidate[0].viewport, points)
          liveRounds[round - 1].status = s.easy ? 'passed' : 'failed'
          await say(
            s.easy
              ? `Round ${round}: PASSED — ${s.foundWhereExpected}/${s.simulatedUsers} found it where they looked` +
                  (s.distanceImprovement !== null ? `, ${Math.round(s.distanceImprovement * 100)}% closer` : '')
              : `Round ${round}: not easy enough — ${s.foundWhereExpected}/${s.simulatedUsers} found it where they looked`,
            s.easy ? 'This placement will be sent to you for approval. Nothing changes on the real site until you approve.' : s.reasons.join('; ').slice(0, 220),
            s.easy ? 'ok' : 'bad',
          )
          await livePause(s.easy ? 4000 : 3500)
        }
      } catch (err) {
        entry.error = err instanceof Error ? err.message.slice(0, 200) : 'measurement failed'
      } finally {
        restoreSandboxFile(rel)
      }
      if (!entry.result?.easy && round < t.maxRounds) {
        await say('Putting the original layout back before the next idea…')
        // Let the sandbox recompile back to the original before the next
        // round, so that round can never measure this round's layout.
        const deadline = Date.now() + 30_000
        try {
          let probe = await measureLayout(session, spec.uxId, baseline[0].viewport)
          while (!sameLayout(probe, baseline[0]) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500))
            probe = await measureLayout(session, spec.uxId, baseline[0].viewport)
          }
        } catch {
          /* the next round's own measurement waits for a stable page */
        }
      }
      if (entry.result?.easy) {
        liveLast = `Last test: ${liveTitle} — passed in round ${round}; sent to you for approval.`
        return outcome({
          passed: true,
          winnerRound: round,
          simulatedUsers: entry.result.simulatedUsers,
          baselineScreenshot,
        })
      }
    }
    const users = rounds.find((r) => r.result)?.result?.simulatedUsers ?? 0
    liveLast = `Last test: ${liveTitle} — no placement passed after ${rounds.length} round(s); nothing was sent for approval and the site is unchanged.`
    return outcome({ simulatedUsers: users, baselineScreenshot })
  } finally {
    restoreSandboxFile(rel)
    if (live) {
      // The window stays open for the next test.
      if (liveLast) {
        await say(liveLast.replace(/^Last test: /, 'Result: '), undefined, /passed/.test(liveLast) ? 'ok' : 'bad')
        await livePause(5000)
      }
      await liveIdle(livePage, sandboxBaseUrl(), liveLast || undefined)
    } else {
      await browser.close().catch(() => undefined)
    }
  }
}
