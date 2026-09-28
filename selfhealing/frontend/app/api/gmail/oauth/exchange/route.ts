import { NextResponse } from 'next/server'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { requireSecurityOperator } from '@/lib/server/security'
import { errorResponse, handleApiError } from '@/lib/server/response'
import { logger } from '@/lib/server/logger'
import { buildGmailConsentUrl } from '@/lib/server/gmail-oauth'

// Phase 12 — secure one-time OAuth code exchange (operator-gated).
//
// The operator pastes the ?code= value from the callback address bar into the
// request BODY (never a URL — URLs end up in access logs). This route
// exchanges it ONCE with Google (grant_type=authorization_code) and persists
// the refresh token straight to the server's local .env as
// GMAIL_REFRESH_TOKEN. The token value is NEVER returned, logged, or stored
// anywhere else. Restart the server afterwards so the new value loads.
//
// On success: { ok:true } — the ONLY success text is
// "Refresh token obtained successfully."
// On expired/consumed code: 410 + a fresh consentUrl to re-authorize.

export async function POST(request: Request) {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  try {
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null
    let code = typeof body?.code === 'string' ? body.code.trim().replace(/\s+/g, '') : ''
    if (/^code=/i.test(code)) code = code.replace(/^code=/i, '')
    if (!code) return errorResponse('Authorization code is required in the request body.', 400)
    if (code.length < 20 || /[&?#]/.test(code)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'The authorization code looks malformed (truncated, or pasted with extra query parts). Re-copy ONLY the ?code= value and retry; nothing was written.',
        },
        { status: 400 },
      )
    }

    const clientId = process.env.GMAIL_CLIENT_ID?.trim() ?? ''
    const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim() ?? ''
    const redirectUri = process.env.GMAIL_REDIRECT_URI?.trim() ?? ''
    const missing = [!clientId && 'GMAIL_CLIENT_ID', !clientSecret && 'GMAIL_CLIENT_SECRET', !redirectUri && 'GMAIL_REDIRECT_URI'].filter(Boolean)
    if (missing.length > 0) {
      return errorResponse(`Gmail OAuth setup incomplete (missing ${missing.join(', ')}).`, 409)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    interface TokenResponse {
      refresh_token?: string
      error?: string
      error_description?: string
    }
    let data: TokenResponse | null = null
    let httpStatus = 0
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
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
      data = (await res.json().catch(() => null)) as TokenResponse | null
    } finally {
      clearTimeout(timer)
    }

    const refreshToken = data?.refresh_token?.trim() ?? ''
    // Safe diagnostics only: HTTP status + Google error fields + the
    // non-secret redirect URI. Never the code, secret, or tokens.
    const googleError = data?.error ?? ''
    const googleDesc = data?.error_description ?? ''
    const safeGoogle = `HTTP ${httpStatus}${googleError ? ` | error=${googleError}` : ''}${googleDesc ? ` | description=${String(googleDesc).slice(0, 200)}` : ''}`
    if (!refreshToken) {
      await logger.warn({
        service: 'gmail',
        message: `Gmail OAuth code exchange failed: ${safeGoogle.slice(0, 200)} (redirect_uri=${redirectUri})`,
        route: '/api/gmail/oauth/exchange',
        method: 'POST',
        status: 410,
      })
      const expired = /invalid_grant|expired|redeemed|already/i.test(`${googleError} ${googleDesc}`)
      const mismatch = /redirect_uri_mismatch/i.test(`${googleError} ${googleDesc}`)
      const detail = mismatch
        ? `Google rejected the redirect URI (sent: ${redirectUri}). It must match the Authorized redirect URI in Google Cloud Console byte-for-byte. Google said: ${safeGoogle}.`
        : `Token exchange failed. Google said: ${safeGoogle}.`
      return NextResponse.json(
        {
          ok: false,
          error: expired
            ? `${detail} Authorization code expired or already used. Re-authorize with the fresh consentUrl below, then exchange the NEW code once.`
            : detail,
          redirectUri,
          consentUrl: expired || mismatch ? buildGmailConsentUrl() : undefined,
        },
        { status: expired || mismatch ? 410 : 502 },
      )
    }

    // Persist WITHOUT ever returning, logging, or echoing the value.
    const envPath = resolve(process.cwd(), '.env')
    if (!existsSync(envPath)) {
      return NextResponse.json(
        {
          ok: true,
          persisted: false,
          message: 'Refresh token obtained successfully. No local .env file exists — set GMAIL_REFRESH_TOKEN in the platform environment and restart.',
        },
      )
    }
    const raw = readFileSync(envPath, 'utf8')
    const line = `GMAIL_REFRESH_TOKEN=${refreshToken}`
    const updated = new RegExp('^GMAIL_REFRESH_TOKEN=.*$', 'm').test(raw)
      ? raw.replace(new RegExp('^GMAIL_REFRESH_TOKEN=.*$', 'm'), line)
      : `${raw.endsWith('\n') ? raw : `${raw}\n`}${line}\n`
    writeFileSync(envPath, updated, 'utf8')

    await logger.info({
      service: 'gmail',
      message: 'Gmail refresh token stored (value never logged)',
      route: '/api/gmail/oauth/exchange',
      method: 'POST',
      status: 200,
    })
    return NextResponse.json({
      ok: true,
      persisted: true,
      message: 'Refresh token obtained successfully. Restart the server so GMAIL_REFRESH_TOKEN loads.',
    })
  } catch (err) {
    return handleApiError(err)
  }
}
