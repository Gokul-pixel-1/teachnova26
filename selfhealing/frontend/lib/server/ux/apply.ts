import 'server-only'

import { prisma } from '@/lib/server/db'
import { readRealFile, repoRelativeFile } from '@/lib/server/repair/evidence'
import { canApplyToRealFile } from '@/lib/server/repair/file-applicator'
import { writeFileExternally } from '@/lib/server/external-write'
import { sha256Of } from '@/lib/server/repair/patch-engine'
import { runUxValidation } from './validate'
import { applyUxPatch } from './draft'
import { uxComponent } from './registry'
import { trace } from '@/lib/server/repair/trace'
import type { UxSuggestion } from '@prisma/client'

// Applies an APPROVED UX suggestion end-to-end: real-file write (anchor must
// still be present) → lightweight validation → VALIDATED, or byte-restore
// rollback → ROLLED_BACK. Mirrors the integrity discipline of
// lib/server/repair/patch-engine.ts's applyCandidate/rollback (backup SHA-256,
// external-process write for dev-server hot-reload, post-write re-read) but
// is reimplemented locally against UxSuggestion — it does not call
// applyCandidate, does not create a PatchRecord, and never touches
// Incident/RepairAttempt.

export interface UxApplyDecision {
  ok: boolean
  status: string
  reason: string
}

export async function applyUxSuggestion(suggestion: UxSuggestion): Promise<UxApplyDecision> {
  const real = readRealFile(suggestion.file)
  const originalContent = real.ok ? real.content : null
  // Strict: the whole excerpt must still be present (the file may have changed
  // since the draft), otherwise nothing is written.
  const appliedContent =
    originalContent !== null
      ? applyUxPatch(originalContent, suggestion.currentCode, suggestion.proposedCode)
      : null

  if (originalContent === null || appliedContent === null) {
    await prisma.uxSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: 'ROLLED_BACK',
        rolledBackAt: new Date(),
        validationResult: 'anchor not present in real file; refusing to apply blind',
      },
    })
    return { ok: false, status: 'ROLLED_BACK', reason: 'anchor not present in real file' }
  }

  await prisma.uxSuggestion.update({
    where: { id: suggestion.id },
    data: {
      originalContent,
      originalSha256: sha256Of(originalContent),
    },
  })

  const relative = repoRelativeFile(suggestion.file)
  try {
    if (!canApplyToRealFile(relative)) throw new Error(`refusing to write outside frontend root: ${relative}`)
    trace('PATCH', `applying UX suggestion ${suggestion.ref} to ${relative}`, {})
    await writeFileExternally(`${process.cwd()}/${relative}`, appliedContent)
    if (process.env.NODE_ENV !== 'production') {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  } catch (err) {
    return rollback(suggestion.id, originalContent, err instanceof Error ? err.message : 'write failed')
  }

  const onDisk = readRealFile(suggestion.file)
  const writtenContent = onDisk.ok ? onDisk.content : appliedContent
  await prisma.uxSuggestion.update({
    where: { id: suggestion.id },
    data: {
      status: 'APPLIED',
      appliedAt: new Date(),
      appliedContent: writtenContent,
      appliedSha256: sha256Of(writtenContent),
      validationResult: 'applied to real file; awaiting validation',
    },
  })

  const probePath = uxComponent(suggestion.uxId)?.probePath ?? null
  const validation = await runUxValidation(suggestion.file, writtenContent, probePath)
  if (!validation.ok) {
    return rollback(suggestion.id, originalContent, validation.detail)
  }

  await prisma.uxSuggestion.update({
    where: { id: suggestion.id },
    data: { status: 'VALIDATED', validationResult: validation.detail },
  })
  return { ok: true, status: 'VALIDATED', reason: validation.detail }
}

async function rollback(
  suggestionId: string,
  originalContent: string,
  reason: string,
): Promise<UxApplyDecision> {
  const suggestion = await prisma.uxSuggestion.findUniqueOrThrow({ where: { id: suggestionId } })
  const relative = repoRelativeFile(suggestion.file)
  let restoreVerified = false
  try {
    await writeFileExternally(`${process.cwd()}/${relative}`, originalContent)
    if (process.env.NODE_ENV !== 'production') {
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
    const restored = readRealFile(suggestion.file)
    restoreVerified = restored.ok && sha256Of(restored.content) === sha256Of(originalContent)
  } catch {
    restoreVerified = false
  }
  await prisma.uxSuggestion.update({
    where: { id: suggestionId },
    data: {
      status: 'ROLLED_BACK',
      rolledBackAt: new Date(),
      restoredContent: originalContent,
      restoredSha256: sha256Of(originalContent),
      validationResult: `${reason}${restoreVerified ? '' : ' (WARNING: restore not verified byte-for-byte)'}`,
    },
  })
  trace('ROLLBACK', `UX suggestion ${suggestion.ref} rolled back: ${reason}`, {})
  return { ok: false, status: 'ROLLED_BACK', reason }
}
