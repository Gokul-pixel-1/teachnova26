import 'server-only'

import type { Browser, Page } from 'puppeteer-core'

import { chromePath } from './simulate'

// Live sandbox window: when UX_SIM_LIVE=true the usability simulation runs in
// ONE visible Chrome window that stays open, so a person can watch it work —
// a status bar explains each step, a cursor visits every spot where real
// users clicked, each spot is marked ✓ (found it) / ✗ (missed) / ⚠ (would hit
// another control), and a green box follows the element as each AI placement
// is applied. Purely a view: every measurement and score is the same as in
// headless mode. Never used in hermetic TEST mode.

export function liveEnabled(): boolean {
  const on = (process.env.UX_SIM_LIVE ?? '').trim().toLowerCase() === 'true'
  const test = (process.env.SELF_HEALING_TEST_MODE ?? '').trim().toLowerCase() === 'true'
  return on && !test
}

export interface LiveRound {
  label: string
  status: 'pending' | 'running' | 'passed' | 'failed'
}

export interface LiveState {
  title: string
  step: string
  detail?: string
  tone?: 'work' | 'ok' | 'bad' | 'idle'
  rounds?: LiveRound[]
}

const KEY = '__buildhub_ux_live_browser__'
const g = globalThis as unknown as Record<string, Promise<Browser> | undefined>

/** The single live-simulation browser. It runs without a window; what it
 * shows is streamed to the /ai/ux-live tab (see latestLiveFrame). */
export async function getLiveBrowser(): Promise<Browser> {
  const existing = g[KEY]
  if (existing) {
    const b = await existing.catch(() => null)
    if (b && b.connected) return b
    g[KEY] = undefined
  }
  const executablePath = chromePath()
  if (!executablePath) throw new Error('No Chrome/Edge found for the live sandbox view.')
  g[KEY] = (async () => {
    const puppeteer = (await import('puppeteer-core')).default
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      defaultViewport: { width: 1400, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu'],
    })
    browser.on('disconnected', () => {
      g[KEY] = undefined
    })
    return browser
  })()
  return g[KEY] as Promise<Browser>
}

// ---------------------------------------------------------------------------
// Screen stream: Chrome's screencast pushes a JPEG whenever the live page
// changes; the latest one is kept here and served to the /ai/ux-live tab.

export interface LiveFrame {
  jpeg: Buffer
  seq: number
  at: number
}

const FRAME_KEY = '__buildhub_ux_live_frame__'
const fg = globalThis as unknown as Record<string, LiveFrame | undefined>

export function latestLiveFrame(): LiveFrame | null {
  return fg[FRAME_KEY] ?? null
}

async function startScreencast(page: Page): Promise<void> {
  const session = await page.createCDPSession()
  session.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
    const prev = fg[FRAME_KEY]
    fg[FRAME_KEY] = { jpeg: Buffer.from(frame.data, 'base64'), seq: (prev?.seq ?? 0) + 1, at: Date.now() }
    void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
  })
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1400, maxHeight: 1000, everyNthFrame: 1 })
}

/** The one tab the live browser uses (extra tabs are closed); streams its screen. */
export async function getLivePage(browser: Browser): Promise<Page> {
  const pages = await browser.pages()
  const page = pages[0] ?? (await browser.newPage())
  for (const extra of pages.slice(1)) await extra.close().catch(() => undefined)
  const marked = page as Page & { __uxLiveInstalled?: boolean }
  if (!marked.__uxLiveInstalled) {
    await page.evaluateOnNewDocument(RENDERER)
    await startScreencast(page).catch(() => undefined)
    marked.__uxLiveInstalled = true
  }
  return page
}

// Runs in the page on every load: draws the status bar from sessionStorage so
// it survives the reloads the simulation causes. Built with DOM nodes (never
// innerHTML) because the text includes AI-written summaries.
const RENDERER = () => {
  const render = () => {
    let s: LiveState | null = null
    try {
      s = JSON.parse(sessionStorage.getItem('__ux_live') || 'null') as LiveState | null
    } catch {
      s = null
    }
    if (!s || !document.body) return
    let bar = document.getElementById('__ux_live_bar__')
    if (!bar) {
      bar = document.createElement('div')
      bar.id = '__ux_live_bar__'
      bar.setAttribute('data-ux-live', '1')
      document.body.appendChild(bar)
    }
    const colors: Record<string, string> = { work: '#2563eb', ok: '#16a34a', bad: '#dc2626', idle: '#64748b' }
    const accent = colors[s.tone ?? 'work'] ?? '#2563eb'
    bar.style.cssText =
      'position:fixed;left:72px;right:16px;bottom:16px;z-index:2147483647;pointer-events:none;' +
      `background:rgba(15,23,42,.94);color:#f8fafc;border-left:6px solid ${accent};border-radius:12px;` +
      'padding:12px 16px;font:14px/1.45 system-ui,Segoe UI,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);'
    bar.replaceChildren()
    const top = document.createElement('div')
    top.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;'
    const badge = document.createElement('span')
    badge.textContent = 'SANDBOX · LIVE'
    badge.style.cssText = `background:${accent};color:#fff;font-weight:700;font-size:11px;letter-spacing:1px;padding:2px 8px;border-radius:6px;`
    const title = document.createElement('strong')
    title.textContent = s.title
    top.append(badge, title)
    for (const r of s.rounds ?? []) {
      const chip = document.createElement('span')
      const mark = r.status === 'passed' ? ' ✓' : r.status === 'failed' ? ' ✗' : r.status === 'running' ? ' …' : ''
      chip.textContent = r.label + mark
      const c = r.status === 'passed' ? '#16a34a' : r.status === 'failed' ? '#dc2626' : r.status === 'running' ? '#2563eb' : '#475569'
      chip.style.cssText = `border:1px solid ${c};color:${c === '#475569' ? '#cbd5e1' : '#fff'};background:${r.status === 'pending' ? 'transparent' : c};font-size:12px;padding:1px 8px;border-radius:999px;`
      top.appendChild(chip)
    }
    const step = document.createElement('div')
    step.textContent = s.step
    step.style.cssText = 'margin-top:6px;font-weight:600;font-size:15px;'
    bar.append(top, step)
    if (s.detail) {
      const detail = document.createElement('div')
      detail.textContent = s.detail
      detail.style.cssText = 'margin-top:2px;color:#cbd5e1;font-size:13px;'
      bar.appendChild(detail)
    }
  }
  ;(window as unknown as { __uxLiveRender?: () => void }).__uxLiveRender = render
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render)
  else render()
}

/** Updates the status bar (and keeps it across page reloads). Never throws. */
export async function liveStatus(page: Page | null | undefined, state: LiveState): Promise<void> {
  if (!page) return
  await page
    .evaluate((s) => {
      sessionStorage.setItem('__ux_live', JSON.stringify(s))
      ;(window as unknown as { __uxLiveRender?: () => void }).__uxLiveRender?.()
    }, state)
    .catch(() => undefined)
}

export const livePause = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Replays the simulated users on the CURRENT page: a cursor visits each spot a
 * real user clicked while looking for the element, with a click ripple, and
 * the spot is marked ✓ (lands on the element), ⚠ (lands on another control)
 * or ✗ (empty space). A green box outlines the element. Never throws.
 */
export async function liveReplay(
  page: Page | null | undefined,
  uxId: string,
  points: Array<{ x: number; y: number }>,
  hits: Array<{ target: boolean; other: string | null }>,
): Promise<void> {
  if (!page) return
  // At most 12 cursor trips per layout, spread over all users.
  const idx = points.length <= 12 ? points.map((_, i) => i) : Array.from({ length: 12 }, (_, k) => Math.round((k * (points.length - 1)) / 11))
  const shown = idx.map((i) => ({ ...points[i], hit: hits[i] ?? { target: false, other: null } }))
  await page
    .evaluate(
      async (id, pts) => {
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
        document.getElementById('__ux_live_layer__')?.remove()
        const layer = document.createElement('div')
        layer.id = '__ux_live_layer__'
        layer.setAttribute('data-ux-live', '1')
        layer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;'
        document.body.appendChild(layer)
        const el = document.querySelector<HTMLElement>(`[data-ux-id="${id}"]`)
        if (el) {
          const r = el.getBoundingClientRect()
          const box = document.createElement('div')
          box.style.cssText = `position:absolute;left:${r.left + scrollX - 4}px;top:${r.top + scrollY - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:3px solid #16a34a;border-radius:10px;box-shadow:0 0 0 4px rgba(22,163,74,.25);`
          layer.appendChild(box)
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
          await wait(500)
        }
        const cursor = document.createElement('div')
        cursor.textContent = '➤'
        cursor.style.cssText =
          'position:absolute;font-size:26px;color:#111827;text-shadow:0 0 3px #fff,0 0 6px #fff;transform:rotate(-135deg);' +
          'transition:left .45s ease,top .45s ease;left:40px;top:' + (scrollY + 40) + 'px;'
        layer.appendChild(cursor)
        for (const p of pts) {
          window.scrollTo({ top: Math.max(0, p.y - innerHeight / 2), behavior: 'smooth' })
          await wait(250)
          cursor.style.left = `${p.x - 6}px`
          cursor.style.top = `${p.y - 4}px`
          await wait(520)
          const ripple = document.createElement('div')
          ripple.style.cssText = `position:absolute;left:${p.x - 14}px;top:${p.y - 14}px;width:28px;height:28px;border-radius:50%;border:3px solid #2563eb;opacity:1;transition:all .4s ease;`
          layer.appendChild(ripple)
          requestAnimationFrame(() => {
            ripple.style.transform = 'scale(1.8)'
            ripple.style.opacity = '0'
          })
          const mark = document.createElement('div')
          const color = p.hit.target ? '#16a34a' : p.hit.other ? '#d97706' : '#dc2626'
          mark.textContent = p.hit.target ? '✓' : p.hit.other ? '⚠' : '✗'
          mark.title = p.hit.other ? `would press "${p.hit.other}"` : ''
          mark.style.cssText = `position:absolute;left:${p.x - 11}px;top:${p.y - 11}px;width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font:700 13px/22px system-ui;text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);`
          layer.appendChild(mark)
          await wait(260)
        }
        cursor.remove()
      },
      uxId,
      shown,
    )
    .catch(() => undefined)
}

/** Idle screen between tests: the sandbox home page with a waiting message. */
export async function liveIdle(page: Page | null | undefined, baseUrl: string, last?: string): Promise<void> {
  if (!page) return
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  } catch {
    /* the status bar still shows once the page loads */
  }
  await liveStatus(page, {
    title: 'BuildHub UX agent',
    step: 'Waiting for the next UX test…',
    detail: last ?? 'When real users struggle to find something, the AI tests its ideas here first — you will see every step.',
    tone: 'idle',
  })
}

/** Opens (or brings back) the live window and shows the idle screen. */
export async function openLiveWindow(baseUrl: string): Promise<void> {
  const browser = await getLiveBrowser()
  const page = await getLivePage(browser)
  await page.bringToFront().catch(() => undefined)
  await liveIdle(page, baseUrl)
}
