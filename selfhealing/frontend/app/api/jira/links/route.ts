import { NextResponse } from 'next/server'

import { requireSecurityOperator } from '@/lib/server/security'
import { jiraLinksFor } from '@/lib/server/jira/approvals'
import { handleApiError } from '@/lib/server/response'

// Jira cards for approvals: GET /api/jira/links?approvalId=APR-1,UXA-2
export async function GET(request: Request) {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response
  try {
    const ids = (new URL(request.url).searchParams.get('approvalId') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => /^[A-Z]{3}-\d{4,8}$/.test(x))
      .slice(0, 50)
    const links = await jiraLinksFor(ids)
    return NextResponse.json({ links: Object.fromEntries(links) })
  } catch (err) {
    return handleApiError(err)
  }
}
