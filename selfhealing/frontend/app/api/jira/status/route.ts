import { NextResponse } from 'next/server'

import { prisma } from '@/lib/server/db'
import { requireSecurityOperator } from '@/lib/server/security'
import { approvalChannel, jiraConfig, jiraMyself, projectStatuses } from '@/lib/server/jira/client'
import { startJiraPoller } from '@/lib/server/jira/approvals'
import { handleApiError } from '@/lib/server/response'

// Jira approval-channel status for operators. Never returns credentials —
// only whether they are present, the site/project, and a live connection check.
export async function GET() {
  const guard = await requireSecurityOperator()
  if (!guard.ok) return guard.response
  try {
    const conf = jiraConfig()
    const recent = await prisma.jiraApproval.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { kind: true, approvalId: true, issueKey: true, issueUrl: true, state: true, outcome: true, error: true, createdAt: true, decidedAt: true },
    })
    if (!conf.ok) return NextResponse.json({ channel: approvalChannel(), configured: false, reason: conf.reason, recent })
    startJiraPoller()
    const cfg = conf.config
    let connection: { ok: boolean; user?: string; statuses?: string[]; error?: string }
    try {
      const me = await jiraMyself(cfg)
      const statuses = await projectStatuses(cfg).catch(() => [])
      connection = { ok: true, user: me.displayName, statuses }
    } catch (err) {
      connection = { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : 'failed' }
    }
    return NextResponse.json({
      channel: approvalChannel(),
      configured: true,
      site: cfg.baseUrl,
      project: cfg.projectKey,
      issueType: cfg.issueType,
      statuses: { waiting: cfg.waitingStatus, approve: cfg.approveStatus, reject: cfg.rejectStatus },
      connection,
      recent,
    })
  } catch (err) {
    return handleApiError(err)
  }
}
