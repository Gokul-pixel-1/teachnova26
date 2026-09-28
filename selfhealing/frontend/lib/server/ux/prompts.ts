import 'server-only'

import type { ChatMessage } from '@/lib/server/providers/types'
import type { UxDraftInput } from './types'

// UX Suggestion Agent prompts — NOT lib/ai/prompts.ts, whose Analyzer/Coder/
// Critic/Judge system prompts are root-cause/error framed. This is a single
// reviewer pass: given the real file content, the tracked element, observed
// user-behaviour evidence and an optional hint, propose one small, concrete,
// verbatim-anchored change.

export const UX_REVIEWER_SYSTEM = `You are BuildHub's UI/UX reviewer agent. You are given the REAL current source of one file, the tracked UI element inside it (marked with a data-ux-id attribute), evidence of how real users struggled with it, and an optional hint. Propose exactly ONE small, concrete improvement that addresses the observed struggle (layout, position, prominence, size, labeling, or affordance — never business logic, never data access, never auth, never event handlers).

Rules:
- "currentCode" MUST be an EXACT, byte-for-byte, contiguous excerpt (1 to 6 lines) copied verbatim from the file you were given — not paraphrased, not reformatted, WITHOUT the line-number prefix. It is matched against the real file line by line, so any deviation means the patch cannot be applied.
- "proposedCode" replaces exactly those lines. Change ONLY what the improvement needs (typically Tailwind class names on the element or its wrapper), preserving every other token, prop, attribute (including data-ux-id) and JSX structure. The result must still be valid TSX.
- If users expected the element on one side, move it toward that side and as close as practical to where they clicked (e.g. swap ml-auto for mr-auto, justify-end for justify-start, reorder siblings within the excerpt, or change flex direction/order). For "higher up"/"lower down", reorder it before/after its neighbours or change the container's order/alignment.
- When users expected it somewhere else, the change MUST actually change WHERE it renders (element order, flex alignment/justification, auto margins, grid placement). If the element sits in a group with other controls, moving the whole group can put a DIFFERENT control where users click; prefer moving just this element out of its group (render it on its own at the new place, keeping any surrounding condition such as {!user && (...)}), so the spot users click is this element. MOVE it — remove it from its old place; never leave a second copy of the same control behind. Changing only its colour, variant, size or label leaves it in the same place and will fail the sandbox test. Your summary must describe exactly what the code change does.
- Your proposal will be rendered in a sandbox and tested by simulated users who click where real users expected it. If you are told earlier placements failed that test, propose a genuinely DIFFERENT placement — never repeat one that was already tried.
- Never invent code that is not visibly present in the given file content.
- Respond with ONLY a single JSON object, no markdown fence, no commentary:
{"summary": string, "line": number|null, "function": string, "currentCode": string, "proposedCode": string}`

export function buildUxReviewerMessages(input: UxDraftInput, fileContent: string): ChatMessage[] {
  const lines = fileContent.split('\n')
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(4, ' ')} | ${l}`).join('\n')
  const hint = input.instruction?.trim() || '(no specific hint given — use your own judgement)'
  return [
    { role: 'system', content: UX_REVIEWER_SYSTEM },
    {
      role: 'user',
      content: [
        `Component: ${input.component}`,
        input.uxId ? `Tracked element marker in the file: data-ux-id="${input.uxId}"` : '',
        `File: ${input.file}`,
        input.evidenceSummary ? `Observed user behaviour: ${input.evidenceSummary}` : '',
        input.direction ? `Users expected it ${({ left: 'on the left', right: 'on the right', up: 'higher up', down: 'lower down' } as const)[input.direction]}.` : '',
        input.hotspot
          ? `Where users clicked looking for it (median, relative to its current centre): ${input.hotspot.dx}px horizontally, ${input.hotspot.dy}px vertically (negative = left/up), from ${input.hotspot.samples} clicks.`
          : '',
        input.feedback ? `Sandbox results of placements already tried:
${input.feedback}` : '',
        `Hint: ${hint}`,
        '',
        'Real current file content (line-numbered for reference only):',
        numbered.slice(0, 14000),
      ]
        .filter((l) => l !== '')
        .join('\n'),
    },
  ]
}
