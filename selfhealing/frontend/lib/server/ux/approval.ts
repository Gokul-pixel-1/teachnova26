import 'server-only'

import { prisma } from '@/lib/server/db'
import { randomInt } from 'node:crypto'
import { Prisma } from '@prisma/client'

// Mirrors lib/server/approval.ts's shape and semantics but targets
// UxApproval/UxSuggestion instead of Approval/Incident — a fully separate
// table, so nothing here can affect the bug-repair approval state machine.

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes, same window as bug repairs

export type UxApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'CONSUMED'

export interface UxApproval {
  id: string
  approvalId: string
  uxSuggestionId: string
  status: UxApprovalStatus
  operator: string
  createdAt: Date
  expiresAt: Date
  statusUpdatedAt: Date
}

function nextUxApprovalId(): string {
  return `UXA-${String(randomInt(100000, 1000000))}`
}

export async function createUxApproval(
  uxSuggestionId: string,
  operator: string,
  expiresInMs: number = APPROVAL_TIMEOUT_MS,
): Promise<UxApproval> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + expiresInMs)

  let approval: Awaited<ReturnType<typeof prisma.uxApproval.create>> | null = null
  for (let attempt = 0; attempt < 5 && !approval; attempt += 1) {
    try {
      approval = await prisma.uxApproval.create({
        data: {
          approvalId: nextUxApprovalId(),
          uxSuggestionId,
          status: 'PENDING',
          operator,
          createdAt: now,
          expiresAt,
          statusUpdatedAt: now,
        },
      })
    } catch (err) {
      const isUniqueCollision =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
      if (!isUniqueCollision) throw err
    }
  }
  if (!approval) throw new Error('Failed to allocate a unique UX approval id')
  return toUxApproval(approval)
}

function toUxApproval(row: {
  id: string
  approvalId: string
  uxSuggestionId: string
  status: string
  operator: string
  createdAt: Date
  expiresAt: Date
  statusUpdatedAt: Date
}): UxApproval {
  return {
    id: row.id,
    approvalId: row.approvalId,
    uxSuggestionId: row.uxSuggestionId,
    status: row.status as UxApprovalStatus,
    operator: row.operator,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    statusUpdatedAt: row.statusUpdatedAt,
  }
}

export async function getPendingUxApproval(approvalId: string): Promise<UxApproval | null> {
  const row = await prisma.uxApproval.findFirst({ where: { approvalId, status: 'PENDING' } })
  return row ? toUxApproval(row) : null
}

async function transition(
  approvalId: string,
  from: UxApprovalStatus,
  to: UxApprovalStatus,
): Promise<UxApproval | null> {
  const existing = await prisma.uxApproval.findUnique({ where: { approvalId }, select: { id: true, status: true } })
  if (!existing || existing.status !== from) return null
  const updated = await prisma.uxApproval.update({
    where: { id: existing.id },
    data: { status: to, statusUpdatedAt: new Date() },
  })
  return toUxApproval(updated)
}

export async function approveUxApproval(approvalId: string): Promise<UxApproval | null> {
  return transition(approvalId, 'PENDING', 'APPROVED')
}

export async function rejectUxApproval(approvalId: string): Promise<UxApproval | null> {
  return transition(approvalId, 'PENDING', 'REJECTED')
}

export async function consumeUxApproval(approvalId: string): Promise<UxApproval | null> {
  return transition(approvalId, 'APPROVED', 'CONSUMED')
}

export async function expireUxApproval(approvalId: string): Promise<UxApproval | null> {
  const row = await prisma.uxApproval.findUnique({ where: { approvalId } })
  if (!row || row.status !== 'PENDING') return row ? toUxApproval(row) : null
  if (new Date() <= row.expiresAt) return toUxApproval(row)
  const updated = await prisma.uxApproval.update({
    where: { id: row.id },
    data: { status: 'EXPIRED', statusUpdatedAt: new Date() },
  })
  return toUxApproval(updated)
}

export function isUxApprovalExpired(approval: UxApproval): boolean {
  return new Date() > approval.expiresAt
}
