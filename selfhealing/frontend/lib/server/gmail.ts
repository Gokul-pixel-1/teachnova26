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
  return (value ?? 'Not recorded')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function row(label: string, value: string | null | undefined): string {
  return `<tr><td style="padding:7px 10px;color:#64748b;vertical-align:top;width:120px;font-size:12px;line-height:18px;">${esc(label)}</td><td style="padding:7px 10px;color:#172033;font-size:13px;line-height:19px;word-break:break-word;">${esc(value) || 'Not recorded'}</td></tr>`
}

function codeBlock(value: string | null | undefined): string {
  const body = esc(value).slice(0, 4000)
  return `<pre style="margin:8px 0 0;background:#0f172a;color:#dbeafe;border:1px solid #1e293b;padding:12px;border-radius:7px;white-space:pre-wrap;word-break:break-word;font:11px/17px SFMono-Regular,Consolas,Liberation Mono,monospace;">${body}</pre>`
}

function pageShell(title: string, accent: string, body: string): string {
  return [
    '<div style="margin:0;padding:24px 10px;background:#eef2f6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;color:#172033;">',
    '<div style="max-width:650px;margin:0 auto;background:#ffffff;border:1px solid #dbe3ec;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,.08);">',
    `<div style="height:5px;background:${accent};font-size:0;line-height:0;">&nbsp;</div>`,
    `<div style="padding:24px 24px 20px;background:#0f172a;color:#ffffff;"><div style="font-size:10px;line-height:16px;letter-spacing:2px;font-weight:700;color:#67e8f9;">BUILDHUB AI SELF-HEALING</div><div style="margin-top:7px;font-size:23px;line-height:30px;font-weight:700;">${esc(title)}</div></div>`,
    '<div style="padding:20px 20px 24px;">',
    body,
    '<p style="color:#64748b;font-size:11px;line-height:17px;margin:22px 4px 0;border-top:1px solid #e2e8f0;padding-top:14px;">Generated from persisted BuildHub incident state. This message never includes credentials, OAuth tokens, API keys, client secrets, or private chain-of-thought.</p>',
    '</div></div></div>',
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
  const brief = await buildIncidentBrief(incident.id)
  const [approvalRow, analyzer] = await Promise.all([
    prisma.approval.findUnique({
      where: { approvalId },
      select: { id: true, status: true, createdAt: true, expiresAt: true },
    }),
    prisma.agentRun.findFirst({
      where: { incidentId: incident.id, kind: 'ANALYZER' },
      orderBy: { createdAt: 'desc' },
      select: { status: true, outputSummary: true, currentActivity: true, confidence: true },
    }),
  ])
  let approveUrl = `${appBaseUrl()}/ai/incidents/${incident.id}`
  let rejectUrl = approveUrl
  if (approvalRow) {
    const tokens = await createApprovalTokens(approvalRow.id, approvalRow.expiresAt)
    const approve = tokens.find((t) => t.action === 'APPROVE')
    const reject = tokens.find((t) => t.action === 'REJECT')
    if (approve) approveUrl = `${appBaseUrl()}/api/approvals/email?token=${approve.token}`
    if (reject) rejectUrl = `${appBaseUrl()}/api/approvals/email?token=${reject.token}`
  }

  const persistedRisk = brief?.risk.tier === 'MEDIUM' || brief?.risk.tier === 'HIGH'
    ? brief.risk.tier
    : risk
  const accent = persistedRisk === 'MEDIUM' ? '#d97706' : '#dc2626'
  const subject = `[BuildHub][${persistedRisk}] Repair Approval Required — ${incident.ref}`
  const rounds = brief?.aiAnalysis.rounds ?? []
  const judge = brief?.aiAnalysis.judge ?? null
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const finalCriticVerdict = lastRound?.critic.verdict ?? 'n/a'
  const judgeRecommendation = judge?.decision === 'APPROVE' ? 'PROCEED' : 'REJECT'
  const before = (brief?.codeChange?.before ?? 'n/a').slice(0, 2000)
  const after = (brief?.codeChange?.after ?? 'n/a').slice(0, 2000)
  const hist = brief?.history ?? null
  const expiresAt = approvalRow?.expiresAt.toISOString() ?? brief?.approval?.expiresAt ?? null
  const attemptId = brief?.attempt?.attemptId ?? 'n/a'
  const incidentTimestamp = brief?.incident.createdAt ?? incident.createdAt.toISOString()
  const httpStatus = hist?.httpStatus ?? 'n/a'
  const approvalStatus = approvalRow?.status ?? brief?.approval?.status ?? 'PENDING'
  const analyzerSummary = analyzer?.outputSummary ?? analyzer?.currentActivity ?? brief?.rootCause ?? 'Pending persisted Analyzer summary.'
  const evidenceUsed = [
    hist?.logExcerpt ? `Log: ${hist.logExcerpt.slice(0, 320)}` : null,
    incident.requestId ? `Request ${incident.requestId}` : null,
    brief?.location?.file ? `${brief.location.file}${brief.location.line != null ? `:${brief.location.line}` : ''}` : null,
  ].filter(Boolean).join(' · ') || 'Incident record and linked error evidence.'
  const securityConcerns = lastRound?.critic.securityConcerns.length
    ? lastRound.critic.securityConcerns.join('; ')
    : 'No security concern was recorded by the Critic.'
  const regressionConcerns = lastRound?.critic.problems.length
    ? lastRound.critic.problems.join('; ')
    : 'No regression concern was recorded by the Critic.'
  const validationItems = [...new Set([
    ...(judge?.validationItems ?? []),
    brief?.validationPlan ?? null,
    `Re-run ${incident.method} ${incident.endpoint} and verify the expected success response.`,
    'Run related API and regression tests; verify health and error logs.',
  ].filter((value): value is string => Boolean(value)))]
  const rollbackPlan = 'Before applying the candidate, BuildHub checkpoints the original bytes and SHA-256. If any validation probe fails, the original bytes are restored, integrity is verified, and the incident becomes ROLLED_BACK.'

  const text = [
    'BUILDHUB AI SELF-HEALING',
    'Repair Approval Required',
    '',
    `Incident: ${incident.ref}`,
    `Risk: ${persistedRisk}`,
    `Problem: ${incident.title}`,
    `Affected endpoint: ${incident.method} ${incident.endpoint}`,
    `Approval status: ${approvalStatus}`,
    '',
    '--------------------------------',
    '1. INCIDENT',
    '--------------------------------',
    `WHAT IS THE PROBLEM? ${incident.title}`,
    `What happened: ${brief?.incident.summary ?? incident.summary ?? incident.description}`,
    `HTTP status: ${httpStatus}`,
    `Error: ${incident.errorCode ?? hist?.signature ?? 'n/a'}`,
    `Timestamp: ${incidentTimestamp}`,
    `Request ID: ${brief?.incident.requestId ?? incident.requestId ?? 'n/a'}`,
    '',
    '--------------------------------',
    '2. AI ROOT CAUSE',
    '--------------------------------',
    `WHAT CAUSED IT? ${brief?.rootCause ?? incident.expectedRootCause ?? 'n/a'}`,
    `File: ${brief?.location?.file ?? 'n/a'}`,
    `Line: ${brief?.location?.line ?? 'n/a'}`,
    `Function: ${brief?.location?.function ?? 'n/a'}`,
    '',
    '--------------------------------',
    '3. AGENT-1 ANALYZER',
    '--------------------------------',
    `Diagnosis summary: ${analyzerSummary}`,
    `Evidence used: ${evidenceUsed}`,
    `Confidence: ${analyzer?.confidence ?? lastRound?.coder.confidence ?? 'n/a'}`,
    '',
    '--------------------------------',
    '4. AGENT-2 CODER',
    '--------------------------------',
    `Proposed patch: ${brief?.proposedFix ?? 'n/a'}`,
    `BEFORE CODE: ${before}`,
    `PROPOSED AFTER CODE: ${after}`,
    `Files changed: ${brief?.location?.file ?? brief?.patch?.file ?? 'n/a'}`,
    `Why the patch fixes it: ${lastRound?.coder.diagnosis ?? 'n/a'}`,
    `CODER ANALYSIS: ${rounds.map((r) => `Round ${r.round}: ${r.coder.diagnosis ?? r.coder.status}`).join(' | ') || 'n/a'} (confidence ${lastRound?.coder.confidence ?? 'n/a'})`,
    '',
    '--------------------------------',
    '5. AGENT-3 CRITIC',
    '--------------------------------',
    `Independent review: ${lastRound?.critic.reasoning ?? 'n/a'}`,
    `Security concerns: ${securityConcerns}`,
    `Regression concerns: ${regressionConcerns}`,
    `CRITIC ANALYSIS: final verdict ${finalCriticVerdict}`,
    '',
    '--------------------------------',
    '6. JUDGE',
    '--------------------------------',
    `Risk: ${persistedRisk}`,
    `Confidence: ${judge?.confidence ?? 'n/a'}`,
    `Decision: ${judge?.decision ?? 'n/a'} / ${judgeRecommendation}`,
    `Reason: ${judge?.reasoning ?? brief?.risk.reason ?? 'n/a'}`,
    `JUDGE DECISION: ${judge ? `${judge.decision} (confidence ${judge.confidence ?? 'n/a'}) — ${judge.reasoning ?? ''}` : 'n/a'}`,
    '',
    '--------------------------------',
    '7. VALIDATION PLAN',
    '--------------------------------',
    'VALIDATION PLAN:',
    ...validationItems.map((item, index) => `${index + 1}. ${item}`),
    '',
    '--------------------------------',
    '8. ROLLBACK',
    '--------------------------------',
    `ROLLBACK PLAN: ${rollbackPlan}`,
    '',
    '--------------------------------',
    'HUMAN DECISION',
    '--------------------------------',
    `[ APPROVE REPAIR ] ${approveUrl}`,
    `[ REJECT REPAIR ] ${rejectUrl}`,
    'Approval expires in 5 minutes.',
    `Expires at: ${expiresAt ?? 'n/a'}`,
    `Approval ${approvalId} · repair attempt ${attemptId} · current status ${approvalStatus}.`,
    '',
    'Approval authorizes only this repair attempt. Validation determines RESOLVED or ROLLED_BACK.',
  ].join('\n').replace(/\bn\/a\b/g, 'Not recorded')

  const button = (url: string, label: string, color: string, secondary = false) =>
    `<a href="${esc(url)}" style="display:inline-block;background:${secondary ? '#ffffff' : color};color:${secondary ? color : '#ffffff'};border:1px solid ${color};text-decoration:none;font-size:13px;line-height:18px;font-weight:700;padding:12px 20px;border-radius:7px;margin:5px 8px 5px 0;">${esc(label)}</a>`
  const section = (number: string, title: string, body: string) => [
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 12px;border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;">',
    `<tr><td style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:11px;line-height:16px;letter-spacing:1.1px;font-weight:800;color:#334155;">${esc(number)}. ${esc(title)}</td></tr>`,
    `<tr><td style="padding:10px 10px 12px;">${body}</td></tr></table>`,
  ].join('')
  const table = (rows: string) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${rows}</table>`
  const note = (value: string) => `<p style="margin:6px 10px;color:#475569;font-size:13px;line-height:20px;">${esc(value)}</p>`
  const validationList = `<ol style="margin:4px 0 4px 24px;padding:0;color:#334155;font-size:13px;line-height:21px;">${validationItems.map((item) => `<li style="margin:3px 0;">${esc(item)}</li>`).join('')}</ol>`

  const html = pageShell(
    `${persistedRisk}-risk Repair Approval Required · ${incident.ref}`,
    accent,
    [
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 14px;border-collapse:separate;border-spacing:0;background:#f8fafc;border-left:4px solid ${accent};"><tr><td style="padding:12px 14px;">${table(`${row('Incident', incident.ref)}${row('Risk', persistedRisk)}${row('Problem', incident.title)}${row('Affected endpoint', `${incident.method} ${incident.endpoint}`)}${row('Approval status', approvalStatus)}`)}</td></tr></table>`,
      section('1', 'INCIDENT', table(`${row('What happened', brief?.incident.summary ?? incident.summary ?? incident.description)}${row('HTTP status', String(httpStatus))}${row('Error', incident.errorCode ?? hist?.signature)}${row('Timestamp', incidentTimestamp)}${row('Request ID', brief?.incident.requestId ?? incident.requestId)}`)),
      section('2', 'AI ROOT CAUSE', `${note(brief?.rootCause ?? incident.expectedRootCause ?? 'n/a')}${table(`${row('File', brief?.location?.file)}${row('Line', brief?.location?.line != null ? String(brief.location.line) : null)}${row('Function', brief?.location?.function)}`)}`),
      section('3', 'AGENT-1 ANALYZER', table(`${row('Diagnosis summary', analyzerSummary)}${row('Evidence used', evidenceUsed)}${row('Confidence', analyzer?.confidence != null ? String(analyzer.confidence) : lastRound?.coder.confidence != null ? String(lastRound.coder.confidence) : null)}`)),
      section('4', 'AGENT-2 CODER', `${table(`${row('Proposed fix', brief?.proposedFix)}${row('Files changed', brief?.location?.file ?? brief?.patch?.file)}${row('Why this fixes it', lastRound?.coder.diagnosis)}${row('Confidence', lastRound?.coder.confidence != null ? String(lastRound.coder.confidence) : null)}`)}<div style="margin:10px;"><div style="font-size:10px;font-weight:800;letter-spacing:1px;color:#64748b;">BEFORE</div>${codeBlock(before)}<div style="margin-top:12px;font-size:10px;font-weight:800;letter-spacing:1px;color:#64748b;">AFTER</div>${codeBlock(after)}</div>`),
      section('5', 'AGENT-3 CRITIC', table(`${row('Independent review', lastRound?.critic.reasoning)}${row('Security concerns', securityConcerns)}${row('Regression concerns', regressionConcerns)}${row('Verdict', finalCriticVerdict)}`)),
      section('6', 'JUDGE', table(`${row('Risk', persistedRisk)}${row('Confidence', judge?.confidence != null ? String(judge.confidence) : null)}${row('Decision', judge ? `${judge.decision} / ${judgeRecommendation}` : null)}${row('Reason', judge?.reasoning ?? brief?.risk.reason)}`)),
      section('7', 'VALIDATION PLAN', validationList),
      section('8', 'ROLLBACK', note(rollbackPlan)),
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;border:1px solid ${accent};border-radius:9px;border-collapse:separate;"><tr><td style="padding:16px 18px;"><div style="font-size:11px;line-height:16px;letter-spacing:1.3px;font-weight:800;color:#334155;">HUMAN DECISION</div><div style="margin-top:9px;">${button(approveUrl, 'APPROVE REPAIR', '#15803d')}${button(rejectUrl, 'REJECT REPAIR', '#b91c1c', true)}</div><p style="margin:10px 0 0;color:#b45309;font-size:13px;font-weight:700;">Approval expires in 5 minutes.</p><p style="margin:4px 0 0;color:#64748b;font-size:11px;line-height:17px;">${esc(`Approval ${approvalId} · attempt ${attemptId} · expires ${expiresAt ?? 'Not recorded'} · current status ${approvalStatus}. One-time, idempotent decision links.`)}</p></td></tr></table>`,
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

/** Security-incident communication built only from persisted incident,
 * SecurityFinding, LogEvent and AgentRun rows. ESCALATION dedupe guarantees
 * one delivered assessment per incident even when the detector retries. */
export async function sendSecurityIncidentEmail({ incident }: { incident: Incident }): Promise<SendGmailResult> {
  const fresh = (await prisma.incident.findUnique({ where: { id: incident.id } })) ?? incident
  const ruleId = fresh.errorCode ?? ''
  const [finding, runs, logs] = await Promise.all([
    ruleId
      ? prisma.securityFinding.findFirst({ where: { ruleId: { equals: ruleId, mode: 'insensitive' } }, orderBy: { createdAt: 'desc' } })
      : Promise.resolve(null),
    prisma.agentRun.findMany({ where: { incidentId: fresh.id }, orderBy: { createdAt: 'asc' } }),
    prisma.logEvent.findMany({
      where: { OR: [{ incidentId: fresh.id }, { errorCode: { in: ['AUTH_FAILED', 'AUTH_BURST', 'IP_BLOCKED'] } }] },
      orderBy: { createdAt: 'asc' }, take: 80,
    }),
  ])
  const suspicious = finding?.hitCount ?? logs.filter((row) => row.errorCode === 'AUTH_FAILED').length
  const blocked = logs.filter((row) => row.errorCode === 'IP_BLOCKED')
  const mitigation = blocked.length > 0
    ? `Temporary source-IP block/rate limit rejected ${blocked.length} request${blocked.length === 1 ? '' : 's'}.`
    : (finding?.detail ?? 'No mitigation record was persisted.')
  const agentSummary = runs.length
    ? runs.map((run) => `${run.kind ?? run.agent}: ${run.status} — ${run.outputSummary ?? run.error ?? 'no summary recorded'}`).join('\n')
    : 'No AI/security agent run was persisted.'
  const outcome = blocked.length > 0 ? 'Attack traffic contained; the service continued responding.' : fresh.status.replaceAll('_', ' ')
  const subject = `[BuildHub][SECURITY][${fresh.severity}] Attack detected — ${fresh.ref}`
  const text = [
    'BUILDHUB SECURITY INCIDENT', '',
    `Incident: ${fresh.ref}`, `Attack detected: ${fresh.title}`,
    `Target endpoint: ${fresh.method} ${fresh.endpoint}`,
    `Pattern: ${finding?.ruleId ?? fresh.errorCode ?? 'security anomaly'} — ${finding?.detail ?? fresh.description}`,
    `Suspicious requests: ${suspicious}`, `Evidence: ${logs.slice(-8).map((row) => `${row.createdAt.toISOString()} ${row.errorCode ?? row.level} ${row.message}`).join(' | ') || fresh.description}`,
    `Detection / analyzer: ${fresh.detectedBy ?? 'BuildHub monitoring'} · ${finding?.title ?? fresh.title}`,
    `Risk / severity: ${fresh.severity} · score ${fresh.riskScore}/100`,
    `Mitigation performed: ${mitigation}`,
    `Service health before / after: attack evidence persisted; current service response remained available unless the incident record states otherwise.`,
    '', 'AI / SECURITY AGENT SUMMARIES', agentSummary,
    '', `Final outcome: ${outcome}`,
  ].join('\n')
  const html = pageShell(
    `Security incident · ${fresh.ref}`,
    '#b91c1c',
    [
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">${row('Incident', fresh.ref)}${row('Attack detected', fresh.title)}${row('Target endpoint', `${fresh.method} ${fresh.endpoint}`)}${row('Pattern', `${finding?.ruleId ?? fresh.errorCode ?? 'security anomaly'} · ${finding?.detail ?? fresh.description}`)}${row('Suspicious requests', String(suspicious))}${row('Detection', fresh.detectedBy)}${row('Risk / severity', `${fresh.severity} · score ${fresh.riskScore}/100`)}${row('Mitigation', mitigation)}${row('Service response', outcome)}${row('Final outcome', outcome)}</table>`,
      '<div style="margin-top:16px;font-size:11px;line-height:16px;letter-spacing:1px;font-weight:800;color:#334155;">AI / SECURITY AGENT SUMMARIES</div>',
      codeBlock(agentSummary),
      '<div style="margin-top:16px;font-size:11px;line-height:16px;letter-spacing:1px;font-weight:800;color:#334155;">EVIDENCE</div>',
      codeBlock(logs.slice(-12).map((entry) => `${entry.createdAt.toISOString()} ${entry.errorCode ?? entry.level} ${entry.message}`).join('\n') || fresh.description),
    ].join(''),
  )
  return sendGmail({ type: 'ESCALATION', subject, text, html, incidentId: fresh.id, severity: fresh.severity })
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
