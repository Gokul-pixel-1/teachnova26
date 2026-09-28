import { NextResponse } from 'next/server'

import { consumeOAuthState, saveOAuthCode } from '@/lib/server/gmail-oauth'

// Gmail OAuth callback (GMAIL_REDIRECT_URI, see GMAIL_ALERTING.md).
//
// Google redirects here with ?code=…&state=… after consent. The route:
//   1. verifies `state` was issued by GET /api/gmail/oauth/url (single use),
//   2. saves the one-time code to the gitignored .data/gmail-oauth-code for
//      scripts/mint-gmail-refresh-token.mjs — no copy/paste needed,
//   3. redirects to a clean URL so the code leaves the address bar and
//      browser history.
// The code is never logged, echoed, returned, or stored in the database, and
// the dev request log ignores this path (next.config.ts). It reports what
// actually arrived instead of always claiming success.

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function page(heading: string, body: string, status = 200): NextResponse {
  return new NextResponse(
    [
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>BuildHub Gmail setup</title></head>',
      '<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:40px auto;padding:0 16px;line-height:1.5;">',
      `<h2>${heading}</h2>`,
      body,
      '</body></html>',
    ].join(''),
    { status, headers: HEADERS },
  )
}

const RESTART =
  '<p>Get a fresh consent link at <a href="/api/gmail/oauth/url">/api/gmail/oauth/url</a> ' +
  '(log in to BuildHub as the operator first), open it while signed in as the <code>GMAIL_SENDER_EMAIL</code> account, and approve.</p>'

export async function GET(request: Request) {
  const url = new URL(request.url)

  if (url.searchParams.get('saved') === '1') {
    return page(
      'Authorization code saved locally',
      '<p>The one-time code was saved to <code>frontend/.data/gmail-oauth-code</code> on this machine. ' +
        'It was not shown here, logged, or stored anywhere else, and it expires in a few minutes.</p>' +
        '<p><strong>Now run, from the <code>selfhealing/frontend</code> folder:</strong></p>' +
        '<pre style="background:#f1f5f9;padding:10px;border-radius:6px;">node scripts/mint-gmail-refresh-token.mjs</pre>' +
        '<p>Then restart the app.</p>',
    )
  }

  const error = url.searchParams.get('error')
  if (error) {
    return page(
      'Google did not grant access',
      `<p>Google returned <code>${esc(error.slice(0, 100))}</code>. No code was issued and nothing was saved.</p>` +
        '<p>If it says <code>access_denied</code>, consent was cancelled, or the account is not listed under ' +
        '<em>Audience → Test users</em> in Google Cloud Console.</p>' +
        RESTART,
      400,
    )
  }

  const code = (url.searchParams.get('code') ?? '').trim()
  if (!code) {
    return page(
      'No authorization code arrived',
      '<p>This page was opened without the <code>?code=…</code> Google adds after consent, so nothing was saved. ' +
        'That happens when the page is opened directly (typed, from history, or a bookmark) instead of through ' +
        'Google’s redirect, or when Google stopped at an error screen before redirecting.</p>' +
        RESTART,
      400,
    )
  }

  const state = url.searchParams.get('state') ?? ''
  if (!state || !consumeOAuthState(state)) {
    return page(
      'Consent link expired or not recognised',
      '<p>This callback did not come from a consent link issued by this BuildHub server in the last 15 minutes ' +
        '(or that link was already used, or the server restarted in between). For safety the code was <strong>not</strong> saved.</p>' +
        RESTART,
      400,
    )
  }

  saveOAuthCode(code)
  // Drop the code from the address bar and history.
  return new NextResponse(null, {
    status: 303,
    headers: { Location: '/api/gmail/oauth/callback?saved=1', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  })
}
