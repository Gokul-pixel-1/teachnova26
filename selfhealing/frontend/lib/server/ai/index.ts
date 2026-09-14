import 'server-only'

// Phase 10 — local AI module index.
//
// Re-exports the pieces the rest of the app needs so imports stay short.
// Server-only is enforced here and by each submodule.

export { createOllamaProvider, ollamaRuntimeStats, MODEL as ollamaDefaultModel } from './ollama-provider'
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
} from './schemas'
export {
  inferenceQueueLength,
  withInferenceQueue,
} from './queue'
export {
  truncate,
  cappedLines,
  renderLogRows,
  renderStack,
  renderSource,
  renderMemoryHints,
  MAX_LOG_ROWS,
  MAX_STACK_LINES,
  MAX_SOURCE_CHARS,
} from './context-builder'
