import 'server-only'

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'

import type { UxComponentSpec } from './registry'

// Usability simulation for the sandbox (test environment). A "simulated user"
// replays one REAL user's struggle click: the spot where that user expected
// the element to be (recorded as an offset from the element's centre). The
// simulation renders a layout in headless Chrome, measures where the element
// actually is, and checks, for every simulated user, whether the element is
// now where they looked. Layout sanity (visible, clickable, not covered,
// big enough to tap, no page overflow) is checked too.

export interface Viewport {
  w: number
  h: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutMeasure {
  viewport: Viewport
  status: number
  found: boolean
  rect: Rect | null
  visible: boolean
  clickable: boolean
  overflowX: boolean
  overlaps: string[]
  /** For each probed expected-click point: does a click there land on the
   * element, on a DIFFERENT control (a misclick), or on empty space? */
  pointHits: Array<{ target: boolean; other: string | null }>
  /** Visible controls showing the same label as the element (itself included). */
  sameLabelCount: number
  label: string
}

export interface Expectation {
  dx: number
  dy: number
  viewportW: number | null
  viewportH: number | null
}

export interface LayoutScore {
  easy: boolean
  score: number
  simulatedUsers: number
  foundWhereExpected: number
  /** Simulated users whose click would land on a different control. */
  misclicks: number
  misclickTargets: string[]
  foundRate: number
  avgDistanceBefore: number | null
  avgDistanceAfter: number | null
  distanceImprovement: number | null
  predictedSecondsBefore: number | null
  predictedSecondsAfter: number | null
  checks: { visible: boolean; clickable: boolean; bigEnough: boolean; noOverflow: boolean; noOverlap: boolean; pageLoads: boolean; noDuplicate: boolean }
  reasons: string[]
}

function num(name: string, fallback: number): number {
  const v = Number.parseFloat(process.env[name] ?? '')
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export function simulationThresholds() {
  return {
    passRate: num('UX_SIM_PASS_RATE', 0.6),
    minImprovement: num('UX_SIM_MIN_IMPROVEMENT', 0.5),
    maxRounds: Math.max(1, Math.round(num('UX_SIM_MAX_ROUNDS', 3))),
    minTargetPx: 24, // WCAG 2.2 target size (minimum)
  }
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

export function chromePath(): string | null {
  const configured = process.env.UX_CHROME_PATH?.trim()
  if (configured) return existsSync(configured) ? configured : null
  return CHROME_CANDIDATES.find((p) => p && existsSync(p)) ?? null
}

export async function launchSimBrowser(): Promise<Browser> {
  const executablePath = chromePath()
  if (!executablePath) {
    throw new Error('No Chrome/Edge found for the usability simulation. Set UX_CHROME_PATH to chrome.exe or msedge.exe.')
  }
  const puppeteer = (await import('puppeteer-core')).default
  return puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
}

/** Up to 3 viewport sizes real users actually had (most common first). */
export function viewportsFor(expectations: Expectation[]): Viewport[] {
  const counts = new Map<string, { v: Viewport; n: number }>()
  for (const e of expectations) {
    if (!e.viewportW || !e.viewportH || e.viewportW < 320) continue
    const v = { w: Math.round(e.viewportW / 10) * 10, h: Math.round(e.viewportH / 10) * 10 }
    const key = `${v.w}x${v.h}`
    counts.set(key, { v, n: (counts.get(key)?.n ?? 0) + 1 })
  }
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n).map((c) => c.v).slice(0, 3)
  return ranked.length > 0 ? ranked : [{ w: 1400, h: 900 }]
}

function nearestViewport(e: Expectation, viewports: Viewport[]): Viewport {
  if (!e.viewportW) return viewports[0]
  return [...viewports].sort((a, b) => Math.abs(a.w - (e.viewportW ?? 0)) - Math.abs(b.w - (e.viewportW ?? 0)))[0]
}

async function resolveSimPath(baseUrl: string, spec: UxComponentSpec): Promise<string> {
  if (!spec.simPath.includes(':post')) return spec.simPath
  const res = await fetch(`${baseUrl}/api/posts?pageSize=1`, { signal: AbortSignal.timeout(30_000) })
  const data = (await res.json().catch(() => null)) as { posts?: Array<{ id: string }> } | null
  const id = data?.posts?.[0]?.id
  if (!id) throw new Error('No post exists to render this component in the sandbox.')
  return spec.simPath.replace(':post', id)
}

export interface SimSession {
  page: Page
  url: string
}

export async function openSimSession(
  browser: Browser,
  baseUrl: string,
  spec: UxComponentSpec,
  /** Live mode: reuse the visible window's tab instead of a hidden context. */
  livePage?: Page,
): Promise<SimSession> {
  const page = livePage ?? (await (await browser.createBrowserContext()).newPage())
  if (spec.auth) {
    const identifier = process.env.UX_SIM_IDENTIFIER?.trim()
    const password = process.env.UX_SIM_PASSWORD?.trim()
    if (!identifier || !password) {
      throw new Error(`"${spec.label}" only renders when signed in; set UX_SIM_IDENTIFIER and UX_SIM_PASSWORD (a demo account) so the sandbox can sign in.`)
    }
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    const ok = await page.evaluate(
      async (id, pw) => {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: id, password: pw }),
        })
        return res.ok
      },
      identifier,
      password,
    )
    if (!ok) throw new Error('Sandbox sign-in with UX_SIM_IDENTIFIER/UX_SIM_PASSWORD failed.')
  }
  const url = `${baseUrl}${await resolveSimPath(baseUrl, spec)}`
  return { page, url }
}

/** Renders the page at one viewport and measures the tracked element. */
export async function measureLayout(
  session: SimSession,
  uxId: string,
  viewport: Viewport,
  probePoints: Array<{ x: number; y: number }> = [],
): Promise<LayoutMeasure> {
  const { page, url } = session
  await page.setViewport({ width: viewport.w, height: viewport.h })
  // A candidate that breaks the page (syntax/runtime error) makes the dev
  // server reload mid-navigation; retry, then report it as a page that does
  // not load (the round fails) instead of aborting the whole trial.
  let response: Awaited<ReturnType<Page['goto']>> = null
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 120_000 })
      break
    } catch (err) {
      if (attempt === 5) {
        void err
        return { viewport, status: 0, found: false, rect: null, visible: false, clickable: false, overflowX: false, overlaps: [], pointHits: [], sameLabelCount: 0, label: '' }
      }
      await new Promise((r) => setTimeout(r, 1500))
    }
  }
  const status = response?.status() ?? 0
  await page.waitForSelector(`[data-ux-id="${uxId}"]`, { timeout: 15_000 }).catch(() => undefined)
  const m = await page.evaluate((id, pts) => {
    const el = document.querySelector<HTMLElement>(`[data-ux-id="${id}"]`)
    const overflowX = document.documentElement.scrollWidth > window.innerWidth + 1
    const interactiveSel = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[data-ux-id]'
    const pointHits = pts.map((p) => {
      window.scrollTo(0, Math.max(0, p.y - window.innerHeight / 2))
      const hit = document.elementFromPoint(p.x - window.scrollX, p.y - window.scrollY)
      const target = !!el && !!hit && (hit === el || el.contains(hit))
      const control = !target && hit ? hit.closest<HTMLElement>(interactiveSel) : null
      const other = control
        ? (control.getAttribute('data-ux-id') ?? control.getAttribute('aria-label') ?? control.textContent ?? control.tagName).trim().slice(0, 40)
        : null
      return { target, other }
    })
    window.scrollTo(0, 0)
    if (!el) return { found: false, rect: null, visible: false, clickable: false, overflowX, overlaps: [] as string[], pointHits, sameLabelCount: 0, label: '' }
    // A "move" that leaves a second copy behind is not a move.
    const label = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    let sameLabelCount = 0
    if (label) {
      for (const c of Array.from(document.querySelectorAll<HTMLElement>(interactiveSel))) {
        const cr = c.getBoundingClientRect()
        if (cr.width === 0 || cr.height === 0) continue
        if (c !== el && (c.contains(el) || el.contains(c))) continue
        if ((c.textContent ?? '').replace(/\s+/g, ' ').trim() === label) sameLabelCount += 1
      }
    }
    const r = el.getBoundingClientRect()
    const rect = { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height }
    const cs = getComputedStyle(el)
    const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05
    let clickable = false
    if (visible) {
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const v = el.getBoundingClientRect()
      const hit = document.elementFromPoint(v.left + v.width / 2, v.top + v.height / 2)
      clickable = !!hit && (hit === el || el.contains(hit) || hit.contains(el))
      window.scrollTo(0, 0)
    }
    const overlaps: string[] = []
    const interactive = 'a,button,input,select,textarea,[role="button"],[data-ux-id]'
    for (const other of Array.from(document.querySelectorAll<HTMLElement>(interactive))) {
      if (other === el || el.contains(other) || other.contains(el)) continue
      const o = other.getBoundingClientRect()
      if (o.width === 0 || o.height === 0) continue
      const ix = Math.min(r.right, o.right) - Math.max(r.left, o.left)
      const iy = Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top)
      if (ix > 2 && iy > 2) overlaps.push((other.getAttribute('data-ux-id') ?? other.textContent ?? other.tagName).trim().slice(0, 40))
    }
    return { found: true, rect, visible, clickable, overflowX, overlaps: overlaps.slice(0, 5), pointHits, sameLabelCount, label }
  }, uxId, probePoints)
  return { viewport, status, ...m }
}

/** Screenshot of the band around the element, with the simulated users'
 * expected click points drawn in red and the element outlined in green. */
export async function screenshotLayout(
  session: SimSession,
  uxId: string,
  measure: LayoutMeasure,
  points: Array<{ x: number; y: number }>,
  dir: string,
  name: string,
): Promise<string | null> {
  if (!measure.rect) return null
  const { page } = session
  await page.evaluate(
    (id, pts) => {
      // The live-view status bar / replay layer never appears in screenshots.
      document.querySelectorAll<HTMLElement>('[data-ux-live]').forEach((e) => (e.style.visibility = 'hidden'))
      document.getElementById('__ux_sim_overlay__')?.remove()
      const layer = document.createElement('div')
      layer.id = '__ux_sim_overlay__'
      layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;'
      const el = document.querySelector<HTMLElement>(`[data-ux-id="${id}"]`)
      if (el) {
        const r = el.getBoundingClientRect()
        const box = document.createElement('div')
        box.style.cssText = `position:absolute;left:${r.left + scrollX - 3}px;top:${r.top + scrollY - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:3px solid #16a34a;border-radius:8px;`
        layer.appendChild(box)
      }
      for (const p of pts) {
        const dot = document.createElement('div')
        dot.style.cssText = `position:absolute;left:${p.x - 6}px;top:${p.y - 6}px;width:12px;height:12px;border-radius:50%;background:rgba(220,38,38,.75);border:2px solid #fff;`
        layer.appendChild(dot)
      }
      document.body.appendChild(layer)
    },
    uxId,
    points,
  )
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.png`)
  const top = Math.max(0, Math.round(Math.min(measure.rect.y, ...points.map((p) => p.y)) - 90))
  const bottom = Math.round(Math.max(measure.rect.y + measure.rect.h, ...points.map((p) => p.y)) + 90)
  await page.screenshot({
    path: file as `${string}.png`,
    clip: { x: 0, y: top, width: measure.viewport.w, height: Math.min(Math.max(bottom - top, 160), 700) },
    captureBeyondViewport: true,
  })
  await page
    .evaluate(() => {
      document.getElementById('__ux_sim_overlay__')?.remove()
      document.querySelectorAll<HTMLElement>('[data-ux-live]').forEach((e) => (e.style.visibility = ''))
    })
    .catch(() => undefined)
  return `${name}.png`
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

function distanceToRect(p: { x: number; y: number }, r: Rect): number {
  const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.w ? p.x - (r.x + r.w) : 0
  const dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.h ? p.y - (r.y + r.h) : 0
  return Math.hypot(dx, dy)
}

/** Predicted seconds to find + click (Fitts's law pointing time, plus a visual
 * search penalty when the element is not where the user looked first). */
function predictedSeconds(p: { x: number; y: number }, r: Rect, foundInArea: boolean): number {
  const c = center(r)
  const d = Math.hypot(c.x - p.x, c.y - p.y)
  const w = Math.max(8, Math.min(r.w, r.h))
  return 0.3 + 0.12 * Math.log2(d / w + 1) + (foundInArea ? 0 : 4)
}

/** Where each simulated user looked, in page coordinates of the ORIGINAL
 * layout at their (nearest) viewport. */
export function expectedPoints(
  expectations: Expectation[],
  baseline: LayoutMeasure[],
): Array<{ x: number; y: number; viewport: Viewport }> {
  const out: Array<{ x: number; y: number; viewport: Viewport }> = []
  const viewports = baseline.map((b) => b.viewport)
  for (const e of expectations) {
    const vp = nearestViewport(e, viewports)
    const base = baseline.find((b) => b.viewport.w === vp.w && b.viewport.h === vp.h)
    if (!base?.rect) continue
    const c = center(base.rect)
    out.push({ x: c.x + e.dx, y: c.y + e.dy, viewport: vp })
  }
  return out
}

function inLookedArea(p: { x: number; y: number }, r: Rect, vp: Viewport): boolean {
  if (distanceToRect(p, r) <= 48) return true
  const c = center(r)
  const third = vp.w / 3
  const sameColumn = Math.floor(p.x / third) === Math.floor(c.x / third)
  const sameBand = Math.abs(p.y - c.y) <= Math.max(80, r.h)
  return sameColumn && sameBand
}

/** Scores a candidate layout against the original by replaying every real
 * user's expectation. "Easy" = passes every layout check, most simulated
 * users find it in the area they looked, and it is much closer than before. */
export function scoreLayout(
  baseline: LayoutMeasure[],
  candidate: LayoutMeasure[],
  expectations: Expectation[],
): LayoutScore {
  const t = simulationThresholds()
  const reasons: string[] = []
  const all = (fn: (m: LayoutMeasure) => boolean) => candidate.length > 0 && candidate.every(fn)
  const checks = {
    pageLoads: all((m) => m.status > 0 && m.status < 500),
    visible: all((m) => m.found && m.visible),
    clickable: all((m) => m.clickable),
    bigEnough: all((m) => !!m.rect && m.rect.w >= t.minTargetPx && m.rect.h >= t.minTargetPx),
    noOverflow: all((m) => !m.overflowX),
    noOverlap: all((m) => m.overlaps.length === 0),
    noDuplicate: candidate.every((m) => {
      const b = baseline.find((x) => x.viewport.w === m.viewport.w && x.viewport.h === m.viewport.h)
      return !b || m.sameLabelCount <= b.sameLabelCount
    }),
  }
  if (!checks.pageLoads) reasons.push('the page failed to load with this change (the code change probably broke the page)')
  if (!checks.visible) reasons.push('the element is hidden or missing')
  if (checks.visible && !checks.clickable) reasons.push('something covers the element, so it cannot be clicked')
  if (checks.visible && !checks.bigEnough) reasons.push(`the element is smaller than ${t.minTargetPx}px to tap`)
  if (!checks.noOverflow) reasons.push('the page now scrolls sideways (layout broke)')
  if (!checks.noDuplicate) {
    reasons.push(`it adds a second "${candidate[0]?.label ?? 'copy'}" control instead of moving the existing one (remove it from its old place)`)
  }
  if (!checks.noOverlap) reasons.push(`it overlaps other controls (${candidate.flatMap((m) => m.overlaps).slice(0, 3).join(', ')})`)
  const checksOk = Object.values(checks).every(Boolean)

  const points = expectedPoints(expectations, baseline)
  const seenPerViewport = new Map<string, number>()
  let found = 0
  let misclicks = 0
  const misclickTargets = new Set<string>()
  const before: number[] = []
  const after: number[] = []
  const tBefore: number[] = []
  const tAfter: number[] = []
  for (const p of points) {
    const b = baseline.find((m) => m.viewport.w === p.viewport.w && m.viewport.h === p.viewport.h)
    const c = candidate.find((m) => m.viewport.w === p.viewport.w && m.viewport.h === p.viewport.h)
    if (!b?.rect || !c?.rect) continue
    // pointHits were probed in expectedPoints() order, per viewport.
    const key = `${p.viewport.w}x${p.viewport.h}`
    const index = seenPerViewport.get(key) ?? 0
    seenPerViewport.set(key, index + 1)
    const hit = c.pointHits[index]
    const misclick = !!hit?.other
    if (misclick) {
      misclicks += 1
      misclickTargets.add(hit.other as string)
    }
    // Found = in the area they looked AND their click would not hit another control.
    const inAreaAfter = !misclick && (hit?.target === true || inLookedArea(p, c.rect, p.viewport))
    if (inAreaAfter) found += 1
    before.push(distanceToRect(p, b.rect))
    after.push(distanceToRect(p, c.rect))
    tBefore.push(predictedSeconds(p, b.rect, inLookedArea(p, b.rect, p.viewport)))
    tAfter.push(predictedSeconds(p, c.rect, inAreaAfter))
  }
  const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, x) => a + x, 0) / xs.length : null)
  const users = after.length
  const avgBefore = avg(before)
  const avgAfter = avg(after)
  const improvement = avgBefore !== null && avgAfter !== null && avgBefore > 0 ? 1 - avgAfter / avgBefore : null
  const foundRate = users > 0 ? found / users : 0

  let easy: boolean
  let score: number
  if (users === 0) {
    // No behaviour data (manual request): only layout sanity can be tested.
    easy = checksOk
    score = checksOk ? 50 : 0
    reasons.push('no recorded user clicks to replay, so only layout checks were run')
  } else {
    if (misclicks > 0) {
      reasons.push(`${misclicks} of ${users} simulated users would click "${[...misclickTargets].join('", "')}" instead, right where they expected it`)
    }
    if (foundRate < t.passRate) {
      reasons.push(`only ${Math.round(foundRate * 100)}% of simulated users would find it where they looked (need ${Math.round(t.passRate * 100)}%)`)
    }
    if (improvement === null || improvement < t.minImprovement) {
      reasons.push(`it is not much closer to where users looked (${improvement === null ? 'n/a' : `${Math.round(improvement * 100)}%`} closer, need ${Math.round(t.minImprovement * 100)}%)`)
    }
    easy = checksOk && foundRate >= t.passRate && improvement !== null && improvement >= t.minImprovement
    score = checksOk ? Math.round(100 * (0.6 * foundRate + 0.4 * Math.max(0, Math.min(1, improvement ?? 0)))) : 0
  }

  const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10)
  return {
    easy,
    score,
    simulatedUsers: users,
    foundWhereExpected: found,
    misclicks,
    misclickTargets: [...misclickTargets],
    foundRate: Math.round(foundRate * 100) / 100,
    avgDistanceBefore: avgBefore === null ? null : Math.round(avgBefore),
    avgDistanceAfter: avgAfter === null ? null : Math.round(avgAfter),
    distanceImprovement: improvement === null ? null : Math.round(improvement * 100) / 100,
    predictedSecondsBefore: round1(avg(tBefore)),
    predictedSecondsAfter: round1(avg(tAfter)),
    checks,
    reasons,
  }
}
