import 'server-only'

// UX Suggestion Agent — shared types. Deliberately independent of
// lib/server/providers/types.ts's RepairEvidence/CoderOutput: those are
// error/root-cause framed (stack traces, endpoints, error codes) and do not
// fit a proactive "reposition this UI element" instruction.

export type UxDirection = 'left' | 'right' | 'up' | 'down'

export interface UxDraftInput {
  /** Human-facing name of the UI element/component, e.g. "login-button". */
  component: string
  /** Repo-relative (or frontend/-prefixed) path to the file that renders it. */
  file: string
  /** Optional hint describing the desired change. Free text. */
  instruction?: string
  /** Registry id of the tracked element (its data-ux-id), when known. */
  uxId?: string
  /** Side users expected the element on, derived from behaviour evidence. */
  direction?: UxDirection
  /** Median offset (px from the element's centre) where users looked for it. */
  hotspot?: { dx: number; dy: number; samples: number }
  /** Human-readable behaviour evidence shown to the reviewer agent. */
  evidenceSummary?: string
  /** Sandbox results of placements already tried (so the next one differs). */
  feedback?: string
  /** 0-based attempt number within one sandbox trial run. */
  attempt?: number
  /** proposedCode values already tried — never propose these again. */
  triedProposals?: string[]
}

export interface UxDraftResult {
  ok: boolean
  error?: string
  summary?: string
  line?: number | null
  function?: string | null
  currentCode?: string
  proposedCode?: string
  /** Model id that produced the draft, or a fixed label in TEST mode. */
  model?: string
}
