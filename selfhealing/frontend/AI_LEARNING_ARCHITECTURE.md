# AI Learning Architecture — RL-Ready Repair Experience + Reward System

Companion to `RL_LEARNING_ARCHITECTURE.md` (bandit policy) and
`docs/SELF_HEALING_ARCHITECTURE.md` (engine flow). This document covers the
experience/reward half: what is recorded, how rewards are computed, how past
repairs steer the next Coder/Critic decision, and where the future training
pipeline plugs in. There is deliberately **no trained RL model** — this is
RL-ready experience + reward infrastructure.

## Repair memory (`lib/server/learning/memory.ts`)

Every terminal repair writes two rows:

- `RepairMemory` (one per incident): error signature, root cause, file,
  endpoint, patch summary, risk, outcome, human decision/reason, reward,
  transparent `rewardBreakdown`, recurrence count.
- `RepairExperience` (state/action/reward/nextState/terminal): the normalized
  RL dataset row (`GET /api/ai/rl-dataset` exports the last 1000).

Learning is now recorded on **every** terminal path: autonomous LOW,
approved MEDIUM/HIGH (with `humanDecision: APPROVED`), human REJECTED
(outcome REJECTED), validation failures and rollbacks. Previously the
approved/rejected paths recorded nothing — that gap is closed
(`continueApprovedRepair`, `finalizeRejectedRepair`).

## Error signatures

Canonical signature = the log-monitor's FNV signature
(`route|METHOD|errorName|message-head`, stored on
`incident.metadata.errorSignature`, used for incident merging) with a
coarse error-code fallback (`signatureFor`). Memory retrieval prefers
same-signature rows first ("have we seen this error before"), then
endpoint/file/code fallbacks.

## Experience schema (conceptual)

`incidentId, faultType(severity), riskLevel, errorSignature, rootCause,
file, function, proposedPatch(before/after), coderDecision, criticDecision,
judgeDecision, humanDecision, validationResult, rollbackOccurred,
finalOutcome, reward(+breakdown)`.

## Reward policy (FINAL, outcome-only)

`computeReward` sums only what the outcome proved (env-tunable via
`REPAIR_REWARD_*`):

| Outcome | Reward |
|---|---|
| RESOLVED | +50 (`successfulRepair`) |
| + human APPROVED | +40 shaping (approved HIGH/MEDIUM success ≈ +90, transparent) |
| ROLLED_BACK | −75 (`rollback`) −50 (`validationFailure`) |
| AI_REPAIR_FAILED | −50 (`validationFailure`); −100 more if security-sensitive |
| REJECTED (human stopped pre-apply) | 0 — information, never a coding success |
| Same error returns after RESOLVED | −100 (`regression`) on the old success claim |

Never +50 for merely applying a patch: RESOLVED requires passing probes;
approved-but-rolled-back is negative despite the approval.

## Repeated-error learning ("same error comes again")

When a new incident's signature matches a prior RESOLVED memory,
`applyRegressionPenalty` increments the old row's `recurrenceCount` and
applies −100 to its reward (breakdown updated) — the old success claim is
corrected, not deleted. Evidence collection surfaces same-signature memories
first, and `renderMemoryHints` adds explicit WARNING lines:

- prior ROLLED_BACK/AI_REPAIR_FAILED → "do NOT repeat it"
- recurrenceCount > 0 → "treat the old patch as suspect"

The Coder receives up to 2 hints; the Critic now receives them too, so a
repeat proposal is judged against history. The AI must still inspect the
current source — old patches are context, never auto-applied
(`RepairMemory` comment: "never auto-applied").

## Coder/Critic/Judge integration

```
NEW ERROR → signature lookup → Coder (+hints) → proposal →
Critic (+hints) → revise/accept → Judge → risk gate →
repair → validation → reward → stored experience → future context
```

## Validation / rollback semantics for learning

Approval authorizes; only validation decides success. Rollback restores
exact bytes (SHA-256 verified) and records the negative experience that
teaches the next run.

## Future RL training path

`exportRlDataset` + `computeEvaluationStats` + `evaluation.ts` harness feed a
future offline trainer. The tabular bandit (`decision.ts`) stays advisory-only
(REAL mode, recorded on `incident.metadata.rlRecommendation`, never overrides
approval/validation/rollback). No model is trained in this codebase.
