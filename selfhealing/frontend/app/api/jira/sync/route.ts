import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { pollJiraApprovals } from '@/lib/server/jira/approvals'
import { handleApiError } from '@/lib/server/response'

// "Check Jira now": one immediate pass over every open Jira approval card
// (the background poller does the same every JIRA_POLL_SECONDS).
export async function POST() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response
  try {
    return NextResponse.json({ ok: true, ...(await pollJiraApprovals()) })
  } catch (err) {
    return handleApiError(err)
  }
}
