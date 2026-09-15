#!/usr/bin/env node
/**
 * LIVE end-to-end demo (REAL mode: Groq agents + real Gmail + real Telegram).
 *
 *   LOW-01     → auto repair, no approval, FINAL Gmail, +50 reward
 *   MEDIUM-01  → WAITING_FOR_APPROVAL, enriched Gmail approval (A–I), dashboard
 *                PROCEED → patch → validate → RESOLVED, +90, FINAL Gmail
 *   MEDIUM-01  → REJECT → no patch, REJECTED, reward 0, FINAL Gmail
 *   HIGH-01    → WAITING_FOR_APPROVAL, HIGH approval email, PROCEED → RESOLVED
 *
 * Requires: REAL-mode server (AI_PROVIDER=groq, SELF_HEALING_TEST_MODE=false),
 * operator account arjun, Gmail + Telegram configured.
 *
 * Run: node scripts/e2e_gmail_live_demo.mjs
 */
const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const OPERATOR = { identifier: 'arjun', password: 'buildhub-demo1' }

let passed = 0
let failed = 0
const failures = []
function check(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  ok  ${name}`) }
  else { failed += 1; console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); failures.push(name) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeClient() {
  let cookie = ''
  async function req(method, path, body, extra = {}) {
    const headers = { ...extra }
    if (cookie) headers.Cookie = cookie
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' })
    const m = (res.headers.get('set-cookie') ?? '').match(/buildhub_session=[^;]+/)
    if (m) cookie = m[0]
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch {}
    return { status: res.status, json }
  }
  return { get: (p, h) => req('GET', p, undefined, h), post: (p, b) => req('POST', p, b) }
}

async function openIds(op) {
  const r = await op.get('/api/incidents?status=DETECTED,INVESTIGATING,AWAITING_REVIEW,WAITING_APPROVAL,VALIDATING&pageSize=100')
  return new Set((r.json?.incidents ?? []).map((i) => i.id))
}
async function waitIncident(op, preOpen, { timeoutMs = 120000 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await op.post('/api/incidents/scan', { limit: 200 }).catch(() => null)
    const r = await op.get('/api/incidents?status=DETECTED,INVESTIGATING,AWAITING_REVIEW,WAITING_APPROVAL,VALIDATING&pageSize=100')
    const found = (r.json?.incidents ?? []).find((i) => !preOpen.has(i.id))
    if (found) return found
    await sleep(5000)
  }
  return null
}
async function waitStatus(op, id, want, timeoutMs = 420000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const r = await op.get(`/api/incidents/${id}`)
    const st = r.json?.incident?.status
    if (want.includes(st)) return r.json.incident
    await sleep(8000)
  }
  return null
}
const gmailOf = (d, t) => (d?.gmail?.deliveries ?? []).filter((x) => x.type === t)
const memoryFor = async (op, ref) => {
  const r = await op.get('/api/ai/memory')
  return (r.json?.memories ?? []).find((m) => m.incidentRef === ref) ?? null
}

async function cohortLow(op) {
  console.log('\n=== LIVE LOW: autonomous repair + FINAL Gmail ===')
  const pre = await openIds(op)
  await op.post('/api/faults', { faultId: 'LOW-01', action: 'activate' })
  await sleep(2500)
  const trig = await op.post('/api/posts', { content: `live low ${Date.now()}`, tags: [] })
  check('LOW trigger 500', trig.status === 500, `status=${trig.status}`)
  const inc = await waitIncident(op, pre)
  check('LOW incident created', !!inc, 'none')
  if (!inc) return
  const done = await waitStatus(op, inc.id, ['RESOLVED', 'ROLLED_BACK', 'AI_REPAIR_FAILED'])
  check('LOW auto-resolved', done?.status === 'RESOLVED', `status=${done?.status}`)
  const detail = (await op.get(`/api/incidents/${inc.id}`)).json?.incident
  const finals = gmailOf(detail, 'FINAL_SUMMARY')
  check('LOW FINAL Gmail SENT', finals.some((d) => d.deliveryStatus === 'SENT'), JSON.stringify(finals.map((d) => d.deliveryStatus)))
  check('LOW no approval email', gmailOf(detail, 'MEDIUM_RISK_APPROVAL_REQUIRED').length === 0 && gmailOf(detail, 'HIGH_RISK_APPROVAL_REQUIRED').length === 0, 'present')
  const mem = await memoryFor(op, detail.ref)
  check('LOW reward +50', mem?.reward === 50 && mem?.outcome === 'RESOLVED', JSON.stringify({ r: mem?.reward, o: mem?.outcome }))
}

async function triggerMedium(op, pre, label) {
  await op.post('/api/faults', { faultId: 'MEDIUM-01', action: 'activate' })
  await sleep(2500)
  const trig = await op.post('/api/posts', { content: `${label} ${Date.now()}`, tags: [] })
  if (trig.status !== 500) { await sleep(3000); const t2 = await op.post('/api/posts', { content: `${label} retry ${Date.now()}`, tags: [] }); return { status: t2.status, inc: await waitIncident(op, pre) } }
  return { status: trig.status, inc: await waitIncident(op, pre) }
}

async function cohortMediumApprove(op) {
  console.log('\n=== LIVE MEDIUM approve: Gmail A–I email → PROCEED → RESOLVED ===')
  const pre = await openIds(op)
  const { status, inc } = await triggerMedium(op, pre, 'live med')
  check('MEDIUM trigger 500', status === 500, `status=${status}`)
  check('MEDIUM incident created', !!inc, 'none')
  if (!inc) return
  const waiting = await waitStatus(op, inc.id, ['WAITING_APPROVAL'])
  check('MEDIUM reached WAITING_FOR_APPROVAL', waiting?.status === 'WAITING_APPROVAL', `status=${waiting?.status}`)
  if (!waiting) return
  let detail = (await op.get(`/api/incidents/${inc.id}`)).json?.incident
  const appr = gmailOf(detail, 'MEDIUM_RISK_APPROVAL_REQUIRED')
  check('MEDIUM Gmail approval SENT', appr.some((d) => d.deliveryStatus === 'SENT'), JSON.stringify(appr.map((d) => d.deliveryStatus)))
  // No patch before approval.
  const faults = await op.get('/api/faults')
  check('MEDIUM fault still active pre-approval', (faults.json?.faults ?? []).some((f) => f.id === 'MEDIUM-01' && f.active), 'cleared early')
  const still = await op.post('/api/posts', { content: `live med pre ${Date.now()}`, tags: [] })
  check('MEDIUM still 500 pre-approval', still.status === 500, `status=${still.status}`)
  // Human decision via dashboard (same approval state machine as email link).
  const approvalId = detail?.approvals?.find((a) => a.status === 'PENDING')?.approvalId
  check('PENDING approval exists', !!approvalId, 'none')
  const proc = await op.post('/api/approvals/proceed', { approvalId, action: 'proceed' })
  check('PROCEED accepted', proc.status === 200, `status=${proc.status}`)
  const done = await waitStatus(op, inc.id, ['RESOLVED', 'ROLLED_BACK'])
  check('MEDIUM RESOLVED after approval', done?.status === 'RESOLVED', `status=${done?.status}`)
  const verify = await op.post('/api/posts', { content: `live med verify ${Date.now()}`, tags: [] })
  check('Post succeeds after repair (201)', verify.status === 201, `status=${verify.status}`)
  detail = (await op.get(`/api/incidents/${inc.id}`)).json?.incident
  check('MEDIUM FINAL Gmail SENT', gmailOf(detail, 'FINAL_SUMMARY').some((d) => d.deliveryStatus === 'SENT'), 'missing')
  const mem = await memoryFor(op, detail.ref)
  check('MEDIUM reward +90 APPROVED', mem?.reward === 90 && mem?.humanDecision === 'APPROVED', JSON.stringify({ r: mem?.reward, h: mem?.humanDecision }))
}

async function cohortMediumReject(op) {
  console.log('\n=== LIVE MEDIUM reject: no patch, REJECTED, reward 0 ===')
  const pre = await openIds(op)
  const { status, inc } = await triggerMedium(op, pre, 'live rej')
  check('REJECT trigger 500', status === 500, `status=${status}`)
  if (!inc) { check('REJECT incident created', false, 'none'); return }
  const waiting = await waitStatus(op, inc.id, ['WAITING_APPROVAL'])
  check('REJECT reached WAITING_FOR_APPROVAL', !!waiting, 'none')
  if (!waiting) return
  let detail = (await op.get(`/api/incidents/${inc.id}`)).json?.incident
  const approvalId = detail?.approvals?.find((a) => a.status === 'PENDING')?.approvalId
  const rej = await op.post('/api/approvals/proceed', { approvalId, action: 'reject' })
  check('REJECT accepted', rej.status === 200, `status=${rej.status}`)
  await sleep(3000)
  detail = (await op.get(`/api/incidents/${inc.id}`)).json?.incident
  check('REJECTED, no patch', (detail?.approvals ?? []).some((a) => a.status === 'REJECTED'), JSON.stringify((detail?.approvals ?? []).map((a) => a.status)))
  const still = await op.post('/api/posts', { content: `live rej after ${Date.now()}`, tags: [] })
  check('Endpoint still 500 (app unchanged)', still.status === 500, `status=${still.status}`)
  const mem = await memoryFor(op, detail.ref)
  check('REJECT reward 0', mem?.reward === 0 && mem?.outcome === 'REJECTED', JSON.stringify({ r: mem?.reward, o: mem?.outcome }))
  await op.post('/api/faults', { faultId: 'MEDIUM-01', action: 'deactivate' })
}

async function cohortHigh(op) {
  console.log('\n=== LIVE HIGH-01 approve: strict approval → RESOLVED ===')
  const pre = await openIds(op)
  await op.post('/api/faults', { faultId: 'HIGH-01', action: 'activate' })
  await sleep(2500)
  const wrong = await op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-live-high' })
  check('HIGH trigger 500', wrong.status === 500, `status=${wrong.status}`)
  const inc = await waitIncident(op, pre)
  check('HIGH incident created', !!inc, 'none')
  if (!inc) return
  const waiting = await waitStatus(op, inc.id, ['WAITING_APPROVAL'])
  check('HIGH WAITING_FOR_APPROVAL', !!waiting, 'none')
  if (!waiting) return
  let detail = (await op.get(`/api/incidents/${inc.id}`)).json?.incident
  const appr = gmailOf(detail, 'HIGH_RISK_APPROVAL_REQUIRED')
  check('HIGH Gmail approval SENT', appr.some((d) => d.deliveryStatus === 'SENT'), JSON.stringify(appr.map((d) => d.deliveryStatus)))
  const approvalId = detail?.approvals?.find((a) => a.status === 'PENDING')?.approvalId
  await op.post('/api/approvals/proceed', { approvalId, action: 'proceed' })
  const done = await waitStatus(op, inc.id, ['RESOLVED', 'ROLLED_BACK'])
  check('HIGH RESOLVED', done?.status === 'RESOLVED', `status=${done?.status}`)
  const back = await op.post('/api/auth/login', { identifier: 'arjun', password: 'wrong-password-live-high' })
  check('Wrong password 401 again', back.status === 401, `status=${back.status}`)
}

async function main() {
  const op = makeClient()
  const login = await op.post('/api/auth/login', OPERATOR)
  if (login.status !== 200) { console.error('operator login failed'); process.exit(2) }
  await cohortLow(op)
  await cohortMediumApprove(op)
  await cohortMediumReject(op)
  await cohortHigh(op)
  await op.post('/api/faults', { faultId: 'MEDIUM-01', action: 'deactivate' }).catch(() => null)
  console.log(`\nLIVE demo: ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log('Failures:'); for (const f of failures) console.log(`- ${f}`) }
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(2) })
