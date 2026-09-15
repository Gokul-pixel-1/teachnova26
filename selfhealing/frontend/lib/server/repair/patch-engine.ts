import 'server-only'

// Phase 9 — patch engine. A candidate patch is structurally verified, written
// into the REAL source file (anchor must be present), then validated by
// re-running the incident's real failing request. Rollback restores the exact
// pre-patch content on any failure. No canonical oracle, no simulated guards:
// validation is the truth.

import { randomBytes, createHash } from 'node:crypto'
import { prisma } from '@/lib/server/db'
import { writeFileExternally } from '@/lib/server/external-write'
import { canApplyToRealFile } from './file-applicator'
import { readRealFile, repoRelativeFile } from './evidence'
import { runValidationProbes } from './validation'
import { deactivateFaultsForEndpoint, reactivateFaults } from '@/lib/server/fault-injection'
import { logger } from '@/lib/server/logger'
import { trace } from '@/lib/server/repair/trace'
import type { Incident, RepairAttempt, PatchRecord } from '@prisma/client'

/** SHA-256 of the exact bytes content — backup/rollback integrity proof. */
export function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export interface PatchDecision {
  ok: boolean
  reason: string
  record: PatchRecord
  requiresApproval: boolean
  applied: boolean
  validated: boolean
  rolledBack: boolean
  /** True when the pre-patch bytes were restored AND the read-back SHA-256
   * matched the backup; false when the restore was skipped or unverified.
   * Undefined when no file edit exists to restore (e.g. runtime-only path). */
  restoreVerified?: boolean
  validation: {
    probes: Array<{ name: string; ok: boolean; expected: string; actual: string }>
  }
}

export function nextPatchId(): string {
  return `PATCH-${randomBytes(3).toString('hex').toUpperCase()}-${Date.now().toString(36).toUpperCase()}`
}

const CANDIDATE_MAX_LINES = 200
const CANDIDATE_MAX_CHARS = 8000

export interface VerifiedCandidate {
  incident: Incident
  file: string
  line: number | null
  function: string
  currentCode: string
  proposedCode: string
}

/**
 * Structural verification only: path safety and size limits within the allowed
 * frontend tree (app/lib/prisma/components). Correctness is decided by
 * re-running the recorded failing request, never here.
 */
export function verifyCandidate(
  candidate: Pick<VerifiedCandidate, 'file' | 'currentCode' | 'proposedCode'>,
): { ok: boolean; error?: string } {
  const relative = repoRelativeFile(candidate.file)
  if (!/^(app|lib|prisma|components)\//.test(relative)) {
    return { ok: false, error: `file outside allowed paths: ${relative}` }
  }
  if (candidate.currentCode.trim().length === 0) {
    return { ok: false, error: 'candidate must define currentCode' }
  }
  if (candidate.currentCode === candidate.proposedCode) {
    return { ok: false, error: 'candidate proposes no change' }
  }
  if (candidate.proposedCode.split('\n').length > CANDIDATE_MAX_LINES) {
    return { ok: false, error: `candidate exceeds line limit (${CANDIDATE_MAX_LINES})` }
  }
  if (candidate.proposedCode.length > CANDIDATE_MAX_CHARS) {
    return { ok: false, error: `candidate exceeds size limit (${CANDIDATE_MAX_CHARS} chars)` }
  }
  return { ok: true }
}

function withIndent(line: string, indent: string): string {
  return line.length === 0 ? line : `${indent}${line}`
}

/**
 * Applies a candidate patch to the real file content using a line-based anchor
 * match that ignores leading whitespace (the small local model does not always
 * reproduce indentation verbatim, but it must reproduce the real token
 * sequence). Real-file indentation is preserved positionally: each matched
 * line keeps its original leading whitespace, extra proposed lines inherit the
 * last matched line's indentation, and surplus current lines are dropped.
 * Correctness is still decided by the live validation probes, never here.
 */
function applyAnchored(content: string, currentCode: string, proposedCode: string): string | null {
  const fileLines = content.split('\n')
  const cur = currentCode.split('\n').map((l) => l.trim())
  const prop = proposedCode.split('\n')

  // Find the first line whose trimmed content matches the start of currentCode.
  let matchStart = -1
  let matchLen = 0
  for (let i = 0; i < fileLines.length; i += 1) {
    if (fileLines[i].trim() === cur[0]) {
      let len = 1
      while (len < cur.length && i + len < fileLines.length) {
        if (fileLines[i + len].trim() !== cur[len]) break
        len += 1
      }
      if (len > matchLen) {
        matchStart = i
        matchLen = len
      }
      if (len === cur.length) break
    }
  }
  if (matchStart === -1) return null

  const out: string[] = []
  for (let i = 0; i < matchStart; i += 1) out.push(fileLines[i])

  const baseIndent = fileLines[matchStart].match(/^\s*/)?.[0] ?? ''
  const tailIndent = fileLines[matchStart + matchLen - 1].match(/^\s*/)?.[0] ?? baseIndent
  for (let p = 0; p < prop.length; p += 1) {
    const trimmed = prop[p].trim()
    if (p < matchLen) {
      const original = fileLines[matchStart + p]
      const leading = original.match(/^\s*/)?.[0] ?? ''
      out.push(withIndent(trimmed, leading))
    } else if (trimmed.length > 0) {
      out.push(withIndent(trimmed, tailIndent))
    }
  }

  for (let i = matchStart + matchLen; i < fileLines.length; i += 1) out.push(fileLines[i])
  return out.join('\n')
}

/**
 * Applies a candidate end-to-end:
 *   real-file write (anchor must still be present) →
 *   re-run the incident's failing request →
 *   VALIDATED on success, ROLLED_BACK (restore prior content) otherwise.
 */
export async function applyCandidate(
  attempt: RepairAttempt,
  candidate: VerifiedCandidate,
): Promise<PatchDecision> {
  const { incident, file, currentCode, proposedCode } = candidate

  const record = await prisma.patchRecord.create({
    data: {
      patchId: nextPatchId(),
      incidentId: incident.id,
      repairAttemptId: attempt.id,
      file: repoRelativeFile(file),
      line: candidate.line,
      function: candidate.function,
      status: 'CHECKPOINTED',
      risk: attempt.risk ?? null,
      requiresApproval: (attempt.risk ?? 'LOW') === 'HIGH' || (attempt.risk ?? 'LOW') === 'MEDIUM',
    },
  })

  const real = readRealFile(file)
  const originalContent = real.ok ? real.content : null
  const appliedContent =
    real.ok && originalContent !== null
      ? applyAnchored(originalContent, currentCode, proposedCode)
      : null

  trace('BACKUP', `original bytes captured for ${record.file} (sha256=${originalContent !== null ? sha256Of(originalContent).slice(0, 12) : 'n/a'}…)`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: incident.endpoint,
    method: incident.method,
  })

  await prisma.patchRecord.update({
    where: { id: record.id },
    data: {
      originalContent,
      appliedContent: appliedContent ?? '',
      originalSha256: originalContent !== null ? sha256Of(originalContent) : null,
      appliedSha256: appliedContent !== null ? sha256Of(appliedContent) : null,
    },
  })

  if (originalContent === null || appliedContent === null) {
    await prisma.patchRecord.update({
      where: { id: record.id },
      data: {
        status: 'ROLLED_BACK',
        rolledBackAt: new Date(),
        validationResult: 'anchor not present in real file; refusing to apply blind',
      },
    })
    return {
      ok: false,
      reason: 'anchor not present in real file',
      record,
      requiresApproval: record.requiresApproval,
      applied: false,
      validated: false,
      rolledBack: false,
      validation: { probes: [] },
    }
  }

  try {
    const relative = repoRelativeFile(file)
    if (!canApplyToRealFile(relative)) throw new Error(`refusing to write outside frontend root: ${relative}`)
    trace('PATCH', `applying anchored patch to ${relative} (bytes ${appliedContent.length.toLocaleString()})`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
    // Write from a child process so the dev file-watcher recompiles the edited
    // module (Next suppresses in-process writes). 
    await writeFileExternally(`${process.cwd()}/${relative}`, appliedContent)
    // Dev only: let turbopack/webpack finish recompiling the edited module
    // before the validation probes re-run the failing request, otherwise the
    // first probe can still hit the pre-edit code and produce a false rollback.
    if (process.env.NODE_ENV !== 'production') {
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  } catch (err) {
    return await rollback(record, err instanceof Error ? err.message : 'write failed')
  }

  // Integrity: hash the bytes actually on disk after the external write so the
  // applied hash represents reality (and can be verified on any later audit).
  const onDisk = readRealFile(file)
  const appliedSha256 = onDisk.ok ? sha256Of(onDisk.content) : null

  await prisma.patchRecord.update({
    where: { id: record.id },
    data: {
      status: 'APPLIED',
      appliedAt: new Date(),
      appliedContent: onDisk.ok ? onDisk.content : record.appliedContent,
      appliedSha256,
      validationResult: 'applied to real file; awaiting validation',
    },
  })

  // Runtime regime: a still-ACTIVE fault on this endpoint would mask the file
  // fix during validation (a freshly installed isFaultActive guard still
  // throws while its flag is on). Deactivate endpoint faults BEFORE probing;
  // on validation failure the exact flags are re-activated alongside the
  // byte-level rollback so the observable regime is restored, never leaked.
  const deactivatedForValidation = await deactivateFaultsForEndpoint(incident.endpoint, incident.method)
  if (deactivatedForValidation.length > 0) {
    trace('PATCH', `runtime faults deactivated pre-validation: ${deactivatedForValidation.join(', ')}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
  }

  // Real HTTP validation: re-run the failing request against the patched file.
  trace('VALIDATION', `running REAL probes against ${incident.method} ${incident.endpoint}`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: incident.endpoint,
    method: incident.method,
  })
  const probeResults = await runValidationProbes(incident)
  const probesPassed = probeResults.length > 0 && probeResults.every((p) => p.ok)

  for (const probe of probeResults) {
    trace('CURL', `${probe.name}: expected ${probe.expected} → actual ${probe.actual} ${probe.ok ? 'OK' : 'FAILED'}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
  }

  await prisma.patchRecord.update({
    where: { id: record.id },
    data: {
      validationResult: JSON.stringify(probeResults),
      validatedAt: new Date(),
    },
  })

  if (probesPassed) {
    const validatedRead = readRealFile(file)
    await prisma.patchRecord.update({
      where: { id: record.id },
      data: {
        status: 'VALIDATED',
        appliedContent: validatedRead.ok ? validatedRead.content : appliedContent,
        appliedSha256: validatedRead.ok ? sha256Of(validatedRead.content) : appliedSha256,
      },
    })
    trace('VALIDATION', `all ${probeResults.length} probe(s) passed — patch VALIDATED (sha256=${appliedSha256?.slice(0, 12) ?? 'n/a'}…)`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
    await logger.info({
      service: 'self-healing',
      message: `Patch validated for ${incident.ref}: ${probeResults.length} real probe(s) passed`,
      route: incident.endpoint,
      method: incident.method,
      status: 200,
      incidentId: incident.id,
    })
    return {
      ok: true,
      reason: `validation passed (${probeResults.length} real HTTP probe(s))`,
      record,
      requiresApproval: record.requiresApproval,
      applied: true,
      validated: true,
      rolledBack: false,
      validation: { probes: probeResults.map((p) => ({ name: p.name, ok: p.ok, expected: p.expected, actual: p.actual })) },
    }
  }

  trace('ROLLBACK', `validation failed (${probeResults.filter((p) => !p.ok).map((p) => p.name).join(', ') || 'no probes'}) — restoring original bytes`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: incident.endpoint,
    method: incident.method,
  })
  const rolledBack = await rollback(record, `one or more real HTTP probes failed after apply (${probeResults.filter((p) => !p.ok).map((p) => p.name).join(', ') || 'no probes'})`)
  if (deactivatedForValidation.length > 0) {
    await reactivateFaults(deactivatedForValidation)
    trace('ROLLBACK', `runtime faults re-activated after failed validation: ${deactivatedForValidation.join(', ')}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
  }
  return rolledBack
}

export interface RuntimeRepairDecision {
  ok: boolean
  reason: string
  record: PatchRecord
  applied: boolean
  validated: boolean
  rolledBack: boolean
  /** Always undefined: runtime repairs touch no files, so there is never a
   * byte-level restore to verify (kept for union compatibility). */
  restoreVerified?: undefined
  deactivated: string[]
  validation: {
    probes: Array<{ name: string; ok: boolean; expected: string; actual: string }>
  }
}

/**
 * Runtime repair — the "patch" for a controlled runtime fault is a real,
 * durable RESTORE of normal behavior: the runtime fault(s) matching the
 * incident endpoint are deactivated (no source file is ever touched), then the
 * incident's real failing request is re-run. On validation failure the exact
 * runtime faults that were deactivated are re-activated (honest rollback of the
 * runtime regime) and the incident ends ROLLED_BACK.
 *
 * `directive === 'none'` intentionally applies NO restore (used by the hermetic
 * bad-fix scenario) so the real validation probes fail and the engine records a
 * genuine ROLLED_BACK — never a fabricated success.
 */
export async function applyRuntimeRepair(
  attempt: RepairAttempt,
  incident: Incident,
  options: { file: string; directive: 'restore' | 'none' },
): Promise<RuntimeRepairDecision> {
  const { file, directive } = options
  const metadata = (incident.metadata ?? null) as { sourceLine?: number | null } | null

  const record = await prisma.patchRecord.create({
    data: {
      patchId: nextPatchId(),
      incidentId: incident.id,
      repairAttemptId: attempt.id,
      file: repoRelativeFile(file),
      line: metadata?.sourceLine ?? null,
      function: 'Runtime fault restore (no source edit)',
      status: 'CHECKPOINTED',
      risk: attempt.risk ?? null,
      requiresApproval: (attempt.risk ?? 'LOW') === 'HIGH' || (attempt.risk ?? 'LOW') === 'MEDIUM',
    },
  })

  // The real corrective action: restore normal runtime behavior for the
  // surface that failed. Persisted immediately, observable via /api/faults.
  let deactivated: string[] = []
  if (directive === 'restore') {
    trace('PATCH', `runtime restore for ${incident.method} ${incident.endpoint}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
    deactivated = await deactivateFaultsForEndpoint(incident.endpoint, incident.method)
    trace('PATCH', `runtime faults deactivated for endpoint: ${deactivated.join(', ') || 'none'}`, {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
  } else {
    trace('PATCH', 'no runtime restore applied (bad-fix / none directive) — validation must fail', {
      incidentRef: incident.ref,
      incidentId: incident.id,
      route: incident.endpoint,
      method: incident.method,
    })
  }

  await prisma.patchRecord.update({
    where: { id: record.id },
    data: {
      status: 'APPLIED',
      appliedAt: new Date(),
      originalContent: '',
      appliedContent: directive === 'restore'
        ? `Runtime fault restored for ${incident.method} ${incident.endpoint} (deactivated: ${deactivated.join(', ') || 'none'}).`
        : 'No runtime restore applied (bad-fix): validation must fail.',
      validationResult: 'runtime behavior restored; awaiting real validation',
    },
  })

  if (directive === 'restore' && deactivated.length === 0) {
    // No active runtime fault matched — the endpoint is already healthy, but
    // the incident was reported as a runtime failure. Validate anyway; if the
    // probes fail this is a real unhandled defect and we must not lie.
    await logger.warn({
      service: 'self-healing',
      message: `Runtime repair for ${incident.ref}: no active runtime fault matched ${incident.endpoint}; validating healthy state`,
      route: incident.endpoint,
      method: incident.method,
      status: 200,
      incidentId: incident.id,
    })
  }

  const probeResults = await runValidationProbes(incident)
  const probesPassed = probeResults.length > 0 && probeResults.every((p) => p.ok)

  await prisma.patchRecord.update({
    where: { id: record.id },
    data: {
      validationResult: JSON.stringify(probeResults),
      validatedAt: new Date(),
    },
  })

  if (probesPassed) {
    await prisma.patchRecord.update({
      where: { id: record.id },
      data: { status: 'VALIDATED' },
    })
    await logger.info({
      service: 'self-healing',
      message: `Runtime repair validated for ${incident.ref}: ${probeResults.length} real probe(s) passed (deactivated ${deactivated.join(', ') || 'none'})`,
      route: incident.endpoint,
      method: incident.method,
      status: 200,
      incidentId: incident.id,
    })
    return {
      ok: true,
      reason: `runtime behavior restored and validated (${probeResults.length} real HTTP probe(s))`,
      record,
      applied: true,
      validated: true,
      rolledBack: false,
      deactivated,
      validation: { probes: probeResults.map((p) => ({ name: p.name, ok: p.ok, expected: p.expected, actual: p.actual })) },
    }
  }

  // Honest rollback of the runtime regime: re-activate exactly what was
  // deactivated so the observable state returns to the failing behavior.
  if (deactivated.length > 0) {
    await reactivateFaults(deactivated)
    await logger.warn({
      service: 'self-healing',
      message: `Runtime repair rolled back for ${incident.ref}: re-activated ${deactivated.join(', ')}`,
      route: incident.endpoint,
      method: incident.method,
      status: 503,
      incidentId: incident.id,
      errorCode: 'PATCH_ROLLBACK',
    })
  }

  await prisma.patchRecord.update({
    where: { id: record.id },
    data: {
      status: 'ROLLED_BACK',
      rolledBackAt: new Date(),
      validationResult: `one or more real HTTP probes failed after runtime restore (${probeResults.filter((p) => !p.ok).map((p) => p.name).join(', ') || 'no probes'})`,
    },
  })

  return {
    ok: false,
    reason: `one or more real HTTP probes failed after runtime restore (${probeResults.filter((p) => !p.ok).map((p) => p.name).join(', ') || 'no probes'})`,
    record,
    applied: true,
    validated: false,
    rolledBack: true,
    deactivated,
    validation: { probes: probeResults.map((p) => ({ name: p.name, ok: p.ok, expected: p.expected, actual: p.actual })) },
  }
}

async function rollback(record: PatchRecord, reason: string): Promise<PatchDecision> {
  // Restore the exact pre-patch content when a real edit was made, then prove
  // the restored bytes match the backup via SHA-256.
  // NOTE: `record` is the create-result snapshot — the backup bytes/hashes live
  // only on the persisted row (written by the CHECKPOINT update). Reload them;
  // trusting the snapshot silently SKIPS the restore and leaks candidate bytes.
  const persisted = await prisma.patchRecord.findUnique({ where: { id: record.id } })
  const originalContent = persisted?.originalContent ?? record.originalContent
  const originalSha256 = persisted?.originalSha256 ?? record.originalSha256
  let restoredContent: string | null = null
  let restoredSha256: string | null = null
  let restoreVerified = false
  if (originalContent !== null && canApplyToRealFile(record.file)) {
    try {
      await writeFileExternally(`${process.cwd()}/${record.file}`, originalContent)
      const readBack = readRealFile(record.file)
      restoredContent = readBack.ok ? readBack.content : null
      restoredSha256 = restoredContent !== null ? sha256Of(restoredContent) : null
      const match = originalSha256 !== null && restoredSha256 === originalSha256
      restoreVerified = match
      if (!match) {
        await logger.error({
          service: 'self-healing',
          message: `ROLLBACK INTEGRITY FAILURE for ${record.patchId}: restored sha256=${restoredSha256 ?? 'n/a'} != backup sha256=${(originalSha256 ?? 'n/a').slice(0, 12)}… — original bytes preserved for manual restore`,
          route: record.file,
          method: 'PATCH',
          status: 503,
          incidentId: record.incidentId,
          errorCode: 'ROLLBACK_HASH_MISMATCH',
        })
      } else {
        trace('ROLLBACK', `original bytes restored for ${record.file} (sha256=${(restoredSha256 ?? 'n/a').slice(0, 12)}… VERIFIED)`, {
          incidentId: record.incidentId,
        })
      }
    } catch {
      // Restore failed; logs below make it visible instead of silent.
      await logger.error({
        service: 'self-healing',
        message: `ROLLBACK WRITE FAILED for ${record.patchId}: could not restore ${record.file} — original bytes preserved for manual restore`,
        route: record.file,
        method: 'PATCH',
        status: 503,
        incidentId: record.incidentId,
        errorCode: 'ROLLBACK_WRITE_FAILED',
      })
    }
  }

  await prisma.patchRecord.update({
    where: { id: record.id },
    data: {
      status: 'ROLLED_BACK',
      rolledBackAt: new Date(),
      validationResult: reason,
      restoredContent,
      restoredSha256,
    },
  })

  await logger.warn({
    service: 'self-healing',
    message: `Patch rolled back: ${reason}`,
    route: record.file,
    method: 'PATCH',
    status: 503,
    incidentId: record.incidentId,
    errorCode: 'PATCH_ROLLBACK',
  })

  // Sync the snapshot callers hold so `decision.record` reflects the restore
  // outcome (callers must not trust the create-result for backup fields).
  record.originalContent = originalContent
  record.originalSha256 = originalSha256
  record.restoredContent = restoredContent
  record.restoredSha256 = restoredSha256

  return {
    ok: false,
    reason,
    record,
    requiresApproval: record.requiresApproval,
    applied: true,
    validated: false,
    rolledBack: true,
    restoreVerified,
    validation: { probes: [] },
  }
}