import 'server-only'

// Phase 9 — hermetic deterministic provider used only when AI_PROVIDER=test
// and SELF_HEALING_TEST_MODE is truthy. Its purpose is isolated, repeatable
// validation of the engine WITHOUT external network calls and WITHOUT canned
// fault answers. The provider reasons from the SAME real evidence a model would
// see (stack trace + rendered real source file + error code) and applies
// deterministic repair patterns to the defect-bearing line it finds there.
// Every interaction is persisted with mode=TEST so it can never be mistaken for
// production telemetry.

import type {
  AIProvider,
  ProviderCall,
  ProviderResponse,
  ProviderName,
  ModeLabel,
  CoderOutput,
  CriticOutput,
  JudgeOutput,
  RepairEvidence,
} from './types'

// Parse an isolated JSON body (with optional code fence) into an object.
function parseFenced(content: string): Record<string, unknown> | null {
  const trimmed = content.trim()
  for (const candidate of [trimmed, trimmed.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')]) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      /* try next candidate */
    }
  }
  return null
}

const MODEL = 'test-provider'
const SOURCE_LINE_RE = /^([ >])\s*(\d+)\s*\| (.*)$/

/**
 * Deterministic repair rules. Each matches a real defect pattern visible in the
 * rendered source and produces the restored line. These are general "remove the
 * offending construct / restore the sane form" rules — matched against the file
 * the failure occurred in, never keyed by fault id.
 */
interface FixRule {
  marker: RegExp
  restore: (line: string) => string
}

const FIX_RULES: FixRule[] = [
  // Undefined member access (e.g. `user.id.missingField,`).
  { marker: /\.missingField\s*,?\s*$/, restore: (line) => line.replace(/\.missingField/, '') },
  // Injected/accidental throw statements that abort the handler.
  { marker: /throw new Error\('Injected DB/i, restore: () => '' },
  // Impossible validation minimum.
  { marker: /^return 1001[\s\S]*/, restore: () => 'return 1 // Normal' },
  // Appended credential-verification throw on the login path.
  { marker: /; if \(!passwordValid\) throw new Error\('Credentials verification/i, restore: (line) => line.split(/; if \(!passwordValid\) throw/)[0] },
  // Inverted ownership comparison.
  { marker: /=== user\.id/, restore: (line) => line.replace(/=== user\.id/, '!== user.id') },
  // Commented / half-disabled ownership guard.
  { marker: /false && existing\.ownerId/, restore: (line) => line.replace(/false &&\s*/, '') },
  // Hard-coded broken database connection string.
  { marker: /postgresql:\/\/invalid:invalid/, restore: (line) => line.replace(/'postgresql:\/\/invalid:invalid@localhost:5432\/invalid'/, 'process.env.DATABASE_URL') },
  // Response key typo.
  { marker: /\{[ \t]*poost: /, restore: (line) => line.replace(/\bpoost\b/g, 'post') },
  // LOW-01 unconditional fault: an UNGUARDED `throw new Error('LOW-01...` must
  // be made runtime-controllable by wrapping it in the isFaultActive guard —
  // NEVER deleted (deleting the line would hide the fault instead of making it
  // controllable, and the engine could never gate it again). The guard-aware
  // scan above already skips throws that sit inside an isFaultActive block, so
  // this rule only fires for the unguarded (CASE B) source.
  {
    marker: /throw new Error\('LOW-01/,
    restore: (line) => {
      const indent = line.match(/^\s*/)?.[0] ?? ''
      const stmt = line.trim()
      return `if (isFaultActive('LOW-01')) {\n${indent}  ${stmt}\n${indent}}`
    },
  },
  // Generic safety net: a lone throw line that aborts handling.
  { marker: /^\s*throw new Error\(.+\);/, restore: () => '' },
]

interface SourceHit {
  line: number
  code: string
  fixed: string
}

function findDefectHit(evidence: RepairEvidence): SourceHit | null {
  const context = evidence.sourceContext
  if (!context) return null
  // Guard-aware scan: lines belonging to the runtime fault-injection scaffolding
  // (`if (isFaultActive(...)) { ... }` blocks, ternaries, and helper calls) are
  // NOT source defects — no matter how much their text resembles one. The real
  // source is healthy by design; a genuine structural defect is only matched
  // when it appears OUTSIDE any fault guard.
  let guardDepth = 0
  for (const raw of context.split('\n')) {
    const match = raw.match(SOURCE_LINE_RE)
    if (!match) continue
    const code = match[3]
    const trimmed = code.trim()

    if (code.includes('isFaultActive(')) {
      const opens = (code.match(/\{/g) ?? []).length
      const closes = (code.match(/\}/g) ?? []).length
      guardDepth = Math.max(0, guardDepth + opens - closes)
      continue
    }
    if (guardDepth > 0) {
      const opens = (code.match(/\{/g) ?? []).length
      const closes = (code.match(/\}/g) ?? []).length
      guardDepth = Math.max(0, guardDepth + opens - closes)
      continue
    }

    if (!trimmed) continue
    for (const rule of FIX_RULES) {
      if (rule.marker.test(code) || rule.marker.test(trimmed)) {
        const fixed = rule.restore(code)
        if (fixed !== code) {
          return { line: Number.parseInt(match[2], 10), code, fixed }
        }
      }
    }
  }
  return null
}

function roundText(round: number): string {
  return `Round ${round}: deterministic test scenario.`
}

function analyzerJson(evidence: RepairEvidence): string {
  const output: {
    classification: string
    rootCause: string
    evidence: string[]
    suspectedFiles: string[]
    confidence: number
  } = {
    classification: evidence.errorCode ?? 'runtime-failure',
    rootCause: `Deterministic analysis: the failure originates in ${evidence.suspectSource}.`,
    evidence: [`Observed ${evidence.errorCode ?? evidence.title} on ${evidence.method} ${evidence.endpoint}.`],
    suspectedFiles: [evidence.suspectSource],
    confidence: 0.9,
  }
  return emit(output)
}

function coderJson(evidence: RepairEvidence, scenario?: string): { json: string; hit: SourceHit | null } {
  const hit = findDefectHit(evidence)
  if (!hit) {
    // The REAL source is healthy — the failure is produced by an active
    // controlled runtime fault. Direct the engine to restore normal runtime
    // behavior instead of applying a source patch. `bad-fix` scenario emits a
    // 'none' directive so the REAL validation probe fails and the engine
    // reports an honest ROLLED_BACK (no fabricated success).
    const runtimeRepair = scenario === 'bad-fix' ? 'none' : 'restore'
    const output: CoderOutput = {
      diagnosis: `Deterministic runtime repair: source is healthy — restore normal runtime behavior for ${evidence.method} ${evidence.endpoint}`,
      rootCause: `The real source file is healthy; the failure originates from an active controlled runtime fault that must be restored.`,
      file: evidence.suspectSource,
      line: null,
      function: '',
      affectedBehavior: evidence.endpoint ? `${evidence.method} ${evidence.endpoint} fails until normal runtime behavior is restored` : 'Endpoint behavior is broken.',
      currentCode: 'Runtime fault active (real source is healthy).',
      proposedCode: runtimeRepair === 'none' ? 'no repair applied (bad-fix scenario: validation must fail)' : 'Restore normal runtime behavior.',
      validationPlan: 'Restore runtime behavior and re-run the recorded failing request.',
      confidence: 90,
      runtimeRepair,
    }
    return { json: emit(output), hit: null }
  }
  const output: CoderOutput = {
    diagnosis: `Deterministic repair of real failure in ${evidence.suspectSource}: ${evidence.errorCode ?? evidence.title}`,
    rootCause: `The code shown at ${evidence.suspectSource}:${hit.line} produces the observed failure.`,
    file: evidence.suspectSource,
    line: hit.line,
    function: '',
    affectedBehavior: evidence.endpoint ? `${evidence.method} ${evidence.endpoint} fails until the defect is restored` : 'Endpoint behavior is broken.',
    currentCode: hit.code,
    proposedCode: hit.fixed,
    validationPlan: 'Re-run the recorded failing request and expect the healthy status.',
    confidence: 88,
  }
  return { json: emit(output), hit }
}

/**
 * `scenario='bad-fix'` — a deliberately WRONG candidate that still passes the
 * structural checks (verifyCandidate) so the engine's REAL validation probe has
 * to catch it and roll back. Mirrors a weak model confidently producing a bad
 * patch; only selected by the test harness, never in production. Provenance is
 * explicit: the proposed line keeps the defect and tags the misfix.
 */
function badFixJson(hit: SourceHit, evidence: RepairEvidence): string {
  const output: CoderOutput = {
    diagnosis: `[bad-fix scenario] deterministic WRONG fix for ${evidence.suspectSource}:${hit.line} — validation must fail`,
    rootCause: 'This candidate is intentionally incorrect so the engine validation probe has to roll it back.',
    file: evidence.suspectSource,
    line: hit.line,
    function: '',
    affectedBehavior: evidence.endpoint ? `${evidence.method} ${evidence.endpoint} still fails after this patch` : 'Endpoint behavior remains broken.',
    currentCode: hit.code,
    proposedCode: `${hit.code} // [TEST] bad-fix candidate (must fail validation)`,
    validationPlan: 'Re-run the recorded failing request — it MUST still fail so the patch is rolled back.',
    confidence: 95,
  }
  return emit(output)
}

// Round-trip the simulated output through the same JSON parser the engine uses
// so DECODED structs (parse errors excluded) are what tests assert on.
function emit(obj: unknown): string {
  const json = JSON.stringify(obj)
  const parsed = parseFenced(json)
  return parsed === null ? json : JSON.stringify(parsed)
}

function criticJson(verdict: 'ACCEPT' | 'REVISE' | 'REJECT', round: number): string {
  const output: CriticOutput =
    verdict === 'ACCEPT'
      ? {
          verdict,
          reasoning: 'The proposed change removes the defect-bearing construct and restores sane behavior for the observed failure.',
          problems: [],
          requiredChanges: ['None.'],
          testsRequired: ['Re-run the incident HTTP probe.'],
          securityConcerns: [],
        }
      : {
          verdict,
          reasoning: 'The proposed change still shows a gap against the evidence described in the incident.',
          problems: ['Proposed change is not yet confirmed against the healthy behavior.'],
          requiredChanges: ['Align proposedCode with the healthy behavior.'],
          testsRequired: ['Re-run the incident HTTP probe.'],
          securityConcerns: [],
        }
  void roundText(round)
  return emit(output)
}

function judgeJson(decision: 'APPROVE' | 'REJECT', risk: string): string {
  const output: JudgeOutput = {
    decision,
    reasoning: decision === 'APPROVE'
      ? 'Conversation converged; proposed patch is backed by real evidence and safe to apply.'
      : 'Repair conversation could not converge to a safe candidate.',
    confidence: decision === 'APPROVE' ? 90 : 25,
    risk: (risk as JudgeOutput['risk']) || 'MEDIUM',
    validationItems: ['Re-run the real failing request after apply.'],
  }
  return emit(output)
}

/** Structural risk derived from the real incident's severity. */
function riskForEvidence(evidence: RepairEvidence): 'LOW' | 'MEDIUM' | 'HIGH' {
  const s = evidence.severity.toUpperCase()
  if (s === 'HIGH' || s === 'CRITICAL') return 'HIGH'
  if (s === 'MEDIUM') return 'MEDIUM'
  return 'LOW'
}

export function createTestProvider(): AIProvider {
  return {
    name: 'test' as ProviderName,
    mode: 'TEST' as ModeLabel,
    configuredModel: () => MODEL,
    async probeModels() {
      return [MODEL]
    },
    async call(req: ProviderCall): Promise<ProviderResponse> {
      const { role, round, scenario, evidence } = req.context
      let content: string | null = null
      let error: string | null = null

      if (role === 'ANALYZER') {
        if (!evidence) {
          error = 'TEST provider requires real repair evidence for ANALYZER determinism.'
        } else {
          content = analyzerJson(evidence)
        }
      } else if (role === 'CODER') {
        if (!evidence) {
          error = 'TEST provider requires real repair evidence for CODER determinism.'
        } else {
          const built = coderJson(evidence, scenario)
          if (built.hit) {
            content = scenario === 'bad-fix' ? badFixJson(built.hit, evidence) : built.json
          } else {
            content = built.json
          }
        }
      } else if (role === 'CRITIC') {
        const s = scenario ?? 'accept-round-1'
        if (s === 'bad-fix') {
          // Accept the erroneous candidate so the engine relies on its REAL
          // validation probe (and rollback) to catch it — never on the critic.
          content = criticJson('ACCEPT', round)
        } else if (s === 'reject-all') {
          content = criticJson('REJECT', round)
        } else if (s === 'accept-round-1') {
          content = criticJson('ACCEPT', round)
        } else if (s === 'accept-round-2') {
          content = criticJson(round === 1 ? 'REVISE' : 'ACCEPT', round)
        } else if (s === 'accept-round-3') {
          content = criticJson(round < 3 ? 'REVISE' : 'ACCEPT', round)
        } else {
          content = criticJson('ACCEPT', round)
        }
      } else if (role === 'JUDGE') {
        const risk = evidence ? riskForEvidence(evidence) : 'MEDIUM'
        const decision = scenario === 'judge-reject' ? 'REJECT' : 'APPROVE'
        content = judgeJson(decision, risk)
      } else {
        error = `TEST provider: unsupported role ${role}`
      }

      return {
        ok: content !== null,
        status: content !== null ? 'COMPLETE' : 'FAILED',
        provider: 'test',
        mode: 'TEST',
        model: MODEL,
        content: content ?? undefined,
        error: error ?? undefined,
        promptTokens: 1,
        completionTokens: 1,
      }
    },
  }
}