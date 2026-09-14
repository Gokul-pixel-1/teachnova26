# RL Learning Architecture — BuildHub Self-Healing

> Documents the Phase 10/11 learning layer: the reward policy, the tabular
> bandit decision layer, and the hard safety boundary that keeps learning
> *advisory*.

---

## 1. Design goal

The system learns from every real repair outcome and turns that experience into
a **recommendation** for the next incident of the same type. Learning is
deliberately **non-enforcing**: it never overrides the deterministic safety
layers (approval, candidate verification, validation, rollback).

## 2. Files

| File | Role |
|------|------|
| `frontend/lib/server/learning/memory.ts` | reward policy defaults, `recordRepairMemory`, `recordRepairExperience`, dataset/metrics export |
| `frontend/lib/server/learning/decision.ts` | `recommendAction`, tabular bandit, `decisionPolicy` |
| `frontend/lib/server/repair/engine.ts` | wiring (REAL mode only) + `decisionLabelFor` in the persisted learning row |

## 3. Reward policy (env-tunable, defaults)

| Outcome | Env var | Default reward |
|---------|---------|----------------|
| Resolution (success)          | `REPAIR_REWARD_SUCCESS` | **+50** |
| Validation failure            | `REPAIR_REWARD_VALIDATION_FAILURE` | **-50** |
| Rollback                      | `REPAIR_REWARD_ROLLBACK` | **-75** |
| Security regression           | `REPAIR_REWARD_SECURITY_REGRESSION` | **-100** |
| Human rejection of a repair   | `REPAIR_REWARD_REJECTION` | **+20** (rejection is *information*) |
| Human approval                | `REPAIR_REWARD_HUMAN_APPROVAL` | **+40** |
| Human-rejected approval       | `REPAIR_REWARD_HUMAN_REJECTION` | **+2** |

Rewards are recorded through `RepairExperience` rows
`(state, action, reward, nextState, terminal)` and surface in
`/api/ai/learning` (metrics + dataset) and the learning dashboard.

## 4. Decision layer (`decision.ts`)

A tabular bandit keyed by:

```text
bucketKey = incident-type | severity | risk | confidenceBucket
confidenceBucket = judge-confidence quantized to 0-3 buckets
```

- `REPAIR_ACTIONS`: `AUTO_REPAIR`, `REQUEST_HUMAN`, `RETRY_ANALYSIS`, `REJECT_REPAIR`.
- `recommendAction()`:
  - bucket has fewer than `RL_MIN_SAMPLES` (default **5**) rows, or no stored
    estimates → conservative **`AUTO_REPAIR`** default (won't block flow).
  - otherwise → arg-max of the mean rewards in the bucket; exploration with
    epsilon 0.1.
- `decisionPolicy()` derives the user-visible policy returned by
  `GET /api/ai/learning` (`rl` block) — viability thresholds and action weights.

## 5. Safety boundary (important)

`recommendAction` output is **recorded, never enforced**:

- in REAL mode the engine stores it on `Incident.metadata.rlRecommendation`
  (`engine.ts`) and logs an `RL decision layer` incident event;
- it can NEVER bypass `HIGH`-risk human approval, candidate structural
  verification, live validation, or rollback;
- it never widens file/security policy. A security regression always dominates.

## 6. RL is REAL-mode only

The decision layer runs when `providerModeLabel() === 'REAL'`. Hermetic
`AI_PROVIDER=test` runs stay byte-for-byte deterministic and produce no
RL noise, keeping the hermetic verification suites stable.

## 7. Where learning is persisted

- `recordRepairMemory` — terminal memory rows surfaced as "Repair memory" hints
  to future Coder prompts.
- `recordRepairExperience` — normalized RL experiences for the dataset.
- The action JSON includes `decisionLabelFor(risk, outcome)` so every experience
  row carries the decision and its outcome for offline training/AB testing.