# SELF_HEALING_ARCHITECTURE.md

> **Single source of truth** for the BuildHub self-healing system. The repair
> engine reads this document before generating a patch. Every component maps to
> a real function in the repository. Do not describe behavior that does not
> exist. When this document and code disagree, the code is reality — update
> this document.

---

## 1. System Overview

BuildHub is a developer-collaboration web app (Next.js 14 App Router, Prisma +
PostgreSQL) that doubles as the target application for an AI self-healing
experiment.

The self-healing system observes the **real** application, finds **real**
runtime failures, and repairs them by restoring the **normal runtime behavior**
the fault deliberately disabled. Faults are **runtime-only** — activating a
fault never rewrites source files, never breaks the build, and never corrupts
the DB. A fault flips an in-memory + durable JSON flag that a guarded handler
checks at request time.

Production rule: the app and the self-healing engine are separate concerns.
The engine may only deactivate/reactivate runtime faults, apply validated code
patches, and run real HTTP validation probes. It never fabricates incidents,
never guesses answers, and never reports success it did not measure.

### End-to-end flow

```text
1. FAILURE      guarded handler observes active fault → throws/behaves wrongly
2. OBSERVE      handleRouteError → structured ERROR LogEvent persisted
3. DISCOVER     log-monitor groups unlinked ERROR logs by signature
                → creates/merges ONE Incident (DETECTED)
4. ALERT        telegram.ts pushes Telegram alert (SENT/FAILED/SKIPPED_DUPLICATE)
5. TRIGGER      auto-trigger enqueues (AUTO_REPAIR on by default in REAL mode)
6. EVIDENCE     engine reads Incident + real failing route/controller/DB/logs
                then reads THIS document (the architecture map) and the real
                source window around sourceFile:sourceLine
7. ANALYZE      Agent-1 Analyzer: root-cause hypothesis + component/function
8. CODER        Agent-2 Coder: anchored minimal fix candidate (+ diff)
9. CRITIC       Agent-3 Critic: ACCEPT / REVISE / REJECT (+ rationale)
  9a. REVISE    → back to Coder (same round), up to MAX_CODER_ROUNDS
  9b. REJECT    round 1 → Coder revision round 2; round 2 → AI_REPAIR_FAILED
10. JUDGE       final verdict APPROVE / REJECT + risk + confidence
11. RISK        classifyPatchRisk → LOW/MEDIUM (auto-apply) or HIGH (approval)
12. BACKUP      original file bytes hashed (SHA-256) + stored on PatchRecord
13. APPLY       anchored patch applied to the real file (external write)
14. VALIDATE    live HTTP probes re-run the recorded request → expected status
15a. OK         → RESOLVED, rewards recorded, score recomputed upward
15b. FAIL       → ROLLED_BACK: original bytes restored, SHA-256 verified
16. LEARN       RepairMemory/RepairExperience recorded; RL metrics recomputed
```

### Non-negotiables

- **Evidence is real.** No fault IDs are handed to the agents. The prompt
  shows the real error message, the real stack, the real source window, and
  the real architecture map entry.
- **Validation is real.** After any apply, the recorded request is replayed
  against the live app and its status checked. A failed probe rolls back.
- **Integrity is real.** Every patch carry `originalContent`/`appliedContent`
  and now SHA-256 hashes of the exact bytes saved before and after apply, and
  after rollback.
- **Humans gate HIGH.** HIGH-risk candidates enter `WAITING_APPROVAL` and are
  applied only after a one-shot PROCEED approval.

---

## 2. Component Map

> The repair engine uses this map (as raw text) to orient itself. Each row:
> COMPONENT | FILE | FUNCTION | RESPONSIBILITY | INPUT | OUTPUT | DEPENDENCIES
> | ERROR TYPES | VALIDATION | REPAIR.

### 2.1 Route layer — API endpoints

| Component | File | Function | Responsibility | Input | Output | Dependencies | Error types | Validation | Repair |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Feed API | `app/api/posts/route.ts` | `GET` | List posts with author filter, pagination | `Request` (query `author`, `page`, `pageSize`) | `{ posts, pagination }` | `prisma`, `getSessionUser`, `serializePost` | 400 query, 500 on `Error("Injected DB query failure")` (MEDIUM-02) | HTTP 200 probe | Deactivate MEDIUM-02 |
| Create post API | `app/api/posts/route.ts` | `POST` | Create a post for the session user | `Request` JSON `{content, projectId?, tags?}` | `201 { post }` | `prisma`, `getSessionUser`, `createPostSchema` | 400 validation; 500 PrismaClientValidationError (LOW-01: authorId omitted); 500 `Error("Injected DB failure during post creation")` (MEDIUM-01) | HTTP 201 probe, post visible in feed | Deactivate LOW-01 / MEDIUM-01 |
| Post detail API | `app/api/posts/[id]/route.ts` | `GET` | Get one post | id param | `200 { post }`; `{ poost }` when LOW-02 active | `prisma`, `serializePost` | 404 not found; LOW-02 is a 200 contract change (no exception) | HTTP 200 + `post` key check | Deactivate LOW-02 |
| Post update/delete API | `app/api/posts/[id]/route.ts` | `PATCH`/`DELETE` | Edit/delete own post | id param, JSON | `{ post }` / `{ ok: true }` | `prisma`, authz `authorId === user.id` | 401/403/404/400, 500 | route-level probes | Restore ownership / create logic |
| Login API | `app/api/auth/login/route.ts` | `POST` | Verify username/password, set session cookie | JSON `{username, password}` | `{ user }` + session cookie | `prisma`, `verifyPassword`, session | 401 wrong creds; 500 `Error("Credentials verification subsystem failure")` when password wrong + HIGH-01 active | wrong cred → 401, correct → 200 | Deactivate HIGH-01 |
| Project API | `app/api/projects/[id]/route.ts` | `PATCH`/`DELETE` | Update/delete own project | id param, JSON | `{ project }` / `{ ok: true }` | `prisma`, ownership guard | MEDIUM-03 inverted authz → 403 for owner; HIGH-02 guard disabled → 403 bypass | owner allowed + non-owner denied | Deactivate MEDIUM-03 / HIGH-02 |
| Health API | `app/api/health/route.ts` | `GET` | DB + app liveness | none | `{ status, database }` | `prisma` | 200 healthy / 503 degraded | status === ok | Restore DB connectivity |
| Incident API | `app/api/incidents/…` | several | scan, list, detail, report | incidents DB rows | DTOs / report | prisma, report.ts | — | — | n/a |
| Security API | `app/api/security/…` | several | status, incidents, `run` (manual repair), findings | state + engine | DTOs | engine, risk.ts | — | — | manual trigger |
| Observability API | `app/api/observability/summary/route.ts` | `GET` | Overview scores + system health | DB state | `overview { riskScore, cyberSafetyScore, systemHealth, applicationReliabilityScore, totalHealthScore }` | observability.ts, risk.ts | — | clean state → 100/100 | recompute only from real state |

### 2.2 Self-healing engine layer

| Component | File | Function | Responsibility | Input | Output | Dependencies | Error types | Validation | Repair |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Engine | `lib/server/repair/engine.ts` | `runSelfHealingRepair(incidentId)` | Full orchestrator: evidence → conversation → risk → apply → validate → finalize | Incident id | Terminal incident (RESOLVED / ROLLED_BACK / AI_REPAIR_FAILED / WAITING_APPROVAL) | evidence, conversation, patch-engine, risk, validation, memory, telegram | any unexpected throw → incident `REPAIR_FAILED` | probe results | State transitions |
| Engine (approval resume) | `lib/server/repair/engine.ts` | `continueApprovedRepair(incidentId, approvalId)` | Resume a WAITING_APPROVAL run after PROCEED | Incident id + approval id | RESOLVED / ROLLED_BACK | patch-engine, validation | bad approval → 400 | probe on apply | nonce consumed once |
| Evidence | `lib/server/repair/evidence.ts` | `collectEvidence(incident)` | Build failure evidence: real log, route, source window, architecture map | Incident | `RepairEvidence` | logger, routes-map, `readRealFile`, THIS doc | file missing → `ok:false` sourceError | file read ok | offer fallback path |
| Evidence file IO | `lib/server/repair/evidence.ts` | `readRealFile(file)` | Read real source bytes (capped window `FULL_FILE_LINE_CAP=250`) | relative path | `{ok, content}` | node fs | not found / outside app | ext + path | n/a |
| Evidence window | `lib/server/repair/evidence.ts` | `buildSourceWindow(file, line)` | Render N lines around the failing line | file, sourceLine | window string | readRealFile | — | — | n/a |
| Conversation | `lib/server/repair/conversation.ts` | `runRepairConversation(incident, evidence, attemptId)` | Analyzer → Coder → Critic (≤2 rounds) → Judge; persists AgentRun rows | Incident + evidence | `ConversationResult { coder?, judge?, converged }` | providers, prompts, schemas | provider failure → FAILED AgentRun | JSON schema parse | round 2 / honest fail |
| Conversation call | `lib/server/repair/conversation.ts` | `callAndStore(incident, attemptId, kind, model, messages, parse, schema)` | Call provider, persist the AgentRun transcript | kind, messages, parser | AgentRun row | provider | provider error | schema parse | retry/FAILED |
| Risk | `lib/server/repair/risk.ts` | `classifyPatchRisk(file, endpoint, method, judge)` | Deterministic structural risk + judge confidence | patch + incident | `PatchRisk` LOW/MEDIUM/HIGH + reasons `HIGH_PATCH_RISK`/`MEDIUM`/`LOW` | — | — | — | gate auto-apply |
| Patch engine | `lib/server/repair/patch-engine.ts` | `applyCandidate(incident, coder, attemptId)` | Backup original bytes + SHA-256, anchored anchor-apply, persist PatchRecord | incident + coder | opt `{applied, patchId}` | `external-write`, canApplyToRealFile | anchor mismatch → revert plan | file write read-back | rollback to original bytes |
| Patch engine runtime | `lib/server/repair/patch-engine.ts` | `applyRuntimeRepair(incident, attemptId)` | Deactivate active wired faults for the incident endpoint (runtime repair) | incident | `{deactivated: []}` | fault-injection | none | fault state file | reactivate on failed validation |
| Patch verify | `lib/server/repair/patch-engine.ts` | `verifyCandidate(candidate)` | AST-ish sanity of proposed code (no raw `any`, balanced) | CoderOutput | `{ok, reason}` | — | TS syntax problems | compile-level | revise by Coder |
| Patch rollback | `lib/server/repair/patch-engine.ts` | `rollback(record, reason)` | Restore original file bytes; SHA-256 must match backup; set ROLLED_BACK | PatchRecord, reason | PatchDecision ROLLED_BACK | external-write | restore failure → emergency log | read-back hash match | manual restore |
| Validation | `lib/server/repair/validation.ts` | `runValidationProbes(incident)` | Real HTTP probes: auth, make post/project, re-run failing request, health | incident | `ProbeResult[]` {name, ok, expected/actual status, detail} | APP_URL, prisma, sessionCookie | network failure → probe not-OK | expected status match | rollback when any fails |
| Log monitor | `lib/server/repair/log-monitor.ts` | `scanForRuntimeIncidents()` | Group unlinked ERROR logs by signature → create/merge Incident | latest LogEvents | created/merged Incident | logger | none | incident open once | merge repeats |
| Auto trigger | `lib/server/repair/auto-trigger.ts` | `enqueueAutoRepair(incidentId)` | FIFO-serialized engine start; admission DETECTED + 0 attempts + not in-flight | incidentId | starts engine | engine | ALREADY_RUNNING guard | admission re-check inside run | n/a |
| Telemetry | `lib/server/observability.ts` | `computeOverview()` | Derive score dimensions from real state (active incidents, probes) | DB state | overview DTO | prisma | — | clean == 100/100 | n/a |
| Risk score | `lib/server/risk.ts` | `computeRiskScore()` | deterministic cyber-safety risk from active incidents | incident list | 0–100 | — | — | 0 when clean | recompute |

### 2.3 Providers + learning layer

| Component | File | Function | Responsibility | Input | Output | Dependencies | Error types | Validation | Repair |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Provider facade | `lib/server/providers/types.ts` | `createProvider()` | Pick TEST/GROQ/OLLAMA by env | env | `AIProvider` | provider.ts | missing key → REAL refuses | mode gating | fall back to TEST only in TEST mode |
| Test provider | `lib/server/providers/test.ts` | `createTestProvider()` | Deterministic agents from evidence markers (+ `AUTO_REPAIR_SCENARIO` accept-round-2/reject-all/bad-fix) | evidence | JSON roles | evidence | — | schema parse | — |
| Groq provider | `lib/server/providers/groq.ts` | `createGroqProvider()` | Real LLM calls (JSON-mode) via GROQ_API_KEY | messages+schema | parsed JSON | env key | API error | schema parse | retry |
| RL evaluation | `lib/server/learning/evaluation.ts` | `runRlEvaluation(seed)` | Train tabular Q-policy on synthetic labeled dataset; compare default baseline | seed dataset | `{ accuracy, reward, delta }` | — | — | split 70/30 | n/a |
| Repair memory | `lib/server/learning/memory.ts` | `recordRepairMemory / computeLearningMetrics / exportRlDataset` | Reward per outcome, persist memory, compute metrics | incident outcome | rows/Metrics | prisma | — | real outcomes only | n/a |

---

## 3. Failure Scenario Catalog

Fault IDs in the durable registry (`lib/server/fault-injection.ts`). All are
`wired: true` except HIGH-03 (catalog-only; activation refused because it would
require corrupting `db.ts`). Activation only flips runtime state.

| ID | Name | Type | Trigger | Symptom | Root cause | Risk | Validation | Repair |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LOW-01 | Undefined author in Post Creation | 500 validation error | `POST /api/posts` | 500 `PrismaClientValidationError: Argument authorId is missing` | POST omits `authorId` in `prisma.post.create` data | LOW | POST → 201 + post in feed | Deactivate LOW-01 (restore authorId) |
| LOW-02 | Field Typo in Post Response | 200 contract change | `GET /api/posts/[id]` | response has `poost`, no `post` | response key renamed | LOW | GET → 200 with `post` | Deactivate LOW-02 |
| LOW-03 | Incorrect Validation Condition | 400 contract change | `POST /api/posts` | valid content rejected 400 | `getPostContentMin()` returns 1001 | LOW | POST with 50-char content → 201 | Deactivate LOW-03 |
| MEDIUM-01 | Broken Post API (Server Error) | 500 exception | `POST /api/posts` | 500 `Injected DB failure during post creation` | guarded `throw new Error(...)` | MEDIUM | POST → 201 | Deactivate MEDIUM-01 |
| MEDIUM-02 | Database Query Failure in Feed | 500 exception | `GET /api/posts` | 500 `Injected DB query failure` | guarded `throw new Error(...)` | MEDIUM | GET → 200 posts | Deactivate MEDIUM-02 |
| MEDIUM-03 | Inverted Project Update Authorization | 403 contract change | `PATCH /api/projects/[id]` | owner denied 403 | ownership check inverted | MEDIUM | owner → 200, non-owner → 403 | Deactivate MEDIUM-03 |
| HIGH-01 | Authentication Verification Failure | 500 exception (auth) | `POST /api/auth/login` wrong password | 500 instead of 401 | guarded throw when password wrong | HIGH | wrong → 401, correct → 200 | Deactivate HIGH-01 |
| HIGH-02 | Authorization Bypass in Project Deletion | 403 bypass | `DELETE /api/projects/[id]` | non-owner allowed 200 | ownership guard disabled | HIGH | non-owner → 403, owner → 200 | Deactivate HIGH-02 |
| HIGH-03 | Database Connectivity Failure | catalog-only | — | not activatable | — | HIGH | — | — |

---

## 4. Logging + Observability Conventions

- Every ERROR LogEvent is written via `handleRouteError` and carries:
  `errorName`, `message`, redacted `stackTrace`, `sourceFile`, `sourceLine`,
  `requestId`, `route`, `method`, `status`.
- Discovery keys: unlinked ERROR logs grouped by signature (message head +
  route). One incident per distinct failure; identical repeats fold in until
  the incident is terminal.
- Server console traces use **bracketed prefixes**:
  `[SELF-HEALING]`, `[AGENT-1 ANALYZER]`, `[AGENT-2 CODER]`,
  `[AGENT-3 CRITIC]`, `[JUDGE]`, `[BACKUP]`, `[PATCH]`, `[VALIDATION]`,
  `[CURL]`, `[SCORE]`, `[LEARN]`, `[APPROVAL]`, `[FINAL]`.
- NEVER log: passwords, session cookies, GROQ_API_KEY, TELEGRAM_BOT_TOKEN,
  DATABASE_URL, API keys. The logger redacts these categories already.

---

## 5. Incident Lifecycle States

`DETECTED → INVESTIGATING → AWAITING_REVIEW → VALIDATING → WAITING_APPROVAL`
→ terminal `RESOLVED` / `ROLLED_BACK` / `AI_REPAIR_FAILED` / `REJECTED` /
`EXPIRED`. Terminal incidents are never auto-retried. HIGH-risk applies only
after `WAITING_APPROVAL` + one-shot `PROCEED`.

---

## 6. Repair Conversation Rounds

```text
Round 1: ANALYZER -> CODER -> CRITIC
  CRITIC ACCEPT -> JUDGE -> terminal verdict
  CRITIC REVISE -> CODER (same round) ... up to MAX_CODER_ROUNDS=2
  CRITIC REJECT -> CODER revision (round 2)
Round 2: CODER -> CRITIC           (auto, when round 1 ended REJECT)
  CRITIC ACCEPT -> JUDGE
  CRITIC REJECT (round 2) -> AI_REPAIR_FAILED   (honest failure)
JUDGE: APPROVE -> risk gate -> apply / WAITING_APPROVAL
       REJECT  -> AI_REPAIR_FAILED (remaining rounds exhausted)
```

Agents run in both REAL and TEST modes. Analyzer runs **always** (both modes)
and is persisted with `agent = ANALYZER`.

---

## 7. Patch Integrity + Rollback

```text
1. Back up   read original file bytes -> store originalContent
             hash bytes -> originalSha256 stored on PatchRecord
2. Apply     anchored replace -> external-write -> appliedContent
             hash -> appliedSha256 stored
3. Validate  live HTTP probes; all OK -> keep
4. Rollback  restore original bytes -> read-back bytes
             hash == originalSha256 (must match) -> ROLLED_BACK
             mismatch -> emergency log, keep original for manual restore
```

Rollback must never restore the score: score recovery is real (post-validation
state), not coupled to file restore.

---

## 8. Score Model

Derived by `computeOverview` from **real** persisted state only. All start at
100/100 when the system is clean and no incident is active. Lowered only by
real active failures; recovered only after validated repairs.

| Score | Meaning |
| --- | --- |
| `riskScore` | 100 − active high-security-incident risk load (0 when clean) |
| `cyberSafetyScore` | security-domain health from active incidents + security probes |
| `systemHealth` | app+liveness/dependency probe health |
| `applicationReliabilityScore` | reliability domain derived from active endpoint failures |
| `totalHealthScore` | weighted combination of the above (all one component) |

### Severity maps (when NO incident is active → NONE → all 100)

| Active severity | riskScore | cyberSafetyScore | applicationReliabilityScore | systemHealth |
| --- | --- | --- | --- | --- |
| (none) | 0 | 100 | 100 | real probe value |
| LOW | 15 | 95 | 95 | 85 |
| MEDIUM | 30 | 60 | 70 | 30 |
| HIGH | 50 | 40 | 45 | 55 |
| CRITICAL | 60 | 20 | 25 | 20 |

`systemHealth` keeps its REAL probe value while clean and falls back to the
deterministic map while incidents are active. `totalHealthScore` is a weighted
combination (`compositeHealthScore`): 25% risk-inverse + 25% cyber + 25%
reliability + 25% actual health — 100 when clean, and it recomputes against the
ACTUAL reported health so it never disagrees with the health card.

---

## 9. RL Learning

`RepairMemory` + `RepairExperience` rows are written from **real** incident
outcomes (reward by decision correctness). `runRlEvaluation` trains a tabular
Q-policy over a seeded labeled dataset and reports accuracy before/after so
judges can compare baseline vs learned policy honestly.

---

## 10. Self-Healing Permission Boundary

The engine may:
1. deactivate/reactivate runtime faults for the incident's endpoint,
2. apply anchored code patches (HIGH only after approval),
3. run real HTTP validation probes,
4. write RepairMemory/Experience + recompute scores,
5. send terminal Telegram alerts.

The engine may NOT: edit `db.ts`, edit this architecture document, activate
faults it did not deactivate, fabricate evidence, or report unverified success.