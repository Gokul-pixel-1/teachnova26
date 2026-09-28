#!/usr/bin/env node
/**
 * UX Suggestion Agent verification (TEST mode) — behaviour → sandbox → approval.
 *
 * Proves against a hermetic TEST-mode server (deterministic offline drafts,
 * no Groq, no real email) that:
 *
 *   BELOW-THRESHOLD   one mildly confused user → nothing is raised
 *   AUTO + SANDBOX    users struggle to find "Log in" → the suggestion is
 *                     tested in the sandbox FIRST (SIMULATING), simulated
 *                     users replay the real clicks, the placement passes, and
 *                     only then an approval (+ email) exists; the real file is
 *                     untouched throughout; screenshots are served
 *                     (or a Jira card when the server runs with the Jira channel)
 *   APPROVE           approve → real file patched + VALIDATED
 *   NO-EASY-PLACEMENT users click where the moved group would put ANOTHER
 *                     button → every tried placement fails (misclicks), the
 *                     result is NO_EASY_PLACEMENT, no approval, no email, file
 *                     untouched; "Re-test" never repeats a failed placement
 *   REJECT / EXPIRY   → file untouched;  INVALID token → ok:false
 *
 * The header is set to its original layout (git HEAD + tracking tags) for the
 * run and restored byte-for-byte afterwards.
 *
 * Server: start-buildhub.ps1 -TestMode   Run: node scripts/verify-ux-suggestions.mjs
 */

import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

const CWD = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(CWD, '..')
const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const OPERATOR = { identifier: 'arjun', password: 'buildhub-demo1' }
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/buildhub'
const TARGET_FILE = 'components/navigation/header.tsx'
const TARGET = 'login-button'
const WEAK_TARGET = 'signup-button'
const SESSION_PREFIX = 'verify-ux-'
const VIEWPORT = { viewportW: 1400, viewportH: 900 }
// Log in's centre in the original 1400px layout is x≈1265. Users who look
// at x≈300 find it after the group moves left (x≈280..344); users who look at
// x≈390 would hit "Sign up" there instead (misclick) — no easy placement.
const DX_PASS = -965
const DX_MISCLICK = -874

let passed = 0
let failed = 0
const failures = []
function check(name, condition, extra) {
  if (condition) {
    passed += 1
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`)
    failures.push(name)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClient() {
  let cookie = ''
  async function req(method, path, body) {
    const headers = { Accept: 'application/json' }
    if (cookie) headers.Cookie = cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' })
    const m = res.headers.get('set-cookie')?.match(/buildhub_session=[^;]+/)
    if (m) cookie = m[0]
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: res.status, json, headers: res.headers }
  }
  return { get: (p) => req('GET', p), post: (p, b) => req('POST', p, b ?? {}) }
}

async function openPrisma() {
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: DATABASE_URL }) })
}

const readTarget = () => readFileSync(resolve(FRONTEND_ROOT, TARGET_FILE), 'utf8')
const writeTarget = (c) => writeFileSync(resolve(FRONTEND_ROOT, TARGET_FILE), c, 'utf8')

function originalHeader() {
  const committed = execSync(`git show HEAD:./${TARGET_FILE}`, { cwd: FRONTEND_ROOT, encoding: 'utf8' })
  return committed
    .replace('<Link href="/login">Log in</Link>', '<Link href="/login" data-ux-id="login-button">Log in</Link>')
    .replace('<Link href="/signup">Sign up</Link>', '<Link href="/signup" data-ux-id="signup-button">Sign up</Link>')
}

let sessionCounter = 0
async function sendSession(uxId, events) {
  sessionCounter += 1
  const sessionId = `${SESSION_PREFIX}${Date.now().toString(36)}-${sessionCounter}`
  const base = { path: '/projects', y: 32, ...VIEWPORT, uxId }
  const res = await fetch(`${BASE}/api/ux/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, events: events.map((e) => ({ ...base, ...e })) }),
  })
  return res.json().catch(() => null)
}

const struggle = (dx) => [
  { type: 'DEAD_CLICK', x: 1265 + dx, side: 'LEFT', dx, dy: 0, targetW: 64, targetH: 32 },
  { type: 'DEAD_CLICK', x: 1265 + dx, side: 'LEFT', dx, dy: 1, targetW: 64, targetH: 32 },
  { type: 'RAGE_CLICK', x: 1265 + dx, side: 'LEFT', dx, dy: 0, targetW: 64, targetH: 32 },
  { type: 'TARGET_CLICK', x: 1265, msSinceLoad: 12500 },
]

async function suggestionsFor(op, uxId) {
  const res = await op.get('/api/ux/suggestions')
  return (res.json?.suggestions ?? []).filter((s) => s.uxId === uxId)
}

async function waitForNew(op, uxId, knownIds, ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const s = (await suggestionsFor(op, uxId)).find((x) => !knownIds.has(x.id))
    if (s) return s
    await sleep(1000)
  }
  return null
}

async function waitForSettled(op, id, ms = 300_000) {
  const deadline = Date.now() + ms
  let s = null
  while (Date.now() < deadline) {
    const res = await op.get('/api/ux/suggestions')
    s = (res.json?.suggestions ?? []).find((x) => x.id === id) ?? null
    if (s && s.status !== 'SIMULATING') return s
    await sleep(3000)
  }
  return s
}

async function tokensFor(op, approvalId) {
  const res = await op.get(`/api/ux/approvals/email-token?approvalId=${approvalId}`)
  return res.json?.tokens ?? []
}

async function clickToken(token) {
  const res = await fetch(`${BASE}/api/ux/approvals/email?token=${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' } })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function main() {
  const prisma = await openPrisma().catch(() => null)
  const op = makeClient()
  const login = await op.post('/api/auth/login', OPERATOR)
  check('Operator login arjun -> 200', login.status === 200, `status=${login.status}`)
  if (login.status !== 200) { process.exitCode = 1; return }

  const mode = await op.get('/api/ux/approvals/email-token?approvalId=none')
  if (mode.status === 404 && mode.json?.error === 'Not found.') {
    console.error('\nThe server is not in TEST mode. Start it with: start-buildhub.ps1 -TestMode')
    process.exitCode = 1
    return
  }
  for (const uxId of [TARGET, WEAK_TARGET]) {
    const open = (await suggestionsFor(op, uxId)).find((s) => ['DRAFTED', 'SIMULATING', 'AWAITING_APPROVAL'].includes(s.status))
    if (open) {
      console.error(`\n${open.ref} (${uxId}) is ${open.status}. Decide it in /ai/ux-suggestions, then re-run.`)
      process.exitCode = 1
      return
    }
  }
  if (prisma) await prisma.uxEvent.deleteMany({ where: { sessionId: { startsWith: SESSION_PREFIX } } })
  // Approvals go to Jira when the server runs with the Jira channel (-JiraMock).
  const viaJira = (await op.get('/api/jira/status')).json?.channel === 'jira'
  console.log(`Approval channel: ${viaJira ? 'Jira' : 'email'}`)

  const userHeader = readTarget()
  const original = originalHeader()
  writeTarget(original)
  await sleep(2500)

  try {
    // --- BELOW-THRESHOLD ----------------------------------------------------
    console.log('\n=== Cohort BELOW-THRESHOLD ===')
    const weakBefore = (await suggestionsFor(op, WEAK_TARGET)).length
    const weak = await sendSession(WEAK_TARGET, [{ type: 'DEAD_CLICK', x: 900, side: 'LEFT', dx: -400, dy: 0 }])
    check('Event batch accepted', weak?.accepted === 1, JSON.stringify(weak))
    const weakRun = await op.post('/api/ux/behavior')
    const weakRow = (weakRun.json?.report ?? []).find((r) => r.uxId === WEAK_TARGET)
    check('Mild confusion is below threshold', weakRow && weakRow.flagged === false, JSON.stringify(weakRow))
    check('No suggestion raised for mild confusion', (await suggestionsFor(op, WEAK_TARGET)).length === weakBefore)
    check('Report does not expose raw click samples', weakRow && !('expectations' in weakRow))
    const unknown = await sendSession('not-a-tracked-component', [{ type: 'DEAD_CLICK', x: 1, side: 'LEFT' }])
    check('Events for unregistered components are ignored', unknown?.accepted === 0, JSON.stringify(unknown))

    // --- AUTO + SANDBOX -----------------------------------------------------
    console.log('\n=== Cohort AUTO + SANDBOX (pass) ===')
    const known = new Set((await suggestionsFor(op, TARGET)).map((s) => s.id))
    for (let i = 0; i < 3; i += 1) await sendSession(TARGET, struggle(DX_PASS))
    const auto = await waitForNew(op, TARGET, known)
    check('Suggestion raised automatically from behaviour', !!auto)
    check('It is tested in the sandbox first (SIMULATING, no approval yet)', auto?.status === 'SIMULATING' && (auto?.approvals ?? []).length === 0, `${auto?.status} approvals=${auto?.approvals?.length}`)
    check('Evidence: direction left + hotspot recorded', auto?.evidence?.direction === 'left' && auto?.evidence?.hotspot?.dx < -500, JSON.stringify(auto?.evidence?.hotspot))
    check('Real file untouched while simulating', readTarget() === original)
    const done = auto ? await waitForSettled(op, auto.id) : null
    const sb = done?.sandbox
    check('Sandbox test passed → AWAITING_APPROVAL', done?.status === 'AWAITING_APPROVAL', `${done?.status} ${done?.validationResult}`)
    check('Sandbox: winning round recorded', sb?.passed === true && sb?.winnerRound >= 1, JSON.stringify({ passed: sb?.passed, winner: sb?.winnerRound }))
    const win = sb?.rounds?.[(sb?.winnerRound ?? 1) - 1]?.result
    check('Sandbox: simulated users found it where they looked', win && win.foundWhereExpected === win.simulatedUsers && win.simulatedUsers >= 6, JSON.stringify(win && { found: win.foundWhereExpected, users: win.simulatedUsers }))
    check('Sandbox: no misclicks, no duplicate, layout checks pass', win && win.misclicks === 0 && Object.values(win.checks).every(Boolean), JSON.stringify(win?.checks))
    check('Sandbox: much closer than before', win && win.distanceImprovement >= 0.5, String(win?.distanceImprovement))
    const shot = done ? await op.get(`/api/ux/suggestions/${done.id}/screenshot?name=${sb?.baselineScreenshot ?? 'baseline.png'}`) : null
    check('Before/after screenshot is served', shot?.status === 200 && (shot?.headers.get('content-type') ?? '').includes('image/png'), `status=${shot?.status}`)
    const bad = done ? await op.get(`/api/ux/suggestions/${done.id}/screenshot?name=../../.env`) : null
    check('Screenshot route refuses other paths', bad?.status === 404, `status=${bad?.status}`)
    check('Real file still untouched after the sandbox test', readTarget() === original)
    if (prisma && done && viaJira) {
      const link = done.approvals?.[0] ? await prisma.jiraApproval.findUnique({ where: { approvalId: done.approvals[0].approvalId } }) : null
      check('Jira approval card opened only after the pass', !!link?.issueKey, done.ref)
    } else if (prisma && done) {
      const mail = await prisma.gmailNotification.findFirst({ where: { type: 'UX_SUGGESTION_APPROVAL_REQUIRED', subject: { contains: done.ref } }, orderBy: { createdAt: 'desc' } })
      check('Approval email recorded only after the pass', !!mail, done.ref)
      check('Email includes the sandbox results', /Tested first in a sandbox/.test(mail?.message ?? ''))
    }

    // --- APPROVE ------------------------------------------------------------
    console.log('\n=== Cohort APPROVE -> APPLIED ===')
    const approvalId = done?.approvals?.[0]?.approvalId
    const approve = approvalId ? (await tokensFor(op, approvalId)).find((t) => t.action === 'APPROVE')?.token : null
    check('APPROVE token issued', !!approve)
    if (approve) {
      const clicked = await clickToken(approve)
      check('Approve -> VALIDATED (live page probe passed)', clicked.json?.ok === true && clicked.json?.status === 'VALIDATED', JSON.stringify(clicked.json))
      const onDisk = readTarget()
      check('Real file now has the tested placement', onDisk !== original && onDisk.includes('data-ux-id="login-button"'))
      const replay = await clickToken(approve)
      check('Reused token -> ok:false, alreadyDecided', replay.json?.ok === false && replay.json?.alreadyDecided === true, JSON.stringify(replay.json))
      writeTarget(original)
      await sleep(2500)
    }

    // --- NO EASY PLACEMENT --------------------------------------------------
    console.log('\n=== Cohort NO-EASY-PLACEMENT (misclicks) ===')
    const known2 = new Set((await suggestionsFor(op, TARGET)).map((s) => s.id))
    for (let i = 0; i < 3; i += 1) await sendSession(TARGET, struggle(DX_MISCLICK))
    const hard = await waitForNew(op, TARGET, known2)
    check('Second struggle raised a suggestion', !!hard)
    const hardDone = hard ? await waitForSettled(op, hard.id) : null
    check('Every tried placement failed → NO_EASY_PLACEMENT', hardDone?.status === 'NO_EASY_PLACEMENT', `${hardDone?.status} ${hardDone?.validationResult}`)
    const hardRounds = hardDone?.sandbox?.rounds ?? []
    check('More than one placement was tried', hardRounds.filter((r) => r.result).length >= 2, `rounds=${hardRounds.length}`)
    check('Failure reason names the misclicked control', hardRounds.some((r) => (r.result?.reasons ?? []).some((x) => /signup-button/.test(x))), JSON.stringify(hardRounds.map((r) => r.result?.reasons)))
    check('No approval created', (hardDone?.approvals ?? []).length === 0)
    if (prisma && hardDone) {
      const mail = await prisma.gmailNotification.count({ where: { type: 'UX_SUGGESTION_APPROVAL_REQUIRED', subject: { contains: hardDone.ref } } })
      check('No approval email sent', mail === 0, `emails=${mail}`)
      const cards = await prisma.jiraApproval.count({ where: { approvalId: { in: (hardDone.approvals ?? []).map((a) => a.approvalId) } } })
      check('No Jira approval card opened', cards === 0, `cards=${cards}`)
    }
    check('Real file untouched', readTarget() === original)
    const retest = hardDone ? await op.post(`/api/ux/suggestions/${hardDone.id}/retest`) : null
    check('Re-test accepted', retest?.json?.ok === true, JSON.stringify(retest?.json))
    const retested = hardDone ? await waitForSettled(op, hardDone.id) : null
    const repeat = (retested?.sandbox?.rounds ?? []).some((r) => r.proposedCode && hardRounds.some((h) => h.proposedCode === r.proposedCode))
    check('Re-test never repeats a failed placement', !repeat && retested?.status !== 'AWAITING_APPROVAL', `${retested?.status}`)

    // --- REJECT / EXPIRY / INVALID ------------------------------------------
    console.log('\n=== Cohort REJECT / EXPIRY / INVALID ===')
    const manual = await op.post('/api/ux/suggestions', { component: TARGET, file: TARGET_FILE, instruction: 'move it left' })
    check('Manual request accepted (tested in sandbox)', manual.json?.ok === true && manual.json?.simulating === true, JSON.stringify(manual.json))
    const manualDone = manual.json?.suggestion ? await waitForSettled(op, manual.json.suggestion.id) : null
    check('Manual request passes layout checks → AWAITING_APPROVAL', manualDone?.status === 'AWAITING_APPROVAL', manualDone?.status)
    const rejectToken = manualDone ? (await tokensFor(op, manualDone.approvals[0].approvalId)).find((t) => t.action === 'REJECT')?.token : null
    if (rejectToken) {
      const clicked = await clickToken(rejectToken)
      check('Reject -> ok', clicked.json?.ok === true, JSON.stringify(clicked.json))
      check('Real file unchanged after reject', readTarget() === original)
    } else {
      check('REJECT token issued', false)
    }
    const toExpire = await op.post('/api/ux/suggestions', { component: TARGET, file: TARGET_FILE, instruction: 'move it left' })
    const expDone = toExpire.json?.suggestion ? await waitForSettled(op, toExpire.json.suggestion.id) : null
    if (prisma && expDone?.approvals?.[0]) {
      await prisma.uxApproval.update({ where: { approvalId: expDone.approvals[0].approvalId }, data: { expiresAt: new Date(Date.now() - 60_000) } })
      const decision = await op.post('/api/ux/approvals/proceed', { approvalId: expDone.approvals[0].approvalId, action: 'proceed' })
      check('Approving after expiry -> EXPIRED', decision.json?.status === 'EXPIRED', JSON.stringify(decision.json))
      check('Real file unchanged after expiry', readTarget() === original)
    } else {
      check('Approving after expiry -> EXPIRED', false, expDone?.status)
    }
    const bogus = await clickToken(`not-a-real-token-${Date.now()}`)
    check('Bogus token -> ok:false', bogus.json?.ok === false)
  } finally {
    writeTarget(userHeader)
    if (prisma) {
      await prisma.uxEvent.deleteMany({ where: { sessionId: { startsWith: SESSION_PREFIX } } })
      await prisma.$disconnect().catch(() => undefined)
    }
  }
  check('Header restored byte-for-byte to its pre-test content', readTarget() === userHeader)

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.error(`Failures: ${failures.join(', ')}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
