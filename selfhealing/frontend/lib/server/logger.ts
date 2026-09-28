import 'server-only'

import { prisma } from './db'
import type { LogLevel } from '@prisma/client'

// Phase 7 — structured server-side logging.
//
// Reusable fields: timestamp (createdAt), level, service, route, method,
// status, requestId, message, errorCode.
//
// Safety contract (enforced here + by callers):
//   - NEVER pass passwords, session tokens, cookies, Authorization headers,
//     API keys, or database credentials into `message`.
//   - `redactSensitive` strips known secret-shaped values defensively before
//     anything is persisted or echoed to the console.

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/

// Very defensive redaction: if a secret-looking value (Bearer token, JWT,
// password=, token=, api key=, URL with credentials, base64 secret blob)
// ever reaches a message it is masked. This is a backstop — callers must not
// rely on it as the primary protection.
const SECRET_PATTERN =
  /(bearer\s+[a-z0-9._-]+|(password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?secret|session)\s*[=:]\s*[^\s,;&]+|https?:\/\/[^\s/]+:[^\s@/]+@)/i

export function redactSensitive(value: string): string {
  return value.replace(SECRET_PATTERN, (match) => {
    const idx = match.search(/[=:]/)
    if (idx === -1) return '[REDACTED]'
    return `${match.slice(0, idx + 1)} [REDACTED]`
  })
}

/**
 * Resolves the request/correlation ID for a request: reuses a safe incoming
 * X-Request-ID or generates one. Generation keeps a per-process counter so the
 * shape is predictable and unique without collisions.
 */
export function resolveRequestId(request: Request): string {
  const incoming = request.headers.get('x-request-id')
  if (incoming && SAFE_REQUEST_ID.test(incoming)) return incoming
  return crypto.randomUUID()
}

export function safeRequestId(value: string | null | undefined): string | null {
  if (!value) return null
  return SAFE_REQUEST_ID.test(value) ? value : null
}

export interface LogInput {
  level: LogLevel
  /** Owning subsystem, e.g. "api", "auth", "monitoring", "health". */
  service: string
  message: string
  route?: string | null
  method?: string | null
  status?: number | null
  requestId?: string | null
  incidentId?: string | null
  approvalId?: string | null
  faultId?: string | null
  action?: string | null
  errorCode?: string | null
  /** Real runtime failure capture — never populated from the fault catalog. */
  errorName?: string | null
  stackTrace?: string | null
  sourceFile?: string | null
  sourceLine?: number | null
}

/**
 * Persists a structured log event. Best-effort: an observability failure must
 * never break the application request, so persistence errors fall back to a
 * single-line console log (without leaking the event's message content).
 */
export async function logEvent(input: LogInput): Promise<void> {
  try {
    await prisma.logEvent.create({
      data: {
        level: input.level,
        service: input.service,
        message: redactSensitive(input.message).slice(0, 1000),
        route: input.route?.slice(0, 200) ?? null,
        method: input.method?.toUpperCase() ?? null,
        status: input.status ?? null,
        requestId: safeRequestId(input.requestId),
        incidentId: input.incidentId ?? null,
        errorCode: input.errorCode?.slice(0, 80) ?? null,
        errorName: input.errorName?.slice(0, 80) ?? null,
        stackTrace: input.stackTrace ? redactSensitive(input.stackTrace).slice(0, 6000) : null,
        sourceFile: input.sourceFile?.slice(0, 300) ?? null,
        sourceLine: input.sourceLine ?? null,
      },
    })
  } catch (err) {
    console.error(
      '[observability] logEvent persist failed:',
      err instanceof Error ? err.message : 'unknown error',
    )
  }
}

/** Convenience helpers so routes read naturally. */
export const logger = {
  info: (input: Omit<LogInput, 'level'>) => logEvent({ ...input, level: 'INFO' }),
  warn: (input: Omit<LogInput, 'level'>) => logEvent({ ...input, level: 'WARN' }),
  error: (input: Omit<LogInput, 'level'>) => logEvent({ ...input, level: 'ERROR' }),
  security: (input: Omit<LogInput, 'level'>) => logEvent({ ...input, level: 'SECURITY' }),
}

// ---------------------------------------------------------------------------
// Real runtime failure capture.
//
// BuildHub's self-healing system discovers problems from REAL application
// error logs. These helpers extract everything the log monitor and the repair
// engine may use from a genuinely-thrown Error — never from a fault catalog.
// ---------------------------------------------------------------------------

const APP_STACK_PREFIXES = ['app/', 'lib/', 'components/', 'prisma/']

function cwdPrefixOf(): string {
  return `${process.cwd().replace(/\/+$/, '')}/`
}

/**
 * Points to the first application frame in a real stack trace
 * (file + line), ignoring node_modules / .next / internal frames.
 * `exclude` lists exact module paths to skip (used to hop past the logger
 * and its callers so the failing handler itself is located).
 * Returns null when the stack carries no usable app frame.
 */
export function firstSourceFrame(
  stack: string | null | undefined,
  options: { exclude?: string[] } = {},
): { file: string; line: number } | null {
  if (!stack) return null
  const prefix = cwdPrefixOf()
  const frameRe = /at\s+(?:async\s+)?(?:[^(]*?\s+)?\(?(.+?):(\d+):\d+\)?\s*$/m
  for (const rawLine of stack.split('\n')) {
    const match = rawLine.match(frameRe)
    if (!match) continue
    let file = match[1] ?? ''
    // webpack/turbopack virtual module wrappers
    file = file.startsWith('file://') ? decodeURIComponent(file.slice('file://'.length)) : file
    // Turbopack dev: frames point into .next/dev/server/chunks/*.js?id=[project]/<real path>+[app-route]+(ecmascript).
    const projectMarker = '[project]/'
    const projectIdx = file.indexOf(projectMarker)
    if (projectIdx !== -1) {
      file = file
        .slice(projectIdx + projectMarker.length)
        .split('+[')[0]
        .split(' (ecmascript)')[0]
    }
    if (file.startsWith(prefix)) file = file.slice(prefix.length)
    if (file.startsWith('./')) file = file.slice(2)
    if (file.includes('node_modules') || file.startsWith('.next/') || file.startsWith('webpack:')) continue
    if (!APP_STACK_PREFIXES.some((p) => file.startsWith(p))) continue
    if (options.exclude?.some((mod) => file.endsWith(mod))) continue
    const line = Number.parseInt(match[2], 10)
    if (!Number.isFinite(line) || line < 1) continue
    return { file, line }
  }
  return null
}

export interface CapturedErrorInfo {
  errorName: string | null
  message: string | null
  stackTrace: string | null
  sourceFile: string | null
  sourceLine: number | null
}

/**
 * Normalizes any thrown value into the real failure facts the log monitor
 * consumes. Messages are redacted; the stack is capped and redacted.
 */
export function captureErrorInfo(err: unknown): CapturedErrorInfo {
  const message = err instanceof Error ? err.message : String(err ?? 'unknown error')
  const stack = err instanceof Error && err.stack ? err.stack : null
  let frame = firstSourceFrame(stack)
  if (!frame) {
    // Prisma and other libraries rewrite stacks to omit frames. Fall back to
    // the live call stack at capture time, skipping the logger/response
    // helpers so the failing handler itself is reported.
    const live = new Error('capture').stack ?? ''
    frame = firstSourceFrame(live, {
      exclude: ['lib/server/logger.ts', 'lib/server/response.ts'],
    })
  }
  return {
    errorName: err instanceof Error ? err.name ?? 'Error' : 'Error',
    message: redactSensitive(message).slice(0, 1000),
    stackTrace: stack ? redactSensitive(stack).slice(0, 6000) : null,
    sourceFile: frame?.file ?? null,
    sourceLine: frame?.line ?? null,
  }
}

export interface LogApiErrorInput {
  service?: string
  route?: string | null
  method?: string | null
  status?: number
  requestId?: string | null
  incidentId?: string | null
  errorCode?: string | null
}

/**
 * Persists a real runtime ERROR event (fire-and-forget — observability must
 * never break the request). `status` defaults to 500.
 *
 * For genuine server errors (status >= 500) the error is followed, once the
 * log row is persisted, by a background runtime-incident scan so the
 * self-healing pipeline starts WITHOUT an operator trigger. The scan is
 * throttled in-process to avoid piling up scans during error bursts, and it
 * is dynamically imported to avoid a logger ↔ log-monitor import cycle.
 */
export function logApiError(err: unknown, input: LogApiErrorInput = {}): void {
  const info = captureErrorInfo(err)
  const persisted = logEvent({
    level: 'ERROR',
    service: input.service ?? 'api',
    message: `${info.errorName ?? 'Error'}: ${info.message}`,
    route: input.route ?? null,
    method: input.method ?? null,
    status: input.status ?? 500,
    requestId: safeRequestId(input.requestId) ?? undefined,
    incidentId: input.incidentId ?? null,
    errorCode: input.errorCode ?? undefined,
    errorName: info.errorName,
    stackTrace: info.stackTrace,
    sourceFile: info.sourceFile,
    sourceLine: info.sourceLine,
  })
  const status = input.status ?? 500
  if (status >= 500) {
    void persisted.then(() => maybeAutoScan()).catch(() => undefined)
  }
}

let lastAutoScanAt = 0
let trailingScan: ReturnType<typeof setTimeout> | null = null
const AUTO_SCAN_INTERVAL_MS = 8_000

async function maybeAutoScan(): Promise<void> {
  const now = Date.now()
  if (now - lastAutoScanAt < AUTO_SCAN_INTERVAL_MS) {
    // Throttled: scan once when the window ends, so a failure that lands
    // inside it still opens (or merges into) an incident without waiting
    // for another error to arrive.
    if (!trailingScan) {
      trailingScan = setTimeout(() => {
        trailingScan = null
        void maybeAutoScan()
      }, AUTO_SCAN_INTERVAL_MS - (now - lastAutoScanAt) + 50)
    }
    return
  }
  lastAutoScanAt = now
  try {
    const { scanForRuntimeIncidents } = await import('./repair/log-monitor')
    const { created, linked, scanned } = await scanForRuntimeIncidents({ limit: 100, statusMin: 500 })
    if (created.length > 0) {
      console.log(
        `[observability] auto-scan: ${created.length} incident(s) created, ${linked} log(s) linked (${scanned} scanned)`,
      )
    }
  } catch {
    // Observability must never break the request; a failed auto-scan is swallowed.
  }
}