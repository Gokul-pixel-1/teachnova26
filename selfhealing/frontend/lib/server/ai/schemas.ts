import 'server-only'

// Phase 10 — strict AI output contract validation.
//
// Schema definitions and helpers live in `lib/ai/schemas` (pure — no server deps),
// so `scripts/test-ai-safety.mts` can assert the shipped contracts directly.
// This module re-exports them for the server-side import path.

export {
  type AnalyzerOutput,
  AnalyzerSchema,
  type CoderValidation,
  CoderSchema,
  type CriticValidation,
  CriticSchema,
  type JudgeValidation,
  JudgeSchema,
  extractJsonObject,
  validateWith,
  parseAndValidate,
} from '../../ai/schemas'