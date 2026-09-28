import 'server-only'

import { createHash, randomBytes } from 'node:crypto'

import { prisma } from '@/lib/server/db'

// Mirrors lib/server/approval-tokens.ts but targets UxApprovalToken/UxApproval
// (a separate table) — same one-time, SHA-256-hashed, single-use contract.

export type UxEmailTokenAction = 'APPROVE' | 'REJECT'

export interface IssuedUxEmailToken {
  action: UxEmailTokenAction
  token: string
  expiresAt: Date
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export async function createUxApprovalTokens(
  uxApprovalDbId: string,
  expiresAt: Date,
): Promise<IssuedUxEmailToken[]> {
  const issued: IssuedUxEmailToken[] = []
  for (const action of ['APPROVE', 'REJECT'] as UxEmailTokenAction[]) {
    const token = randomBytes(32).toString('base64url')
    await prisma.uxApprovalToken.create({
      data: {
        uxApprovalId: uxApprovalDbId,
        tokenHash: sha256Hex(token),
        action,
        expiresAt,
      },
    })
    issued.push({ action, token, expiresAt })
  }
  return issued
}

export interface ConsumedUxEmailToken {
  ok: boolean
  reason: string
  approvalId?: string
  uxSuggestionId?: string
  action?: UxEmailTokenAction
  alreadyDecided?: boolean
}

export async function consumeUxEmailToken(rawToken: string): Promise<ConsumedUxEmailToken> {
  const tokenHash = sha256Hex(rawToken.trim())
  const row = await prisma.uxApprovalToken.findUnique({
    where: { tokenHash },
    include: { uxApproval: { include: { uxSuggestion: true } } },
  })
  if (!row) return { ok: false, reason: 'Unknown or invalid approval link.' }
  if (row.usedAt) {
    return {
      ok: false,
      reason: 'This approval link has already been used.',
      approvalId: row.uxApproval.approvalId,
      uxSuggestionId: row.uxApproval.uxSuggestionId,
      action: row.action as UxEmailTokenAction,
      alreadyDecided: true,
    }
  }
  if (row.expiresAt.getTime() < Date.now()) {
    return {
      ok: false,
      reason: 'This approval link has expired.',
      approvalId: row.uxApproval.approvalId,
      uxSuggestionId: row.uxApproval.uxSuggestionId,
      action: row.action as UxEmailTokenAction,
    }
  }
  if (row.uxApproval.status !== 'PENDING') {
    return {
      ok: false,
      reason: `This approval is already ${row.uxApproval.status}.`,
      approvalId: row.uxApproval.approvalId,
      uxSuggestionId: row.uxApproval.uxSuggestionId,
      action: row.action as UxEmailTokenAction,
      alreadyDecided: true,
    }
  }
  const terminal = ['APPLIED', 'VALIDATED', 'REJECTED', 'ROLLED_BACK', 'EXPIRED'].includes(
    row.uxApproval.uxSuggestion.status,
  )
  if (terminal) {
    return {
      ok: false,
      reason: `Suggestion ${row.uxApproval.uxSuggestion.ref} is already ${row.uxApproval.uxSuggestion.status} — no decision needed.`,
      approvalId: row.uxApproval.approvalId,
      uxSuggestionId: row.uxApproval.uxSuggestionId,
      action: row.action as UxEmailTokenAction,
      alreadyDecided: true,
    }
  }
  const claimed = await prisma.uxApprovalToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  })
  if (claimed.count !== 1) {
    return {
      ok: false,
      reason: 'This approval link has already been used.',
      approvalId: row.uxApproval.approvalId,
      uxSuggestionId: row.uxApproval.uxSuggestionId,
      action: row.action as UxEmailTokenAction,
      alreadyDecided: true,
    }
  }
  return {
    ok: true,
    reason: 'Token accepted.',
    approvalId: row.uxApproval.approvalId,
    uxSuggestionId: row.uxApproval.uxSuggestionId,
    action: row.action as UxEmailTokenAction,
  }
}
