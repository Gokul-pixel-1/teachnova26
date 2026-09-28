import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { buildGmailConsentUrl, gmailOAuthSettings } from '@/lib/server/gmail-oauth'
import { errorResponse, handleApiError } from '@/lib/server/response'

// Operator helper for the one-time Gmail OAuth setup (see GMAIL_ALERTING.md).
// Returns the Google consent URL for the sender account, bound to a fresh
// single-use `state`. The client_id and redirect URI are non-secret
// identifiers; the client secret and any issued code/token never pass
// through this route.
export async function GET() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response

  try {
    const { clientId, redirectUri } = gmailOAuthSettings()
    if (!clientId || !redirectUri) {
      const missing = [!clientId && 'GMAIL_CLIENT_ID', !redirectUri && 'GMAIL_REDIRECT_URI'].filter(Boolean)
      return errorResponse(`Gmail OAuth setup incomplete (missing ${missing.join(', ')}).`, 409)
    }
    const consentUrl = buildGmailConsentUrl()
    return NextResponse.json({
      ok: true,
      consentUrl,
      expiresInMinutes: 15,
      instructions: [
        '1. Open consentUrl (within 15 minutes, once) while signed in as the GMAIL_SENDER_EMAIL account and approve the gmail.send scope.',
        '2. Google redirects to GMAIL_REDIRECT_URI; the callback saves the one-time code to frontend/.data/gmail-oauth-code.',
        '3. Run: node scripts/mint-gmail-refresh-token.mjs (from selfhealing/frontend).',
        '4. Restart the server; the /ai/security Gmail card flips to configured.',
      ],
    })
  } catch (err) {
    return handleApiError(err)
  }
}
