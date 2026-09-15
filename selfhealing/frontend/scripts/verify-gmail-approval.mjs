#!/usr/bin/env node
/**
 * Phase 12 — Gmail approval + FINAL risk-policy verification (TEST mode).
 *
 * Proves, against a hermetic TEST-mode server (no Groq calls, no real email),
 * the complete FINAL-policy loop:
 *
 *   LOW    → auto-apply, no approval, FINAL email, +50 reward
 *   MEDIUM → WAITING_FOR_APPROVAL, Gmail+Telegram approval request, one-click
 *            APPROVE → apply → validate → RESOLVED (+90), or one-click REJECT
 *            → no patch, reward 0; expiry/invalid/replay handled honestly
 *   HIGH   → detailed approval email (14 sections), one-click APPROVE → RESOLVED
 *   bad-fix→ ROLLED_BACK with negative reward; recurrence → regression penalty
 *
 * Gmail has no credentials in TEST, so every Gmail assertion is about HONESTY:
 * rows persist as FAILED naming the missing variable, and zero rows are SENT.
 * (With credentials configured the same code path delivers via the Gmail API;
 * the SENT contract is asserted by test-incident-briefing check 18.)
 *
 * Server requirements (started by this script on BASE_URL's port):
 *     FAULT_INJECTION_ENABLED=true AUTH_GUARD_ENABLED=false
 *     AI_PROVIDER=test SELF_HEALING_TEST_MODE=true AUTO_REPAIR=false
 *
 * Run:
 *     node scripts/verify-gmail-approval.mjs
 *     BASE_URL=http://localhost:3100 node scripts/verify-gmail-approval.mjs
 */

import { spawn, execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'

const CWD = dirname(fileURLToPath(import.meta.url))
const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const OPERATOR = { identifier: 'arjun', password: 'buildhub-demo1' }

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
  async function req(method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders }
    if (cookie) headers.Cookie = cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    })
    const setCookie = res.headers.get('set-cookie')
    const m = setCookie && setCookie.match(/buildhub_session=[^;]+/)
    if (m) cookie = m[0]
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    return { status: res.status, json, text }
  }
  return {
    get: (p, h) => req('GET', p, undefined, h),
    post: (p, b) => req('POST', p, b),
  }
}

function devPort() {
  try { return new URL(BASE).port || '3000' } catch { return '3000' }
}

async function restartTestServer(extraEnv = {}) {
  const port = devPort()
  try {
    const pids = execSync(`ss -ltnp 2>/dev/null | grep ':${port} ' | grep -o 'pid=[0-9]*' | cut -d= -f2`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM') } catch {}
    }
  } catch {}
  for (let i = 0; i < 20; i += 1) {
    let busy = true
    try { execSync(`ss -ltn 2>/dev/null | grep ':${port} '`) } catch { busy = false }
    if (!busy) break
    await sleep(500)
  }
  const child = spawn('npx', ['next', 'dev', '-p', port], {
    cwd: resolve(CWD, '..'),
    env: {
      ...process.env,
      SELF_HEALING_TEST_MODE: 'true',
      AI_PROVIDER: 'test',
      FAULT_INJECTION_ENABLED: 'true',
      AUTH_GUARD_ENABLED: 'false',
      AUTO_REPAIR: 'false',
      // Hermetic TEST servers must NEVER send real email: blank only the
      // refresh token (client/sender stay, so honesty rows still name the
      // exact missing variable). Production .env keeps the real token.
      GMAIL_REFRESH_TOKEN: '',
      ...extraEnv,
    },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return true
    } catch {}
    await sleep(1000)
  }
  return false
}

async function stopTestServer() {
  const port = devPort()
  try {
    const pids = execSync(`ss -ltnp 2>/dev/null | grep ':${port} ' | grep -o 'pid=[0-9]*' | cut -d= -f2`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean)
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM') } catch {}
    }
  } catch {}
}

function loadEnv() {
  const vars = {}
  const p = resolve(CWD, '../.env')
  if (!existsSync(p)) return vars
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const clean = line.trim()
    if (!clean || clean.startsWith('#')) continue
    const eq = clean.indexOf('=')
    if (eq === -1) continue
    let value = clean.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    vars[clean.slice(0, eq).trim()] = value
  }
  return vars
}

async function openPrisma(env) {
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
  return new PrismaClient({ adapter })
}

let prisma = null

async function gmailMessage(incidentId, type) {
  if (!prisma) return ''
  const row = await prisma.gmailNotification.findFirst({
    where: { incidentId, type, deliveryStatus: { not: 'SKIPPED_DUPLICATE' } },
    orderBy: { createdAt: 'desc' },
    select: { message: true },
  })
  return row?.message ?? ''
}

// --- shared flow helpers ----------------------------------------------------

async function activateFault(op, faultId, action = 'activate') {
  return op.post('/api/faults', { faultId, action })
}

async function triggerPost(op, label) {
  return op.post('/api/posts', { content: `${label} ${Date.now()}`, tags: [] })
}

async function scan(op) {
  return op.post('/api/incidents/scan', { limit: 200 })
}

async function openIncidentIds(op) {
  const res = await op.get('/api/incidents?status=DETECTED,INVESTIGATING,AWAITING_REVIEW,WAITING_APPROVAL,VALIDATING&pageSize=100')
  return new Set((res.json?.incidents ?? []).map((i) => i.id))
}

async function incidentDetail(op, id) {
  const res = await op.get(`/api/incidents/${id}`)
  return res.json?.incident ?? null
}

async function faultActive(op, faultId) {
  const res = await op.get('/api/faults')
  return (res.json?.faults ?? []).find((f) => f.id === faultId)?.active === true
}

async function memoryFor(op, ref) {
  const res = await op.get('/api/ai/memory')
  return (res.json?.memories ?? []).find((m) => m.incidentRef === ref) ?? null
}

function gmailOf(detail, type) {
  return (detail?.gmail?.deliveries ?? []).filter((d) => d.type === type)
}

function telegramOf(detail, type) {
  return (detail?.telegram?.deliveries ?? []).filter((d) => d.type === type)
}

/** Full fault → incident cycle; returns { incidentId } (null when no incident). */
async function faultCycle(op, preOpen, faultId, label) {
  await activateFault(op, faultId)
  await sleep(1500)
  let trigger = await triggerPost(op, label)
  if (trigger.status !== 500) {
    // One retry for dev-server compile latency, then report honestly.
    await sleep(2500)
    trigger = await triggerPost(op, label)
  }
  if (trigger.status !== 500) return { incidentId: null, triggerStatus: trigger.status }
  return { incidentId: await incidentAfterScan(op, preOpen) }
}

async function incidentAfterScan(op, preOpen) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const s = await scan(op)
    const created = (s.json?.created ?? []).filter((c) => !preOpen.has(c.id))
    if (created.length > 0) return created[created.length - 1].id
    await sleep(1500)
  }
  const open = await openIncidentIds(op)
  for (const id of open) if (!preOpen.has(id)) return id
  return null
}

// --- cohorts ------------------------------------------------------------------

async function cohortLow(op, preOpen) {
  console.log('\n=== Cohort LOW: autonomous repair, no approval, honest Gmail ===')
  const { incidentId } = await faultCycle(op, preOpen, 'LOW-01', 'LOW coh')
  check('LOW incident created', !!incidentId, `id=${incidentId}`)
  if (!incidentId) return null
  const run = await op.post('/api/security/run', { incidentId })
  check('LOW run → RESOLVED automatically', run.json?.stage === 'RESOLVED', `stage=${run.json?.stage}`)
  check('LOW requires no approval', run.json?.requiresApproval === false && !run.json?.approvalId, JSON.stringify({ a: run.json?.requiresApproval, id: run.json?.approvalId }))
  check('LOW risk classified LOW', run.json?.risk === 'LOW', `risk=${run.json?.risk}`)
  const detail = await incidentDetail(op, incidentId)
  check('LOW incident RESOLVED', detail?.status === 'RESOLVED', `status=${detail?.status}`)
  check('LOW fault inactive (runtime restored)', !(await faultActive(op, 'LOW-01')), 'still active')
  const verify = await triggerPost(op, 'LOW verify')
  check('LOW post works after repair (201)', verify.status === 201, `status=${verify.status}`)

  // Gmail honesty (no credentials in TEST): FINAL attempted + FAILED with the
  // missing variable named, zero SENT, zero approval requests.
  const finals = gmailOf(detail, 'FINAL_SUMMARY')
  check('LOW FINAL_SUMMARY Gmail attempted once', finals.length === 1, `count=${finals.length}`)
  check('LOW Gmail honestly FAILED (unconfigured)', finals[0]?.deliveryStatus === 'FAILED', `status=${finals[0]?.deliveryStatus}`)
  check('LOW Gmail names the missing variable', (finals[0]?.error ?? '').includes('GMAIL_REFRESH_TOKEN'), `error=${finals[0]?.error}`)
  const allGmail = detail?.gmail?.deliveries ?? []
  check('LOW zero SENT Gmail rows (no fake delivery)', allGmail.every((d) => d.deliveryStatus !== 'SENT'), JSON.stringify(allGmail.map((d) => d.deliveryStatus)))
  check('LOW no approval email sent', gmailOf(detail, 'MEDIUM_RISK_APPROVAL_REQUIRED').length === 0 && gmailOf(detail, 'HIGH_RISK_APPROVAL_REQUIRED').length === 0, 'approval email present')

  // Learning: +50 outcome-only reward with breakdown.
  const mem = await memoryFor(op, detail.ref)
  check('LOW memory recorded (RESOLVED)', mem?.outcome === 'RESOLVED', `outcome=${mem?.outcome}`)
  check('LOW reward +50', mem?.reward === 50, `reward=${mem?.reward}`)
  check('LOW breakdown is outcome-only', mem?.rewardBreakdown?.successfulRepair === 50 && Object.keys(mem.rewardBreakdown ?? {}).length === 1, JSON.stringify(mem?.rewardBreakdown))
  return { incidentId, ref: detail.ref }
}

async function cohortMediumApprove(op, preOpen) {
  console.log('\n=== Cohort MEDIUM: approval gate → one-click APPROVE → RESOLVED ===')
  const { incidentId } = await faultCycle(op, preOpen, 'MEDIUM-01', 'MED coh')
  check('MEDIUM incident created', !!incidentId, `id=${incidentId}`)
  if (!incidentId) return null
  const run = await op.post('/api/security/run', { incidentId })
  check('MEDIUM run stops at WAITING_APPROVAL', run.json?.stage === 'WAITING_APPROVAL', `stage=${run.json?.stage}`)
  check('MEDIUM risk classified MEDIUM', run.json?.risk === 'MEDIUM', `risk=${run.json?.risk}`)
  check('MEDIUM requiresApproval + approvalId', run.json?.requiresApproval === true && !!run.json?.approvalId, JSON.stringify(run.json))
  const approvalId = run.json?.approvalId

  // No patch before approval: fault still active, trigger still 500.
  check('MEDIUM fault still active pre-approval', await faultActive(op, 'MEDIUM-01'), 'fault cleared early')
  const still = await triggerPost(op, 'MEDIUM pre-approve')
  check('MEDIUM still 500 before approval (no early patch)', still.status === 500, `status=${still.status}`)

  let detail = await incidentDetail(op, incidentId)
  const apprMsg = telegramOf(detail, 'MEDIUM_RISK_APPROVAL_REQUIRED')
  check('MEDIUM Telegram approval request SENT', apprMsg.some((d) => d.deliveryStatus === 'SENT'), JSON.stringify(apprMsg.map((d) => d.deliveryStatus)))
  const gmailAppr = gmailOf(detail, 'MEDIUM_RISK_APPROVAL_REQUIRED')
  check('MEDIUM Gmail approval attempted once', gmailAppr.length === 1, `count=${gmailAppr.length}`)
  check('MEDIUM Gmail honestly FAILED (unconfigured)', gmailAppr[0]?.deliveryStatus === 'FAILED' && (gmailAppr[0]?.error ?? '').includes('GMAIL_REFRESH_TOKEN'), `row=${JSON.stringify(gmailAppr[0])?.slice(0, 160)}`)
  const apprText = await gmailMessage(incidentId, 'MEDIUM_RISK_APPROVAL_REQUIRED')
  for (const section of ['WHAT IS THE PROBLEM', 'WHAT CAUSED IT', 'BEFORE CODE', 'PROPOSED AFTER CODE', 'CODER ANALYSIS', 'CRITIC ANALYSIS', 'JUDGE DECISION', 'VALIDATION PLAN', 'ROLLBACK PLAN', '/api/approvals/email?token=']) {
    check(`MEDIUM email section/link: ${section.slice(0, 24)}`, apprText.includes(section), 'missing')
  }

  // One-click APPROVE via the email link (JSON mode for the harness).
  const tok = await op.get(`/api/approvals/email-token?approvalId=${approvalId}`)
  check('TEST token reveal works (pending approval)', tok.status === 200 && Array.isArray(tok.json?.tokens), `status=${tok.status}`)
  const approveToken = (tok.json?.tokens ?? []).find((t) => t.action === 'APPROVE')?.token
  check('APPROVE token issued', !!approveToken, 'missing')
  const click = await op.get(`/api/approvals/email?token=${approveToken}`, { Accept: 'application/json' })
  check('One-click APPROVE → RESOLVED', click.json?.approved === true && click.json?.stage === 'RESOLVED', JSON.stringify(click.json)?.slice(0, 300))
  detail = await incidentDetail(op, incidentId)
  check('MEDIUM incident RESOLVED', detail?.status === 'RESOLVED', `status=${detail?.status}`)
  check('MEDIUM fault inactive after approved repair', !(await faultActive(op, 'MEDIUM-01')), 'still active')
  const verify = await triggerPost(op, 'MEDIUM verify')
  check('MEDIUM post works after repair (201)', verify.status === 201, `status=${verify.status}`)

  // Replay: same link is one-time — no duplicate execution.
  const attemptsBefore = (detail?.timeline ?? []).length
  const replay = await op.get(`/api/approvals/email?token=${approveToken}`, { Accept: 'application/json' })
  check('Replayed link is idempotent (no re-execution)', replay.json?.ok === false, JSON.stringify(replay.json)?.slice(0, 200))
  detail = await incidentDetail(op, incidentId)
  check('No duplicate repair on replay', (detail?.timeline ?? []).length === attemptsBefore, 'timeline grew')

  // Learning: +90 with approval shaping + breakdown.
  const mem = await memoryFor(op, detail.ref)
  check('MEDIUM memory APPROVED+RESOLVED', mem?.outcome === 'RESOLVED' && mem?.humanDecision === 'APPROVED', JSON.stringify({ o: mem?.outcome, h: mem?.humanDecision }))
  check('MEDIUM reward +90', mem?.reward === 90, `reward=${mem?.reward}`)
  check('MEDIUM breakdown transparent', mem?.rewardBreakdown?.successfulRepair === 50 && mem?.rewardBreakdown?.humanApproval === 40, JSON.stringify(mem?.rewardBreakdown))
  const finals = gmailOf(detail, 'FINAL_SUMMARY')
  check('MEDIUM FINAL_SUMMARY Gmail attempted', finals.length === 1, `count=${finals.length}`)
  return { incidentId, ref: detail.ref }
}

async function cohortMediumReject(op, preOpen) {
  console.log('\n=== Cohort MEDIUM-REJECT: one-click REJECT → no patch, reward 0 ===')
  const { incidentId } = await faultCycle(op, preOpen, 'MEDIUM-01', 'MED rej')
  check('REJECT incident created', !!incidentId, `id=${incidentId}`)
  if (!incidentId) return null
  const run = await op.post('/api/security/run', { incidentId })
  check('REJECT run stops at WAITING_APPROVAL', run.json?.stage === 'WAITING_APPROVAL', `stage=${run.json?.stage}`)
  const tok = await op.get(`/api/approvals/email-token?approvalId=${run.json?.approvalId}`)
  const rejectToken = (tok.json?.tokens ?? []).find((t) => t.action === 'REJECT')?.token
  check('REJECT token issued', !!rejectToken, 'missing')
  const click = await op.get(`/api/approvals/email?token=${rejectToken}`, { Accept: 'application/json' })
  check('One-click REJECT recorded', click.json?.rejected === true, JSON.stringify(click.json)?.slice(0, 200))
  const detail = await incidentDetail(op, incidentId)
  check('REJECT approval is REJECTED', (detail?.approvals ?? []).some((a) => a.status === 'REJECTED'), JSON.stringify((detail?.approvals ?? []).map((a) => a.status)))
  check('REJECT applies no patch (fault still active)', await faultActive(op, 'MEDIUM-01'), 'fault cleared!')
  const still = await triggerPost(op, 'MEDIUM rejected')
  check('REJECT leaves endpoint failing (500, app unchanged)', still.status === 500, `status=${still.status}`)
  const mem = await memoryFor(op, detail.ref)
  check('REJECT memory outcome REJECTED', mem?.outcome === 'REJECTED', `outcome=${mem?.outcome}`)
  check('REJECT reward is 0 (not a success)', mem?.reward === 0, `reward=${mem?.reward}`)
  check('REJECT breakdown has no success term', mem?.rewardBreakdown?.successfulRepair === undefined, JSON.stringify(mem?.rewardBreakdown))
  await activateFault(op, 'MEDIUM-01', 'deactivate')
  return { incidentId, ref: detail.ref }
}

async function cohortExpiryInvalid(op, preOpen, prisma) {
  console.log('\n=== Cohort EXPIRY/INVALID: honest token guards ===')
  const { incidentId } = await faultCycle(op, preOpen, 'MEDIUM-01', 'MED exp')
  check('EXPIRY incident created', !!incidentId, `id=${incidentId}`)
  if (!incidentId) return null
  const run = await op.post('/api/security/run', { incidentId })
  check('EXPIRY run stops at WAITING_APPROVAL', run.json?.stage === 'WAITING_APPROVAL', `stage=${run.json?.stage}`)
  // Backdate approval + token expiry (DB-level time travel for the test).
  const past = new Date(Date.now() - 10 * 60 * 1000)
  const approval = await prisma.approval.findFirst({ where: { incidentId }, orderBy: { createdAt: 'desc' } })
  check('Approval row exists', !!approval?.approvalId, 'missing')
  if (approval) {
    await prisma.approval.update({ where: { id: approval.id }, data: { expiresAt: past } })
    await prisma.approvalToken.updateMany({ where: { approvalId: approval.id }, data: { expiresAt: past } })
  }
  const tok = await op.get(`/api/approvals/email-token?approvalId=${run.json?.approvalId}`)
  const approveToken = (tok.json?.tokens ?? []).find((t) => t.action === 'APPROVE')?.token
  // Freshly minted TEST tokens inherit the approval's (backdated) expiry.
  const click = await op.get(`/api/approvals/email?token=${approveToken}`, { Accept: 'application/json' })
  check('Expired link refused honestly', click.json?.ok === false && /expired/i.test(click.json?.reason ?? ''), JSON.stringify(click.json)?.slice(0, 200))
  const detail = await incidentDetail(op, incidentId)
  check('Expired approval closes incident without patch', detail?.status === 'AI_REPAIR_FAILED', `status=${detail?.status}`)
  check('Expired approval marked EXPIRED', (detail?.approvals ?? []).some((a) => a.status === 'EXPIRED'), 'not expired')
  check('Expiry applies no patch (fault still active)', await faultActive(op, 'MEDIUM-01'), 'fault cleared!')

  // Invalid token: no state change anywhere.
  const bogus = await op.get('/api/approvals/email?token=bogus-token-value-12345', { Accept: 'application/json' })
  check('Invalid token refused honestly', bogus.json?.ok === false && /invalid/i.test(bogus.json?.reason ?? ''), JSON.stringify(bogus.json)?.slice(0, 160))
  await activateFault(op, 'MEDIUM-01', 'deactivate')
  return { incidentId, ref: detail.ref }
}

async function cohortHigh(op, preOpen) {
  console.log('\n=== Cohort HIGH: detailed email, one-click APPROVE ===')
  await activateFault(op, 'HIGH-01')
  await sleep(1500)
  const wrong = await op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' })
  if (wrong.status !== 500) {
    check('HIGH trigger produces 500', false, `status=${wrong.status}`)
    await activateFault(op, 'HIGH-01', 'deactivate')
    return null
  }
  check('HIGH trigger produces 500', true)
  // NOTE: the background auto-scan may ingest the ERROR row first (correct —
  // no duplicate incident). incidentAfterScan covers created + open fallback.
  const incidentId = await incidentAfterScan(op, preOpen)
  check('HIGH incident created', !!incidentId, `id=${incidentId}`)
  if (!incidentId) return null
  const run = await op.post('/api/security/run', { incidentId })
  check('HIGH run stops at WAITING_APPROVAL', run.json?.stage === 'WAITING_APPROVAL', `stage=${run.json?.stage}`)
  check('HIGH risk classified HIGH', run.json?.risk === 'HIGH', `risk=${run.json?.risk}`)
  let detail = await incidentDetail(op, incidentId)
  const gmailAppr = gmailOf(detail, 'HIGH_RISK_APPROVAL_REQUIRED')
  check('HIGH Gmail approval attempted once', gmailAppr.length === 1, `count=${gmailAppr.length}`)
  const text = await gmailMessage(incidentId, 'HIGH_RISK_APPROVAL_REQUIRED')
  for (const section of ['WHAT IS THE PROBLEM', 'BEFORE CODE', 'PROPOSED AFTER CODE', 'VALIDATION PLAN', 'ROLLBACK PLAN', 'JUDGE DECISION']) {
    check(`HIGH email section: ${section}`, text.includes(section), 'missing')
  }
  check('HIGH email has no secrets', !/GMAIL_CLIENT_SECRET|GMAIL_REFRESH_TOKEN|BEGIN PRIVATE|postgresql:\/\/[^@]*@/.test(text), 'leak?')
  const tok = await op.get(`/api/approvals/email-token?approvalId=${run.json?.approvalId}`)
  const approveToken = (tok.json?.tokens ?? []).find((t) => t.action === 'APPROVE')?.token
  const click = await op.get(`/api/approvals/email?token=${approveToken}`, { Accept: 'application/json' })
  check('HIGH one-click APPROVE → RESOLVED', click.json?.approved === true && click.json?.stage === 'RESOLVED', JSON.stringify(click.json)?.slice(0, 300))
  detail = await incidentDetail(op, incidentId)
  const wrongAfter = await op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-for-high01' })
  check('HIGH validation: wrong password → 401 again', wrongAfter.status === 401, `status=${wrongAfter.status}`)
  const mem = await memoryFor(op, detail.ref)
  check('HIGH reward positive with approval shaping', (mem?.reward ?? 0) > 0 && mem?.rewardBreakdown?.humanApproval === 40, `reward=${mem?.reward}`)
  return { incidentId, ref: detail.ref }
}

async function cohortRecurrence(op, preOpen, firstRef) {
  console.log('\n=== Cohort RECURRENCE: same error returns → regression penalty ===')
  const before = await memoryFor(op, firstRef)
  const beforeRec = before?.recurrenceCount ?? 0
  const { incidentId } = await faultCycle(op, preOpen, 'LOW-01', 'LOW recur')
  check('Recurrence incident created', !!incidentId, `id=${incidentId}`)
  if (!incidentId) return
  const run = await op.post('/api/security/run', { incidentId })
  check('Recurrence auto-resolves', run.json?.stage === 'RESOLVED', `stage=${run.json?.stage}`)
  const detail = await incidentDetail(op, incidentId)
  const old = await memoryFor(op, firstRef)
  check('Old success claim penalized (recurrence +1)', (old?.recurrenceCount ?? 0) === beforeRec + 1, `recurrence=${old?.recurrenceCount} before=${beforeRec}`)
  check('Old reward carries regression penalty', (old?.rewardBreakdown?.regression ?? 0) === -100, JSON.stringify(old?.rewardBreakdown))
  check('New incident learned separately', (await memoryFor(op, detail.ref))?.outcome === 'RESOLVED', 'missing')
}

async function cohortDashboardChat(op) {
  console.log('\n=== Cohort DASHBOARD/CHAT surfaces ===')
  const status = await op.get('/api/security/status')
  check('Security status exposes gmail block', !!status.json?.gmail && Array.isArray(status.json.gmail.missing), 'missing gmail block')
  check('Gmail block honest when unconfigured', status.json?.gmail?.configured === false, JSON.stringify(status.json?.gmail))
  const page = await op.get('/ai/security')
  check('/ai/security responds', page.status === 200, `status=${page.status}`)
  const chat = await op.post('/api/ai/chat', { message: 'Have we seen this error before?' })
  check('AI chat responds in TEST mode', chat.status === 200 && chat.json?.mode === 'TEST', `status=${chat.status}`)
  const learning = await op.get('/api/ai/learning')
  check('Learning API exposes reward policy', !!learning.json?.policy?.successfulRepair, 'no policy')
}

async function main() {
  console.log('# Phase 12 Gmail approval + FINAL risk-policy verification (TEST mode)')
  console.log(`BASE=${BASE}`)
  const env = loadEnv()
  if (!env.DATABASE_URL) {
    console.error('No DATABASE_URL in frontend/.env — aborting.')
    process.exitCode = 1
    return
  }
  console.log('Starting TEST-mode dev server…')
  const up = await restartTestServer()
  check('TEST dev server up', up, 'server did not start')
  if (!up) { process.exitCode = 1; return }

  const op = makeClient()
  const login = await op.post('/api/auth/login', OPERATOR)
  check('Operator login arjun → 200', login.status === 200, `status=${login.status}`)
  if (login.status !== 200) { process.exitCode = 1; return }

  const preOpen = await openIncidentIds(op)
  await op.post('/api/faults', { action: 'deactivate-all' })
  prisma = await openPrisma(env).catch((e) => {
    check('Prisma client loads (expiry cohort needs DB)', false, String(e).slice(0, 120))
    return null
  })

  const low = await cohortLow(op, preOpen)
  const med = await cohortMediumApprove(op, preOpen)
  await cohortMediumReject(op, preOpen)
  if (prisma) await cohortExpiryInvalid(op, preOpen, prisma)
  await cohortHigh(op, preOpen)

  // Rollback cohort drives the bad-fix scenario per-run (no server restart
  // needed — the TEST provider reads scenario from the run request).
  console.log('\n=== Cohort ROLLBACK: bad fix → ROLLED_BACK, negative reward ===')
  if (true) {
    const op2 = makeClient()
    const login2 = await op2.post('/api/auth/login', OPERATOR)
    check('Operator re-login → 200', login2.status === 200, `status=${login2.status}`)
    const preOpen2 = await openIncidentIds(op2)
    const { incidentId } = await faultCycle(op2, preOpen2, 'LOW-01', 'LOW badfix')
    check('Rollback incident created', !!incidentId, `id=${incidentId}`)
    if (incidentId) {
      const run = await op2.post('/api/security/run', { incidentId, scenario: 'bad-fix' })
      check('Bad fix rolls back (validation catches it)', run.json?.stage === 'ROLLED_BACK', `stage=${run.json?.stage}`)
      const detail = await incidentDetail(op2, incidentId)
      const mem = await memoryFor(op2, detail.ref)
      check('Rollback reward negative', (mem?.reward ?? 0) < 0, `reward=${mem?.reward}`)
      check('Rollback breakdown has rollback+validation terms', (mem?.rewardBreakdown?.rollback ?? 0) < 0 && (mem?.rewardBreakdown?.validationFailure ?? 0) < 0, JSON.stringify(mem?.rewardBreakdown))
      check('Fault still active after rollback (honest)', await faultActive(op2, 'LOW-01'), 'fault cleared!')
      await activateFault(op2, 'LOW-01', 'deactivate')
    }
  }

  console.log('\nRestarting TEST server (default scenario)…')
  const up3 = await restartTestServer()
  check('TEST server back up', up3, 'restart failed')
  if (up3 && low?.ref) {
    const op3 = makeClient()
    await op3.post('/api/auth/login', OPERATOR)
    const preOpen3 = await openIncidentIds(op3)
    await cohortRecurrence(op3, preOpen3, low.ref)
    await cohortDashboardChat(op3)
    await op3.post('/api/faults', { action: 'deactivate-all' }).catch(() => undefined)
  }
  if (prisma) await prisma.$disconnect().catch(() => undefined)

  console.log('\n' + '='.repeat(60))
  console.log(`Gmail approval verification: ${passed} passed, ${failed} failed`)
  if (failures.length) console.log(`Failures:\n- ${failures.join('\n- ')}`)
  process.exitCode = failed ? 1 : 0
}

main().catch((err) => {
  console.error('Harness error:', err)
  process.exitCode = 1
})
