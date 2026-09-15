import 'server-only'

import { prisma } from './db'
import { logger } from './logger'
import type { Incident, IncidentSeverity, NotificationType } from '@prisma/client'
import { buildIncidentBrief, finalStateOf } from './notifications/brief'
import { createApprovalTokens } from './approval-tokens'

// Phase 12 — Gmail notification channel (parallel to Telegram).
//
// Safety contract (mirrors lib/server/telegram.ts):
//   - OAuth client secret + refresh token are read from env, never logged,
//     never stored in the DB, never included in messages or API responses.
//     Error strings name the MISSING variable, never a value.
//   - Gmail never creates incident/repair/approval state — it renders the same
//     persisted brief Telegram uses and records its own delivery rows.
//   - When Gmail is not configured the send is an honest no-op returning
//     `configured:false` — it never persists a fake SENT row and callers must
//     report "GMAIL NOT CONFIGURED" instead of claiming delivery.
//   - Dedupe (permanent): at most ONE SENT message per (incident, type).
//
// Required env (server-only). Names follow the project's existing Gmail
// configuration (frontend/.env); GMAIL_REFRESH_TOKEN is minted once via the
// OAuth consent flow (see GMAIL_ALERTING.md) and is the only piece expected
// to be missing on a fresh setup.
const REQUIRED_VARS = [
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  'GMAIL_SENDER_EMAIL',
  'GMAIL_APPROVER_EMAIL',
] as const

const SENDER_VAR = 'GMAIL_SENDER_EMAIL'
const RECIPIENT_VAR = 'GMAIL_APPROVER_EMAIL'

export interface GmailConfigResult {
  configured: boolean
  missing: string[]
  sender: string | null
  recipient: string | null
}

export function gmailConfig(): GmailConfigResult {
  const missing = REQUIRED_VARS.filter((name) => !(process.env[name]?.trim()))
  return {
    configured: missing.length === 0,
    missing: [...missing],
    sender: process.env[SENDER_VAR]?.trim() || null,
    recipient: process.env[RECIPIENT_VAR]?.trim() || null,
  }
}

export function gmailNotConfiguredReason(): string {
  const { missing } = gmailConfig()
  return `GMAIL NOT CONFIGURED (missing ${missing.join(', ')}).`
}

export type GmailDeliveryStatus = 'SENT' | 'FAILED' | 'SKIPPED_DUPLICATE'

export interface SendGmailResult {
  ok: boolean
  configured: boolean
  deliveryStatus: GmailDeliveryStatus
  gmailMessageId: string | null
  error: string | null
}

interface SendGmailOptions {
  type: NotificationType
  subject: string
  text: string
  html: string
  incidentId?: string | null
  severity?: IncidentSeverity | null
}

// ---------------------------------------------------------------------------
// OAuth2 + Gmail API transport (fetch, 12s timeouts)
// ---------------------------------------------------------------------------

async function refreshAccessToken(): Promise<{ token: string | null; error: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GMAIL_CLIENT_ID?.trim() ?? '',
        client_secret: process.env.GMAIL_CLIENT_SECRET?.trim() ?? '',
        refresh_token: process.env.GMAIL_REFRESH_TOKEN?.trim() ?? '',
        grant_type: 'refresh_token',
      }).toString(),
      signal: controller.signal,
    })
    const data = (await res.json().catch(() => null)) as { access_token?: string; error?: string; error_description?: string } | null
    if (!res.ok || !data?.access_token) {
      const detail = data?.error_description ?? data?.error ?? `HTTP ${res.status}`
      return { token: null, error: `Gmail OAuth refresh failed: ${detail}`.slice(0, 300) }
    }
    return { token: data.access_token, error: null }
  } catch (err) {
    return { token: null, error: `Gmail OAuth refresh failed: ${err instanceof Error ? err.message : 'network error'}`.slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}

function base64Url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function buildMime(from: string, to: string, subject: string, text: string, html: string): string {
  const boundary = `buildhub-${Date.now().toString(36)}`
  const safeSubject = subject.replace(/[\r\n]+/g, ' ').slice(0, 200)
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

async function deliverMime(raw: string): Promise<{ messageId: string | null; error: string | null }> {
  const auth = await refreshAccessToken()
  if (!auth.token) return { messageId: null, error: auth.error }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ raw: base64Url(raw) }),
      signal: controller.signal,
    })
    const data = (await res.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null
    if (!res.ok || !data?.id) {
      return { messageId: null, error: `Gmail send failed: ${data?.error?.message ?? `HTTP ${res.status}`}`.slice(0, 300) }
    }
    return { messageId: data.id, error: null }
  } catch (err) {
    return { messageId: null, error: `Gmail send failed: ${err instanceof Error ? err.message : 'network error'}`.slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Persistence (append-only, permanent dedupe per (incident, type))
// ---------------------------------------------------------------------------

async function recordGmail(
  incidentId: string | null,
  type: NotificationType,
  severity: IncidentSeverity | null,
  recipient: string,
  subject: string,
  message: string,
  deliveryStatus: GmailDeliveryStatus,
  gmailMessageId: string | null,
  error: string | null,
): Promise<void> {
  await prisma.gmailNotification.create({
    data: {
      incidentId,
      type,
      severity,
      recipient,
      subject: subject.slice(0, 300),
      message,
      deliveryStatus,
      gmailMessageId,
      error: error?.slice(0, 500) ?? null,
      lastSentAt: deliveryStatus === 'SENT' ? new Date() : null,
    },
  })
}

export async function gmailAlreadySent(incidentId: string, type: NotificationType): Promise<boolean> {
  const row = await prisma.gmailNotification.findFirst({
    where: { incidentId, type, deliveryStatus: 'SENT' },
    select: { id: true },
  })
  return row !== null
}

export async function sendGmail({
  type,
  subject,
  text,
  html,
  incidentId = null,
  severity = null,
}: SendGmailOptions): Promise<SendGmailResult> {
  const config = gmailConfig()
  if (!config.configured) {
    // Honest audit row (never SENT): the dashboard, tests and operators see
    // exactly which variable is missing instead of silence.
    await recordGmail(
      incidentId, type, severity, config.recipient ?? '', subject, text, 'FAILED', null,
      gmailNotConfiguredReason(),
    )
    return {
      ok: false,
      configured: false,
      deliveryStatus: 'FAILED',
      gmailMessageId: null,
      error: gmailNotConfiguredReason(),
    }
  }
  const recipient = config.recipient ?? ''
  const sender = config.sender ?? ''

  if (incidentId && (await gmailAlreadySent(incidentId, type))) {
    await recordGmail(
      incidentId, type, severity, recipient, subject, text, 'SKIPPED_DUPLICATE', null,
      'Duplicate delivery skipped — a SENT message already exists for this incident and type.',
    )
    return {
      ok: false,
      configured: true,
      deliveryStatus: 'SKIPPED_DUPLICATE',
      gmailMessageId: null,
      error: 'Duplicate delivery skipped — a SENT message already exists for this incident and type.',
    }
  }

  // One retry on transport failure (OAuth/send), then an honest FAILED row.
  let attempt: { messageId: string | null; error: string | null } = { messageId: null, error: 'not attempted' }
  for (let i = 0; i < 2; i += 1) {
    attempt = await deliverMime(buildMime(sender, recipient, subject, text, html))
    if (attempt.messageId) break
    await new Promise((r) => setTimeout(r, 600 * (i + 1)))
  }

  if (attempt.messageId) {
    await recordGmail(incidentId, type, severity, recipient, subject, text, 'SENT', attempt.messageId, null)
    await logger.info({
      service: 'gmail',
      message: `Gmail ${type} delivered`,
      route: '/api/approvals/email',
      method: 'POST',
      status: 200,
      incidentId: incidentId ?? undefined,
    })
    return { ok: true, configured: true, deliveryStatus: 'SENT', gmailMessageId: attempt.messageId, error: null }
  }
  await recordGmail(incidentId, type, severity, recipient, subject, text, 'FAILED', null, attempt.error)
  return { ok: false, configured: true, deliveryStatus: 'FAILED', gmailMessageId: null, error: attempt.error }
}

// ---------------------------------------------------------------------------
// Email content (rendered from the canonical persisted brief — same facts as
// Telegram, the dashboard, the PDF and the AI chat)
// ---------------------------------------------------------------------------

function esc(value: string | null | undefined): string {
  return (value ?? 'n/a')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function row(label: string, value: string | null | undefined): string {
  return `<tr><td style="padding:6px 10px;color:#666;vertical-align:top;white-space:nowrap;">${esc(label)}</td><td style="padding:6px 10px;">${esc(value) || 'n/a'}</td></tr>`
}

function codeBlock(value: string | null | undefined): string {
  const body = esc(value).slice(0, 4000)
  return `<pre style="background:#f4f4f5;padding:10px;border-radius:6px;overflow-x:auto;font-size:12px;">${body}</pre>`
}

function pageShell(title: string, accent: string, body: string): string {
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111;">',
    `<div style="background:${accent};color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;font-weight:700;">${esc(title)}</div>`,
    '<div style="border:1px solid #e4e4e7;border-top:none;border-radius:0 0 8px 8px;padding:16px 18px;">',
    body,
    '<p style="color:#888;font-size:12px;margin-top:16px;">BuildHub Self-Healing DevOps · this message was generated from persisted incident state.</p>',
    '</div></div>',
  ].join('')
}

function appBaseUrl(): string {
  return (process.env.COMMAND_CENTER_URL ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

export interface ApprovalEmailInput {
  incident: Incident
  risk: 'MEDIUM' | 'HIGH'
  approvalId: string
}

export interface BuiltEmail {
  subject: string
  text: string
  html: string
  approveUrl: string
  rejectUrl: string
}

/** Renders the approval-request email (no sending — used by the sender and
 *  by the operator preview so "what you see" is byte-identical). */
export async function buildApprovalEmail({ incident, risk, approvalId }: ApprovalEmailInput): Promise<BuiltEmail> {
  const type: NotificationType = risk === 'MEDIUM' ? 'MEDIUM_RISK_APPROVAL_REQUIRED' : 'HIGH_RISK_APPROVAL_REQUIRED'
  const brief = await buildIncidentBrief(incident.id)

  const approvalRow = await prisma.approval.findUnique({ where: { approvalId }, select: { id: true, expiresAt: true } })
  let approveUrl = `${appBaseUrl()}/ai/incidents/${incident.id}`
  let rejectUrl = approveUrl
  if (approvalRow) {
    const tokens = await createApprovalTokens(approvalRow.id, approvalRow.expiresAt)
    const approve = tokens.find((t) => t.action === 'APPROVE')
    const reject = tokens.find((t) => t.action === 'REJECT')
    if (approve) approveUrl = `${appBaseUrl()}/api/approvals/email?token=${approve.token}`
    if (reject) rejectUrl = `${appBaseUrl()}/api/approvals/email?token=${reject.token}`
  }

  const accent = risk === 'MEDIUM' ? '#b45309' : '#b91c1c'
  const subject = `[BuildHub][${risk}] Approval Required — Incident ${incident.ref}`
  const rounds = brief?.aiAnalysis.rounds ?? []
  const judge = brief?.aiAnalysis.judge ?? null
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const finalCriticVerdict = lastRound?.critic.verdict ?? 'n/a'
  const judgeRecommendation = judge?.decision === 'APPROVE' ? 'PROCEED' : 'REJECT'
  // All values below come from the persisted incident + brief — never raw
  // stacks, never secrets. Long code is truncated for deliverability.
  const before = (brief?.codeChange?.before ?? 'n/a').slice(0, 2000)
  const after = (brief?.codeChange?.after ?? 'n/a').slice(0, 2000)
  const hist = brief?.history ?? null
  const expiresAt = brief?.approval?.expiresAt ?? null
  const attemptId = brief?.attempt?.attemptId ?? 'n/a'
  const incidentTimestamp = brief?.incident.createdAt ?? incident.createdAt.toISOString()
  const httpStatus = hist?.httpStatus ?? 'n/a'

  const roundText = rounds
    .map((r) => {
      const parts = [
        `Iteration ${r.round} — CODER: ${r.coder.diagnosis ?? r.coder.status} (confidence ${r.coder.confidence ?? 'n/a'})`,
        `Iteration ${r.round} — CRITIC verdict: ${r.critic.verdict ?? 'n/a'}${r.critic.reasoning ? ` — ${r.critic.reasoning}` : ''}`,
      ]
      if (r.critic.requiredChanges.length > 0) parts.push(`Coder was asked to change: ${r.critic.requiredChanges.join('; ')}`)
      if (r.critic.problems.length > 0) parts.push(`Problems found: ${r.critic.problems.join('; ')}`)
      if (r.critic.securityConcerns.length > 0) parts.push(`Security concerns: ${r.critic.securityConcerns.join('; ')}`)
      if (r.critic.testsRequired.length > 0) parts.push(`Missing validation: ${r.critic.testsRequired.join('; ')}`)
      return parts.join('\n')
    })
    .join('\n')

  const historyText = hist && hist.previous.length > 0
    ? hist.previous
      .map((p) => `${p.ref} (${p.status}, ${p.severity}): root cause "${(p.rootCause ?? 'n/a').slice(0, 160)}"; outcome ${p.outcome ?? 'unknown'}; reward ${p.reward ?? 'n/a'}; human ${p.humanDecision ?? 'n/a'}`)
      .join('\n')
    : 'No previous occurrences of this error signature. Historical repairs below are CONTEXT ONLY — do not blindly reuse an old patch; current evidence is authoritative.'

  const canonicalPlan = [
    '1. Apply patch.',
    '2. Restart affected service.',
    '3. Reproduce original failure.',
    '4. Confirm original failure is gone.',
    '5. Run relevant API test.',
    '6. Run regression tests.',
    '7. Verify logs contain no new errors.',
    '8. Verify service health.',
    '9. Rollback if any critical validation fails.',
  ].join('\n')

  const text = [
    `${risk}-RISK CHANGE — human approval required before any patch is applied. No patch has been applied yet.`,
    '',
    'A. INCIDENT',
    `Incident ID: ${incident.ref}`,
    `Timestamp: ${incidentTimestamp}`,
    'Application/service: BuildHub API',
    `Endpoint: ${incident.method} ${incident.endpoint}`,
    `HTTP status: ${httpStatus}`,
    `WHAT IS THE PROBLEM? ${incident.title}`,
    `Error message: ${brief?.incident.summary ?? incident.summary ?? incident.title}`,
    `Error signature: ${hist?.signature ?? 'n/a'}`,
    `Severity: ${incident.severity}`,
    `Risk level: ${risk} — ${brief?.risk.reason ?? 'n/a'}`,
    '',
    'B. DETECTION EVIDENCE',
    `Log evidence: ${(hist?.logExcerpt ?? 'n/a').slice(0, 500)}`,
    `Request ID: ${brief?.incident.requestId ?? incident.requestId ?? 'n/a'}`,
    `Occurrences linked to this incident: ${hist?.occurrences ?? 'n/a'}`,
    `Related previous incidents: ${hist?.previous.length ?? 0} (see section G)`,
    `Detected by: ${brief?.incident.detectedBy ?? incident.detectedBy ?? 'n/a'} (risk score ${brief?.incident.riskScore ?? incident.riskScore})`,
    '',
    'C. ROOT CAUSE ANALYSIS',
    `What failed: ${incident.title}`,
    `Why it failed: ${brief?.rootCause ?? incident.expectedRootCause ?? 'n/a'}`,
    `WHAT CAUSED IT? ${brief?.rootCause ?? incident.expectedRootCause ?? 'n/a'}`,
    `Affected file: ${brief?.location?.file ?? 'n/a'}`,
    `Exact line/range: ${brief?.location?.line ?? 'n/a'}`,
    `Function/module: ${brief?.location?.function ?? 'n/a'}`,
    `Why the evidence supports this: ${lastRound?.coder.diagnosis ?? 'n/a'}`,
    `If left unfixed: ${lastRound?.coder.affectedBehavior ?? 'continued failures on this endpoint'}`,
    '',
    'D. CODER AGENT',
    `Investigated: ${brief?.location?.file ?? 'n/a'}${brief?.location?.line != null ? `:${brief.location.line}` : ''} (${brief?.location?.function ?? 'n/a'})`,
    `Root cause conclusion: ${brief?.rootCause ?? 'n/a'}`,
    `Proposed patch: ${brief?.proposedFix ?? 'n/a'}`,
    `BEFORE CODE: ${before}`,
    `PROPOSED AFTER CODE: ${after}`,
    `Why the patch fixes it: ${lastRound?.coder.diagnosis ?? 'n/a'}`,
    `Potential side effects: ${lastRound && lastRound.critic.problems.length > 0 ? lastRound.critic.problems.join('; ') : 'none flagged by Critic'}`,
    `CODER ANALYSIS: ${rounds.map((r) => `Round ${r.round}: ${r.coder.diagnosis ?? r.coder.status}`).join(' | ') || 'n/a'} (confidence ${lastRound?.coder.confidence ?? 'n/a'})`,
    '',
    'E. CRITIC AGENT (independent review)',
    roundText || 'CRITIC ANALYSIS: n/a',
    `CRITIC ANALYSIS: final verdict ${finalCriticVerdict}`,
    '',
    'F. JUDGE AGENT',
    `Evidence considered: ${incident.method} ${incident.endpoint} failure (${httpStatus}), Coder diagnosis, Critic ${finalCriticVerdict}, ${hist?.previous.length ?? 0} historical occurrence(s)`,
    `Coder conclusion: ${lastRound?.coder.diagnosis ?? 'n/a'}`,
    `Critic conclusion: ${finalCriticVerdict}${lastRound?.critic.reasoning ? ` — ${lastRound.critic.reasoning}` : ''}`,
    `Historical evidence: ${hist && hist.previous.length > 0 ? `${hist.previous.length} previous occurrence(s), latest outcome ${hist.previous[0].outcome ?? 'unknown'} (reward ${hist.previous[0].reward ?? 'n/a'})` : 'first occurrence'}`,
    `Risk assessment: ${risk} — ${brief?.risk.reason ?? 'n/a'}`,
    `Expected impact: ${lastRound?.coder.affectedBehavior ?? 'endpoint restored'}`,
    `Required validation: ${judge && judge.validationItems.length > 0 ? judge.validationItems.join('; ') : 'apply, re-run failing request, regression probes'}`,
    'Rollback strategy: original bytes checkpointed (SHA-256); automatic restore + ROLLED_BACK if validation fails.',
    `JUDGE DECISION: ${judge ? `${judge.decision} (confidence ${judge.confidence ?? 'n/a'}) — ${judge.reasoning ?? ''}` : 'n/a'}`,
    `Final recommendation: ${judgeRecommendation}`,
    '',
    'G. HISTORICAL / MEMORY CONTEXT (context only — never blindly reuse)',
    historyText,
    '',
    'H. VALIDATION PLAN',
    `VALIDATION PLAN: ${brief?.validationPlan ?? 'n/a'}`,
    canonicalPlan,
    'ROLLBACK PLAN: the original bytes are checkpointed (SHA-256) and restored automatically if validation fails; incident becomes ROLLED_BACK with a negative learning signal.',
    '',
    'I. APPROVAL DECISION',
    `APPROVE: ${approveUrl}`,
    `REJECT: ${rejectUrl}`,
    `Approval ${approvalId} · incident ${incident.ref} · repair attempt ${attemptId} · expires ${expiresAt ?? 'in 5 minutes'} · one-time links, idempotent replays.`,
    '',
    'BuildHub Self-Healing: approval authorizes the repair only — validation decides RESOLVED vs ROLLED_BACK.',
  ].join('\n')

  const button = (url: string, label: string, color: string) =>
    `<a href="${esc(url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:700;padding:12px 26px;border-radius:8px;margin:6px 8px 6px 0;">${esc(label)}</a>`
  const sec = (t: string) => `<h3 style="margin:18px 0 6px;">${esc(t)}</h3>`

  const html = pageShell(
    `${risk === 'MEDIUM' ? '🟡' : '🔴'} ${risk}-RISK REPAIR — APPROVAL REQUIRED (${incident.ref})`,
    accent,
    [
      sec('A. Incident'),
      `<table style="border-collapse:collapse;font-size:14px;">${row('Incident', `${incident.ref} · ${incident.severity}`)}${row('Timestamp', incidentTimestamp)}${row('Service', 'BuildHub API')}${row('Endpoint', `${incident.method} ${incident.endpoint}`)}${row('HTTP status', String(httpStatus))}${row('Problem', incident.title)}${row('Signature', hist?.signature)}${row('Risk', `${risk} — ${brief?.risk.reason ?? ''}`)}</table>`,
      sec('B. Detection evidence'),
      `<table style="border-collapse:collapse;font-size:14px;">${row('Request ID', brief?.incident.requestId ?? incident.requestId)}${row('Occurrences', hist?.occurrences != null ? String(hist.occurrences) : null)}${row('Detected by', brief?.incident.detectedBy ?? incident.detectedBy)}${row('Log', hist?.logExcerpt?.slice(0, 500))}</table>`,
      sec('C. Root cause'),
      `<table style="border-collapse:collapse;font-size:14px;">${row('Cause', brief?.rootCause ?? incident.expectedRootCause)}${row('File', brief?.location?.file)}${row('Line', brief?.location?.line != null ? String(brief.location.line) : null)}${row('Function', brief?.location?.function)}${row('If unfixed', lastRound?.coder.affectedBehavior)}</table>`,
      sec('D. Coder — before / after'),
      '<h4>Before</h4>', codeBlock(before),
      '<h4>Proposed after</h4>', codeBlock(after),
      `<p>${esc(`Why it fixes the problem: ${lastRound?.coder.diagnosis ?? 'n/a'} (confidence ${lastRound?.coder.confidence ?? 'n/a'})`)}</p>`,
      sec('E. Critic — independent review by iteration'),
      ...rounds.flatMap((r) => [
        `<p><strong>${esc(`Iteration ${r.round} — verdict ${r.critic.verdict ?? 'n/a'}`)}</strong><br>${esc(r.critic.reasoning ?? '')}${
          r.critic.requiredChanges.length > 0 ? `<br>Asked Coder to change: ${esc(r.critic.requiredChanges.join('; '))}` : ''
        }${r.critic.securityConcerns.length > 0 ? `<br>Security: ${esc(r.critic.securityConcerns.join('; '))}` : ''}</p>`,
      ]),
      sec('F. Judge'),
      `<p>${esc(`Decision ${judge?.decision ?? 'n/a'} → recommendation ${judgeRecommendation}. ${judge?.reasoning ?? ''}`)}</p>`,
      sec('G. History (context only)'),
      `<p>${esc(hist && hist.previous.length > 0 ? hist.previous.map((p) => `${p.ref}: outcome ${p.outcome ?? '?'} reward ${p.reward ?? '?'}`).join(' · ') : 'First occurrence — no previous repairs. Never blindly reuse old patches.')}</p>`,
      sec('H. Validation plan'),
      `<p>${esc(brief?.validationPlan ?? 'n/a')}</p><pre style="font-size:12px;">${esc(canonicalPlan)}</pre>`,
      sec('I. Approval decision'),
      `<div style="margin-top:14px;">${button(approveUrl, risk === 'MEDIUM' ? 'APPROVE REPAIR' : 'APPROVE HIGH-RISK REPAIR', '#15803d')}${button(rejectUrl, 'REJECT', '#b91c1c')}</div>`,
      `<p style="color:#666;font-size:13px;">${esc(`Approval ${approvalId} · attempt ${attemptId} · expires ${expiresAt ?? 'in 5 minutes'} · one-time links, idempotent replays.`)}</p>`,
    ].join(''),
  )

  return { subject, text, html, approveUrl, rejectUrl }
}

/** Approval-request email with one-click APPROVE/REJECT buttons (sends the
 *  rendered content through the Gmail delivery layer with dedupe). */
export async function sendApprovalEmail({ incident, risk, approvalId }: ApprovalEmailInput): Promise<SendGmailResult> {
  const type: NotificationType = risk === 'MEDIUM' ? 'MEDIUM_RISK_APPROVAL_REQUIRED' : 'HIGH_RISK_APPROVAL_REQUIRED'
  const built = await buildApprovalEmail({ incident, risk, approvalId })
  return sendGmail({ type, subject: built.subject, text: built.text, html: built.html, incidentId: incident.id, severity: incident.severity })
}

export interface FinalEmailInput {
  incident: Incident
}

/** Renders the terminal lifecycle email (no sending). */
export async function buildFinalEmail({ incident }: FinalEmailInput): Promise<BuiltEmail> {
  const fresh = (await prisma.incident.findUnique({ where: { id: incident.id } })) ?? incident
  const brief = await buildIncidentBrief(fresh.id)
  const finalState = brief ? finalStateOf(brief) : 'AI_REPAIR_FAILED'
  const risk = (brief?.risk.tier === 'MEDIUM' || brief?.risk.tier === 'HIGH' ? brief.risk.tier : fresh.severity === 'MEDIUM' || fresh.severity === 'HIGH' ? fresh.severity : 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH'
  const subject = `[BuildHub][${risk}] Repair ${finalState} — Incident ${fresh.ref}`
  const accent = finalState === 'RESOLVED' ? '#15803d' : '#b91c1c'
  const patch = brief?.patch
  const validation = brief?.validation

  const text = [
    risk === 'LOW' ? 'A low-risk repair was automatically applied.' : 'Repair lifecycle completed.',
    '',
    `Incident: ${fresh.ref}`,
    `Problem: ${fresh.title}`,
    `Root cause: ${brief?.rootCause ?? fresh.expectedRootCause ?? 'n/a'}`,
    `File: ${brief?.location?.file ?? 'n/a'}`,
    `Repair: ${brief?.proposedFix ?? patch?.patchId ?? 'n/a'}`,
    `Validation: ${validation?.result ?? 'not run'}${validation?.detail ? ` — ${validation.detail}` : ''}`,
    `Final status: ${finalState}`,
    patch?.status === 'ROLLED_BACK' || finalState === 'ROLLED_BACK' ? 'Rollback occurred: original bytes were restored.' : 'Rollback: not required.',
    `Outcome: ${finalState === 'RESOLVED' ? 'application recovered and verified' : 'see incident detail'}`,
  ].join('\n')

  const html = pageShell(
    `Repair ${finalState} (${fresh.ref})`,
    accent,
    [
      `<table style="border-collapse:collapse;font-size:14px;">${row('Incident', fresh.ref)}${row('Problem', fresh.title)}${row('Root cause', brief?.rootCause ?? fresh.expectedRootCause)}${row('File', brief?.location?.file)}${row('Repair', brief?.proposedFix ?? patch?.patchId)}${row('Validation', `${validation?.result ?? 'not run'}${validation?.detail ? ` — ${validation.detail}` : ''}`)}${row('Final status', finalState)}${row('Rollback', patch?.status === 'ROLLED_BACK' || finalState === 'ROLLED_BACK' ? 'occurred — original bytes restored' : 'not required')}</table>`,
      `<p><a href="${esc(`${appBaseUrl()}/ai/incidents/${fresh.id}`)}">Open incident in BuildHub</a></p>`,
    ].join(''),
  )

  return { subject, text, html, approveUrl: `${appBaseUrl()}/ai/incidents/${fresh.id}`, rejectUrl: `${appBaseUrl()}/ai/incidents/${fresh.id}` }
}

/** Terminal lifecycle email (sends the rendered content with dedupe). */
export async function sendFinalEmail({ incident }: FinalEmailInput): Promise<SendGmailResult> {
  const fresh = (await prisma.incident.findUnique({ where: { id: incident.id } })) ?? incident
  const built = await buildFinalEmail({ incident: fresh })
  return sendGmail({ type: 'FINAL_SUMMARY', subject: built.subject, text: built.text, html: built.html, incidentId: fresh.id, severity: fresh.severity })
}

/** Gmail delivery history for an incident (newest first, for UI binding). */
export async function gmailDeliveriesForIncident(incidentId: string, take = 12) {
  return prisma.gmailNotification.findMany({
    where: { incidentId },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, type: true, severity: true, subject: true, deliveryStatus: true, gmailMessageId: true, error: true, createdAt: true },
  })
}
