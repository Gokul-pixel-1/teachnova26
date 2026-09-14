// Phase 10/11 — strict AI output contract validation (pure module, no server deps).
//
// Every agent's raw LLM response is validated against an explicit schema before
// the engine may act on it. A response that violates the schema is recorded as
// a FAILED agent run — it is never partially trusted. Unknown keys are ignored;
// required fields, enums, ranges and array caps are enforced.
//
// Pure on purpose: `scripts/test-ai-safety.mts` imports this module directly
// (plain Node, no `server-only`, no Prisma) to assert the shipped contracts.

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Analyzer (first-stage failure analyst)
// ---------------------------------------------------------------------------

const stringArray = (max: number) => z.array(z.string().min(1).max(600)).max(max)

export const AnalyzerSchema = z.object({
  classification: z.string().min(1).max(120).default('runtime-failure'),
  rootCause: z.string().min(1).max(2000),
  evidence: stringArray(10).default([]),
  suspectedFiles: stringArray(8).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
})
export type AnalyzerOutput = z.infer<typeof AnalyzerSchema>

// ---------------------------------------------------------------------------
// Coder
// ---------------------------------------------------------------------------

export const CoderSchema = z.object({
  diagnosis: z.string().min(1).max(2000),
  rootCause: z.string().min(1).max(1500).default(''),
  file: z.string().min(1).max(300),
  line: z.number().nullable().default(null),
  function: z.string().max(300).default(''),
  affectedBehavior: z.string().max(1000).default(''),
  currentCode: z.string().min(1).max(7000),
  proposedCode: z.string().max(14000).default(''),
  validationPlan: z.string().max(1000).default(''),
  confidence: z.number().min(0).max(100).default(50),
  // Nullish (not just optional): models explicitly emit `"runtimeRepair": null`
  // for an ordinary file-patch candidate that needs no runtime directive.
  // A literal null must validate and normalize to "absent" — rejecting the
  // whole candidate for this would discard a correct source repair.
  runtimeRepair: z.enum(['restore', 'none']).nullish(),
})
export type CoderValidation = z.infer<typeof CoderSchema>

// ---------------------------------------------------------------------------
// Critic
// ---------------------------------------------------------------------------

export const CriticSchema = z.object({
  verdict: z.enum(['ACCEPT', 'REVISE', 'REJECT']),
  reasoning: z.string().min(1).max(2000),
  problems: stringArray(8).default([]),
  requiredChanges: stringArray(8).default([]),
  testsRequired: stringArray(8).default([]),
  securityConcerns: stringArray(8).default([]),
})
export type CriticValidation = z.infer<typeof CriticSchema>

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export const JudgeSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reasoning: z.string().min(1).max(2500),
  confidence: z.number().min(0).max(100).default(50),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
  validationItems: stringArray(8).default([]),
})
export type JudgeValidation = z.infer<typeof JudgeSchema>

// ---------------------------------------------------------------------------
// Extraction + validation helpers
// ---------------------------------------------------------------------------

/** Walks fenced/bare/embedded JSON and returns the first parseable object. */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    const inner = fence[1].trim()
    try {
      const parsed = JSON.parse(inner)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* fall through */
    }
  }

  let depth = 0
  let start = -1
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0 && start !== -1) {
        const candidate = trimmed.slice(start, i + 1)
        try {
          const parsed = JSON.parse(candidate)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>
          }
        } catch {
          /* keep scanning */
        }
      }
    }
  }
  return null
}

export type StrictParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Validates an extracted JSON object against a schema; never throws. */
export function validateWith<T>(
  schema: z.ZodType<T>,
  parsed: Record<string, unknown> | null,
): StrictParseResult<T> {
  if (!parsed) return { ok: false, error: 'no parseable JSON object in response' }
  const result = schema.safeParse(parsed)
  if (result.success) return { ok: true, value: result.data }
  const first = result.error.issues[0]
  return {
    ok: false,
    error: first
      ? `schema violation at ${first.path.join('.') || '<root>'}: ${first.message}`
      : 'schema violation',
  }
}

/** Validates a full response string (extraction + schema). */
export function parseAndValidate<T>(
  schema: z.ZodType<T>,
  content: string,
): StrictParseResult<T> {
  return validateWith(schema, extractJsonObject(content))
}