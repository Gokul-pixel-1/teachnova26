/**
 * Bug-repair (self-healing) end-to-end check that runs on Windows/macOS/Linux.
 * Needs the app running in TEST mode on :3000 with FAULT_INJECTION_ENABLED=true:
 *   powershell -File C:\Users\sugan\buildhub-tools\start-buildhub.ps1 -TestMode
 *   node scripts/verify-repair-flow.mjs
 * LOW-01: error -> incident -> automatic repair. HIGH-01: error -> incident ->
 * waits for human approval -> approved -> repaired. Posting/login work after.
 */
const BASE = 'http://localhost:3000'
let cookie = ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function req(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' })
  const sc = res.headers.getSetCookie?.() ?? []
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ')
  let json = null; try { json = await res.json() } catch {}
  return { status: res.status, json }
}
let pass = 0, fail = 0
const check = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? '  ok' : 'FAIL'}  ${n}${ok ? '' : ' — ' + d}`) }
check('login', (await req('POST', '/api/auth/login', { identifier: 'arjun', password: 'buildhub-demo1' })).status === 200)
await req('POST', '/api/faults', { action: 'deactivate-all' })
const newPost = () => req('POST', '/api/posts', { content: 'e2e check ' + Date.now(), tags: [] })
const p0 = await newPost(); check('posting works normally (201)', p0.status === 201, `status=${p0.status}`)
const recent = async (since) => ((await req('GET', '/api/incidents?pageSize=50')).json?.incidents ?? []).filter((i) => new Date(i.createdAt ?? i.detectedAt ?? 0) >= since)

for (const id of ['LOW-01', 'HIGH-01']) {
  console.log(`\n--- ${id} ---`)
  const since = new Date(Date.now() - 1000)
  check(`${id} activate`, (await req('POST', '/api/faults', { faultId: id })).status === 200)
  await sleep(2500)
  let t
  for (let i = 0; i < 8; i++) {
    t = id === 'HIGH-01'
      ? await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'arjun', password: 'wrong-password-x' }) }).then((r) => ({ status: r.status }))
      : await newPost()
    if (t.status >= 500) break
    await sleep(1000)
  }
  check(`${id} real failure produced (500)`, t.status >= 500, `status=${t.status}`)
  let inc = null
  const ep = id === 'HIGH-01' ? '/api/auth/login' : '/api/posts'
  for (let i = 0; i < 15 && !inc; i++) { await sleep(1000); inc = (await recent(since)).find((x) => x.endpoint === ep) ?? ((await req('GET', '/api/incidents?status=DETECTED,INVESTIGATING,WAITING_APPROVAL,VALIDATING&pageSize=100')).json?.incidents ?? []).find((x) => x.endpoint === ep) }
  check(`${id} incident created or merged automatically`, !!inc, 'none')
  if (!inc) continue
  console.log(`      ${inc.ref} status=${inc.status} severity=${inc.severity}`)
  let stage = null
  if (!['RESOLVED', 'ROLLED_BACK'].includes(inc.status)) {
    const run = await req('POST', '/api/security/run', { incidentId: inc.id })
    stage = run.json?.stage
    console.log(`      engine stage=${stage} risk=${run.json?.risk ?? ''}`)
    if (stage === 'WAITING_APPROVAL') {
      check(`${id} high risk waits for human approval`, !!run.json.approvalId)
      const pr = await req('POST', '/api/approvals/proceed', { approvalId: run.json.approvalId, action: 'proceed' })
      stage = pr.json?.repair?.stage ?? pr.json?.status
      console.log(`      after approval stage=${stage}`)
    }
  }
  const det = (await req('GET', `/api/incidents/${inc.id}`)).json?.incident
  check(`${id} incident RESOLVED`, det?.status === 'RESOLVED', `status=${det?.status}`)
  const f = ((await req('GET', '/api/faults')).json?.faults ?? []).find((x) => x.id === id)
  check(`${id} fault cleared`, f?.active === false, `active=${f?.active}`)
  await req('POST', '/api/faults', { action: 'deactivate-all' })
}
const p1 = await newPost(); check('\nposting works after repairs (201)', p1.status === 201, `status=${p1.status}`)
const lg = await req('POST', '/api/auth/login', { identifier: 'arjun', password: 'buildhub-demo1' }); check('login works after repairs', lg.status === 200)
console.log(`\n${pass} passed, ${fail} failed`)
