'use client'

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

// Anonymous UI-friction signals for the UX Suggestion Agent. Records only
// interaction shape — never typed text, never identity:
//   TARGET_CLICK  a tracked element ([data-ux-id]) was clicked, and how long
//                 after the page appeared (slow = hard to find)
//   DEAD_CLICK    a click on non-interactive space, attributed to the nearest
//                 tracked element with the side it landed on (users clicking
//                 where they EXPECTED the control to be)
//   RAGE_CLICK    3+ rapid clicks in one spot (frustration)
// Batched and sent to POST /api/ux/events. Failures are swallowed: tracking
// must never affect the app.

type UxEventType = 'TARGET_CLICK' | 'DEAD_CLICK' | 'RAGE_CLICK'
type Side = 'LEFT' | 'RIGHT' | 'ABOVE' | 'BELOW'

interface UxEventPayload {
  type: UxEventType
  uxId?: string
  path: string
  x?: number
  y?: number
  viewportW?: number
  viewportH?: number
  side?: Side
  dx?: number
  dy?: number
  targetW?: number
  targetH?: number
  msSinceLoad?: number
}

interface Nearest {
  uxId: string
  side: Side
  dx: number
  dy: number
  targetW: number
  targetH: number
}

const ENDPOINT = '/api/ux/events'
const INTERACTIVE =
  'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[contenteditable="true"]'
const NEAR_RADIUS_PX = 260
const SAME_ROW_BAND_PX = 48
const RAGE_WINDOW_MS = 800
const RAGE_RADIUS_PX = 30
const RAGE_MIN_CLICKS = 3

function sessionId(): string {
  try {
    const existing = sessionStorage.getItem('bh_ux_sid')
    if (existing) return existing
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    sessionStorage.setItem('bh_ux_sid', id)
    return id
  } catch {
    return `s-${Date.now().toString(36)}`
  }
}

/** The tracked element the user was most likely looking for. Elements in the
 * same row as the click win over nearer ones in other rows: someone clicking
 * along the header is looking in the header, not at a box below it. */
function nearestTracked(x: number, y: number): Nearest | null {
  let best: (Nearest & { distance: number; sameRow: boolean }) | null = null
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-ux-id]'))) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const gapX = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
    const gapY = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
    const distance = Math.hypot(gapX, gapY)
    const sameRow = gapY <= SAME_ROW_BAND_PX
    if (!sameRow && distance > NEAR_RADIUS_PX) continue
    // Offset from the element's centre: where the user expected it to be.
    const offX = x - (rect.left + rect.width / 2)
    const offY = y - (rect.top + rect.height / 2)
    // Side by the dominant direction, so up/down count as much as left/right.
    const horizontal = gapX > 0 && (gapY === 0 || Math.abs(offX) >= Math.abs(offY))
    const side: Side = horizontal ? (offX < 0 ? 'LEFT' : 'RIGHT') : offY < 0 ? 'ABOVE' : 'BELOW'
    const uxId = el.dataset.uxId
    const better =
      !best || (sameRow && !best.sameRow) || (sameRow === best.sameRow && distance < best.distance)
    if (uxId && better) {
      best = {
        sameRow,
        uxId,
        side,
        dx: Math.round(offX),
        dy: Math.round(offY),
        targetW: Math.round(rect.width),
        targetH: Math.round(rect.height),
        distance,
      }
    }
  }
  if (!best) return null
  const { distance: _distance, sameRow: _sameRow, ...nearest } = best
  void _distance
  void _sameRow
  return nearest
}

export function BehaviorTracker() {
  const pathname = usePathname()
  const routeStart = useRef(0)
  const queue = useRef<UxEventPayload[]>([])
  const recentClicks = useRef<Array<{ t: number; x: number; y: number }>>([])
  const lastRageAt = useRef(0)

  useEffect(() => {
    routeStart.current = performance.now()
  }, [pathname])

  useEffect(() => {
    const sid = sessionId()

    const flush = (useBeacon = false) => {
      if (queue.current.length === 0) return
      const events = queue.current.splice(0, 50)
      const body = JSON.stringify({ sessionId: sid, events })
      try {
        if (useBeacon && typeof navigator.sendBeacon === 'function') {
          navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
          return
        }
        void fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => undefined)
      } catch {
        /* tracking must never affect the app */
      }
    }

    const onClick = (e: MouseEvent) => {
      try {
        const path = window.location.pathname
        if (path.startsWith('/ai')) return // operator command center is not user-facing UI
        const target = e.target instanceof Element ? e.target : null
        if (!target) return
        const now = performance.now()
        const base = {
          path,
          x: Math.round(e.clientX),
          y: Math.round(e.clientY),
          viewportW: window.innerWidth,
          viewportH: window.innerHeight,
        }

        const tracked = target.closest<HTMLElement>('[data-ux-id]')
        const near = tracked ? null : nearestTracked(e.clientX, e.clientY)
        const attributedId = tracked?.dataset.uxId ?? near?.uxId

        recentClicks.current = recentClicks.current.filter((c) => now - c.t <= RAGE_WINDOW_MS)
        recentClicks.current.push({ t: now, x: e.clientX, y: e.clientY })
        const burst = recentClicks.current.filter(
          (c) => Math.hypot(c.x - e.clientX, c.y - e.clientY) <= RAGE_RADIUS_PX,
        )
        if (burst.length >= RAGE_MIN_CLICKS && now - lastRageAt.current > RAGE_WINDOW_MS && attributedId) {
          lastRageAt.current = now
          queue.current.push({
            ...base,
            type: 'RAGE_CLICK',
            uxId: attributedId,
            side: near?.side,
            dx: near?.dx,
            dy: near?.dy,
            targetW: near?.targetW,
            targetH: near?.targetH,
          })
        }

        if (tracked?.dataset.uxId) {
          queue.current.push({
            ...base,
            type: 'TARGET_CLICK',
            uxId: tracked.dataset.uxId,
            msSinceLoad: Math.round(now - routeStart.current),
          })
          flush(true) // a tracked click often navigates away
        } else if (near && !target.closest(INTERACTIVE)) {
          queue.current.push({
            ...base,
            type: 'DEAD_CLICK',
            uxId: near.uxId,
            side: near.side,
            dx: near.dx,
            dy: near.dy,
            targetW: near.targetW,
            targetH: near.targetH,
          })
        }
      } catch {
        /* tracking must never affect the app */
      }
    }

    const onHide = () => {
      if (document.visibilityState === 'hidden') flush(true)
    }

    document.addEventListener('click', onClick, { capture: true, passive: true })
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    const timer = window.setInterval(() => flush(false), 2500)
    return () => {
      document.removeEventListener('click', onClick, { capture: true })
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
      window.clearInterval(timer)
      flush(true)
    }
  }, [])

  return null
}
