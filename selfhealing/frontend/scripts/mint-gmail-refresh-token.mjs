#!/usr/bin/env node
/**
 * Phase 12 — Mint GMAIL_REFRESH_TOKEN (one-time, offline, operator-run).
 *
 * Completes the Google offline OAuth flow AFTER the operator approves the
 * gmail.send consent screen as the GMAIL_SENDER_EMAIL account:
 *
 *   Google authorization (consent, access_type=offline + prompt=consent)
 *     ↓ authorization code → saved by the callback to frontend/.data/gmail-oauth-code
 *     ↓ this script: POST oauth2.googleapis.com/token (grant_type=authorization_code)
 *     ↓ refresh_token
 *     ↓ written to frontend/.env as GMAIL_REFRESH_TOKEN
 *
 * SECURITY CONTRACT (never violated):
 *   - The refresh token is NEVER printed to stdout/stderr, NEVER logged,
 *     NEVER returned by any API, NEVER embedded in email/dashboard/chat/Git.
 *   - The authorization code is read from the GMAIL_OAUTH_CODE env var if set,
 *     otherwise from the gitignored file the callback saved (never a CLI flag,
 *     so it never appears in process listings). It is held only in memory for
 *     the single token exchange, and the saved file is deleted afterwards.
 *   - Diagnostics print ONLY safe metadata: HTTP status, Google's error code /
 *     description, the redirect URI used (a non-secret identifier), and the
 *     code LENGTH (never any character of the code itself).
 *   - The client secret is read from frontend/.env and only sent to Google's
 *     token endpoint over HTTPS; it is never echoed back in any message.
 *   - Nothing is written to .env unless Google returns a valid refresh_token.
 *   - On success this script prints ONLY:
 *         "Refresh token obtained successfully."
 *     plus the expected environment variable name — never the value.
 *
 * Usage (after approving the consent link from GET /api/gmail/oauth/url):
 *     node scripts/mint-gmail-refresh-token.mjs
 * or, with a code obtained some other way:
 *     GMAIL_OAUTH_CODE='<code>' node scripts/mint-gmail-refresh-token.mjs
 *
 * Then: restart the application so the server picks up GMAIL_REFRESH_TOKEN.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CWD = dirname(fileURLToPath(import.meta.url))
const FRONTEND_DIR = resolve(CWD, '..')
const ENV_PATH = resolve(FRONTEND_DIR, '.env')
const EXPECTED_VAR = 'GMAIL_REFRESH_TOKEN'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

function fail(message) {
  // Messages carry Google error codes, the redirect URI, and code metadata
  // only — never secret values.
  console.error(message)
  process.exit(1)
}

function loadDotEnv(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) {
      let v = m[2].trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[m[1]] = v
    }
  }
  return out
}

// Consent links carry a single-use `state` issued by the running server, so a
// fresh link must come from the server (operator login required), not from
// this script.
const FRESH_LINK = 'http://localhost:3000/api/gmail/oauth/url  (log in to BuildHub as the operator, then open the consentUrl it returns)'

// The callback route saves the code here (gitignored, owner-only); it is
// deleted after the single exchange attempt below.
const CODE_FILE = resolve(FRONTEND_DIR, '.data', 'gmail-oauth-code')
let codeFromFile = false
let rawCode = (process.env.GMAIL_OAUTH_CODE ?? '').trim()
if (!rawCode && existsSync(CODE_FILE)) {
  rawCode = readFileSync(CODE_FILE, 'utf8').trim()
  codeFromFile = true
}
if (!rawCode) {
  fail(
    'No authorization code found. Complete the consent step first: get a fresh link at\n' +
      `  ${FRESH_LINK}\n` +
      'open it as the GMAIL_SENDER_EMAIL account and approve; the callback saves the code to\n' +
      '  frontend/.data/gmail-oauth-code\n' +
      'then re-run: node scripts/mint-gmail-refresh-token.mjs\n' +
      'No token was requested and nothing was written.',
  )
}
if (codeFromFile) console.error('Using the authorization code saved by the OAuth callback (value not shown).')

/** Codes are single use: once Google has seen it, the saved copy is useless. */
function discardSavedCode() {
  if (!codeFromFile) return
  try {
    unlinkSync(CODE_FILE)
  } catch {
    /* already gone */
  }
}

// Normalize unambiguous paste artifacts (codes never contain whitespace and
// never start with "code="). Anything else suspicious is reported, not sent.
let code = rawCode.replace(/\s+/g, '')
if (/^code=/i.test(code)) code = code.replace(/^code=/i, '')
const shapeNotes = []
if (code.length < 20) shapeNotes.push('the value is unusually short — it looks truncated; re-copy the FULL ?code= value')
if (/[&?#]/.test(code)) shapeNotes.push('the value contains URL separators — paste ONLY the code, without &scope=… or other query parts')

const env = loadDotEnv(ENV_PATH)
const clientId = (env.GMAIL_CLIENT_ID ?? '').trim()
const clientSecret = (env.GMAIL_CLIENT_SECRET ?? '').trim()
const redirectUri = (env.GMAIL_REDIRECT_URI ?? '').trim() || 'http://localhost:3000/api/gmail/oauth/callback'
if (!clientId || !clientSecret) {
  const missing = [!clientId && 'GMAIL_CLIENT_ID', !clientSecret && 'GMAIL_CLIENT_SECRET'].filter(Boolean)
  fail(`Gmail OAuth setup incomplete (missing ${missing.join(', ')} in frontend/.env). Nothing was written.`)
}

console.error(`OAuth configuration: client ID and secret present; redirect URI in use: ${redirectUri}`)
console.error(`Authorization code received: ${code.length} chars${shapeNotes.length > 0 ? ` (note: ${shapeNotes.join('; ')})` : ''}`)
if (shapeNotes.length > 0) {
  fail(
    'The authorization code looks malformed (see note above). Fix the paste and re-run. ' +
      'No token was requested and nothing was written.',
  )
}

let data = null
let httpStatus = 0
try {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
      signal: controller.signal,
    })
    httpStatus = res.status
    data = (await res.json().catch(() => null)) ?? null
  } finally {
    clearTimeout(timer)
  }
} catch (err) {
  fail(`Token exchange failed: network error (${err instanceof Error ? err.message : 'unknown'}). Nothing was written.`.slice(0, 200))
}

// Google has now seen the code (success or rejection) — it can never be used
// again, so the saved copy is removed. A network failure above keeps it for a
// retry within its few-minute lifetime.
discardSavedCode()

const refreshToken = typeof data?.refresh_token === 'string' ? data.refresh_token.trim() : ''
if (refreshToken) {
  // Success: persist WITHOUT ever printing the value.
  const raw = readFileSync(ENV_PATH, 'utf8')
  const line = `${EXPECTED_VAR}=${refreshToken}`
  const updated = new RegExp(`^${EXPECTED_VAR}=.*$`, 'm').test(raw)
    ? raw.replace(new RegExp(`^${EXPECTED_VAR}=.*$`, 'm'), line)
    : `${raw.endsWith('\n') ? raw : `${raw}\n`}${line}\n`
  writeFileSync(ENV_PATH, updated, 'utf8')

  console.log('Refresh token obtained successfully.')
  console.log(`Expected environment variable: ${EXPECTED_VAR}`)
  console.log('Restart the application so the server picks up the new value.')
  process.exit(0)
}

// Failure: report Google's safe fields + actionable cause, never secrets.
const googleError = typeof data?.error === 'string' ? data.error : ''
const googleDesc = typeof data?.error_description === 'string' ? data.error_description : ''
const safeGoogle = `HTTP ${httpStatus}${googleError ? ` | error=${googleError}` : ''}${googleDesc ? ` | description=${googleDesc.slice(0, 200)}` : ''}`
const consentUrl = FRESH_LINK

if (httpStatus === 200) {
  fail(
    `Google issued no refresh token for this code (it may already have been used, or consent lacked ` +
      `access_type=offline + prompt=consent). Google said: ${safeGoogle}. Re-authorize once with this fresh URL, ` +
      `then exchange the NEW code once:\n${consentUrl}\nNothing was written.`,
  )
}
if (/redirect_uri_mismatch/i.test(`${googleError} ${googleDesc}`)) {
  fail(
    `Google rejected the redirect URI. Sent redirect_uri: ${redirectUri}. It must match the Authorized redirect URI ` +
      `registered in Google Cloud Console byte-for-byte (scheme, host, port, path, no trailing slash). ` +
      `Google said: ${safeGoogle}. Fix the Console registration (or GMAIL_REDIRECT_URI), re-authorize here:\n${consentUrl}\nNothing was written.`,
  )
}
if (/invalid_grant/i.test(googleError)) {
  fail(
    `Authorization code expired, already used, or issued for different credentials. Google said: ${safeGoogle}. ` +
      `Codes are single-use and short-lived — re-authorize once with this fresh URL, then exchange the NEW code immediately:\n${consentUrl}\nNothing was written.`,
  )
}
fail(
  `Token exchange failed. Google said: ${safeGoogle}. Sent redirect_uri: ${redirectUri}. ` +
    `If the code was re-copied, get a FRESH one here (single use, expires in minutes) and exchange it immediately:\n${consentUrl}\nNothing was written.`,
)
