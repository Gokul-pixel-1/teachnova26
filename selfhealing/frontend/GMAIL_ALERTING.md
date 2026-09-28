# Gmail Alerting + One-Click Approval — BuildHub Self-Healing

Parallel channel to Telegram (`TELEGRAM_ALERTING.md`). Gmail never creates
incident/repair/approval state: every message renders the same persisted
`buildIncidentBrief` facts, and every delivery is recorded in
`gmail_notifications` under the same lifecycle types + permanent-dedupe
contract (one SENT per incident+type).

## Architecture

```
Incident / repair state (PostgreSQL — single source of truth)
  ↓  buildIncidentBrief(incidentId)
Telegram sender ─┐
                 ├→ operator
Gmail sender ────┘
```

- Service: `lib/server/gmail.ts` (OAuth2 refresh → Gmail API send, fetch
  transport, 12s timeouts, one retry, honest FAILED rows).
- Tokens: `lib/server/approval-tokens.ts` (32-byte random, SHA-256 stored,
  one-time atomic claim, expiry mirrors the approval).
- Endpoint: `GET /api/approvals/email?token=…` (no session — the token is the
  credential; JSON for `Accept: application/json`, result page otherwise).
- Shared rejection finalizer: `finalizeRejectedRepair` in
  `lib/server/repair/engine.ts` (used by the dashboard PROCEED/REJECT route
  and the email route).

## OAuth configuration

Google Cloud Console → APIs & Services → enable **Gmail API** → Credentials →
OAuth client ID (web application) → OAuth consent flow against scope
`https://www.googleapis.com/auth/gmail.send` → mint the refresh token once.

Required environment variables (server-only, never logged, never returned).
Names match the existing `frontend/.env` Gmail configuration:

| Variable | Purpose | Status |
|---|---|---|
| `GMAIL_CLIENT_ID` | OAuth client id | configured |
| `GMAIL_CLIENT_SECRET` | OAuth client secret | configured |
| `GMAIL_REFRESH_TOKEN` | Long-lived refresh token (mint once) | **missing — Gmail sends fail honestly until set** |
| `GMAIL_REDIRECT_URI` | OAuth callback (`…/api/gmail/oauth/callback`), registered in Cloud Console | configured |
| `GMAIL_SENDER_EMAIL` | From address (must match the consent user) | configured |
| `GMAIL_APPROVER_EMAIL` | Operator inbox (approvals + results) | configured |
| `GMAIL_OAUTH_SCOPES` | `https://www.googleapis.com/auth/gmail.send` | configured |

## Refresh-token requirement

Without `GMAIL_REFRESH_TOKEN` (or any variable above) every send returns
`configured:false` with `GMAIL NOT CONFIGURED (missing …)` naming the exact
missing variable — no row is persisted as SENT, nothing claims delivery, and
the repair pipeline continues (Telegram + dashboard + audit log unaffected).
The `/ai/security` Gmail card shows the same missing-variable message.

## Minting the refresh token (one time)

1. As an operator: `GET /api/gmail/oauth/url` → open `consentUrl` (single
   use, valid 15 minutes — it carries a `state` bound to this server) as the
   `GMAIL_SENDER_EMAIL` account and approve the `gmail.send` scope.
2. Google redirects to `GMAIL_REDIRECT_URI` (`/api/gmail/oauth/callback`).
   The callback verifies `state`, saves the one-time code to the gitignored
   `frontend/.data/gmail-oauth-code` (never logged; the dev request log
   ignores this path) and redirects to a clean URL, so the code is NOT left
   in the address bar. It reports honestly when no code / an error / an
   unknown state arrived instead.
3. Exchange the code ONCE, locally (the code, like all credentials, never
   leaves your machine and never enters chat). Pick one:
   a. Offline mint script (recommended) — run inside `frontend/`:
   `node scripts/mint-gmail-refresh-token.mjs` (reads the saved code and
   deletes it after the exchange; `GMAIL_OAUTH_CODE='<code>'` still works)
   It writes `GMAIL_REFRESH_TOKEN` straight to `frontend/.env` and prints
   ONLY "Refresh token obtained successfully." Then restart the server.
   b. Server exchange route — from the browser devtools console on the app
   origin (your operator session is reused; nothing is pasted into chat):
   `fetch('/api/gmail/oauth/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'<code>'})}).then(r=>r.json()).then(console.log)`
   On success it stores the token server-side and answers
   "Refresh token obtained successfully." On an expired/consumed code it
   answers 410 with a fresh `consentUrl` — re-authorize and exchange the
   NEW code once. Then restart the server.
4. Restart the server; the Gmail card flips
   to configured. The secret lives only in server env — never in the DB, UI,
   logs, or emails.

## Troubleshooting the one-time exchange

- `Bad Request` from Google almost always means the pasted `?code=` value was
  truncated or included extra query parts (`&scope=…`). The mint script now
  rejects such pastes before sending (it reports only the code LENGTH, never
  its characters). Re-copy ONLY the full code, wrapped in SINGLE quotes
  (codes contain `/` and shell-significant characters), and exchange it
  within minutes — codes are single-use and short-lived.
- `redirect_uri_mismatch` means the sent `GMAIL_REDIRECT_URI` differs
  byte-for-byte from the Authorized redirect URI in Google Cloud Console
  (scheme, host, port, path, no trailing slash). The failing redirect URI is
  printed by the script/route (it is a non-secret identifier).
- `invalid_grant` means the code expired or was already used: re-authorize
  from the fresh consent URL the script/route prints, then exchange the NEW
  code immediately (once).

## Behavior by risk (FINAL POLICY: LOW auto, MEDIUM/HIGH approval)

- LOW: no approval email. One FINAL_SUMMARY email after terminal state
  (`[BuildHub][LOW] Auto-Healing Completed`): incident, problem, root cause,
  file, repair, validation, final status, rollback note.
- MEDIUM: approval email (`[BuildHub][MEDIUM] Approval Required`) with
  problem, root cause, file/line/function, BEFORE/AFTER, coder/critic/judge,
  validation + rollback plans, and [ APPROVE REPAIR ] / [ REJECT ] buttons.
  No patch before approval. After the decision, one FINAL_SUMMARY email
  (RESOLVED / ROLLED_BACK / REJECTED).
- HIGH: same shape with stricter wording (`[BuildHub][HIGH] Approval
  Required`, [ APPROVE HIGH-RISK REPAIR ] / [ REJECT ]), all 14 required
  sections, then one FINAL_SUMMARY email.

## Secure approval links

- One token per action (APPROVE-link ≠ REJECT-link); the URL carries only the
  token — no secrets, no raw database ids.
- Tokens are non-guessable (256-bit), incident+approval specific, expire with
  the approval (5 minutes), one-time (atomic `usedAt` claim wins races),
  invalid after use/expiry/rejection/resolution.
- Replays are idempotent: already-used/decided links render the current state
  and never re-execute a repair.
- Approval only authorizes: every approved patch still runs the existing
  apply → validate → RESOLVED / rollback → ROLLED_BACK path. Validation
  failure is never reported as success.

## Deduplication

Same budget as Telegram: INCIDENT(1) → approval-required(1) → FINAL_SUMMARY(1)
per incident per channel (independent tables, independent dedupe). No email
per internal AI step.

## Failure handling

Transport/OAuth failures persist FAILED rows with the provider error (values
redacted by construction — only variable names appear). Approval creation,
patching, validation, rollback and learning never depend on Gmail delivery.
