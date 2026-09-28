import 'server-only'

import { sendGmail } from '@/lib/server/gmail'
import type { UxSuggestion } from '@prisma/client'
import type { IssuedUxEmailToken } from './approval-tokens'

// UX-specific email copy on top of the generic, unmodified sendGmail()
// (dedupe/retry/audit against GmailNotification — reused as-is). Distinct
// NotificationType values (UX_SUGGESTION_APPROVAL_REQUIRED/APPLIED/REJECTED)
// keep these deliveries clearly separate from bug-repair notifications in the
// GmailNotification audit trail.

function esc(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function codeBlock(value: string): string {
  return `<pre style="margin:8px 0 0;background:#0f172a;color:#dbeafe;border:1px solid #1e293b;padding:12px;border-radius:7px;white-space:pre-wrap;word-break:break-word;font:11px/17px SFMono-Regular,Consolas,Liberation Mono,monospace;">${esc(value).slice(0, 2000)}</pre>`
}

function shell(title: string, body: string): string {
  return [
    '<div style="margin:0;padding:24px 10px;background:#eef2f6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;color:#172033;">',
    '<div style="max-width:650px;margin:0 auto;background:#ffffff;border:1px solid #dbe3ec;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(15,23,42,.08);">',
    '<div style="height:5px;background:#7c3aed;font-size:0;line-height:0;">&nbsp;</div>',
    `<div style="padding:24px 24px 20px;background:#0f172a;color:#ffffff;"><div style="font-size:10px;line-height:16px;letter-spacing:2px;font-weight:700;color:#c4b5fd;">BUILDHUB UX SUGGESTION AGENT</div><div style="margin-top:7px;font-size:23px;line-height:30px;font-weight:700;">${esc(title)}</div></div>`,
    '<div style="padding:20px 20px 24px;">',
    body,
    '<p style="color:#64748b;font-size:11px;line-height:17px;margin:22px 4px 0;border-top:1px solid #e2e8f0;padding-top:14px;">No UI file is ever changed without your explicit approval. This message never includes credentials or secrets.</p>',
    '</div></div></div>',
  ].join('')
}

function appBaseUrl(): string {
  return (process.env.COMMAND_CENTER_URL ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

function buttonRow(approveUrl: string, rejectUrl: string): string {
  return `<div style="margin-top:18px;display:flex;gap:10px;">
    <a href="${approveUrl}" style="flex:1;text-align:center;padding:11px 16px;border-radius:8px;background:#7c3aed;color:#ffffff;font-weight:700;text-decoration:none;font-size:13px;">Approve change</a>
    <a href="${rejectUrl}" style="flex:1;text-align:center;padding:11px 16px;border-radius:8px;background:#f1f5f9;color:#334155;font-weight:700;text-decoration:none;font-size:13px;border:1px solid #dbe3ec;">Reject</a>
  </div>`
}

interface SandboxSummaryRound {
  round: number
  summary: string
  error: string | null
  result: {
    easy: boolean
    simulatedUsers: number
    foundWhereExpected: number
    distanceImprovement: number | null
    predictedSecondsBefore: number | null
    predictedSecondsAfter: number | null
    reasons: string[]
  } | null
}

/** Plain-language lines describing the sandbox trials (empty when none ran). */
function sandboxLines(suggestion: UxSuggestion): { headline: string; rounds: string[] } | null {
  const sb = suggestion.sandbox as
    | { skipped?: boolean; reason?: string; passed?: boolean; winnerRound?: number | null; simulatedUsers?: number; rounds?: SandboxSummaryRound[] }
    | null
  if (!sb) return null
  if (sb.skipped) return { headline: `Not tested in the sandbox: ${sb.reason ?? 'not testable'}`, rounds: [] }
  if (!sb.passed || !sb.rounds) return null
  const rounds = sb.rounds.map((r) => {
    if (r.error || !r.result) return `Round ${r.round}: ${r.summary || 'placement'} — not testable (${r.error ?? 'no result'})`
    const x = r.result
    const closer = x.distanceImprovement !== null ? `, ${Math.round(x.distanceImprovement * 100)}% closer to where they looked` : ''
    const time =
      x.predictedSecondsBefore !== null && x.predictedSecondsAfter !== null
        ? `, predicted time to find ${x.predictedSecondsBefore}s → ${x.predictedSecondsAfter}s`
        : ''
    return (
      `Round ${r.round}: ${r.summary} — ${x.easy ? 'PASSED' : 'failed'} ` +
      `(${x.foundWhereExpected}/${x.simulatedUsers} simulated users found it where they looked${closer}${time})` +
      (!x.easy && x.reasons.length > 0 ? ` — ${x.reasons.join('; ')}` : '')
    )
  })
  return {
    headline: `Tested first in a sandbox copy of BuildHub with ${sb.simulatedUsers ?? 0} simulated users (each replays where a real user clicked looking for it). The placement below passed in round ${sb.winnerRound}.`,
    rounds,
  }
}

export async function sendUxSuggestionApprovalEmail(
  suggestion: UxSuggestion,
  tokens: IssuedUxEmailToken[],
  expiresAt: Date,
): Promise<{ ok: boolean; error: string | null }> {
  const approve = tokens.find((t) => t.action === 'APPROVE')
  const reject = tokens.find((t) => t.action === 'REJECT')
  const approveUrl = `${appBaseUrl()}/api/ux/approvals/email?token=${approve?.token ?? ''}`
  const rejectUrl = `${appBaseUrl()}/api/ux/approvals/email?token=${reject?.token ?? ''}`
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60000))
  const auto = suggestion.source === 'AUTO'
  const why = auto
    ? `Detected automatically from user behaviour: ${suggestion.instruction}`
    : `Requested by an operator: ${suggestion.instruction}`

  const trial = sandboxLines(suggestion)
  const dashboardUrl = `${appBaseUrl()}/ai/ux-suggestions`
  const subject = `[BuildHub] ${suggestion.ref}: UX suggestion for "${suggestion.component}" needs your approval`
  const text = [
    `${suggestion.ref}: BuildHub's UX agent has a suggestion for "${suggestion.component}" (${suggestion.file}).`,
    '',
    `Why: ${why}`,
    '',
    `Proposed change: ${suggestion.summary ?? suggestion.instruction}`,
    '',
    ...(trial ? [`Sandbox test: ${trial.headline}`, ...trial.rounds.map((r) => `  - ${r}`), `Before/after screenshots: ${dashboardUrl}`, ''] : []),
    `Approve: ${approveUrl}`,
    `Reject: ${rejectUrl}`,
    '',
    `No file will be changed unless you click Approve. This link expires in ${minutes} minutes.`,
  ].join('\n')

  const html = shell(
    'UX suggestion awaiting your approval',
    [
      `<p style="margin:0 0 10px;font-size:14px;line-height:21px;">The UX agent proposes a change to <strong>${esc(suggestion.component)}</strong> in <code>${esc(suggestion.file)}</code>.</p>`,
      `<div style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:${auto ? '#f5f3ff' : '#f8fafc'};border:1px solid ${auto ? '#ddd6fe' : '#e2e8f0'};"><div style="font-size:11px;font-weight:700;letter-spacing:1px;color:${auto ? '#6d28d9' : '#64748b'};">${auto ? 'WHY — OBSERVED USER BEHAVIOUR' : 'WHY — OPERATOR REQUEST'}</div><div style="margin-top:4px;font-size:13px;line-height:20px;color:#334155;">${esc(suggestion.instruction)}</div></div>`,
      `<p style="margin:0 0 10px;font-size:13px;line-height:20px;color:#475569;"><strong>Proposed change:</strong> ${esc(suggestion.summary ?? suggestion.instruction)}</p>`,
      trial
        ? `<div style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:#f0fdf4;border:1px solid #bbf7d0;"><div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#15803d;">TESTED IN SANDBOX FIRST</div><div style="margin-top:4px;font-size:13px;line-height:20px;color:#334155;">${esc(trial.headline)}</div>${trial.rounds.length > 0 ? `<ul style="margin:6px 0 0;padding-left:18px;font-size:12px;line-height:18px;color:#475569;">${trial.rounds.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}<div style="margin-top:6px;font-size:12px;"><a href="${dashboardUrl}" style="color:#15803d;">See before/after screenshots in the dashboard</a></div></div>`
        : '',
      `<p style="margin:0 0 10px;font-size:11px;color:#94a3b8;">Link expires in ${minutes} minutes.</p>`,
      `<p style="margin:14px 0 2px;font-size:12px;font-weight:700;color:#64748b;">CURRENT</p>${codeBlock(suggestion.currentCode)}`,
      `<p style="margin:14px 0 2px;font-size:12px;font-weight:700;color:#64748b;">PROPOSED</p>${codeBlock(suggestion.proposedCode)}`,
      buttonRow(approveUrl, rejectUrl),
      `<p style="margin-top:14px;font-size:11px;color:#94a3b8;">This decision is required no matter how small the change looks — the agent never applies a UI change on its own.</p>`,
    ].join(''),
  )

  const result = await sendGmail({
    type: 'UX_SUGGESTION_APPROVAL_REQUIRED',
    subject,
    text,
    html,
    incidentId: null,
    severity: null,
  })
  return { ok: result.ok, error: result.error }
}

export async function sendUxSuggestionOutcomeEmail(
  suggestion: UxSuggestion,
  outcome: 'APPLIED' | 'REJECTED',
): Promise<{ ok: boolean; error: string | null }> {
  const applied = outcome === 'APPLIED'
  const subject = `[BuildHub] ${suggestion.ref}: UX suggestion for "${suggestion.component}" ${applied ? 'applied' : 'rejected'}`
  const text = applied
    ? `Your approved UX change to "${suggestion.component}" (${suggestion.file}) has been applied. Status: ${suggestion.status}.`
    : `The UX suggestion for "${suggestion.component}" (${suggestion.file}) was rejected. No file was changed.`
  const html = shell(
    applied ? 'Change applied' : 'Suggestion rejected',
    `<p style="margin:0;font-size:14px;line-height:21px;">${esc(text)}</p>`,
  )
  const result = await sendGmail({
    type: applied ? 'UX_SUGGESTION_APPLIED' : 'UX_SUGGESTION_REJECTED',
    subject,
    text,
    html,
    incidentId: null,
    severity: null,
  })
  return { ok: result.ok, error: result.error }
}
