import 'server-only'

// Phase 9 — Controlled Fault Injection Layer (RUNTIME-ONLY model)
//
// SAFETY CONTRACT (non-negotiable):
//   * Fault activation NEVER writes, patches, or rewrites source files. The
//     application source stays syntactically valid and Next.js stays bootable
//     while a fault is active. No syntax errors, no malformed TS/JS, no
//     build-time breakage — ever.
//   * A fault is a controlled RUNTIME behavior. Handlers consult
//     `isFaultActive(faultId)` and deliberately produce the documented failure
//     (thrown controlled error / faulted response / inverted check). When the
//     fault is deactivated the handler returns to normal behavior.
//   * Fault state is DURABLE across restarts via a JSON state file under
//     frontend/.data/fault-state.json — never a compiled source module.
//   * The self-healing engine repairs a runtime fault by RE-ACTIVATING normal
//     behavior (deactivating the fault) for the incident's endpoint and then
//     re-running the real failing request. No incident is fabricated here: a
//     real failing request must surface first; the log monitor turns the
//     resulting ERROR log into an incident.
//
// Each fault in the registry carries `wired: true` only when a real runtime
// guard implements it. HIGH-03 (database connection string) is catalog-only:
// activating it would require corrupting lib/server/db.ts, which violates the
// safety contract, so activation is refused.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

/**
 * Matches a registry trigger endpoint against a concrete request route.
 * Exact match first; `[param]` template segments (e.g. `/api/posts/[id]/…`)
 * match any single path segment so dynamic routes map to their fault.
 */
export function triggerTemplateMatches(triggerEndpoint: string, route: string | null): boolean {
  const norm = (route ?? '').split('?')[0]
  if (triggerEndpoint === norm) return true
  const t = triggerEndpoint.split('/')
  const r = norm.split('/')
  if (t.length !== r.length) return false
  return t.every((seg, i) => seg === r[i] || /^\[.+\]$/.test(seg))
}

export interface FaultConfig {
  id: string
  name: string
  difficulty: 'EASY' | 'MEDIUM' | 'DIFFICULT'
  /** Whether a real runtime guard in the handler implements this fault. */
  wired: boolean
  /** What the runtime guard deliberately does while the fault is active. */
  runtimeBehavior: string
  target: {
    /** Path relative to the Next.js app root (e.g. app/api/posts/route.ts). */
    file: string
    line: number
    function: string
  }
  trigger: {
    method: string
    endpoint: string
  }
  expectedError: string
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'
  riskReason: string
  /** Exact message the runtime guard surfaces in the ERROR log (only for
   * exception-style wired faults). Lets the log monitor map a real failure
   * back to its declared risk tier without duplicating registry data. */
  thrownMessage?: string
  aiExpectedFix: string
  validation: string
  rollback: string
  active: boolean
}

// Fault registry — all defined faults. `wired` marks the runtime faults
// implemented by real handler guards; `active` reflects the durable runtime
// state (never source state).
// COMMENT-01 is the demo-canonical "Cannot Comment" fault: same comment
// creation surface as LOW-04, dedicated id so the comment self-healing demo
// (Demo 3) runs under its own scenario definition.
export const FAULT_REGISTRY: Record<string, FaultConfig> = {
  'LOW-01': {
    id: 'LOW-01',
    name: 'Undefined author in Post Creation',
    difficulty: 'EASY',
    wired: true,
    runtimeBehavior:
      'POST /api/posts omits the required authorId when calling prisma.post.create, so Prisma throws a REAL PrismaClientValidationError (500). No source change.',
    target: {
      file: 'app/api/posts/route.ts',
      line: 56,
      function: 'POST handler',
    },
    trigger: { method: 'POST', endpoint: '/api/posts' },
    expectedError: '500 PrismaClientValidationError: Argument `authorId` is missing',
    riskLevel: 'LOW',
    riskReason: 'Single file, single line, no security impact',
    // Fragment of the REAL PrismaClientValidationError surfaced when the
    // guard omits authorId ("Invalid `prisma.post.create()` invocation: …").
    // Matched together with the trigger route+method in faultFor(), so the
    // incident keeps severity LOW + faultId LOW-01.
    thrownMessage: 'prisma.post.create',
    aiExpectedFix: 'Restore authorId: user.id (or restore normal runtime behavior)',
    validation: 'POST /api/posts → 201, post appears in feed',
    rollback: 'Deactivate runtime fault → handler returns to normal behavior',
    active: false,
  },
  'LOW-02': {
    id: 'LOW-02',
    name: 'Field Typo in Post Response',
    difficulty: 'EASY',
    wired: true,
    runtimeBehavior:
      'GET /api/posts/[id] renames the response key post → poost while active (200, no exception).',
    target: {
      file: 'app/api/posts/[id]/route.ts',
      line: 36,
      function: 'GET handler',
    },
    trigger: { method: 'GET', endpoint: '/api/posts/[id]' },
    expectedError: '200 response missing the `post` field (frontend renders undefined)',
    riskLevel: 'LOW',
    riskReason: 'Single file, single line, UI-only contract change',
    aiExpectedFix: 'Restore property name to post',
    validation: 'GET /api/posts/[id] → 200 with { post: {...} }',
    rollback: 'Deactivate runtime fault → property name restored',
    active: false,
  },
  'LOW-03': {
    id: 'LOW-03',
    name: 'Incorrect Validation Condition',
    difficulty: 'EASY',
    wired: true,
    runtimeBehavior:
      'Post content minimum becomes 1001 while active, so valid content is rejected with a 400 (no exception).',
    target: {
      file: 'lib/server/validation.ts',
      line: 12,
      function: 'getPostContentMin()',
    },
    trigger: { method: 'POST', endpoint: '/api/posts' },
    expectedError: '400: Post content is required (valid content rejected)',
    riskLevel: 'LOW',
    riskReason: 'Validation logic only, no security impact',
    aiExpectedFix: 'Restore minimum length 1',
    validation: 'POST /api/posts with 50-char content → 201',
    rollback: 'Deactivate runtime fault → minimum restored',
    active: false,
  },
  'LOW-04': {
    id: 'LOW-04',
    name: 'Broken Comment Creation (Server Error)',
    difficulty: 'EASY',
    wired: true,
    runtimeBehavior:
      'POST /api/posts/[id]/comments throws a controlled Error("Injected comment failure") while active (500).',
    target: {
      file: 'app/api/posts/[id]/comments/route.ts',
      line: 78,
      function: 'POST handler',
    },
    trigger: { method: 'POST', endpoint: '/api/posts/[id]/comments' },
    expectedError: '500: Internal Server Error',
    riskLevel: 'LOW',
    riskReason: 'Single comment endpoint, isolated surface, no security impact',
    thrownMessage: 'Injected comment failure',
    aiExpectedFix: 'Restore normal runtime behavior (deactivate fault)',
    validation: 'POST /api/posts/[id]/comments → 201, comment created',
    rollback: 'Deactivate runtime fault → handler returns to normal behavior',
    active: false,
  },
  'COMMENT-01': {
    id: 'COMMENT-01',
    name: 'Comment creation service failure',
    difficulty: 'EASY',
    wired: true,
    runtimeBehavior:
      'POST /api/posts/[id]/comments throws a controlled Error("COMMENT-01: Injected comment service failure") while active (500).',
    target: {
      file: 'app/api/posts/[id]/comments/route.ts',
      line: 82,
      function: 'POST handler',
    },
    trigger: { method: 'POST', endpoint: '/api/posts/[id]/comments' },
    expectedError: '500: Internal Server Error',
    riskLevel: 'LOW',
    riskReason: 'Single comment endpoint, isolated surface, no security impact',
    thrownMessage: 'COMMENT-01: Injected comment service failure',
    aiExpectedFix: 'Restore normal runtime behavior (deactivate fault)',
    validation: 'POST /api/posts/[id]/comments → 201, comment created',
    rollback: 'Deactivate runtime fault → handler returns to normal behavior',
    active: false,
  },
  'MEDIUM-01': {
    id: 'MEDIUM-01',
    name: 'Broken Post API (Server Error)',
    difficulty: 'MEDIUM',
    wired: true,
    runtimeBehavior:
      'POST /api/posts throws a controlled Error("Injected DB failure during post creation") while active (500).',
    target: {
      file: 'app/api/posts/route.ts',
      line: 60,
      function: 'POST handler',
    },
    trigger: { method: 'POST', endpoint: '/api/posts' },
    expectedError: '500: Internal Server Error',
    riskLevel: 'MEDIUM',
    riskReason: 'API endpoint, server error, affects all post creation',
    thrownMessage: 'Injected DB failure during post creation',
    aiExpectedFix: 'Remove thrown error, restore prisma.create',
    validation: 'POST /api/posts → 201, post created, appears in feed',
    rollback: 'Deactivate runtime fault → handler returns to normal behavior',
    active: false,
  },
  'MEDIUM-02': {
    id: 'MEDIUM-02',
    name: 'Database Query Failure in Feed',
    difficulty: 'MEDIUM',
    wired: true,
    runtimeBehavior:
      'GET /api/posts throws a controlled Error("Injected DB query failure") while active (500).',
    target: {
      file: 'app/api/posts/route.ts',
      line: 121,
      function: 'GET handler',
    },
    trigger: { method: 'GET', endpoint: '/api/posts' },
    expectedError: '500: Internal Server Error',
    riskLevel: 'MEDIUM',
    riskReason: 'Read endpoint, affects feed for all users',
    thrownMessage: 'Injected DB query failure',
    aiExpectedFix: 'Remove thrown error, restore prisma.findMany',
    validation: 'GET /api/posts → 200, posts array returned',
    rollback: 'Deactivate runtime fault → handler returns to normal behavior',
    active: false,
  },
  'MEDIUM-03': {
    id: 'MEDIUM-03',
    name: 'Inverted Project Update Authorization',
    difficulty: 'MEDIUM',
    wired: true,
    runtimeBehavior:
      'PATCH /api/projects/[id] ownership check is inverted while active: the owner is incorrectly denied (403), a non-owner would be allowed (no exception).',
    target: {
      file: 'app/api/projects/[id]/route.ts',
      line: 84,
      function: 'PATCH handler',
    },
    trigger: { method: 'PATCH', endpoint: '/api/projects/[id]' },
    expectedError: '403: Forbidden (owner incorrectly denied)',
    riskLevel: 'MEDIUM',
    riskReason: 'Authz logic, single route, business logic bug (no exception)',
    aiExpectedFix: 'Restore !== comparison',
    validation: 'Owner PATCH own project → 200, non-owner → 403',
    rollback: 'Deactivate runtime fault → comparison restored',
    active: false,
  },
  'HIGH-01': {
    id: 'HIGH-01',
    name: 'Authentication Verification Failure',
    difficulty: 'DIFFICULT',
    wired: true,
    runtimeBehavior:
      'POST /api/auth/login throws Error("Credentials verification subsystem failure") when the password is wrong while active (500 instead of 401). Correct credentials still succeed.',
    target: {
      file: 'app/api/auth/login/route.ts',
      line: 64,
      function: 'POST handler',
    },
    trigger: { method: 'POST', endpoint: '/api/auth/login' },
    expectedError: '500: Credentials verification subsystem failure (wrong password)',
    riskLevel: 'HIGH',
    riskReason: 'Authentication path, security-critical, affects all users',
    thrownMessage: 'Credentials verification subsystem failure',
    aiExpectedFix: 'Remove thrown error so wrong passwords return 401 via verifyPassword',
    validation: 'Wrong password → 401, correct password → 200',
    rollback: 'Deactivate runtime fault → 401 path restored',
    active: false,
  },
  'HIGH-02': {
    id: 'HIGH-02',
    name: 'Authorization Bypass in Project Deletion',
    difficulty: 'DIFFICULT',
    wired: true,
    runtimeBehavior:
      'DELETE /api/projects/[id] ownership guard is disabled while active: any authenticated user can delete another user\u2019s project (403 bypass, no exception).',
    target: {
      file: 'app/api/projects/[id]/route.ts',
      line: 143,
      function: 'DELETE handler',
    },
    trigger: { method: 'DELETE', endpoint: '/api/projects/[id]' },
    expectedError: '200: Deleted (non-owner incorrectly allowed)',
    riskLevel: 'HIGH',
    riskReason: 'Authorization bypass, data destruction, security-critical',
    aiExpectedFix: 'Restore ownership check',
    validation: 'Non-owner DELETE → 403, owner DELETE → 200',
    rollback: 'Deactivate runtime fault → ownership guard restored',
    active: false,
  },
  'HIGH-03': {
    id: 'HIGH-03',
    name: 'Database Connectivity Failure',
    difficulty: 'DIFFICULT',
    wired: false,
    runtimeBehavior:
      'CATALOG-ONLY. Implementing this fault would require corrupting lib/server/db.ts (a cascading source defect). That violates the runtime-only safety contract, so activation is refused.',
    target: {
      file: 'lib/server/db.ts',
      line: 11,
      function: 'createPrismaClient()',
    },
    trigger: { method: 'ANY', endpoint: '/*' },
    expectedError: '500: Database connection failed',
    riskLevel: 'HIGH',
    riskReason: 'Infrastructure failure, cascading, affects entire application',
    aiExpectedFix: 'Restore correct DATABASE_URL',
    validation: 'GET /api/health → database: healthy, GET /api/posts → 200',
    rollback: 'Restore connection string',
    active: false,
  },
}

const STATE_VERSION = 1

/** Durable runtime fault state — the ONLY thing activation persists. */
function stateFilePath(): string {
  return resolve(process.cwd(), '.data', 'fault-state.json')
}

// One active-fault set per server process. In `next dev` each route bundle
// can load its own copy of this module; a module-level Set would let the
// repair engine deactivate a fault in ITS copy while the route handler still
// sees it active in another copy (validation then fails and rolls back).
// globalThis is shared by every copy, so all handlers see the same state.
const ACTIVE_KEY = '__buildhub_active_faults__'
const faultGlobal = globalThis as unknown as Record<string, Set<string> | undefined>
if (!faultGlobal[ACTIVE_KEY]) faultGlobal[ACTIVE_KEY] = new Set<string>()
const activeFaults = faultGlobal[ACTIVE_KEY] as Set<string>

function replaceActive(ids: Iterable<string>): void {
  activeFaults.clear()
  for (const id of ids) activeFaults.add(id)
}

function applyActiveSet(): void {
  for (const fault of Object.values(FAULT_REGISTRY)) {
    fault.active = activeFaults.has(fault.id)
  }
}

async function loadPersistedState(): Promise<void> {
  try {
    const raw = await readFile(stateFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as { version?: number; active?: string[] } | null
    const ids = Array.isArray(parsed?.active) ? (parsed?.active ?? []) : []
    const known = new Set(Object.keys(FAULT_REGISTRY))
    replaceActive(ids.filter((id) => known.has(id)))
  } catch {
    // No state file yet (or unreadable) → all inactive. Never crash on a bad file.
    replaceActive([])
  }
  applyActiveSet()
}

async function persistState(): Promise<void> {
  try {
    await mkdir(dirname(stateFilePath()), { recursive: true })
    await writeFile(
      stateFilePath(),
      JSON.stringify({ version: STATE_VERSION, active: Array.from(activeFaults) }, null, 2),
      'utf8',
    )
  } catch (err) {
    // Fault state must never break a request; log and continue in-memory.
    console.warn(`[fault-injection] failed to persist fault state: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

export function isFaultInjectionEnabled(): boolean {
  return process.env.FAULT_INJECTION_ENABLED === 'true'
}

export function getFaultRegistry(): FaultConfig[] {
  return Object.values(FAULT_REGISTRY)
}

export function getFault(faultId: string): FaultConfig | null {
  return FAULT_REGISTRY[faultId] ?? null
}

// The durable state file is the source of truth. Code that runs outside the
// request graph (the background Jira poller started from instrumentation, the
// auto-repair queue) may hold a separate in-memory copy, so a guard re-reads
// the file whenever it changed on disk (a cheap stat per check).
let seenStateMtime = -1

function syncFromDisk(): void {
  try {
    const mtime = statSync(stateFilePath()).mtimeMs
    if (mtime === seenStateMtime) return
    const parsed = JSON.parse(readFileSync(stateFilePath(), 'utf8')) as { active?: string[] } | null
    const known = new Set(Object.keys(FAULT_REGISTRY))
    replaceActive((Array.isArray(parsed?.active) ? parsed.active : []).filter((id) => known.has(id)))
    applyActiveSet()
    seenStateMtime = mtime
  } catch {
    // No/unreadable state file: keep the in-memory state.
  }
}

/** Synchronous guard read used by route handlers. */
export function isFaultActive(faultId: string): boolean {
  if (!isFaultInjectionEnabled()) return false
  syncFromDisk()
  return activeFaults.has(faultId)
}

export function getActiveFaults(): FaultConfig[] {
  return Array.from(activeFaults)
    .map((id) => FAULT_REGISTRY[id])
    .filter(Boolean)
}

/**
 * Reloads state from the durable file so the registry reflects reality across
 * process boundaries. Never restores "active" state that was deactivated via
 * the engine or the API.
 */
export async function reconcileActiveFaults(): Promise<void> {
  await loadPersistedState()
}

// ---------------------------------------------------------------------------
// Activation / deactivation (runtime state only — no file writes)
// ---------------------------------------------------------------------------

/**
 * Activates a fault by flipping durable runtime state. The affected handlers
 * read `isFaultActive` and inject the controlled failure. Source is NEVER
 * touched. Faults without a runtime guard (HIGH-03) are refused.
 */
export async function activateFault(faultId: string): Promise<{ ok: boolean; error?: string }> {
  if (!isFaultInjectionEnabled()) {
    return { ok: false, error: 'Fault injection not enabled (FAULT_INJECTION_ENABLED=true required)' }
  }
  const fault = getFault(faultId)
  if (!fault) return { ok: false, error: `Fault ${faultId} not found` }
  if (!fault.wired) {
    return {
      ok: false,
      error: `Fault ${faultId} has no runtime wiring in this build; activating it would require corrupting source files, which is not allowed.`,
    }
  }

  await reconcileActiveFaults()
  activeFaults.add(faultId)
  fault.active = true
  await persistState()
  return { ok: true }
}

/** Deactivates a fault by flipping durable runtime state (handlers go back to
 * their normal behavior immediately). */
export async function deactivateFault(faultId: string): Promise<{ ok: boolean; error?: string }> {
  const fault = getFault(faultId)
  if (!fault) return { ok: false, error: `Fault ${faultId} not found` }

  await reconcileActiveFaults()
  activeFaults.delete(faultId)
  fault.active = false
  await persistState()
  return { ok: true }
}

export async function deactivateAllFaults(): Promise<void> {
  await reconcileActiveFaults()
  activeFaults.clear()
  applyActiveSet()
  await persistState()
}

/**
 * Deactivates every ACTIVE WIRED fault whose documented trigger matches the
 * incident's endpoint. Used by the self-healing engine to restore normal
 * runtime behavior for the surface under repair. Falls back to a full
 * deactivation when the matched set is empty but faults are active (keeps the
 * runtime regime consistent with an incident that names the endpoint).
 */
export async function deactivateFaultsForEndpoint(
  endpoint: string,
  method?: string | null,
): Promise<string[]> {
  const norm = (endpoint ?? '/').split('?')[0]
  const verb = (method ?? 'ANY').toUpperCase()
  await reconcileActiveFaults()
  const matching = getActiveFaults().filter(
    (f) => f.wired && triggerTemplateMatches(f.trigger.endpoint, norm) && (f.trigger.method === 'ANY' || f.trigger.method.toUpperCase() === verb),
  )
  const target = matching.length > 0 ? matching : getActiveFaults().filter((f) => f.wired)
  const deactivated: string[] = []
  for (const fault of target) {
    if (activeFaults.has(fault.id)) {
      activeFaults.delete(fault.id)
      fault.active = false
      deactivated.push(fault.id)
    }
  }
  if (deactivated.length > 0) await persistState()
  return deactivated
}

/** Restores runtime faults previously deactivated for an endpoint — the honest
 * "rollback" of a runtime regime when validation fails after deactivation. */
export async function reactivateFaults(faultIds: string[]): Promise<void> {
  await reconcileActiveFaults()
  let changed = false
  for (const id of faultIds) {
    const fault = getFault(id)
    if (fault?.wired && !activeFaults.has(id)) {
      activeFaults.add(id)
      fault.active = true
      changed = true
    }
  }
  if (changed) await persistState()
}

// ---------------------------------------------------------------------------
// Backwards-compatible surface (UI + legacy scripts).
// ---------------------------------------------------------------------------

/** @deprecated — kept for legacy callers only. */
export function shouldApplyFault(_faultId: string): boolean {
  return isFaultInjectionEnabled()
}

export const applyDefect = activateFault
export const restoreDefect = deactivateFault
export async function restoreAllDefects(): Promise<void> {
  await deactivateAllFaults()
}

// Legacy disarm/rearm — kept for import safety until the patch engine is
// fully reworked. They are inert.
const disarmedFaults = new Set<string>()

export function disposeFault(faultId: string): void {
  disarmedFaults.delete(faultId)
}

export function isFaultDisarmed(faultId: string): boolean {
  return disarmedFaults.has(faultId)
}

export function resetFaultDisarms(): void {
  disarmedFaults.clear()
}