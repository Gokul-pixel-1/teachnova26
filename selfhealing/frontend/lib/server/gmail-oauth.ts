import 'server-only'

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// One-time Gmail OAuth setup helpers (see GMAIL_ALERTING.md).
//
// The callback receives Google's one-time authorization code and hands it to
// scripts/mint-gmail-refresh-token.mjs through a local file instead of the
// browser address bar:
//   - `state` (256-bit, single use, 15 min) ties every callback to a consent
//     URL issued by an authenticated operator, so an unsolicited request can
//     never plant a code;
//   - the code is written only to the gitignored .data/gmail-oauth-code
//     (mode 0600) — never logged, returned, or stored in the database;
//   - the mint script deletes the file after its single exchange attempt.

export const OAUTH_CODE_FILE = resolve(process.cwd(), '.data', 'gmail-oauth-code')
const STATE_TTL_MS = 15 * 60 * 1000
const STATE_KEY = '__buildhub_gmail_oauth_states__'

const g = globalThis as unknown as Record<string, Map<string, number> | undefined>
if (!g[STATE_KEY]) g[STATE_KEY] = new Map()
const states = g[STATE_KEY] as Map<string, number>

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function pruneStates(now: number): void {
  for (const [hash, expiresAt] of states) if (expiresAt <= now) states.delete(hash)
}

/** Issues a fresh single-use state value; only its hash is kept in memory. */
export function issueOAuthState(): string {
  const now = Date.now()
  pruneStates(now)
  const state = randomBytes(32).toString('base64url')
  states.set(sha256(state), now + STATE_TTL_MS)
  return state
}

/** Validates and burns a state value. False when unknown, used, or expired. */
export function consumeOAuthState(state: string): boolean {
  const now = Date.now()
  pruneStates(now)
  const hash = sha256(state)
  const expiresAt = states.get(hash)
  if (!expiresAt) return false
  states.delete(hash)
  return expiresAt > now
}

export function gmailOAuthSettings() {
  return {
    clientId: process.env.GMAIL_CLIENT_ID?.trim() ?? '',
    redirectUri: process.env.GMAIL_REDIRECT_URI?.trim() ?? '',
    scopes: process.env.GMAIL_OAUTH_SCOPES?.trim() || 'https://www.googleapis.com/auth/gmail.send',
  }
}

/** Consent URL for the sender account, bound to a fresh single-use state. */
export function buildGmailConsentUrl(): string {
  const { clientId, redirectUri, scopes } = gmailOAuthSettings()
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', scopes)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', issueOAuthState())
  return url.toString()
}

/** Stores the one-time code for the mint script (owner-only, gitignored). */
export function saveOAuthCode(code: string): void {
  mkdirSync(resolve(process.cwd(), '.data'), { recursive: true })
  writeFileSync(OAUTH_CODE_FILE, code, { encoding: 'utf8', mode: 0o600 })
}
