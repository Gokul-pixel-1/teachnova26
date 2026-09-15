import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { errorResponse, handleApiError } from '@/lib/server/response'

// Operator helper for the one-time Gmail OAuth setup (see GMAIL_ALERTING.md).
// Returns the Google consent URL for the sender account. The client_id and
// redirect URI are non-secret identifiers; the client secret and any issued
// code/token never pass through this route. After consent, Google redirects
// to GMAIL_REDIRECT_URI with a code that the operator exchanges once (offline
// script or OAuth playground) to mint GMAIL_REFRESH_TOKEN.
export async function GET() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  try {
    const clientId = process.env.GMAIL_CLIENT_ID?.trim() ?? ''
    const redirectUri = process.env.GMAIL_REDIRECT_URI?.trim() ?? ''
    const scopes = process.env.GMAIL_OAUTH_SCOPES?.trim() || 'https://www.googleapis.com/auth/gmail.send'
    if (!clientId || !redirectUri) {
      const missing = [!clientId && 'GMAIL_CLIENT_ID', !redirectUri && 'GMAIL_REDIRECT_URI'].filter(Boolean)
      return errorResponse(`Gmail OAuth setup incomplete (missing ${missing.join(', ')}).`, 409)
    }
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', scopes)
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    const consentUrl = url.toString()
    return NextResponse.json({
      ok: true,
      consentUrl,
      instructions: [
        '1. Open consentUrl as the GMAIL_SENDER_EMAIL account and approve the gmail.send scope.',
        '2. Google redirects to GMAIL_REDIRECT_URI with ?code=… (the callback route is informational only).',
        '3. Exchange the code once for a refresh token (offline script or OAuth playground) and set GMAIL_REFRESH_TOKEN.',
        '4. Restart the server; /ai/security Gmail card flips to configured.',
      ],
    })
  } catch (err) {
    return handleApiError(err)
  }
}
