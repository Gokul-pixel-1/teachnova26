import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import { prisma } from './db'

export type EmailTokenAction = 'APPROVE' | 'REJECT'

export interface IssuedEmailToken {
  action: EmailTokenAction
  /** Raw token — returned ONCE so it can be embedded in the email link. Never logged, never persisted. */
  token: string
  expiresAt: Date
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * Issues one single-use token per action for an Approval. The raw tokens are
 * returned once for email embedding; only SHA-256 hashes reach the database.
 * Expiry mirrors the parent approval's expiresAt (5-minute window).
 */
export async function createApprovalTokens(
  approvalDbId: string,
  expiresAt: Date,
): Promise<IssuedEmailToken[]> {
  const issued: IssuedEmailToken[] = []
  for (const action of ['APPROVE', 'REJECT'] as EmailTokenAction[]) {
    const token = randomBytes(32).toString('base64url')
    await prisma.approvalToken.create({
      data: {
        approvalId: approvalDbId,
        tokenHash: sha256Hex(token),
        action,
        expiresAt,
      },
    })
    issued.push({ action, token, expiresAt })
  }
  return issued
}

export interface ConsumedEmailToken {
  ok: boolean
  reason: string
  approvalId?: string
  incidentId?: string
  action?: EmailTokenAction
  alreadyDecided?: boolean
}

/**
 * Validates + atomically consumes a one-click email token. Guards (all
 * server-side): token exists, unused, unexpired, approval still PENDING,
 * incident still awaiting decision. Replays return an idempotent
 * already-decided answer and never re-execute a repair.
 */
export async function consumeEmailToken(rawToken: string): Promise<ConsumedEmailToken> {
  const tokenHash = sha256Hex(rawToken.trim())
  const row = await prisma.approvalToken.findUnique({
    where: { tokenHash },
    include: { approval: { include: { incident: true } } },
  })
  if (!row) return { ok: false, reason: 'Unknown or invalid approval link.' }
  if (row.usedAt) {
    return {
      ok: false,
      reason: 'This approval link has already been used.',
      approvalId: row.approval.approvalId,
      incidentId: row.approval.incidentId,
      action: row.action as EmailTokenAction,
      alreadyDecided: true,
    }
  }
  if (row.expiresAt.getTime() < Date.now()) {
    return {
      ok: false,
      reason: 'This approval link has expired.',
      approvalId: row.approval.approvalId,
      incidentId: row.approval.incidentId,
      action: row.action as EmailTokenAction,
    }
  }
  if (row.approval.status !== 'PENDING') {
    return {
      ok: false,
      reason: `This approval is already ${row.approval.status}.`,
      approvalId: row.approval.approvalId,
      incidentId: row.approval.incidentId,
      action: row.action as EmailTokenAction,
      alreadyDecided: true,
    }
  }
  const terminalIncident = ['RESOLVED', 'ROLLED_BACK', 'AI_REPAIR_FAILED', 'REJECTED'].includes(row.approval.incident.status)
  if (terminalIncident) {
    return {
      ok: false,
      reason: `Incident ${row.approval.incident.ref} is already ${row.approval.incident.status} — no decision needed.`,
      approvalId: row.approval.approvalId,
      incidentId: row.approval.incidentId,
      action: row.action as EmailTokenAction,
      alreadyDecided: true,
    }
  }
  // Atomic one-time claim: exactly one redemption wins the race.
  const claimed = await prisma.approvalToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  })
  if (claimed.count !== 1) {
    return {
      ok: false,
      reason: 'This approval link has already been used.',
      approvalId: row.approval.approvalId,
      incidentId: row.approval.incidentId,
      action: row.action as EmailTokenAction,
      alreadyDecided: true,
    }
  }
  return {
    ok: true,
    reason: 'Token accepted.',
    approvalId: row.approval.approvalId,
    incidentId: row.approval.incidentId,
    action: row.action as EmailTokenAction,
  }
}
