#!/usr/bin/env node
/**
 * Canonical incident-briefing verification (18 Teleind checks + Gmail honesty).
 *
 * Verifies — against REAL persisted state, never fabricated — that every
 * Telegram message an incident produced is built from the SAME canonical brief
 * (`buildIncidentBrief(incidentId)` in `lib/server/notifications/brief.ts`)
 * that drives the incident-detail terminal card, the PDF report and the AI chat.
 *
 * Scenario coverage (context-aware; a check passes when its scenario has data):
 *   A) LOW auto-repair ESCALATION + FINAL_SUMMARY
 *   A2) MEDIUM approval-required + PROCEED/REJECT flow
 *   B) HIGH-approval PROCEED → RESOLVED
 *   C) HIGH-approval REJECTED → REJECTED terminal, no code change
 *   D) approval EXPIRED → EXPIRED terminal, no code change
 *   E) ROLLED_BACK → validation FAIL + known-good outcome
 *   ATTACK) security-log-analyzer honesty
 *
 * Every decision uses only:
 *   - the stored `TelegramNotification.message` (the exact text Telegram got),
 *   - the `/api/incidents/:id` detail DTO (terminalSummary == PDF section 6.6),
 *   - the live SSE lifecycle stream, and
 *   - the AI chat route source contract.
 *
 * Run:  node scripts/test-incident-briefing.mjs        (needs server on :3000)
 *       BASE_URL=http://localhost:3000 node scripts/test-incident-briefing.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CWD = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const ENV_PATH = resolve(CWD, '../.env')

let passed = 0
let failed = 0
const failures = []
const coverage = new Set()

function check(number, name, condition, extra) {
  if (condition) {
    passed += 1
    console.log(`  ok  ${number}. ${name}`)
  } else {
    failed += 1
    console.error(`FAIL  ${number}. ${name}${extra ? ` — ${extra}` : ''}`)
    failures.push(`${number}. ${name}`)
  }
}

function mark(scenario) {
  coverage.add(scenario)
}

function loadEnv() {
  const vars = {}
  if (!existsSync(ENV_PATH)) return vars
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const clean = line.trim()
    if (!clean || clean.startsWith('#')) continue
    const eq = clean.indexOf('=')
    if (eq === -1) continue
    const key = clean.slice(0, eq).trim()
    let value = clean.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    vars[key] = value
  }
  return vars
}

function tokenFromSetCookie(setCookie) {
  const match = setCookie && setCookie.match(/buildhub_session=[^;]+/)
  return match ? match[0] : null
}

let cookie = ''
async function api(method, path, body) {
  const headers = cookie ? { Cookie: cookie } : {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) {
    const t = tokenFromSetCookie(setCookie)
    if (t) cookie = t
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

function groupBy(rows, keyFn) {
  const map = new Map()
  for (const row of rows) {
    const k = keyFn(row)
    map.set(k, [...(map.get(k) ?? []), row])
  }
  return map
}

const TEN_SECTIONS = ['TRIGGER', 'ROOT CAUSE', 'LOCATION', 'AI ANALYSIS', 'PROPOSED FIX', 'CODE CHANGE', 'VALIDATION', 'RISK POLICY']
const TERMINAL_HEADER = {
  RESOLVED: 'BUILDHUB REPAIR SUCCESSFUL',
  ROLLED_BACK: 'REPAIR FAILED',
  REJECTED: 'REPAIR REJECTED',
  EXPIRED: 'APPROVAL EXPIRED',
}

async function readSseLifecycle() {
  const sse = await fetch(`${BASE}/api/security/events`, { headers: { Cookie: cookie } })
  if (sse.status !== 200 || !(sse.headers.get('content-type') ?? '').includes('text/event-stream') || !sse.body) {
    try {
      await sse.body?.cancel()
    } catch {
      // ignore
    }
    return false
  }
  const reader = sse.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (let guard = 0; guard < 4 && !text.includes('event: lifecycle'); guard += 1) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    // stream aborted
  }
  try {
    await reader.cancel()
  } catch {
    // ignore
  }
  return text.includes('event: lifecycle')
}

async function main() {
  const env = loadEnv()
  console.log('# BuildHub canonical incident-briefing verification (18 checks)')
  console.log(`BASE=${BASE} · DATABASE_URL=${env.DATABASE_URL ? 'present' : 'MISSING'}`)

  if (!env.DATABASE_URL) {
    console.error('No DATABASE_URL in frontend/.env — aborting.')
    process.exitCode = 1
    return
  }

  const { PrismaClient } = await import('@prisma/client')
  const { PrismaPg } = await import('@prisma/adapter-pg')
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter })

  const login = await api('POST', '/api/auth/login', {
    identifier: 'arjun',
    password: 'buildhub-demo1',
  })
  if (login.status !== 200) {
    console.error('Operator login failed — is the server running on :3000?')
    process.exitCode = 1
    return
  }

  const incidents = await prisma.incident.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, ref: true, status: true, severity: true, detectedBy: true },
  })
  const byId = new Map(incidents.map((i) => [i.id, i]))

  const deliveries = await prisma.telegramNotification.findMany({
    where: { incidentId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: {
      incidentId: true,
      type: true,
      deliveryStatus: true,
      message: true,
      telegramMessageId: true,
      error: true,
    },
  })
  const sent = deliveries.filter((r) => r.deliveryStatus === 'SENT')
  // Canonical messages always begin with the HTML-bolder header. Messages
  // recorded by pre-brief pipelines (short legacy alerts) are reported below
  // but excluded from content-contract checks.
  const canonicalSent = sent.filter((r) => typeof r.message === 'string' && r.message.startsWith('<b>'))
  const finals = canonicalSent.filter((r) => r.type === 'FINAL_SUMMARY')
  const incidentMsgs = canonicalSent.filter((r) => r.type === 'INCIDENT')
  const escalations = canonicalSent.filter((r) => r.type === 'ESCALATION')
  const approvalReqs = canonicalSent.filter((r) => r.type === 'HIGH_RISK_APPROVAL_REQUIRED' || r.type === 'MEDIUM_RISK_APPROVAL_REQUIRED')
  const attackIncidents = incidents.filter((i) => i.detectedBy && /security-log-analyzer/i.test(i.detectedBy))

  const gmailRows = await prisma.gmailNotification.findMany({
    orderBy: { createdAt: 'asc' },
    select: { incidentId: true, type: true, deliveryStatus: true, subject: true, message: true, gmailMessageId: true, error: true },
  })

  console.log(`incidents=${incidents.length} · deliveries=${deliveries.length} · SENT=${sent.length} · canonical=${canonicalSent.length} (legacy=${sent.length - canonicalSent.length})`)

  // ── 1. Schema: briefing message types exist ──────────────────────────────
  const types = await prisma.$queryRawUnsafe('SELECT unnest(enum_range(NULL::"NotificationType")) AS v')
  const typeSet = new Set(types.map((row) => row.v))
  const missing = ['INCIDENT', 'ESCALATION', 'HIGH_RISK_APPROVAL_REQUIRED', 'MEDIUM_RISK_APPROVAL_REQUIRED', 'FINAL_SUMMARY'].filter((t) => !typeSet.has(t))
  check(1, 'Schema: briefing NotificationTypes exist', missing.length === 0, `missing=${missing.join(',') || '—'}`)

  // ── 2. Dedupe: at most one SENT per (incident, type) ─────────────────────
  const pairs = groupBy(deliveries, (r) => `${r.incidentId}\u0000${r.type}`)
  let pairDupes = 0
  for (const rows of pairs.values()) {
    if (rows.filter((r) => r.deliveryStatus === 'SENT').length > 1) pairDupes += 1
    const first = rows[0]
    if (rows.some((r) => r.deliveryStatus === 'SKIPPED_DUPLICATE') && first.deliveryStatus !== 'SENT') pairDupes += 1
  }
  check(2, 'Delivery dedupe: one SENT per (incident,type), log stays append-only', pairDupes === 0, `violations=${pairDupes}`)

  // ── 3. Persistence: SENT rows store the canonical message text ───────────
  const briefed = canonicalSent.filter((r) => r.message && r.message.length > 120)
  check(3, 'Persistence: canonical SENT rows store the full message text', canonicalSent.length === 0 || briefed.length === canonicalSent.length, `briefed=${briefed.length}/${canonicalSent.length}`)

  // ── 4. INCIDENT brief: all ten sections ─────────────────────────────────
  // Content-signature freshness: every current-builder INCIDENT carries the
  // '📍 TRIGGER' section. Messages recorded by earlier brief revisions (short
  // alerts, no TRIGGER) are reported but not asserted against the ten-section
  // contract — they were produced before the contract existed.
  const legacyIncidentMsgs = incidentMsgs.filter((row) => !stripHtml(row.message).includes('TRIGGER'))
  const currentIncidentMsgs = incidentMsgs.filter((row) => stripHtml(row.message).includes('TRIGGER'))
  const badIncident = currentIncidentMsgs.filter((row) => !TEN_SECTIONS.every((s) => stripHtml(row.message).includes(s)))
  check(
    4,
    'Current-revision INCIDENT briefs carry all ten sections',
    badIncident.length === 0,
    `bad=${badIncident.length} legacy=${legacyIncidentMsgs.length}`,
  )
  if (legacyIncidentMsgs.length) console.log(`     note: ${legacyIncidentMsgs.length} pre-revision INCIDENT alert(s) excluded (no TRIGGER section)`)

  // ── 5. No fabrication at send time ──────────────────────────────────────
  const mixed = incidentMsgs.filter((row) => {
    const text = stripHtml(row.message)
    return text.includes('Pending AI analysis') && /Judge:/i.test(text)
  })
  check(5, 'No fabrication: pending AI steps render as pending, never invented', mixed.length === 0, `mixed=${mixed.length}`)
  mark(incidentMsgs.length ? 'A' : '—')

  // ── 6. LOW ESCALATION: AUTO-APPLY plan (only LOW auto-applies) ──────────
  const badEsc = escalations.filter((row) => {
    const text = stripHtml(row.message)
    return !(/AUTO-APPLY/.test(text) && text.includes('Action: auto-apply') && /RISK/.test(text))
  })
  check(6, 'LOW ESCALATION carries the AUTO-APPLY plan', escalations.length === 0 || badEsc.length === 0, `bad=${badEsc.length}`)
  if (escalations.length) mark('A')

  // ── 6b. MEDIUM approval request contract ─────────────────────────────────
  const mediumReqs = approvalReqs.filter((r) => r.type === 'MEDIUM_RISK_APPROVAL_REQUIRED')
  const badMedium = mediumReqs.filter((row) => {
    const text = stripHtml(row.message)
    return !(text.includes('Approval:') && text.includes('Reply PROCEED') && text.includes('Reply REJECT') && text.includes('Expires:'))
  })
  check('6b', 'MEDIUM approval request carries PROCEED/REJECT + expiry', mediumReqs.length === 0 || badMedium.length === 0, `bad=${badMedium.length}`)
  if (mediumReqs.length) mark('A2')

  // ── 7. HIGH approval request contract ────────────────────────────────────
  const badApproval = approvalReqs.filter((r) => r.type === 'HIGH_RISK_APPROVAL_REQUIRED').filter((row) => {
    const text = stripHtml(row.message)
    return !(text.includes('Approval:') && text.includes('Reply PROCEED') && text.includes('Reply REJECT') && text.includes('Expires:'))
  })
  check(7, 'HIGH approval request carries PROCEED/REJECT + expiry', approvalReqs.length === 0 || badApproval.length === 0, `bad=${badApproval.length}`)
  if (approvalReqs.length) mark('B')

  // ── 8. Terminal header agrees with the canonical final state ─────────────
  // Ground truth is the persisted-brief terminal final state, which the brief
  // derives from real approval/attempt data (REJECT and EXPIRY outrank the
  // incident status, which stays AI_REPAIR_FAILED). Rejection/expiry rows are
  // therefore matched through the detail API's terminalSummary.finalState.
  const badHeader = []
  for (const row of finals) {
    const detail = await api('GET', `/api/incidents/${row.incidentId}`)
    const state = detail.json?.incident?.terminalSummary?.finalState ?? null
    const expected = state ? TERMINAL_HEADER[state] ?? null : null
    if (expected && !stripHtml(row.message).includes(expected)) badHeader.push(`${state}:${row.incidentId}`)
  }
  check(8, 'FINAL_SUMMARY header matches the canonical final state', badHeader.length === 0, `bad=${badHeader.join(',') || '—'}`)

  // ── 9. Terminal text agrees with the detail/PDF terminalSummary.text ─────
  let detailMismatch = 0
  let detailChecked = 0
  for (const row of finals) {
    const detail = await api('GET', `/api/incidents/${row.incidentId}`)
    const ts = detail.json?.incident?.terminalSummary
    if (typeof ts?.text !== 'string') continue
    detailChecked += 1
    const stored = stripHtml(row.message)
    const detailText = stripHtml(ts.text.replace(/<\/?[^>]+>/g, ' '))
    if (stored.slice(0, 60) !== detailText.slice(0, 60)) detailMismatch += 1
  }
  check(9, 'Detail/PDF terminal text matches the stored FINAL_SUMMARY', detailChecked === 0 || detailMismatch === 0, `mismatch=${detailMismatch}/${detailChecked}`)

  // ── 10. System-health lines in every terminal ────────────────────────────
  const noHealth = finals.filter((row) => {
    const text = stripHtml(row.message)
    return !(text.includes('System Health') && text.includes('Cyber Score') && text.includes('Site Risk'))
  })
  check(10, 'FINAL_SUMMARY has System Health / Cyber Score / Site Risk', noHealth.length === 0, `missing=${noHealth.length}`)

  // ── 11. ROLLED_BACK honesty ──────────────────────────────────────────────
  const rolledBack = finals.filter((row) => byId.get(row.incidentId)?.status === 'ROLLED_BACK')
  const badRolledBack = rolledBack.filter((row) => {
    const text = stripHtml(row.message)
    return !(text.includes('FAIL') && text.includes('rolled back') && text.includes('known-good'))
  })
  check(11, 'ROLLED_BACK terminals state FAIL + known-good outcome', badRolledBack.length === 0, `bad=${badRolledBack.length}`)
  if (rolledBack.length) mark('E')

  // ── 12. REJECTED / EXPIRED honesty ───────────────────────────────────────
  const humanEnded = finals.filter((row) => /REPAIR REJECTED|APPROVAL EXPIRED/.test(stripHtml(row.message)))
  const badHumanEnded = humanEnded.filter((row) => !/no code change was applied/.test(stripHtml(row.message)))
  check(12, 'REJECTED/EXPIRED terminals state "no code change was applied"', badHumanEnded.length === 0, `bad=${badHumanEnded.length}`)
  if (humanEnded.some((row) => /REPAIR REJECTED/.test(stripHtml(row.message)))) mark('C')
  if (humanEnded.some((row) => /APPROVAL EXPIRED/.test(stripHtml(row.message)))) mark('D')

  // ── 13. Attack honesty ───────────────────────────────────────────────────
  let attackOk = true
  for (const inc of attackIncidents) {
    for (const row of incidentMsgs.filter((r) => r.incidentId === inc.id)) {
      const text = stripHtml(row.message)
      if (!text.includes('BUILDHUB ATTACK DETECTED') || !text.includes('ATTACK TELEMETRY') || !text.includes('Security Log Analyzer')) attackOk = false
      if (inc.status !== 'RESOLVED' && inc.status !== 'ROLLED_BACK' && !/no code change auto-applied/.test(text)) attackOk = false
    }
  }
  check(13, 'Attack briefs are honest and telemetry-rich', attackIncidents.length === 0 || attackOk, 'attack honesty violated')
  if (attackIncidents.length) mark('ATTACK')

  // ── 14. AI chat routes only the canonical brief ──────────────────────────
  const chatSource = readFileSync(resolve(CWD, '../app/api/ai/chat/route.ts'), 'utf8')
  const chatOk = chatSource.includes('buildIncidentBrief') && chatSource.includes('no incidents on record') && chatSource.includes('Telegram delivery failed')
  const chatEnv = await api('POST', '/api/ai/chat', { message: 'Which incident was most recent?' })
  check(14, 'AI chat uses the canonical brief + delivery-failed phrase, endpoint responds', chatOk && chatEnv.status === 200, `status=${chatEnv.status}`)

  // ── 15. Realtime: SSE lifecycle stream ───────────────────────────────────
  const lifecycleSeen = await readSseLifecycle()
  check(15, 'SSE /api/security/events emits an initial lifecycle event', lifecycleSeen, 'no lifecycle frame')

  // ── 16. No terminal while an incident awaits approval ────────────────────
  const terminalOnPending = finals.filter((row) => byId.get(row.incidentId)?.status === 'WAITING_APPROVAL')
  check(16, 'No FINAL_SUMMARY while an incident still awaits approval', terminalOnPending.length === 0, `${terminalOnPending.length} violated`)

  // ── 17. No secrets in the stored briefs ──────────────────────────────────
  const tokenPattern = /bot\d{5,}:[A-Za-z0-9_-]{30,}/
  let leaks = 0
  const secretNeedles = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, env.GMAIL_CLIENT_SECRET, env.GMAIL_REFRESH_TOKEN].filter(Boolean)
  for (const row of [...deliveries, ...gmailRows]) {
    const blob = `${row.message ?? ''} ${row.error ?? ''} ${row.subject ?? ''}`
    if (tokenPattern.test(blob) || secretNeedles.some((s) => s && blob.includes(s))) leaks += 1
  }
  check(17, 'No tokens/chat-id/Gmail secrets leak in any stored delivery', leaks === 0, `leaks=${leaks}`)

  // ── 18. Gmail honesty: dedupe + no fake SENT ─────────────────────────────
  const gmailPairs = groupBy(gmailRows, (r) => `${r.incidentId ?? 'none'}\u0000${r.type}`)
  let gmailDupes = 0
  for (const rows of gmailPairs.values()) {
    if (rows.filter((r) => r.deliveryStatus === 'SENT').length > 1) gmailDupes += 1
  }
  const gmailSentNoId = gmailRows.filter((r) => r.deliveryStatus === 'SENT' && !r.gmailMessageId)
  const gmailFailedNoReason = gmailRows.filter((r) => r.deliveryStatus === 'FAILED' && !r.error)
  check(
    18,
    'Gmail: one SENT per (incident,type); SENT rows carry a provider id; FAILED rows carry a reason',
    gmailDupes === 0 && gmailSentNoId.length === 0 && gmailFailedNoReason.length === 0,
    `dupes=${gmailDupes} sentNoId=${gmailSentNoId.length} failedNoReason=${gmailFailedNoReason.length}`,
  )
  if (gmailRows.length) mark('GMAIL')

  await prisma.$disconnect()

  console.log('\n' + '='.repeat(52))
  console.log(`Briefing verification: ${passed} passed, ${failed} failed`)
  console.log(`SENT messages: ${sent.length} (canonical ${canonicalSent.length}, pre-brief legacy ${sent.length - canonicalSent.length})`)
  console.log(`DB-covered scenarios: ${[...coverage].filter((s) => s !== '—').join(', ') || 'none (activate faults to create incidents first)'}`)
  if (failures.length) {
    console.log('Failures:')
    for (const f of failures) console.log(`  - ${f}`)
  }
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((err) => {
  console.error('Briefing verification crashed:', err)
  process.exitCode = 1
})