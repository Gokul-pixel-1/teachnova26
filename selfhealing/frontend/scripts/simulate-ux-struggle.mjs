#!/usr/bin/env node
/**
 * Simulates several users struggling to find one tracked UI component, using
 * REAL headless Chrome against the running app. Each simulated user opens the
 * page in a fresh incognito window (= a separate session), clicks empty space
 * in the direction where they expect the component, rage-clicks there, waits,
 * and finally finds and clicks the real component. The in-page tracker
 * (components/ux/behavior-tracker.tsx) records it exactly like a real visit.
 *
 * With the defaults this crosses the friction threshold; the server then
 * drafts a suggestion automatically, tests it in the sandbox, and emails an
 * approval request only if a placement passes.
 *
 * Usage (from selfhealing/frontend, app running on :3000):
 *   node scripts/simulate-ux-struggle.mjs
 *   node scripts/simulate-ux-struggle.mjs --component login-button --side left
 *   node scripts/simulate-ux-struggle.mjs --component login-button --side right --distance 1100
 *   node scripts/simulate-ux-struggle.mjs --component projects-status-filter --side down --distance 80
 * Options:
 *   --component <data-ux-id>   tracked component (default login-button)
 *   --side left|right|up|down  where users expect it (default left)
 *   --distance <px>            how far from it they click (default 220; 80 for up/down)
 *   --users <n>                simulated users / sessions (default 3)
 *   --path </page>             page to open (defaults per component)
 *   --quick                    skip the slow-search wait (still crosses the threshold)
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

const PATHS = {
  'login-button': '/projects',
  'signup-button': '/projects',
  'sidebar-login': '/projects',
  'sidebar-signup': '/projects',
  'landing-login': '/',
  'landing-get-started': '/',
  'landing-hero-start': '/',
  'landing-hero-explore': '/',
  'projects-search': '/projects',
  'projects-status-filter': '/projects',
}

const component = arg('component', 'login-button')
const side = ['left', 'right', 'up', 'down'].includes(arg('side', 'left')) ? arg('side', 'left') : 'left'
const distance = Number.parseInt(arg('distance', side === 'up' || side === 'down' ? '80' : '220'), 10)
const users = Number.parseInt(arg('users', arg('sessions', '3')), 10)
const path = arg('path', PATHS[component])
const quick = process.argv.includes('--quick')
const VIEWPORT = { width: 1400, height: 900 }

if (!path) {
  console.error(`No default page for "${component}". Pass --path /the-page (it must render [data-ux-id="${component}"] without signing in).`)
  process.exit(1)
}

const chrome = [
  process.env.UX_CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p))
if (!chrome) {
  console.error('Chrome/Edge not found. Set UX_CHROME_PATH.')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] })
try {
  for (let u = 1; u <= users; u += 1) {
    const ctx = await browser.createBrowserContext()
    const page = await ctx.newPage()
    await page.setViewport(VIEWPORT)
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 120000 })
    const target = await page.waitForSelector(`[data-ux-id="${component}"]`, { visible: true, timeout: 30000 }).catch(() => null)
    if (!target) {
      console.error(`"${component}" is not visible on ${path} (at ${VIEWPORT.width}x${VIEWPORT.height}).`)
      process.exit(1)
    }
    // Pick an EMPTY spot in the chosen direction (nudging outward past other controls).
    const spot = await page.evaluate(
      (id, dir, dist) => {
        const el = document.querySelector(`[data-ux-id="${id}"]`)
        const r = el.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const step = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir]
        const interactive = 'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[data-ux-id]'
        for (let extra = 0; extra <= 400; extra += 20) {
          const edge = dir === 'left' || dir === 'right' ? r.width / 2 : r.height / 2
          const x = Math.round(Math.min(Math.max(cx + step[0] * (edge + dist + extra), 6), innerWidth - 6))
          const y = Math.round(Math.min(Math.max(cy + step[1] * (edge + dist + extra), 6), innerHeight - 6))
          const hit = document.elementFromPoint(x, y)
          if (hit && !hit.closest(interactive)) return { x, y }
        }
        return null
      },
      component,
      side,
      distance,
    )
    if (!spot) {
      console.error(`No empty space found ${distance}px ${side} of "${component}". Try another --distance.`)
      process.exit(1)
    }
    await page.mouse.click(spot.x, spot.y)
    await sleep(600)
    await page.mouse.click(spot.x + 8, spot.y)
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.click(spot.x + 8, spot.y)
      await sleep(110)
    }
    await sleep(quick ? 500 : 8400)
    await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => undefined), target.click()])
    await sleep(1500)
    console.log(`user ${u}/${users}: looked ${side} of "${component}" (clicked empty space at ${spot.x},${spot.y}), then found it`)
    await ctx.close()
  }
} finally {
  await browser.close()
}

console.log(`\n${users} simulated users struggled with "${component}" (expected it ${side}).`)
console.log('The server analyses this automatically within a few seconds, then tests a fix in the sandbox.')
console.log(`Watch ${BASE}/ai/ux-suggestions — you get an approval email only if a placement passes the sandbox test.`)
