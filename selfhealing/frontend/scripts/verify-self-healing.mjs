#!/usr/bin/env node
/**
 * Phase 9 — Self-Healing Verification (REAL runtime loop)
 *
 * Proves the self-healing engine works ONLY from real runtime evidence — no
 * fault ids or canned answers anywhere in the repair path:
 *
 *   1. activate a fault           → the defect is written into the real file
 *   2. make a REAL failing request → ERROR log persists errorName / stack /
 *                                    sourceFile / sourceLine / requestId
 *   3. scan                        → log monitor groups the unlinked ERROR logs
 *                                    by signature → ONE incident per failure
 *   4. run                         → engine reads evidence from the REAL file,
 *                                    produces a candidate, applies it to the
 *                                    REAL file and validates with real probes
 *   5. RESOLVED                    (HIGH risk → WAITING_APPROVAL → proceed)
 *
 * Also verifies:
 *   - the merge behaviour (repeated identical failures fold into one incident)
 *   - the harness-only behavioural faults (no exception → no incident)
 *   - every target file is left clean at the end
 *
 * Dev-server note: Turbopack dev recompilation of a repeatedly rewritten route
 * becomes unreliable after the server has been up a while. Before the
 * behavioural (harness-only) phase this script restarts the dev server so each
 * edited module is compiled fresh from its current on-disk state. The engine
 * (crash-fault) phase runs against the server you launched.
 *
 * Requirements:
 *   The app must be running with the fault harness enabled and an AI provider:
 *     FAULT_INJECTION_ENABLED=true   (already set in .env)
 *     AI_PROVIDER=test SELF_HEALING_TEST_MODE=true   (hermetic CI runs)
 *
 * Run:   node scripts/verify-self-healing.mjs
 */

import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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
  patch(path, body) {
    return this.request('PATCH', path, body ?? undefined)
  }
  delete(path) {
    return this.request('DELETE', path)
  }
}

/**
 * Triggers the (just-activated) fault and retries while the dev server
 * recompiles the written file. Turbopack needs a beat before the route serves
 * the faulted module; the retry makes this deterministic in dev.
 */
async function triggerUntilFailure(fn, { expected, attempts = 40, waitMs = 500 }) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fn()
    if (expected(res)) return res
    await sleep(waitMs)
  }
  const last = await fn()
  return last
}

/**
 * Warms a route module so a later fault/repair write only triggers a FAST
 * incremental recompile (dev servers compile a route on its first request; a
 * cold first request after a file edit can take many seconds).
 */
async function warmFor(op, faultId) {
  const url = faultId === 'HIGH-01'
    ? () => op.post('/api/auth/login', { identifier: 'arjun', password: DEMO_PASSWORD })
    : faultId === 'MEDIUM-03' || faultId === 'HIGH-02'
      ? () => op.get('/api/projects?pageSize=3')
      : () => op.get('/api/posts?pageSize=3')
  const res = await url()
  await sleep(300)
  return res
}

async function activateFault(op, faultId) {
  return op.post('/api/faults', { faultId })
}

async function deactivateFault(op, faultId) {
  return op.post('/api/faults', { faultId, action: 'deactivate' })
}

async function scanIncidents(op) {
  return op.post('/api/incidents/scan', { limit: 100 })
}

/** Newest OPEN incident NOT already open before this cycle (avoids stale pickups). */
async function findOpenIncident(op, method, endpoint, excludeIds) {
  const list = await op.get('/api/incidents?status=DETECTED,INVESTIGATING,WAITING_APPROVAL,VALIDATING&pageSize=100')
  const incidents = list.json?.incidents ?? []
  return incidents.find(
    (inc) => inc.method === method && inc.endpoint === endpoint && !excludeIds.has(inc.id),
  ) ?? null
}

/** All currently-open incident ids (DETECTED/INVESTIGATING/WAITING_APPROVAL/VALIDATING). */
async function openIncidentIds(op) {
  const list = await op.get('/api/incidents?status=DETECTED,INVESTIGATING,WAITING_APPROVAL,VALIDATING&pageSize=100')
  return (list.json?.incidents ?? []).map((inc) => inc.id)
}

/**
 * Full real self-healing cycle for a crash fault.
 * `trigger` must perform a real failing request; `verifyBehaviour` checks the
 * REAL endpoint after the engine repaired the file.
 */
async function crashFaultCycle(op, preOpenIds, { faultId, trigger, expectTrigger, verifyBehaviour }) {
  console.log(`\n--- ${faultId}: real failure → incident → repair ---`)

  await warmFor(op, faultId)
  const activate = await activateFault(op, faultId)
  check(
    `${faultId} activate → 200 with defect location`,
    activate.status === 200 && activate.json?.defect?.file,
    `status=${activate.status} ${JSON.stringify(activate.json)}`,
  )
  // Settle + warm again so Turbopack recompiles the faulted module before the
  // trigger loop measures the real failure.
  await sleep(2000)
  await warmFor(op, faultId)

  const triggerRes = await triggerUntilFailure(trigger, {
    expected: expectTrigger,
    label: faultId,
  })
  check(`${faultId} trigger produces the real failure`, expectTrigger(triggerRes), `status=${triggerRes.status}`)

  const scan = await scanIncidents(op)
  check(
    `${faultId} scan sees the ERROR log(s)`,
    (scan.json?.scanned ?? 0) >= 1,
    JSON.stringify(scan.json),
  )
  const created = scan.json?.created ?? []
  const merged = scan.json?.merged ?? 0
  check(
    `${faultId} created and/or merged an incident`,
    created.length >= 1 || merged >= 1,
    JSON.stringify({ created: created.length, merged }),
  )

  let incident = created[0] ?? null
  if (!incident) {
    // Accept ONLY incidents that opened after this cycle started — a leftover
    // open incident is not evidence of the just-activated fault.
    const open = await findOpenIncident(op, triggerMethod(faultId), triggerEndpoint(faultId), preOpenIds)
    if (open) incident = { id: open.id, ref: open.ref }
  }
  check(`${faultId} incident resolved for running`, !!incident?.id, `created=${created.length} merged=${merged}`)
  if (!incident?.id) {
    // The dev server did not recompile the faulted module. Clean up so later
    // cycles are not polluted, and fail loudly instead of repairing stale
    // incidents.
    await deactivateFault(op, faultId)
    return
  }

  const run = await op.post('/api/security/run', { incidentId: incident.id })
  check(
    `${faultId} engine reaches WAITING_APPROVAL or a terminal stage`,
    ['WAITING_APPROVAL', 'RESOLVED', 'ROLLED_BACK'].includes(run.json?.stage),
    `stage=${run.json?.stage} ${JSON.stringify(run.json)}`,
  )

  if (run.json?.stage === 'WAITING_APPROVAL') {
    check(
      `${faultId} ${run.json?.risk ?? 'elevated'} risk requires a human decision`,
      run.json.requiresApproval === true && !!run.json.approvalId,
      JSON.stringify(run.json),
    )
    const proceed = await op.post('/api/approvals/proceed', {
      approvalId: run.json.approvalId,
      action: 'proceed',
    })
    check(
      `${faultId} approval PROCEED applies + validates the patch`,
      proceed.json?.repair?.stage === 'RESOLVED',
      `stage=${proceed.json?.repair?.stage ?? proceed.json?.status} ${JSON.stringify(proceed.json)}`,
    )
  } else {
    check(`${faultId} engine stages the patch + validates`, run.json?.stage === 'RESOLVED', `stage=${run.json?.stage}`)
  }

  const detail = await op.get(`/api/incidents/${incident.id}`)
  const det = detail.json?.incident
  check(`${faultId} incident reached RESOLVED`, det?.status === 'RESOLVED', `status=${det?.status}`)
  check(`${faultId} repair attempt + patch recorded`, !!det?.repairAttempt && !!det?.patch, JSON.stringify({ attempt: det?.repairAttempt, patch: det?.patch }))
  check(
    `${faultId} real evidence captured (error + source file)`,
    (det?.description ?? '').includes(faultEvidenceMarker(faultId)),
    `description=${(det?.description ?? '').slice(0, 120)}`,
  )
  check(
    `${faultId} real evidence points at the real source file`,
    (det?.description ?? '').includes(faultEvidenceFile(faultId)),
    `description=${(det?.description ?? '').slice(0, 200)}`,
  )

  await verifyBehaviour(op)

  const after = await op.get('/api/faults')
  const fault = after.json?.faults?.find((f) => f.id === faultId)
  check(
    `${faultId} fault no longer active (file repaired, not leaked)`,
    fault?.active === false,
    `active=${fault?.active}`,
  )
}

const triggerMethod = (faultId) => (faultId === 'HIGH-01' ? 'POST' : faultId === 'MEDIUM-02' ? 'GET' : 'POST')
const triggerEndpoint = (faultId) => (faultId === 'HIGH-01' ? '/api/auth/login' : '/api/posts')

const faultEvidenceMarker = (faultId) =>
  faultId === 'LOW-01'
    ? 'PrismaClientValidationError'
    : faultId === 'MEDIUM-01' || faultId === 'MEDIUM-02'
      ? 'Injected'
      : 'Credentials verification subsystem failure'

const faultEvidenceFile = (faultId) => {
  if (faultId === 'HIGH-01') return 'app/api/auth/login/route.ts'
  return 'app/api/posts/route.ts'
}

/**
 * Re-runs `fn` until `pred` passes (dev-server recompile latency tolerance) or
 * `tries` attempts are exhausted; returns the last result.
 */
async function retryUntil(fn, pred, { tries = 8, waitMs = 1000 } = {}) {
  let res
  for (let i = 0; i < tries; i += 1) {
    res = await fn()
    if (pred(res)) return res
    await sleep(waitMs)
  }
  return res
}

/**
 * Nudges a source file with a harmless comment so Turbopack's watcher
 * re-compiles it from its CURRENT on-disk state. Turbopack occasionally
 * coalesces a fast activate→deactivate write pair into one (stale) compile;
 * this separate-process write forces the fresh state into the served module.
 */
const NUDGE_RE = /[ \t]*\/\/ bh-nudge-[0-9]+[ \t]*\n/g
const NUDGED_FILES = [
  'app/api/posts/[id]/route.ts',
  'lib/server/validation.ts',
  'app/api/projects/[id]/route.ts',
]
async function bumpFile(relativePath) {
  const abs = resolve(process.cwd(), relativePath)
  const src = readFileSync(abs, 'utf8').replace(NUDGE_RE, '')
  writeFileSync(abs, `${src.trimEnd()}\n// bh-nudge-${Date.now()}\n`)
  await sleep(1200)
}
async function stripNudges() {
  for (const rel of NUDGED_FILES) {
    try {
      const abs = resolve(process.cwd(), rel)
      const src = readFileSync(abs, 'utf8')
      const clean = src.replace(NUDGE_RE, '').trimEnd()
      if (clean !== src) writeFileSync(abs, `${clean}\n`)
    } catch {}
  }
}

async function behaviouralFaultChecks(op) {
  console.log('\n--- Behavioural (no-exception) faults: harness symptom only, NO incident ---')

  // LOW-02 — response-key typo on GET detail (returns 200, never throws).
  {
    await activateFault(op, 'LOW-02')
    await bumpFile('app/api/posts/[id]/route.ts')
    const created = await op.post('/api/posts', { content: 'LOW-02 verification post', tags: [] })
    const postId = created.json?.post?.id
    check('LOW-02 activate + create a normal post (POST unchanged)', created.status === 201 && !!postId, `status=${created.status}`)
    if (postId) {
      const faulted = await op.get(`/api/posts/${postId}`)
      check('LOW-02 GET detail renames post → poost', faulted.json?.poost !== undefined, `keys=${Object.keys(faulted.json ?? {})}`)
      await deactivateFault(op, 'LOW-02')
      await bumpFile('app/api/posts/[id]/route.ts')
      const restored = await retryUntil(
        () => op.get(`/api/posts/${postId}`),
        (r) => r.json?.post !== undefined && r.json?.poost === undefined,
      )
      check('LOW-02 restored GET detail returns `post` (not poost)', restored.json?.post !== undefined && restored.json?.poost === undefined, `keys=${Object.keys(restored.json ?? {})}`)
    }
  }

  // LOW-03 — validation minimum becomes impossible → 400, no exception.
  {
    await activateFault(op, 'LOW-03')
    await warmFor(op, 'LOW-03')
    await bumpFile('lib/server/validation.ts')
    const rejected = await retryUntil(
        () => op.post('/api/posts', { content: 'x', tags: [] }),
        (r) => r.status === 400,
      )
      check('LOW-03 short content rejected (400)', rejected.status === 400, `status=${rejected.status}`)
    await deactivateFault(op, 'LOW-03')
    await bumpFile('lib/server/validation.ts')
    const accepted = await op.post('/api/posts', { content: 'x', tags: [] })
    check('LOW-03 restored: short content accepted (201)', accepted.status === 201, `status=${accepted.status}`)
  }

  // MEDIUM-03 — ownership check inverted (no exception).
  {
    await activateFault(op, 'MEDIUM-03')
    await warmFor(op, 'MEDIUM-03')
    await bumpFile('app/api/projects/[id]/route.ts')
    const proj = await op.post('/api/projects', { name: `M03-${Date.now()}`, description: 'medium-03 check', status: 'ACTIVE' })
    const projectId = proj.json?.project?.id
    check('MEDIUM-03 create project', proj.status === 201 && !!projectId, `status=${proj.status}`)
    if (projectId) {
      const denied = await op.patch(`/api/projects/${projectId}`, { name: 'Owner update', description: 'owner edit', status: 'ACTIVE' })
      check('MEDIUM-03 owner incorrectly denied (403)', denied.status === 403, `status=${denied.status}`)
      await deactivateFault(op, 'MEDIUM-03')
      await bumpFile('app/api/projects/[id]/route.ts')
      const allowed = await op.patch(`/api/projects/${projectId}`, { name: 'Owner update', description: 'owner edit', status: 'ACTIVE' })
      check('MEDIUM-03 restored: owner can edit (200)', allowed.status === 200, `status=${allowed.status}`)
      await op.delete(`/api/projects/${projectId}`)
    }
  }

  // HIGH-02 — authorization guard disabled (no exception). Cross-user delete.
  {
    const meera = new Client()
    await meera.post('/api/auth/login', { identifier: 'meera', password: DEMO_PASSWORD })

    await activateFault(op, 'HIGH-02')
    await warmFor(op, 'HIGH-02')
    await bumpFile('app/api/projects/[id]/route.ts')
    const victim = await meera.post('/api/projects', { name: `H02-victim-${Date.now()}`, description: 'guard bypass check' })
    const victimId = victim.json?.project?.id
    check('HIGH-02 victim project created by meera', victim.status === 201 && !!victimId, `status=${victim.status}`)
    if (victimId) {
      const hijack = await op.delete(`/api/projects/${victimId}`)
      check('HIGH-02 guard OFF: arjun deletes meera project (200 bypass)', hijack.status === 200, `status=${hijack.status}`)
    }
    const gate = await createProjectAs(meera, 'H02-guarded')
    const gateId = gate?.id
    await deactivateFault(op, 'HIGH-02')
    await bumpFile('app/api/projects/[id]/route.ts')
    if (gateId) {
      const blocked = await op.delete(`/api/projects/${gateId}`)
      check('HIGH-02 restored: arjun cannot delete other user project (403)', blocked.status === 403, `status=${blocked.status}`)
      await meera.delete(`/api/projects/${gateId}`)
    }
  }

  // Confirm none of the behavioural faults produced an error-log incident.
  const scan = await scanIncidents(op)
  check(
    'Behavioural faults produced no new ERROR-log incident',
    (scan.json?.created ?? []).length === 0,
    JSON.stringify(scan.json),
  )
}

/** Creates a project for `client` and returns its id. */
async function createProjectAs(client, tag) {
  const res = await client.post('/api/projects', { name: `${tag}-${Date.now()}`, description: tag })
  return res.status === 201 ? { id: res.json?.project?.id } : null
}

function devPort() {
  try { return new URL(BASE).port || '3000' } catch { return '3000' }
}

async function restartDevServer() {
  const port = devPort()
  // Kill the running dev server for this port.
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
      // Hermetic TEST servers must NEVER send real email (see
      // verify-gmail-approval.mjs): blank only the refresh token.
      GMAIL_REFRESH_TOKEN: '',
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch {}
    await sleep(1000)
  }
  return false
}

async function run() {
  const op = new Client()
  console.log('# Phase 9 Self-Healing Verification (real runtime loop)')

  console.log('\nAuthentication')
  const login = await op.post('/api/auth/login', OPERATOR)
  check('Operator login arjun → 200', login.status === 200, `status=${login.status}`)
  if (login.status !== 200) throw new Error('Cannot login — aborting')

  // Open incidents existing before the run begin — later cycles must never
  // treat these as evidence of a just-activated fault.
  const preOpen = new Set()
  for (const candidate of await openIncidentIds(op)) preOpen.add(candidate)

  console.log('\nCleanup: deactivate any leftover faults')
  const cleanup = await op.post('/api/faults', { action: 'deactivate-all' })
  check('Deactivate all faults → 200', cleanup.status === 200, `status=${cleanup.status}`)

  console.log('\nFault Injection API')
  const faultsList = await op.get('/api/faults')
  check('GET /api/faults → 200 + enabled', faultsList.status === 200 && faultsList.json?.enabled === true, `status=${faultsList.status} enabled=${faultsList.json?.enabled}`)
  check('11 faults registered', faultsList.json?.total === 11, `got ${faultsList.json?.total}`)
  for (const id of ['LOW-01', 'LOW-02', 'LOW-03', 'MEDIUM-01', 'MEDIUM-02', 'MEDIUM-03', 'HIGH-01', 'HIGH-02', 'HIGH-03']) {
    const fault = faultsList.json?.faults?.find((f) => f.id === id)
    check(`Fault registry has ${id}`, !!fault, 'not found')
    if (fault) {
      check(`${id} risk level`, fault.severity === (id.startsWith('LOW') ? 'LOW' : id.startsWith('MEDIUM') ? 'MEDIUM' : 'HIGH'), `got ${fault.severity}`)
      check(`${id} starts inactive`, fault.active === false, `active=${fault.active}`)
    }
  }

  console.log('\n=== Real failure → incident → engine (crash faults) ===')

  await crashFaultCycle(op, preOpen, {
    faultId: 'LOW-01',
    trigger: () => op.post('/api/posts', { content: `LOW-01 trigger ${Date.now()}`, tags: [] }),
    expectTrigger: (res) => res.status === 500,
    verifyBehaviour: async (client) => {
      const created = await client.post('/api/posts', { content: `LOW-01 verified ${Date.now()}`, tags: [] })
      check('LOW-01 repaired: post creation works (201)', created.status === 201, `status=${created.status}`)
    },
  })

  await crashFaultCycle(op, preOpen, {
    faultId: 'MEDIUM-01',
    trigger: () => op.post('/api/posts', { content: `MEDIUM-01 trigger ${Date.now()}`, tags: [] }),
    expectTrigger: (res) => res.status === 500,
    verifyBehaviour: async (client) => {
      const created = await client.post('/api/posts', { content: `MEDIUM-01 verified ${Date.now()}`, tags: [] })
      check('MEDIUM-01 repaired: post creation works (201)', created.status === 201, `status=${created.status}`)
    },
  })

  await crashFaultCycle(op, preOpen, {
    faultId: 'MEDIUM-02',
    trigger: () => op.get('/api/posts?pageSize=3'),
    expectTrigger: (res) => res.status === 500,
    verifyBehaviour: async (client) => {
      const feed = await client.get('/api/posts?pageSize=3')
      check('MEDIUM-02 repaired: feed loads (200 + posts)', feed.status === 200 && Array.isArray(feed.json?.posts), `status=${feed.status}`)
    },
  })

  await crashFaultCycle(op, preOpen, {
    faultId: 'HIGH-01',
    trigger: () => op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' }),
    expectTrigger: (res) => res.status === 500,
    verifyBehaviour: async (client) => {
      const wrong = await client.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' })
      check('HIGH-01 repaired: wrong password → 401', wrong.status === 401, `status=${wrong.status}`)
      const right = await client.post('/api/auth/login', { identifier: 'arjun', password: DEMO_PASSWORD })
      check('HIGH-01 repaired: correct password → 200', right.status === 200, `status=${right.status}`)
    },
  })

  // Merge check (one extra failure while the incident is still OPEN).
  console.log('\n=== Merge behaviour ===')
  await sleep(2000)
  await warmFor(op, 'LOW-01')
  await activateFault(op, 'LOW-01')
  await sleep(2000)
  await warmFor(op, 'LOW-01')
  const preMergeOpen = new Set(await openIncidentIds(op))
  const mergeTrigger = async () => {
    const res = await triggerUntilFailure(() => op.post('/api/posts', { content: `MERGE trigger ${Date.now()}`, tags: [] }), {
      expected: (r) => r.status === 500,
    })
    return res
  }
  await mergeTrigger()
  await mergeTrigger()
  const mergeScan = await scanIncidents(op)
  const mergeNew = (mergeScan.json?.created ?? []).filter((c) => !preOpen.has(c.id) && !preMergeOpen.has(c.id))
  check(
    'Two identical failures consolidate into ONE incident (created=1 or merged)',
    (mergeScan.json?.created?.length ?? 0) === 1 || (mergeScan.json?.merged ?? 0) >= 1,
    JSON.stringify(mergeScan.json),
  )
  const mergedIncident = mergeNew.length > 0
    ? mergeNew[mergeNew.length - 1]
    : (mergeScan.json?.created ?? [])[0] ?? null
  if (mergedIncident) {
    const runMerged = await op.post('/api/security/run', { incidentId: mergedIncident.id })
    check('Merged incident also repairs (RESOLVED)', runMerged.json?.stage === 'RESOLVED', `stage=${runMerged.json?.stage}`)
  }
  await op.post('/api/faults', { action: 'deactivate-all' })
  const faultsFinal = await op.get('/api/faults')
  check('All faults clean after merge block', (faultsFinal.json?.active ?? 0) === 0, `active=${faultsFinal.json?.active}`)

  // Turbopack dev recompile of repeatedly-rewritten route files drifts into a
  // stale state. Restart the dev server so every module compiles fresh from
  // current on-disk state before the harness-only behavioural checks.
  console.log('\n--- restarting dev server for clean compilation slate ---')
  check('dev server restarted', await restartDevServer(), 'restartTimedOut')
  const relogin = await op.post('/api/auth/login', OPERATOR)
  check('post-restart login arjun → 200', relogin.status === 200, `status=${relogin.status}`)

  console.log('\n=== Behavioural (non-crash) faults ===')
  await behaviouralFaultChecks(op)

  const allClean = await op.get('/api/faults')
  check('Final: no active faults (all repaired or restored)', (allClean.json?.active ?? 0) === 0, `active=${allClean.json?.active}`)

  await stripNudges()

  console.log('\n' + '='.repeat(52))
  console.log(`Self-Healing verification: ${passed} passed, ${failed} failed`)
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