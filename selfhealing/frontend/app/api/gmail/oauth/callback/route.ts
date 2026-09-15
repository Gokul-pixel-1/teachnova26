import { NextResponse } from 'next/server'

// Informational OAuth callback target (see GMAIL_ALERTING.md). Google
// redirects here with ?code=… after consent. This route deliberately does NOT
// read, log, store, or exchange the code server-side (no secrets touch the
// server here): it tells the operator how to finish minting
// GMAIL_REFRESH_TOKEN offline. Nothing is persisted by this route.
export async function GET() {
  return new NextResponse(
    [
      '<!doctype html><html><head><meta charset="utf-8"><title>BuildHub Gmail setup</title></head>',
      '<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;">',
      '<h2>Gmail consent received</h2>',
      '<p>Copy the <code>?code=…</code> value from this page\u2019s address bar, then exchange it <strong>once, offline</strong> ',
      '(one-off script or OAuth playground) for a refresh token and set <code>GMAIL_REFRESH_TOKEN</code> on the server. ',
      'This page never reads or stores the code.</p>',
      '</body></html>',
    ].join(''),
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )
}
