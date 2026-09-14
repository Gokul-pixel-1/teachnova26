import 'server-only'

// Phase 11 — bracketed pipeline trace. Every meaningful self-healing step is
// printed to the server console with a recognizable bracket prefix so a judge
// watching the terminal can follow the pipeline live, and persisted as an
// INFO LogEvent so the same steps are visible in the JSON observability store.
// Messages are passed through the shared redaction backstop — passwords,
// cookies, tokens, API keys and URLs-with-credentials are never printed.

import { logger, redactSensitive } from '@/lib/server/logger'

export type TraceStage =
  | 'SELF-HEALING'
  | 'DISCOVERY'
  | 'AGENT-1 ANALYZER'
  | 'AGENT-2 CODER'
  | 'AGENT-3 CRITIC'
  | 'JUDGE'
  | 'EVIDENCE'
  | 'BACKUP'
  | 'PATCH'
  | 'CURL'
  | 'VALIDATION'
  | 'SCORE'
  | 'LEARN'
  | 'APPROVAL'
  | 'ROLLBACK'
  | 'FINAL'

const STAGE_COLORS: Record<TraceStage, string> = {
  'SELF-HEALING': '\u001b[1;36m',
  DISCOVERY: '\u001b[1;36m',
  'AGENT-1 ANALYZER': '\u001b[1;35m',
  'AGENT-2 CODER': '\u001b[1;34m',
  'AGENT-3 CRITIC': '\u001b[1;33m',
  JUDGE: '\u001b[1;35m',
  EVIDENCE: '\u001b[1;36m',
  BACKUP: '\u001b[1;36m',
  PATCH: '\u001b[1;34m',
  CURL: '\u001b[1;32m',
  VALIDATION: '\u001b[1;32m',
  SCORE: '\u001b[1;32m',
  LEARN: '\u001b[1;33m',
  APPROVAL: '\u001b[1;33m',
  ROLLBACK: '\u001b[0;31m',
  FINAL: '\u001b[1;31m',
}

interface TraceMeta {
  incidentRef?: string | null
  incidentId?: string | null
  route?: string | null
  method?: string | null
}

/** Prints `[STAGE] message` to stdout and persists an INFO LogEvent. */
export function trace(stage: TraceStage, message: string, meta: TraceMeta = {}): void {
  const clean = redactTrace(message)
  const color = STAGE_COLORS[stage] ?? ''
  const reset = '\u001b[0m'
  const prefix = `${color}[${stage}]${reset}`
  const reference = meta.incidentRef ? ` [${meta.incidentRef}]` : ''
  console.log(`${prefix}${reference} ${clean}`)
  void logger
    .info({
      service: 'self-healing',
      message: `[${stage}] ${clean}`.slice(0, 1000),
      route: meta.route ?? null,
      method: meta.method ?? null,
      status: 200,
      incidentId: meta.incidentId ?? null,
    })
    .catch(() => undefined)
}

/** Redaction backstop imported from the logger module (single source). */
function redactTrace(message: string): string {
  return redactSensitive(message).slice(0, 2000)
}

export { redactSensitive }