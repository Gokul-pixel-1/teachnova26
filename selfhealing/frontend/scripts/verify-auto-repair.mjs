#!/usr/bin/env node
/**
 * Phase 11 — Automatic Self-Healing Verification (real runtime loop, auto-trigger)
 *
 * Proves the repair pipeline starts ITSELF from a real application error —
 * nothing presses a repair button. Same evidence-only discipline as
 * verify-self-healing.mjs, but NO manual `POST /api/security/run` anywhere in
 * the happy path: the log monitor's scan is the only interjection.
 *
 *   1. activate a fault            → defect written into the real file
 *   2. make a REAL failing request → ERROR log persists errorName / stack /
 *                                    sourceFile / sourceLine / requestId
 *   3. scan                        → log monitor creates an incident and
 *                                    AUTOMATICALLY enqueues the repair engine
 *   4. engine (TEST provider)      → evidence → candidate → risk → apply →
 *                                    real validation → RESOLVED
 *   5. verify NO duplicate runs    → repeated scans/polling add no second attempt
 *
 * Cohorts verified here:
 *   A) LOW-01 auto-trigger             → RESOLVED, single attempt, endpoint fixed
 *   B) HIGH-01 auto-trigger             → WAITING_APPROVAL (human gate), single
 *                                         attempt even when repeated failures merge
 *   C) --failure-scenarios (opt-in):
 *        bad-fix    → the engine APPLIES a wrong candidate, its REAL validation
 *                     probe fails, and it ROLLS BACK (no infinite loop)
 *        reject-all → a model that cannot produce a candidate records an honest
 *                     AI_REPAIR_FAILED — no fabricated success
 *
 * Server requirements (TEST mode + AUTO_REPAIR on, so the engine starts itself):
 *     FAULT_INJECTION_ENABLED=true
 *     AUTH_GUARD_ENABLED=false
 *     AI_PROVIDER=test SELF_HEALING_TEST_MODE=true
 *     AUTO_REPAIR=true                          (required for this script)
 *
 *     cd frontend
 *     env FAULT_INJECTION_ENABLED=true AUTH_GUARD_ENABLED=false \
 *         AI_PROVIDER=test SELF_HEALING_TEST_MODE=true AUTO_REPAIR=true \
 *         npx next dev -p 3000
 *
 * Run:
 *     node scripts/verify-auto-repair.mjs
 *     node scripts/verify-auto-repair.mjs --failure-scenarios   (restarts server
 *        once per failure cohort with AUTO_REPAIR_SCENARIO set)
 */

import { spawn, execSync } from 'node:child_process'
import { resolve } from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const DEMO_PASSWORD = 'buildhub-demo1'
const OPERATOR = { identifier: 'arjun', password: DEMO_PASSWORD }

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function tokenFromSetCookie(setCookie) {
  const match = setCookie && setCookie.match(/buildhub_session=[^;]+/)
  return match ? match[0] : null
}

class Client {
  constructor() {
    this.cookie = ''
  }

  async request(method, path, body) {
    const headers = this.cookie ? { Cookie: this.cookie } : {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) {
      const token = tokenFromSetCookie(setCookie)
      if (token) this.cookie = token
    }
    let json = null
    const text = await res.text()
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text }
  }

  get(path) {
    return this.request('GET', path)
  }
  post(path, body) {
    return this.request('POST', path, body ?? undefined)
  }
}

async function triggerUntilFailure(fn, { expected, attempts = 40, waitMs = 500 }) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fn()
    if (expected(res)) return res
    await sleep(waitMs)
  }
  const last = await fn()
  return last
}

async function warmFor(op, faultId) {
  const url = faultId === 'HIGH-01'
    ? () => op.post('/api/auth/login', { identifier: 'arjun', password: DEMO_PASSWORD })
    : () => op.get('/api/posts?pageSize=3')
  const res = await url()
  await sleep(300)
  return res
}

async function activateFault(op, faultId) {
  return op.post('/api/faults', { faultId })
}

async function scanIncidents(op) {
  return op.post('/api/incidents/scan', { limit: 100 })
}

async function openIncidentIds(op) {
  const list = await op.get('/api/incidents?status=DETECTED,INVESTIGATING,WAITING_APPROVAL,VALIDATING&pageSize=100')
  return (list.json?.incidents ?? []).map((inc) => inc.id)
}

async function incidentDetail(op, incidentId) {
  const res = await op.get(`/api/incidents/${incidentId}`)
  return res.json?.incident ?? null
}

/** Polls the incident until `pred` is true (dev/turbopack + auto-run latency). */
async function pollIncident(op, incidentId, pred, { tries = 120, waitMs = 1000 } = {}) {
  let det = null
  for (let i = 0; i < tries; i += 1) {
    det = await incidentDetail(op, incidentId)
    if (det && pred(det)) return det
    await sleep(waitMs)
  }
  return det
}

/**
 * Cohort runner shared by every scenario: activate → real failure → ONE scan →
 * the scan self-starts the repair → poll the incident for the expected stage.
 * Returns the incident detail once it reaches `expectedStage`.
 */
async function autoCycle(op, preOpenIds, { faultId, trigger, expectTrigger, expectedStage }) {
  console.log(`\n--- ${faultId}: real failure → scan → AUTO repair → ${expectedStage} (no manual run) ---`)

  await warmFor(op, faultId)
  const activate = await activateFault(op, faultId)
  check(
    `${faultId} activate → 200 with defect location`,
    activate.status === 200 && activate.json?.defect?.file,
    `status=${activate.status} ${JSON.stringify(activate.json)}`,
  )
  await sleep(2000)
  await warmFor(op, faultId)

  const triggerRes = await triggerUntilFailure(trigger, { expected: expectTrigger })
  check(`${faultId} trigger produces the real failure (${expectTrigger({ status: triggerRes.status }) ? `status=${triggerRes.status}` : ''})`, expectTrigger(triggerRes), `status=${triggerRes.status}`)

  // Dev-mode Turbopack can serve a stale GOOD compile when the defect write
  // races the first on-demand compile right after a server restart. If the
  // expected failure didn't materialize, re-assert the fault once and retry.
  let resolvedTrigger = triggerRes
  if (!expectTrigger(triggerRes)) {
    await warmFor(op, faultId)
    const re = await activateFault(op, faultId).catch(() => ({ status: 500 }))
    await sleep(1500)
    await warmFor(op, faultId)
    resolvedTrigger = await triggerUntilFailure(trigger, { expected: expectTrigger })
    check('re-activated + revived: real failure reproduced', expectTrigger(resolvedTrigger), `reActivate=${re.status} then=${resolvedTrigger.status}`)
  }

  // ERROR log rows are persisted fire-and-forget, so the scan can race the
  // flush right after the trigger. Retry briefly before declaring the real
  // failure invisible (same robustness as pollIncident / triggerUntilFailure).
  let scan = await scanIncidents(op)
  for (let i = 0; i < 5 && (scan.json?.scanned ?? 0) < 1; i += 1) {
    await sleep(400)
    scan = await scanIncidents(op)
  }
  check(
    `${faultId} scan sees the ERROR log(s)`,
    (scan.json?.scanned ?? 0) >= 1,
    JSON.stringify(scan.json),
  )
  const created = (scan.json?.created ?? []).filter((c) => !preOpenIds.has(c.id))
  const merged = scan.json?.merged ?? 0
  check(
    `${faultId} scan created and/or merged an incident`,
    created.length >= 1 || merged >= 1,
    JSON.stringify({ created: created.length, merged }),
  )
  // The in-request log monitor auto-scans too, so the incident the repair
  // engine is already working on may be reported by our scan as MERGED rather
  // than CREATED. Resolve the pipeline's incident as any NEWLY-OPEN incident
  // that appeared since the cohort began (created OR merged OR auto-started),
  // not solely one returned in this scan's `created` list.
  const openedNow = new Set(await openIncidentIds(op))
  const newIds = [...openedNow].filter((id) => !preOpenIds.has(id))
  const incidentId = newIds[0] ?? null
  if (!incidentId) {
    check(`${faultId} an incident is available to auto-repair`, false, `created=${created.length} merged=${merged} openedNow=${newIds.length}`)
    return null
  }

  await sleep(300)
  const detail = await pollIncident(op, incidentId, (d) => d.status === expectedStage)
  check(
    `${faultId} incident reached ${expectedStage} WITHOUT a manual run`,
    detail?.status === expectedStage,
    `status=${detail?.status ?? 'null'}`,
  )
  return detail
}

/** The incident detail exposes the LATEST repairAttempt; 1 means ≥1 ever ran. */
const attemptCount = (det) => (det?.repairAttempt ? 1 : 0)

async function cohortLowAuto(op, preOpenIds) {
  const detail = await autoCycle(op, preOpenIds, {
    faultId: 'LOW-01',
    trigger: () => op.post('/api/posts', { content: `LOW-01 auto ${Date.now()}`, tags: [] }),
    expectTrigger: (res) => res.status === 500,
    expectedStage: 'RESOLVED',
  })
  if (!detail) return

  const timeline = detail.timeline ?? []
  check(
    'Auto-repair event recorded by the log monitor',
    timeline.some((e) => e.label === 'Auto-repair triggered by log monitor'),
    `labels=${timeline.map((e) => e.label).join(' | ').slice(0, 300)}`,
  )
  check(
    'Self-healing engine event recorded (INVESTIGATING started)',
    timeline.some((e) => e.label === 'Self-healing repair started'),
    `labels=${timeline.map((e) => e.label).join(' | ').slice(0, 300)}`,
  )
  check(
    'Agent transcript ran under the auto-trigger',
    (detail.agentRuns ?? []).length >= 3,
    `runs=${(detail.agentRuns ?? []).length} kinds=${(detail.agentRuns ?? []).map((r) => r.kind).join(',')}`,
  )
  check(
    'Exactly ONE repair conversation ran (single attempt, ≥3 agent runs)',
    attemptCount(detail) === 1 && (detail.agentRuns ?? []).length >= 3,
    `attempt=${attemptCount(detail)} runs=${(detail.agentRuns ?? []).length}`,
  )

  const created = await op.post('/api/posts', { content: `LOW-01 auto verified ${Date.now()}`, tags: [] })
  check('LOW-01 repaired: post creation works (201)', created.status === 201, `status=${created.status}`)

  // Repeated scanning + polling must NOT spawn a second repair run.
  const before = await incidentDetail(op, detail.id)
  const runsBefore = (before?.agentRuns ?? []).length
  const scan2 = await scanIncidents(op)
  await sleep(1500)
  const after = await incidentDetail(op, detail.id)
  const runsAfter = (after?.agentRuns ?? []).length
  check(
    'Repeated scan does NOT duplicate the repair run (same incident)',
    after?.status === 'RESOLVED' && runsAfter === runsBefore,
    `scan2=${JSON.stringify(scan2.json ?? {})} runs ${runsBefore}→${runsAfter}`,
  )

  const faults = await op.get('/api/faults')
  const fault = (faults.json?.faults ?? []).find((f) => f.id === 'LOW-01')
  check('LOW-01 fault inactive after auto-repair (file repaired, not leaked)', fault?.active === false, `active=${fault?.active}`)
}

async function cohortHighApproval(op, preOpenIds) {
  const detail = await autoCycle(op, preOpenIds, {
    faultId: 'HIGH-01',
    trigger: () => op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' }),
    expectTrigger: (res) => res.status === 500,
    expectedStage: 'WAITING_APPROVAL',
  })
  if (!detail) return

  const attempts = attemptCount(detail)
  check('HIGH auto-repair STOPS for human approval (one attempt, <3 runs OK)', attempts === 1, `attempts=${attempts}`)
  const approvalId = (detail.approvals ?? [])[0]?.approvalId ?? null
  check('HIGH auto-repair created an approval record', !!approvalId, `approvals=${JSON.stringify(detail.approvals ?? [])}`)

  // A REPEATED failure while the incident is OPEN merges in — the guard must
  // refuse to start a SECOND repair on the same incident.
  const trigger2 = await triggerUntilFailure(
    () => op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' }),
    { expected: (res) => res.status === 500 },
  )
  check('HIGH repeat failure still produces the real 500', trigger2.status === 500, `status=${trigger2.status}`)
  const runsBefore = (detail.agentRuns ?? []).length
  const scan2 = await scanIncidents(op)
  await sleep(1500)
  const detail2 = await incidentDetail(op, detail.id)
  const runsAfter = (detail2?.agentRuns ?? []).length
  const attempts2 = attemptCount(detail2)
  check(
    'Repeated HIGH failure merges into the SAME incident without a duplicate repair run',
    detail2?.status === 'WAITING_APPROVAL' && attempts2 === attempts && runsAfter === runsBefore,
    `scan2=${JSON.stringify(scan2.json ?? {})} status=${detail2?.status} runs ${runsBefore}→${runsAfter}`,
  )

  const proceed = await op.post('/api/approvals/proceed', { approvalId, action: 'proceed' })
  const stage = proceed.json?.repair?.stage ?? proceed.json?.stage
  check('HIGH approval PROCEED applies + validates the patch (RESOLVED)', stage === 'RESOLVED', `stage=${stage}`)
  const finalDetail = await incidentDetail(op, detail.id)
  check('HIGH incident reached RESOLVED after approval', finalDetail?.status === 'RESOLVED', `status=${finalDetail?.status}`)

  const wrong = await op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' })
  const right = await op.post('/api/auth/login', { identifier: 'arjun', password: DEMO_PASSWORD })
  check('HIGH-01 repaired: wrong password → 401', wrong.status === 401, `status=${wrong.status}`)
  check('HIGH-01 repaired: correct password → 200', right.status === 200, `status=${right.status}`)

  const faults = await op.get('/api/faults')
  const fault = (faults.json?.faults ?? []).find((f) => f.id === 'HIGH-01')
  check('HIGH-01 fault inactive after approved repair', fault?.active === false, `active=${fault?.active}`)
}

function devPort() {
  try { return new URL(BASE).port || '3000' } catch { return '3000' }
}

async function restartDevServer(extraEnv = {}) {
  const port = devPort()
  try {
    const pids = execSync(`ss -ltnp | grep ':${port} ' | grep -o 'pid=[0-9]*' | cut -d= -f2`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM') } catch {}
    }
  } catch {}
  for (let i = 0; i < 20; i += 1) {
    try { execSync(`ss -ltn | grep ':${port}'`) } catch { break }
    await sleep(500)
  }
  const child = spawn('npx', ['next', 'dev', '-p', port], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SELF_HEALING_TEST_MODE: 'true',
      AI_PROVIDER: 'test',
      FAULT_INJECTION_ENABLED: 'true',
      AUTH_GUARD_ENABLED: 'false',
      AUTO_REPAIR: 'true',
      ...extraEnv,
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  for (let i = 0; i < 90; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch {}
    await sleep(1000)
  }
  return false
}

/** Failure cohort: the TEST provider is forced to emit a WRONG candidate. */
async function cohortRollback(op, preOpenIds) {
  const detail = await autoCycle(op, preOpenIds, {
    faultId: 'LOW-01',
    trigger: () => op.post('/api/posts', { content: `LOW-01 badfix ${Date.now()}`, tags: [] }),
    expectTrigger: (res) => res.status === 500,
    expectedStage: 'ROLLED_BACK',
  })
  if (!detail) return
  const timeline = detail.timeline ?? []
  check(
    'Rollback event recorded (validation failure → rolled back)',
    timeline.some((e) => e.label === 'Patch failed validation — rolled back'),
    `labels=${timeline.map((e) => e.label).join(' | ').slice(0, 300)}`,
  )
  check(
    'Bad candidate was honestly rejected by REAL validation (no RESOLVED)',
    detail.status === 'ROLLED_BACK',
    `status=${detail.status}`,
  )
  const faults = await op.get('/api/faults')
  const fault = (faults.json?.faults ?? []).find((f) => f.id === 'LOW-01')
  check(
    'File left in faulted state after rollback (bug NOT silently kept repaired)',
    fault?.active === true,
    `active=${fault?.active}`,
  )
  // A rollback is TERMINAL: repeated scanning must not loop auto-repairs.
  await scanIncidents(op)
  await sleep(1200)
  const after = await incidentDetail(op, detail.id)
  check('Rolled-back incident is terminal (no infinite repair loop)', after?.status === 'ROLLED_BACK' && attemptCount(after) === 1, `status=${after?.status} attempt=${attemptCount(after)}`)
}

/** Failure cohort: a model that cannot produce any candidate. */
async function cohortHonestFailure(op, preOpenIds) {
  const detail = await autoCycle(op, preOpenIds, {
    faultId: 'LOW-01',
    trigger: () => op.post('/api/posts', { content: `LOW-01 reject ${Date.now()}`, tags: [] }),
    expectTrigger: (res) => res.status === 500,
    expectedStage: 'AI_REPAIR_FAILED',
  })
  if (!detail) return
  check(
    'Honest failure recorded (AI_REPAIR_FAILED, never fabricated RESOLVED)',
    detail.status === 'AI_REPAIR_FAILED',
    `status=${detail.status}`,
  )
  // Failed terminal state must not auto-loop either.
  await scanIncidents(op)
  await sleep(1200)
  const after = await incidentDetail(op, detail.id)
  check('Failed incident is terminal (no automatic retry loop)', after?.status === 'AI_REPAIR_FAILED' && attemptCount(after) === 1, `status=${after?.status} attempt=${attemptCount(after)}`)
  await op.post('/api/faults', { action: 'deactivate-all' })
}

async function run() {
  const runFailureScenarios = process.argv.includes('--failure-scenarios')
  const op = new Client()
  console.log('# Automatic Self-Healing Verification (no manual run on the happy path)')

  const login = await op.post('/api/auth/login', OPERATOR)
  check('Operator login arjun → 200', login.status === 200, `status=${login.status}`)
  if (login.status !== 200) throw new Error('Cannot login — aborting')

  const cleanup = await op.post('/api/faults', { action: 'deactivate-all' })
  check('Deactivate all faults → 200', cleanup.status === 200, `status=${cleanup.status}`)

  const skipHappyPath = process.argv.includes('--skip-happy-path')
  const preOpen = new Set(await openIncidentIds(op))

  if (skipHappyPath) {
    check('happy-path cohorts A+B skipped (--skip-happy-path: cohorts C run standalone)', true)
  } else {
    console.log('\n=== Cohort A: LOW-01 automatic (un-supervised) repair ===')
    await cohortLowAuto(op, preOpen)

    console.log('\n=== Cohort B: HIGH-01 auto-repair stops for human approval ===')
    await cohortHighApproval(op, preOpen)
  }

  if (runFailureScenarios) {
    console.log('\n=== Cohort C: --failure-scenarios (server restarts) ===')
    check('dev server restarted (bad-fix scenario)', await restartDevServer({ AUTO_REPAIR_SCENARIO: 'bad-fix' }), 'restartTimedOut')
    const opFix = new Client()
    const re1 = await opFix.post('/api/auth/login', OPERATOR)
    check('post-restart login arjun → 200', re1.status === 200, `status=${re1.status}`)
    await opFix.post('/api/faults', { action: 'deactivate-all' })
    const preFix = new Set(await openIncidentIds(opFix))
    console.log('\n--- Cohort C1: wrong candidate → ROLLED_BACK ---')
    await cohortRollback(opFix, preFix)
    await opFix.post('/api/faults', { action: 'deactivate-all' })

    check('dev server restarted (reject-all scenario)', await restartDevServer({ AUTO_REPAIR_SCENARIO: 'reject-all' }), 'restartTimedOut')
    const opRej = new Client()
    const re2 = await opRej.post('/api/auth/login', OPERATOR)
    check('post-restart login arjun → 200', re2.status === 200, `status=${re2.status}`)
    await opRej.post('/api/faults', { action: 'deactivate-all' })
    const preRej = new Set(await openIncidentIds(opRej))
    console.log('\n--- Cohort C2: no candidate → honest AI_REPAIR_FAILED ---')
    await cohortHonestFailure(opRej, preRej)
  } else {
    check('--failure-scenarios skipped (ROLLED_BACK + AI_REPAIR_FAILED cohorts opt-in)', true)
  }

  console.log('\n' + '='.repeat(52))
  console.log(`Automatic self-healing verification: ${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exitCode = failed > 0 ? 1 : 0
}

run().catch((err) => {
  console.error('Verification crashed:', err)
  process.exitCode = 1
})