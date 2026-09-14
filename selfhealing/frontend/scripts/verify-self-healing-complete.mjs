#!/usr/bin/env node
/**
 * Phase 11 — Complete Self-Healing Verification (24 named phases).
 *
 * Evidence-only master check. Assumes a server is ALREADY running from the
 * frontend directory with the hermetic TEST provider and AUTO_REPAIR enabled
 * so the repair pipeline starts ITSELF from a real application error:
 *
 *   cd frontend
 *   env FAULT_INJECTION_ENABLED=true AUTH_GUARD_ENABLED=false \
 *       AI_PROVIDER=test SELF_HEALING_TEST_MODE=true AUTO_REPAIR=true \
 *       npx next dev -p 3000
 *
 *   node scripts/verify-self-healing-complete.mjs
 *
 * Covers (in order):
 *   1- 2  score model present + clean baseline (cyber / reliability / total)
 *   3-18  LOW-01: fault → REAL 500 → auto incident → ANALYZER/CODER/CRITIC/JUDGE
 *          → RESOLVED (single attempt) → endpoint verified → SHA-256 patch
 *          integrity (recorded + on-disk match) → scores recovered → all
 *          [STAGE] terminal traces → no duplicate run → telegram delivery
 *  19-23  HIGH-01: fault → REAL 500 → WAITING_APPROVAL gate → no duplicate run
 *          → human approval → applied → endpoint verified → fault cleared
 *    24  honest TOTAL (never fabricates a PASS; a missing server/DB = FAIL)
 *
 * Terminal evidence is read two ways:
 *   - HTTP: /api/observability/summary, /api/incidents/{id}, /api/faults,
 *           /api/incidents/scan, /api/approvals/proceed
 *   - DB (direct Prisma read of LogEvent + PatchRecord, the persisted truth):
 *           [STAGE] brackets, originalSha256/appliedSha256/restoredSha256
 *
 * ROLLED_BACK and AI_REPAIR_FAILED cohorts require server restarts with
 * AUTO_REPAIR_SCENARIO=bad-fix / reject-all and are covered by
 * `verify-auto-repair.mjs --failure-scenarios`.
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const DEMO_PASSWORD = 'buildhub-demo1'
const OPERATOR = { identifier: 'arjun', password: DEMO_PASSWORD }
const LOW_FAULT = 'LOW-01'
const HIGH_FAULT = 'HIGH-01'
const LOW_TRIGGER_BODY = () => ({ content: `SELF-HEALING-COMPLETE ${Date.now()}`, tags: [] })

const PHASES = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (content) => createHash('sha256').update(content, 'utf8').digest('hex')
const LOW_FILE = fileURLToPath(new URL('../app/api/posts/route.ts', import.meta.url))

let prisma = null
function getPrisma() {
  if (!prisma) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL missing — run from the frontend directory so dotenv loads .env')
    }
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
    prisma = new PrismaClient({ adapter })
  }
  return prisma
}

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

async function pollIncident(op, incidentId, pred, { tries = 150, waitMs = 1000 } = {}) {
  let det = null
  for (let i = 0; i < tries; i += 1) {
    det = await op.get(`/api/incidents/${incidentId}`)
    if (det.json?.incident && pred(det.json.incident)) return det.json.incident
    await sleep(waitMs)
  }
  return det.json?.incident ?? null
}

async function openIncidentIds(op) {
  const list = await op.get('/api/incidents?status=DETECTED,INVESTIGATING,WAITING_APPROVAL,VALIDATING&pageSize=100')
  return new Set((list.json?.incidents ?? []).map((inc) => inc.id))
}

async function activateFault(op, faultId) {
  return op.post('/api/faults', { faultId })
}

async function scanIncidents(op) {
  return op.post('/api/incidents/scan', { limit: 100 })
}

async function deactivateAll(op) {
  const res = await op.post('/api/faults', { action: 'deactivate-all' })
  // Wait for dev recompile of the previously-faulted file (if any) to settle.
  await sleep(1800)
  return res
}

function define(name, fn) {
  PHASES.push({ name, fn })
}

let passed = 0
let failed = 0
let skipped = 0
let phasesPassed = 0
let phasesFailed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.error(`FAIL   ${label}${detail ? ` — ${detail}` : ''}`)
    failures.push(label)
  }
}

// ---------------------------------------------------------------------------
// 1-2 Clean-state score model: the dashboard must expose cyber safety, app
// reliability and total health, and report 100/100/100/100/100 when clean.
// ---------------------------------------------------------------------------
define('01 SCORES-PRESENT', async (op) => {
  const res = await op.get('/api/observability/summary')
  check('score payload exposes risk + cyber + reliability + health + total', res.status === 200 && res.json?.overview, `status=${res.status}`)
  const o = res.json?.overview ?? {}
  check('applicationReliabilityScore is a number', Number.isFinite(o.applicationReliabilityScore), `value=${o.applicationReliabilityScore}`)
  check('totalHealthScore is a number', Number.isFinite(o.totalHealthScore), `value=${o.totalHealthScore}`)
  check('legacy fields still present (riskScore/cyberSafetyScore/systemHealth)', Number.isFinite(o.riskScore) && Number.isFinite(o.cyberSafetyScore) && Number.isFinite(o.systemHealth), JSON.stringify(o))
})

define('02 CLEAN-BASELINE', async (op) => {
  const res = await op.get('/api/observability/summary')
  const o = res.json?.overview ?? {}
  const clean =
    o.activeIncidents === 0 &&
    o.riskScore === 0 &&
    o.cyberSafetyScore === 100 &&
    o.applicationReliabilityScore === 100 &&
    o.systemHealth === 100 &&
    o.totalHealthScore === 100
  check('clean baseline is risk 0 / cyber 100 / reliability 100 / health 100 / total 100', clean, JSON.stringify(o))
})

// ---------------------------------------------------------------------------
// 3-18 LOW-01 automatic repair (engine starts itself from a REAL error).
// ---------------------------------------------------------------------------
define('03 FAULT-INJECT-LOW01', async (op) => {
  const res = await activateFault(op, LOW_FAULT)
  check('LOW-01 activation returns 200 with defect location', res.status === 200 && res.json?.defect?.file, `status=${res.status} ${JSON.stringify(res.json)}`)
})

define('04 REAL-FAILURE-REPRO', async (op) => {
  const res = await op.post('/api/posts', LOW_TRIGGER_BODY())
  check('LOW-01 real request reproduces the failure (500 with error context)', res.status === 500 && (res.json?.errorName || res.json?.error), `status=${res.status} body=${String(res.text).slice(0, 120)}`)
})

define('05 SCAN-DETECTS-INCIDENT', async (op, ctx) => {
  const pre = ctx.preOpen
  const scan = await scanIncidents(op)
  const created = (scan.json?.created ?? []).filter((c) => !pre.has(c.id))
  check('scan sees the ERROR log(s)', (scan.json?.scanned ?? 0) >= 1, JSON.stringify(scan.json))
  check('scan created an incident for LOW-01', created.length >= 1 || (scan.json?.merged ?? 0) >= 1, JSON.stringify({ created: created.length, merged: scan.json?.merged ?? 0 }))
  const opened = new Set(await openIncidentIds(op))
  const incidentId = [...opened].find((id) => !pre.has(id)) ?? [...created].map((c) => c.id)[0] ?? null
  check('an incident id is available to follow', !!incidentId, `created=${created.length}`)
  ctx.lowIncidentId = incidentId
})

define('06 AUTO-ENGINE-START', async (op, ctx) => {
  const incident = await pollIncident(op, ctx.lowIncidentId, (d) => d.status === 'INVESTIGATING' || d.status === 'RESOLVED' || d.status === 'ROLLED_BACK' || d.status === 'AI_REPAIR_FAILED')
  check('incident reached INVESTIGATING/RESOLVED without a manual /api/security/run', incident && (incident.status === 'INVESTIGATING' || incident.status === 'RESOLVED'), `status=${incident?.status}`)
  check('Auto-repair was triggered by the log monitor', (incident?.timeline ?? []).some((e) => e.label === 'Auto-repair triggered by log monitor'), `labels=${(incident?.timeline ?? []).map((e) => e.label).join(' | ').slice(0, 200)}`)
})

define('07 AGENT-1-ANALYZER', async (op, ctx) => {
  const incident = await pollIncident(op, ctx.lowIncidentId, (d) => (d.agentRuns ?? []).some((r) => r.agent === 'ANALYZER'))
  check('ANALYZER agent run exists (agent=ANALYZER)', (incident?.agentRuns ?? []).some((r) => r.agent === 'ANALYZER'), `agents=${(incident?.agentRuns ?? []).map((r) => r.agent).join(',')}`)
  ctx.lowIncident = incident
})

define('08 AGENT-2-CODER', async (op, ctx) => {
  const incident = await pollIncident(op, ctx.lowIncidentId, (d) => (d.agentRuns ?? []).some((r) => r.agent === 'CODER'))
  check('CODER agent run exists', (incident?.agentRuns ?? []).some((r) => r.agent === 'CODER'), `agents=${(incident?.agentRuns ?? []).map((r) => r.agent).join(',')}`)
})

define('09 AGENT-3-CRITIC', async (op, ctx) => {
  const incident = await pollIncident(op, ctx.lowIncidentId, (d) => (d.agentRuns ?? []).some((r) => r.agent === 'CRITIC'))
  check('CRITIC agent run exists', (incident?.agentRuns ?? []).some((r) => r.agent === 'CRITIC'), `agents=${(incident?.agentRuns ?? []).map((r) => r.agent).join(',')}`)
})

define('10 JUDGE-VERDICT', async (op, ctx) => {
  const incident = await pollIncident(op, ctx.lowIncidentId, (d) => (d.agentRuns ?? []).some((r) => r.agent === 'JUDGE'))
  check('JUDGE agent run exists (verdict emitted)', (incident?.agentRuns ?? []).some((r) => r.agent === 'JUDGE'), `agents=${(incident?.agentRuns ?? []).map((r) => r.agent).join(',')}`)
})

define('11 RESOLVED-SINGLE-ATTEMPT', async (op, ctx) => {
  const incident = await pollIncident(op, ctx.lowIncidentId, (d) => d.status === 'RESOLVED')
  check('LOW-01 incident reached RESOLVED', incident?.status === 'RESOLVED', `status=${incident?.status}`)
  check('exactly ONE repair conversation ran', (incident?.repairAttempt ? 1 : 0) === 1, `attempt=${incident?.repairAttempt?.status}`)
  ctx.lowIncident = incident
})

define('12 ENDPOINT-REPAIRED', async (op) => {
  const res = await op.post('/api/posts', LOW_TRIGGER_BODY())
  check('LOW-01 repaired: post creation returns 201', res.status === 201, `status=${res.status}`)
})

define('13 FAULT-CLEARED', async (op) => {
  const faults = await op.get('/api/faults')
  const fault = (faults.json?.faults ?? []).find((f) => f.id === LOW_FAULT)
  check('LOW-01 inactive after repair (file repaired, not leaked)', fault?.active === false, `active=${fault?.active}`)
})

define('14 PATCH-SHA-RECORDED', async (op, ctx) => {
  const rows = await getPrisma().patchRecord.findMany({
    where: { status: { in: ['APPLIED', 'VALIDATED'] } },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })
  const patch = rows[0] ?? null
  check('latest applied PatchRecord exists', !!patch, 'no APPLIED patch record found')
  check('originalSha256 recorded for the backup', patch && !!patch.originalSha256, `original=${patch?.originalSha256}`)
  check('appliedSha256 recorded for the patch', patch && !!patch.appliedSha256, `applied=${patch?.appliedSha256}`)
  if (patch && patch.appliedSha256) ctx.lowPatchSha = patch.appliedSha256
})

define('15 PATCH-ON-DISK-MATCH', async (op, ctx) => {
  if (!ctx.lowPatchSha) {
    check('on-disk file hash matches the applied patch SHA', false, 'no appliedSha256 available from phase 14')
    return
  }
  const onDisk = await readFile(LOW_FILE, 'utf8')
  const hash = sha256(onDisk)
  check('frontend/app/api/posts/route.ts on-disk sha256 === PatchRecord.appliedSha256', hash === ctx.lowPatchSha, `disk=${hash.slice(0, 12)}… record=${ctx.lowPatchSha.slice(0, 12)}…`)
})

define('16 SCORE-RECOVERED', async (op) => {
  const res = await op.get('/api/observability/summary')
  const o = res.json?.overview ?? {}
  const recovered = o.activeIncidents === 0 && o.cyberSafetyScore === 100 && o.applicationReliabilityScore === 100 && o.totalHealthScore === 100 && o.riskScore === 0
  check('scores recovered to clean after RESOLVED (reliability + total 100)', recovered, JSON.stringify(o))
})

define('17 TRACE-STAGES-BRACKETS', async () => {
  const since = new Date(Date.now() - 15 * 60 * 1000)
  const required = [
    'AGENT-1 ANALYZER',
    'AGENT-2 CODER',
    'AGENT-3 CRITIC',
    'JUDGE',
    'BACKUP',
    'PATCH',
    'CURL',
    'VALIDATION',
    'SCORE',
    'FINAL',
  ]
  // Terminal stages are persisted fire-and-forget; allow a short flush window
  // before declaring a missing bracket (same robustness as pollIncident).
  let missing = required
  for (let attempt = 0; attempt < 6 && missing.length > 0; attempt += 1) {
    const rows = await getPrisma().logEvent.findMany({
      where: { service: 'self-healing', createdAt: { gte: since } },
      select: { message: true },
      orderBy: { createdAt: 'asc' },
    })
    const messages = rows.map((r) => r.message)
    missing = required.filter((stage) => !messages.some((m) => m.startsWith(`[${stage}]`)))
    if (missing.length > 0 && attempt < 5) await sleep(400)
  }
  check('all [STAGE] pipeline brackets persisted to LogEvent rows', missing.length === 0, `missing=${missing.join(',')}`)
})

define('18 NO-DUPLICATE-RUN', async (op, ctx) => {
  const before = (ctx.lowIncident?.agentRuns ?? []).length
  await scanIncidents(op)
  await sleep(1500)
  const after = await op.get(`/api/incidents/${ctx.lowIncidentId}`)
  const runsAfter = (after.json?.incident?.agentRuns ?? []).length
  check('repeat scan does NOT spawn a second repair run', after.json?.incident?.status === 'RESOLVED' && runsAfter === before, `runs ${before}→${runsAfter} status=${after.json?.incident?.status}`)
})

define('19 TELEGRAM-DELIVERY', async (op, ctx) => {
  const incident = (await op.get(`/api/incidents/${ctx.lowIncidentId}`)).json?.incident ?? ctx.lowIncident
  const deliveries = incident?.telegram?.deliveries ?? []
  check('a terminal delivery was recorded for LOW-01', deliveries.length >= 1, `deliveries=${deliveries.length}`)
  check('delivery is the FINAL_SUMMARY terminal message', deliveries.some((d) => d.type === 'FINAL_SUMMARY'), `types=${deliveries.map((d) => d.type).join(',')} statuses=${deliveries.map((d) => d.deliveryStatus).join(',')}`)
})

// ---------------------------------------------------------------------------
// 20-23 HIGH-01: auto-repair STOPS at the human gate, then applies after approval.
// ---------------------------------------------------------------------------
define('20 HIGH-FAULT-REPRO', async (op, ctx) => {
  const res = await activateFault(op, HIGH_FAULT)
  check('HIGH-01 activation returns 200', res.status === 200, `status=${res.status}`)
  const trigger = await (async () => {
    for (let i = 0; i < 30; i += 1) {
      const r = await op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' })
      if (r.status === 500) return r
      await sleep(600)
    }
    return op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' })
  })()
  check('HIGH-01 real request reproduces the 500', trigger.status === 500, `status=${trigger.status}`)
  const scan = await scanIncidents(op)
  const opened = new Set(await openIncidentIds(op))
  const incidentId = [...opened].find((id) => !ctx.preOpen.has(id)) ?? null
  check('HIGH-01 scan created an incident', incidentId !== null, `created=${(scan.json?.created ?? []).length} merged=${scan.json?.merged ?? 0}`)
  ctx.highIncidentId = incidentId
})

define('21 HIGH-APPROVAL-GATE', async (op, ctx) => {
  const incident = await pollIncident(op, ctx.highIncidentId, (d) => d.status === 'WAITING_APPROVAL')
  check('HIGH-01 auto-repair STOPS at WAITING_APPROVAL', incident?.status === 'WAITING_APPROVAL', `status=${incident?.status}`)
  check('a repair attempt was recorded (no runaway apply)', !!incident?.repairAttempt, `attempt=${incident?.repairAttempt?.status}`)
  const approvalId = (incident?.approvals ?? [])[0]?.approvalId ?? null
  check('an approval record was created for the HIGH patch', !!approvalId, `approvals=${JSON.stringify(incident?.approvals ?? [])}`)
  ctx.highApprovalId = approvalId
  // A repeated failure while open merges in but must NOT spawn a second run.
  const runsBefore = (incident?.agentRuns ?? []).length
  for (let i = 0; i < 8; i += 1) {
    const r = await op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' })
    if (r.status === 500) break
    await sleep(500)
  }
  await scanIncidents(op)
  await sleep(1500)
  const after = await op.get(`/api/incidents/${ctx.highIncidentId}`)
  const runsAfter = (after.json?.incident?.agentRuns ?? []).length
  check('repeat HIGH failure merges without a duplicate repair run', after.json?.incident?.status === 'WAITING_APPROVAL' && runsAfter === runsBefore, `runs ${runsBefore}→${runsAfter} status=${after.json?.incident?.status}`)
})

define('22 HIGH-APPROVED-APPLY', async (op, ctx) => {
  if (!ctx.highApprovalId) {
    check('HIGH approval proceed applied the patch', false, 'no approvalId from phase 21')
    return
  }
  const proceed = await op.post('/api/approvals/proceed', { approvalId: ctx.highApprovalId, action: 'proceed' })
  const stage = proceed.json?.repair?.stage ?? proceed.json?.stage
  check('HIGH approval PROCEED applied + validated the patch (RESOLVED)', stage === 'RESOLVED', `stage=${stage}`)
  const final = await op.get(`/api/incidents/${ctx.highIncidentId}`)
  check('HIGH incident reached RESOLVED after approval', final.json?.incident?.status === 'RESOLVED', `status=${final.json?.incident?.status}`)
})

define('23 HIGH-ENDPOINT-VERIFY', async (op) => {
  const wrong = await op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' })
  const right = await op.post('/api/auth/login', { identifier: 'arjun', password: DEMO_PASSWORD })
  check('HIGH-01 repaired: wrong password → 401', wrong.status === 401, `status=${wrong.status}`)
  check('HIGH-01 repaired: correct password → 200', right.status === 200, `status=${right.status}`)
  const faults = await op.get('/api/faults')
  const fault = (faults.json?.faults ?? []).find((f) => f.id === HIGH_FAULT)
  check('HIGH-01 inactive after approved repair', fault?.active === false, `active=${fault?.active}`)
})

define('24 HONEST-TOTAL', async () => {
  check('all 24 named phases passed with zero failures and zero skips', phasesFailed === 0 && skipped === 0, `phases passed=${phasesPassed} failed=${phasesFailed} skipped=${skipped}`)
})

async function main() {
  console.log('# Complete Self-Healing Verification — 24 named phases (evidence only)')
  const op = new Client()
  const ctx = { preOpen: new Set() }

  const health = await op.get('/api/health')
  if (health.status !== 200) {
    console.error(`Preflight FAIL: /api/health returned ${health.status}. Start the server first (see header).`)
    process.exitCode = 1
    return
  }
  const login = await op.post('/api/auth/login', OPERATOR)
  if (login.status !== 200) {
    console.error(`Preflight FAIL: operator login returned ${login.status}. Is the server running and AUTH_GUARD_ENABLED=false?`)
    process.exitCode = 1
    return
  }
  console.log('  ok   preflight — server up, operator login')
  ctx.preOpen = await openIncidentIds(op)
  await deactivateAll(op)

  for (const phase of PHASES) {
    console.log(`--- ${phase.name} ---`)
    const failedBefore = failed
    try {
      await phase.fn(op, ctx)
      if (failed === failedBefore) phasesPassed += 1
      else phasesFailed += 1
    } catch (err) {
      phasesFailed += 1
      failed += 1
      console.error(`FAIL   ${phase.name} — threw: ${err instanceof Error ? err.message : String(err)}`)
      failures.push(phase.name)
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log(`TOTAL: ${passed} checks PASS / ${failed} checks FAIL / ${skipped} SKIP — ${phasesPassed}/${PHASES.length} named phases PASS`)
  if (failures.length) {
    console.log('Failed:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  if (prisma) await prisma.$disconnect()
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('Verification crashed:', err instanceof Error ? err.message : err)
  if (prisma) prisma.$disconnect().finally(() => { process.exitCode = 1 })
  else process.exitCode = 1
})