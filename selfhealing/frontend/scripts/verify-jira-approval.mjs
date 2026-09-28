#!/usr/bin/env node
/**
 * Jira approval channel verification (TEST mode + local mock Jira).
 *
 * Proves, for BOTH pipelines, that the human decision now happens in Jira:
 *
 *   STATUS     /api/jira/status: channel=jira, connection ok, no secrets
 *   REPAIR ✓   HIGH-risk fault → WAITING_APPROVAL → a Jira card in "In Review"
 *              (incident, root cause, before/after code, approval id);
 *              moving it to "In Progress" decides nothing; moving it to
 *              "Done" → patch applied + validated → incident RESOLVED and a
 *              BuildHub result comment on the card
 *   REPAIR ✗   comment "reject" (picked up by the BACKGROUND poller) →
 *              REJECTED, no patch, card moved to "To Do"
 *   MIRROR     decided in the dashboard → the Jira card is closed with a note
 *   EXPIRY     approval past its expiry → EXPIRED, nothing executed
 *   UX ✓       UX suggestion passes the sandbox → Jira card with before/after
 *              screenshots attached → "Done" → change applied (VALIDATED)
 *   UX ✗       comment "rejected" → REJECTED, file untouched
 *
 * Needs:
 *   1. node scripts/mock-jira.mjs                      (mock Jira on :3300)
 *   2. start-buildhub.ps1 -TestMode -JiraMock          (app wired to the mock)
 *   3. node scripts/verify-jira-approval.mjs
 * The header is set to its original layout for the UX cohorts and restored
 * byte-for-byte afterwards.
 */

import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync } from 'node:fs'

const CWD = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(CWD, '..')
const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const JIRA = (process.env.MOCK_JIRA_URL ?? 'http://localhost:3300').replace(/\/$/, '')
const OPERATOR = { identifier: 'arjun', password: 'buildhub-demo1' }
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/buildhub'
const TARGET_FILE = 'components/navigation/header.tsx'
const TARGET = 'login-button'

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
    return { status: res.status, json }
  }
  return { get: (p) => req('GET', p), post: (p, b) => req('POST', p, b ?? {}) }
}

async function jira(path, body) {
  const res = await fetch(JIRA + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  return res.json().catch(() => null)
}
const mockIssues = () => jira('/__test/issues')
const issueFor = async (approvalId) => (await mockIssues()).find((i) => i.descriptionText.includes(approvalId)) ?? null

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

/** Activates HIGH-01, produces the real failure and runs the engine → WAITING_APPROVAL. */
async function highRiskApproval(op, label) {
  await op.post('/api/faults', { action: 'deactivate-all' })
  const before = new Set(((await op.get('/api/incidents?pageSize=100')).json?.incidents ?? []).map((i) => i.id))
  await op.post('/api/faults', { faultId: 'HIGH-01' })
  await sleep(2500)
  let status = 0
  for (let i = 0; i < 8 && status < 500; i += 1) {
    const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'arjun', password: 'wrong-password-for-high01' }) })
    status = r.status
    if (status < 500) await sleep(1000)
  }
  let incident = null
  for (let i = 0; i < 20 && !incident; i += 1) {
    await sleep(1000)
    const list = (await op.get('/api/incidents?status=DETECTED,INVESTIGATING,WAITING_APPROVAL,VALIDATING&pageSize=100')).json?.incidents ?? []
    incident = list.find((x) => x.endpoint === '/api/auth/login' && !before.has(x.id)) ?? list.find((x) => x.endpoint === '/api/auth/login') ?? null
  }
  if (!incident) { check(`${label}: incident opened`, false); return null }
  const run = await op.post('/api/security/run', { incidentId: incident.id })
  check(`${label}: engine stops at WAITING_APPROVAL`, run.json?.stage === 'WAITING_APPROVAL' && !!run.json?.approvalId, JSON.stringify(run.json)?.slice(0, 200))
  check(`${label}: approval request went to Jira`, /jira issue KAN-\d+/.test(run.json?.gmail?.reason ?? ''), run.json?.gmail?.reason)
  return run.json?.approvalId ? { incidentId: incident.id, approvalId: run.json.approvalId } : null
}

async function waitSettled(op, id, ms = 240_000) {
  const deadline = Date.now() + ms
  let s = null
  while (Date.now() < deadline) {
    s = ((await op.get('/api/ux/suggestions')).json?.suggestions ?? []).find((x) => x.id === id) ?? null
    if (s && s.status !== 'SIMULATING') return s
    await sleep(3000)
  }
  return s
}

async function main() {
  const prisma = await openPrisma().catch(() => null)
  const op = makeClient()
  check('Operator login', (await op.post('/api/auth/login', OPERATOR)).status === 200)
  if (!(await fetch(`${JIRA}/__test/issues`).then((r) => r.ok).catch(() => false))) {
    console.error('\nMock Jira is not running. Start it with: node scripts/mock-jira.mjs')
    process.exitCode = 1
    return
  }
  await jira('/__test/reset', {})

  // --- STATUS -----------------------------------------------------------------
  console.log('\n=== Jira status ===')
  const st = await op.get('/api/jira/status')
  check('Channel is jira', st.json?.channel === 'jira', JSON.stringify(st.json))
  check('Connection to Jira works', st.json?.connection?.ok === true, JSON.stringify(st.json?.connection))
  check('Board statuses visible', (st.json?.connection?.statuses ?? []).includes('In Review'))
  check('Status never exposes the API token', !JSON.stringify(st.json).includes('mock-token'))
  if (st.json?.channel !== 'jira') {
    console.error('\nThe app is not wired to the mock Jira. Start it with: start-buildhub.ps1 -TestMode -JiraMock')
    process.exitCode = 1
    return
  }

  // --- REPAIR approve ----------------------------------------------------------
  console.log('\n=== Cohort REPAIR approve (card → Done) ===')
  const a = await highRiskApproval(op, 'REPAIR approve')
  if (a) {
    const issue = await issueFor(a.approvalId)
    check('Jira card created with the approval id', !!issue)
    check('Card waits in "In Review"', issue?.status === 'In Review', issue?.status)
    check('Card is labelled buildhub-approval', issue?.labels?.includes('buildhub-approval'))
    check('Card explains root cause + before/after code', /AI root cause/.test(issue?.descriptionText ?? '') && /Before/.test(issue?.descriptionText ?? '') && /After/.test(issue?.descriptionText ?? ''))
    if (prisma) {
      const row = await prisma.approval.findUnique({ where: { approvalId: a.approvalId } })
      check('Jira approvals get a 30-minute window', row && row.expiresAt.getTime() - row.createdAt.getTime() > 20 * 60_000)
    }
    await jira('/__test/move', { key: issue.key, status: 'In Progress' })
    await op.post('/api/jira/sync')
    const still = prisma ? await prisma.approval.findUnique({ where: { approvalId: a.approvalId } }) : null
    check('Moving to "In Progress" decides nothing', !prisma || still?.status === 'PENDING', still?.status)
    await jira('/__test/move', { key: issue.key, status: 'Done' })
    const sync = await op.post('/api/jira/sync')
    check('Sync decided the card', (sync.json?.decided ?? []).some((d) => d.approvalId === a.approvalId && d.state === 'APPROVED'), JSON.stringify(sync.json))
    const inc = (await op.get(`/api/incidents/${a.incidentId}`)).json?.incident
    check('Incident RESOLVED after Jira approval', inc?.status === 'RESOLVED', inc?.status)
    const after = await issueFor(a.approvalId)
    check('BuildHub result comment on the card', (after?.comments ?? []).some((c) => /Approved by Jira/.test(JSON.stringify(c.body))))
    check('Card stays in Done', after?.status === 'Done', after?.status)
    const wrong = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'arjun', password: 'wrong-password-x' }) })
    check('Repaired: wrong password → 401', wrong.status === 401, `status=${wrong.status}`)
  }

  // --- REPAIR reject via comment (background poller) --------------------------
  console.log('\n=== Cohort REPAIR reject (comment, background poller) ===')
  const r = await highRiskApproval(op, 'REPAIR reject')
  if (r) {
    const issue = await issueFor(r.approvalId)
    await jira('/__test/comment', { key: issue.key, text: 'reject — not now' })
    let row = null
    for (let i = 0; i < 30; i += 1) {
      await sleep(1000)
      row = prisma ? await prisma.approval.findUnique({ where: { approvalId: r.approvalId } }) : null
      if (row?.status !== 'PENDING') break
    }
    check('Background poller rejected it (no manual sync)', row?.status === 'REJECTED', row?.status)
    const after = await issueFor(r.approvalId)
    check('Rejected card moved to "To Do"', after?.status === 'To Do', after?.status)
    check('Reject comment explains no patch applied', (after?.comments ?? []).some((c) => /No patch was applied/.test(JSON.stringify(c.body))))
  }
  await op.post('/api/faults', { action: 'deactivate-all' })

  // --- MIRROR: decided in the dashboard ---------------------------------------
  console.log('\n=== Cohort MIRROR (decided in dashboard) ===')
  const m = await highRiskApproval(op, 'MIRROR')
  if (m) {
    const dash = await op.post('/api/approvals/proceed', { approvalId: m.approvalId, action: 'reject' })
    check('Dashboard reject accepted', dash.status === 200, JSON.stringify(dash.json)?.slice(0, 200))
    await op.post('/api/jira/sync')
    const link = prisma ? await prisma.jiraApproval.findUnique({ where: { approvalId: m.approvalId } }) : null
    check('Jira card closed to match the dashboard', !prisma || link?.state === 'CLOSED', link?.state)
    const after = await issueFor(m.approvalId)
    check('Card notes it was decided in BuildHub', (after?.comments ?? []).some((c) => /already decided in BuildHub/.test(JSON.stringify(c.body))))
  }
  await op.post('/api/faults', { action: 'deactivate-all' })

  // --- EXPIRY -----------------------------------------------------------------
  console.log('\n=== Cohort EXPIRY ===')
  const e = await highRiskApproval(op, 'EXPIRY')
  if (e && prisma) {
    await prisma.approval.update({ where: { approvalId: e.approvalId }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    const issue = await issueFor(e.approvalId)
    await jira('/__test/move', { key: issue.key, status: 'Done' })
    await op.post('/api/jira/sync')
    const row = await prisma.approval.findUnique({ where: { approvalId: e.approvalId } })
    check('Late approval → EXPIRED (never executed)', row?.status === 'EXPIRED', row?.status)
    const inc = (await op.get(`/api/incidents/${e.incidentId}`)).json?.incident
    check('Incident not resolved by an expired approval', inc?.status !== 'RESOLVED', inc?.status)
  }
  await op.post('/api/faults', { action: 'deactivate-all' })
  const ok = await op.post('/api/auth/login', OPERATOR)
  check('Login works after the repair cohorts', ok.status === 200)

  // --- UX via Jira -------------------------------------------------------------
  const userHeader = readTarget()
  writeTarget(originalHeader())
  await sleep(2500)
  try {
    console.log('\n=== Cohort UX approve (sandbox pass → Jira card → Done) ===')
    const open = ((await op.get('/api/ux/suggestions')).json?.suggestions ?? []).find((s) => s.uxId === TARGET && ['DRAFTED', 'SIMULATING', 'AWAITING_APPROVAL'].includes(s.status))
    if (open) {
      check(`No open suggestion for ${TARGET} (found ${open.ref} ${open.status})`, false)
    } else {
      const req = await op.post('/api/ux/suggestions', { component: TARGET, file: TARGET_FILE, instruction: 'move it left' })
      const done = req.json?.suggestion ? await waitSettled(op, req.json.suggestion.id) : null
      check('UX suggestion passed the sandbox → AWAITING_APPROVAL', done?.status === 'AWAITING_APPROVAL', done?.status)
      const approvalId = done?.approvals?.[0]?.approvalId
      const issue = approvalId ? await issueFor(approvalId) : null
      check('UX Jira card created', !!issue)
      check('UX card has the sandbox results', /Tested in the sandbox first/.test(issue?.descriptionText ?? ''))
      check('Before/after screenshots attached', (issue?.attachments ?? []).some((x) => /before\.png$/.test(x.name)) && (issue?.attachments ?? []).some((x) => /after\.png$/.test(x.name)), JSON.stringify(issue?.attachments))
      check('Header untouched while waiting', readTarget() === originalHeader())
      if (issue) {
        await jira('/__test/move', { key: issue.key, status: 'Done' })
        await op.post('/api/jira/sync')
        const s = ((await op.get('/api/ux/suggestions')).json?.suggestions ?? []).find((x) => x.id === done.id)
        check('UX change applied after Jira approval', ['APPLIED', 'VALIDATED'].includes(s?.status), s?.status)
        check('Header now has the approved change', readTarget() !== originalHeader())
      }
    }

    console.log('\n=== Cohort UX reject (comment) ===')
    writeTarget(originalHeader())
    await sleep(2500)
    const req2 = await op.post('/api/ux/suggestions', { component: TARGET, file: TARGET_FILE, instruction: 'move it left' })
    const done2 = req2.json?.suggestion ? await waitSettled(op, req2.json.suggestion.id) : null
    const approvalId2 = done2?.approvals?.[0]?.approvalId
    const issue2 = approvalId2 ? await issueFor(approvalId2) : null
    check('Second UX card created', !!issue2, done2?.status)
    if (issue2) {
      await jira('/__test/comment', { key: issue2.key, text: 'Rejected, keep it as is' })
      await op.post('/api/jira/sync')
      const s = ((await op.get('/api/ux/suggestions')).json?.suggestions ?? []).find((x) => x.id === done2.id)
      check('UX suggestion REJECTED from Jira', s?.status === 'REJECTED', s?.status)
      check('Header unchanged after reject', readTarget() === originalHeader())
    }
  } finally {
    writeTarget(userHeader)
    if (prisma) await prisma.$disconnect().catch(() => undefined)
  }
  check('Header restored byte-for-byte', readTarget() === userHeader)

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
