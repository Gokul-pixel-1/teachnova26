import 'server-only'

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { prisma } from '@/lib/server/db'
import { suspectSourceFor } from '@/lib/server/routes-map'
import { trace } from '@/lib/server/repair/trace'
import type { Incident } from '@prisma/client'
import type { EvidenceLog, RepairEvidence } from '@/lib/server/providers/types'

// Phase 9 — evidence collection for the self-healing engine. Only REAL data is
// shown to the agents: the actual stack trace captured by the route handler,
// the real source file rendered from the stack's first application frame, and
// the genuinely linked ERROR logs. No fault catalog values are consulted.

/** Normalizes an app-relative or frontend/-prefixed source path. */
export function repoRelativeFile(file: string): string {
  return file.replace(/^frontend\//, '')
}

/** Small files are shown in full so the agent never misses the faulty line. */
export const FULL_FILE_LINE_CAP = 250

/** Capped excerpt of the architecture map given to the agents. */
export const ARCHITECTURE_DOC_CAP = 40_000

/** Resolves docs/SELF_HEALING_ARCHITECTURE.md from the frontend cwd — the
 * single source of truth the repair engine reads before generating a patch.
 * Tries cwd, cwd/.. and cwd/../.. so it works from `frontend/` and from repo
 * root. Returns null (never throws) when the document is not present. */
export function findArchitectureDoc(): string | null {
  const cwd = process.cwd().replace(/\/+$/, '') || '.'
  const candidates = [
    join(cwd, 'docs', 'SELF_HEALING_ARCHITECTURE.md'),
    join(dirname(cwd), 'docs', 'SELF_HEALING_ARCHITECTURE.md'),
    resolve(join(dirname(cwd), '..', 'docs', 'SELF_HEALING_ARCHITECTURE.md')),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8').slice(0, ARCHITECTURE_DOC_CAP)
    } catch {
      // keep trying candidates
    }
  }
  return null
}

/** Deterministically pulls the component-map rows relevant to one failure out
 * of the architecture document. The Coder/Judge get this compact mapping —
 * never the full document — so a single prompt stays far below the provider's
 * input-token cap while still naming component / file / function. Falls back
 * to a short excerpt when no explicit row matches. */
export function architectureExtract(
  doc: string | null,
  method: string | null,
  endpoint: string,
  suspectFile: string,
): string {
  if (!doc) return '(no architecture document available)'
  const lines = doc.split('\n')
  const fileNeedle = repoRelativeFile(suspectFile).toLowerCase()
  const endpointNeedle = (endpoint ?? '/').split('?')[0].replace(/\/+$/, '').toLowerCase()

  const mapRows: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^#{1,6}\s*.*component\s*map/i.test(lines[i])) continue
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^#{1,6}\s/.test(lines[j])) break
      const row = lines[j]
      if (!row.trimStart().startsWith('|')) continue
      mapRows.push(row.trimEnd())
    }
    break
  }

  const narrowed = mapRows.filter((row) => {
    const r = row.toLowerCase()
    return (fileNeedle !== '' && r.includes(fileNeedle)) || r.includes(endpointNeedle)
  })

  const chose = narrowed.length > 0 ? narrowed : mapRows.slice(0, 10)
  return [
    `Relevant component-map rows for ${method ?? 'ANY'} ${endpoint} (extracted from docs/SELF_HEALING_ARCHITECTURE.md):`,
    ...chose.slice(0, 10),
  ].join('\n')
}

export function readRealFile(file: string): { ok: boolean; content: string; error?: string } {
  const relative = repoRelativeFile(file)
  const full = `${process.cwd()}/${relative}`
  try {
    if (!existsSync(full)) {
      return { ok: false, content: '', error: `file does not exist: ${relative}` }
    }
    return { ok: true, content: readFileSync(full, 'utf8').replace(/^\uFEFF/, '') }
  } catch (err) {
    return {
      ok: false,
      content: '',
      error: err instanceof Error ? err.message : `cannot read ${relative}`,
    }
  }
}

/**
 * Renders the REAL source file around the failure's first application frame.
 * Turbopack dev frames carry chunk-relative line numbers, so for small files
 * the WHOLE file is shown (line numbers are from the file itself — exactly what
 * a developer debugging the 500 would see). Larger files fall back to a
 * generous window around the frame.
 */
export function buildSourceWindow(file: string, line: number | null): string | null {
  const real = readRealFile(file)
  if (!real.ok) return null

  const lines = real.content.split('\n')
  const at = Math.max(0, Math.min(lines.length - 1, Math.max(1, line ?? 1) - 1))
  if (lines.length <= FULL_FILE_LINE_CAP) {
    const window = lines.map((src, i) => {
      const lineNo = i + 1
      const marker = lineNo === at + 1 ? '>' : ' '
      return `${marker} ${String(lineNo).padStart(4, ' ')} | ${src}`
    })
    return `${file} (real file, full source — line ${at + 1} is the first stack frame):\n${window.join('\n')}`
  }

  const start = Math.max(0, at - 40)
  const end = Math.min(lines.length, at + 60)
  const window = lines.slice(start, end).map((src, i) => {
    const lineNo = start + i + 1
    const marker = lineNo === at + 1 ? '>' : ' '
    return `${marker} ${String(lineNo).padStart(4, ' ')} | ${src}`
  })
  return `${file} (real file, line ${start + 1}-${end}:${at + 1} is the first stack frame):\n${window.join('\n')}`
}

export async function collectEvidence(incident: Incident): Promise<RepairEvidence> {
  const logs = await prisma.logEvent.findMany({
    where: { incidentId: incident.id },
    orderBy: { createdAt: 'desc' },
    take: 25,
  })
  const evidenceLogs: EvidenceLog[] = logs.map((log) => ({
    level: log.level,
    route: log.route,
    method: log.method,
    status: log.status,
    message: log.message,
    requestId: log.requestId,
    errorCode: log.errorCode,
    createdAt: log.createdAt.toISOString(),
  }))

  const metadata = (incident.metadata ?? null) as {
    source?: string
    stackTrace?: string | null
    errorName?: string | null
    sourceFile?: string | null
    sourceLine?: number | null
    requestId?: string | null
    message?: string | null
    evidenceLogId?: string | null
  } | null

  const stackTrace = metadata?.stackTrace ?? null
  const sourceFile = metadata?.sourceFile ?? null
  const sourceLine = metadata?.sourceLine ?? null
  const memoryHints: RepairEvidence['memoryHints'] = []
  try {
    const { signatureFor } = await import('@/lib/server/learning/memory')
    const signature = signatureFor(incident)
    // Same-signature memories first (the "seen this error before" signal),
    // then endpoint/file/code fallbacks. Newest first, capped.
    const memories = await prisma.repairMemory.findMany({
      where: {
        OR: [
          { errorSignature: signature },
          ...(incident.endpoint ? [{ endpoint: incident.endpoint }] : []),
          ...(sourceFile ? [{ file: sourceFile }] : []),
          ...(incident.errorCode ? [{ rootCause: { contains: incident.errorCode } }] : []),
        ],
      },
      take: 4,
      orderBy: { updatedAt: 'desc' },
    })
    memories.sort((a, b) => Number(b.errorSignature === signature) - Number(a.errorSignature === signature))
    for (const memory of memories) {
      memoryHints.push({
        rootCause: memory.rootCause ?? '',
        patchSummary: memory.patchSummary ?? '',
        outcome: memory.outcome,
        reward: memory.reward,
        recurrenceCount: memory.recurrenceCount,
        humanDecision: memory.humanDecision,
        signatureMatch: memory.errorSignature === signature,
      })
    }
  } catch {
    // memory table is empty on first runs — hints stay empty
  }

  const suspectSource = sourceFile ?? suspectSourceFor(incident.endpoint)
  // When the real stack frame could not be captured (Prisma/Turbopack rewrite
  // stacks), still render the route's real source so the repair agent has code
  // to inspect — the rendered file is real, never fault-catalog data.
  const sourceContext = suspectSource ? buildSourceWindow(suspectSource, sourceLine) : null

  // The architecture document (single source of truth) is read for every
  // repair so the agents can orient themselves inside the real component map.
  const architectureDoc = findArchitectureDoc()
  trace('EVIDENCE', `architecture map ${architectureDoc ? 'loaded' : 'MISSING (docs/SELF_HEALING_ARCHITECTURE.md not found)'} for ${incident.method} ${incident.endpoint}`, {
    incidentRef: incident.ref,
    incidentId: incident.id,
    route: incident.endpoint,
    method: incident.method,
  })

  return {
    incidentRef: incident.ref,
    incidentId: incident.id,
    severity: incident.severity,
    title: incident.title,
    description: incident.description,
    endpoint: incident.endpoint,
    method: incident.method,
    errorCode: incident.errorCode,
    requestId: incident.requestId,
    expectedRootCause: incident.expectedRootCause,
    suspectSource,
    detectedBy: incident.detectedBy ?? 'Log monitor (real runtime ERROR log)',
    evidenceCount: Math.max(1, evidenceLogs.length),
    logs: evidenceLogs,
    stackTrace,
    sourceContext,
    architectureDoc,
    memoryHints,
  }
}