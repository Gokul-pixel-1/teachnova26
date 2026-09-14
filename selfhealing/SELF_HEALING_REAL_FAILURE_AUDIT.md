# BuildHub — Self-Healing "Real Failure" Architecture Audit

> Status: **Rework in progress** (started this session). Companion doc:
> `REAL_SELF_HEALING_ARCHITECTURE.md` (target design, updated alongside code).
> Source of truth: `PLAN.md` must be kept in sync.

## 1. Acceptance criterion (what the corrected system must prove)

A **developer introduces a real bug in real source code** (e.g. `authorId: user.id.missingField`).
The application runs normally. A **real request** triggers the bug and returns a **real 500**.
A **real stack trace** lands in the structured log. The self-healing system then

1. **Discovers** the problem **ONLY from real logs/evidence** — never from a fault ID
   (`LOW-01`, `MEDIUM-01`, `HIGH-01`, …) or a pre-recorded answer,
2. **Diagnoses** root cause and pinpoints the source file/line,
3. **Proposes** a real code fix (Coder), reviews it (Critic), and reaches a verdict (Judge),
4. **Risks** it deterministically and **asks a human for approval when HIGH risk**,
5. **Applies** the patch to the real source (with a checkpoint),
6. **Re-runs the same failing request** (plus regression probes) and **rolls back** to the exact
   prior file state if validation fails,
7. Records the outcome in repair memory.

The harness may keep *fault injection as a demo convenience* **only if** activation simply writes
real defect code into the real file — identical to what a developer would commit — and never bakes
answers into incidents.

---

## 2. How the system actually behaves today (before this rework)

### 2.1 Fault / incident creation — fully answer-driven

`frontend/lib/server/repair/ingest.ts` `createFaultIncident(faultId)`:

- `title` = `"LOW-01 — Undefined Variable in Post Creation"`
- `description` = `"Controlled fault injected at frontend/app/api/posts/route.ts:45 … Expected symptom: TypeError: Cannot read property"`
- `errorCode` = fault-keyed map (`sanitizedErrorCode`)
- `expectedRootCause` = `fault.aiExpectedFix`
- `metadata` = `{ faultId, severity, stackTrace: fault.expectedError, symptomDetail, sanitizedCode }`

So the Incident row **already contains the answer** (file, line, expected stack, expected fix).

### 2.2 Runtime fault behavior — runtime guards, not real bugs

`frontend/lib/server/fault-injection-handlers.ts`:

- `withFaultInjection('LOW-01', …)` returns a **canned** `500 {"error": "Cannot read property 'id' of undefined"}`.
- MEDIUM-01/02 and HIGH-03 return canned JSON bodies. **No exception is thrown, no stack trace exists.**
- LOW-02 / MEDIUM-03 / HIGH-01 / HIGH-02 are in-handler helper behaviors (`applyLow02Typo`,
  `applyMedium03InvertedAuthz`, `applyHigh01AuthBypass`, `applyHigh02AuthzBypass`).

The real source files stay **healthy**. The defect only exists in a guard, identified by its fault ID.

### 2.3 Evidence — sandbox view synthesized from the catalog

`frontend/lib/server/repair/evidence.ts`:

- `buildSourceContext(incident)` reads the **fault registry's** `originalCode`/`faultCode` and splices the
  defect into a displayed "current source" view.
- `stackTrace` shown to the AI is `fault.expectedError` (a string from the catalog).
- `suspectSource` is `fault.target.file`.
- `faultMetadataFor(faultId, severity)` builds the incident metadata blob — again from the catalog.

### 2.4 Diagnosis — the Coder is steered to the pre-recorded fix

`frontend/lib/server/repair/engine.ts` passes a `fault` object
(`{ id, file, line, function, originalCode, faultCode }`) into `RepairOptions`, which the
`test` provider turns directly into "the" answer. The Groq provider never receives it, **but the
evidence (stack, source view, description) shown to Groq already encodes the answer**, so in
practice the repair is a lookup, not a diagnosis.

### 2.5 Correctness gate — "canonical" oracle from the catalog

`frontend/lib/server/repair/canonical.ts` decides whether a candidate "restores the healthy
baseline" by comparing it against `fault.originalCode` / per-fault regexes keyed on `faultId`.
`patch-engine.ts` only writes to disk when the oracle approves and "disarms" the runtime guard.

### 2.6 Validation — probes keyed on fault ID

`frontend/lib/server/repair/validation.ts` `probeSpecsFor(faultId)` maps each fault ID to a fixed
set of HTTP probes. Unless the fault is disarmed, `runValidationProbes` cannot observe real
recovery.

### 2.7 Risk — catalog-authoritative

`frontend/lib/server/repair/risk.ts` returns `fault.riskLevel` verbatim for any incident carrying
`metadata.faultId`.

### 2.8 Dispatch

`app/api/security/run/route.ts`: incidents with `metadata.faultId` → `runSelfHealingRepair`;
**all other incidents** (incl. real security-promoted incidents) → the legacy `runAgentPipeline`.
There is currently **no path that creates an incident purely from a runtime error log**.

> **Post-audit state (Phase 9–11 fixes shipped):** the log monitor now DOES create
> incidents purely from real `ERROR` logs (`lib/server/repair/log-monitor.ts`), and
> `lib/server/repair/auto-trigger.ts` auto-starts `runSelfHealingRepair` whenever a
> scan creates or merges such an incident (`AUTO_REPAIR` default ON in REAL mode).
> The engine uses evidence-only diagnosis (no fault IDs) and live validation probes;
> manual dispatch on `/api/security/run` returns `409 ALREADY_RUNNING` if an
> auto-run owns the same incident.

---

## 3. Why this fails the acceptance criterion

| # | Requirement | Current state |
|---|-------------|---------------|
| 1 | Bug is real source | Defect lives in a runtime guard keyed by fault ID |
| 2 | Real request → real 500 | Canned JSON responses, **no throw, no stack** |
| 3 | Real stack trace in logs | `LogEvent` has **no** `stackTrace`/`errorName`/`sourceFile`/`sourceLine`; route catches use `console.error` only |
| 4 | Discover from logs only | Incident is created from the fault catalog with the answers embedded |
| 5 | Diagnose from evidence | Coder given `expectedError` + sandbox source + pre-recorded fix target |
| 6 | Deterministic risk from change | Risk is the catalog's `riskLevel` |
| 7 | Apply + re-run same request | Oracle gate on known fix; probes keyed on fault ID; guard must be "disarmed" |
| 8 | Rollback to exact prior file | Only works for fault-backed incidents via guard re-arm |

Root cause of all of it: **the catalog replaces both the developer and the monitor.** Fault IDs are
the loader's cargo manifest — the AI never has to look.

---

## 4. Target architecture (implemented by this rework)

```text
Developer / fault harness writes REAL defect text into a REAL source file
        │
        ▼
Real request → real thrown error → route catch logs a REAL structured ERROR
        │   (errorName, message, full stackTrace, sourceFile, sourceLine,
        │    route, method, requestId, status) — no fault IDs anywhere
        ▼
Log monitor (scan) groups unlinked ERROR logs by signature
        │   (route | method | errorName | message)
        ▼
Incident created FROM THE LOG ONLY
        │   title/description from real message+stack; expectedRootCause = null;
        │   metadata = { source:'log-monitor', stackTrace, errorName,
        │                sourceFile, sourceLine, requestId }  — NO faultId
        ▼
Evidence = real stack trace + real file content (line-numbered)
        ▼
Coder (real messages, no answers) → Critic → Judge
        ▼
Deterministic risk from the real change surface (auth/file/cascading/verb)
        ▼
LOW/MEDIUM auto-apply · HIGH human approval (PROCEED/REJECT, expiry)
        ▼
Checkpoint current real file → write candidate → re-run the SAME failing
request (+ regression probes) → validation pass → RESOLVED
        │  validation fail → restore EXACT pre-patch file → ROLLED_BACK
        ▼
Repair memory / experience recorded
```

Key rules:
1. **Incidents are produced by a log monitor over real `LogEvent` rows.** Nothing pre-answers them.
2. **Fault injection = writing real defect code.** Activating a fault patches the real file and
   checkpoints it; deactivating restores it only if the faulted text is still present. The harness
   is a stand-in for "a developer introduced this bug".
3. **No canonical oracle, no disarming.** Validation is the truth: the recorded request must recover.
4. **Risk is structural**, from the file/route/method being patched.
5. **Providers only ever see real evidence.** The hermetic `test` provider derives deterministic
   output from the (real) stack/source evidence — it does not receive catalog answers from the engine.

---

## 5. Inventory of simulated dependencies to be removed

| Location | What | Disposition |
|----------|------|-------------|
| `lib/server/fault-injection-handlers.ts` | `withFaultInjection` canned responses | Remove wrappers; routes become clean |
| `lib/server/fault-injection.ts` | registry `originalCode/faultCode/expectedError/aiExpectedFix` driving evidence/oracle/risk | Registry becomes a *file-patch harness* only; anchors updated to real source |
| `lib/server/repair/ingest.ts` `createFaultIncident` | writes title/description/errorCode/expectedRootCause/metadata from catalog | Replaced by log-monitor incident creation |
| `lib/server/repair/evidence.ts` | `buildSourceContext` sandbox splice; `faultMetadataFor`; `sanitizedErrorCode(faultId)` | Replaced by real-file + real-stack view |
| `lib/server/repair/canonical.ts` | canonical oracle | Deleted from apply path |
| `lib/server/repair/patEngine` `disarmFault/rearmFault` | guard reflection | Removed |
| `lib/server/repair/validation.ts` `probeSpecsFor(faultId)` | fault-keyed probes | Replaced by incident-driven replay |
| `lib/server/repair/risk.ts` catalog branch | `fault.riskLevel` authoritative | Removed; structural rules only |
| `lib/server/repair/engine.ts` + `conversation.ts` `options.fault` | answer handed to TEST provider, leaked via description/stack | Engine no longer passes it; metadata carries no answers |

---

## 6. Files touched by the rework

Server core

- `prisma/schema.prisma` — add `errorName`, `stackTrace`, `sourceFile`, `sourceLine` to `LogEvent`.
- `lib/server/logger.ts` — `captureErrorInfo()`, `logApiError()`, persist new fields.
- `lib/server/response.ts` — `handleApiError` acquires a request context and emits a structured ERROR log.
- `lib/server/repair/log-monitor.ts` — **new**: scan unlinked ERROR logs → incidents.
- `app/api/incidents/scan/route.ts` — **new**: operator-triggered monitor run.
- `lib/server/repair/validation.ts` — `runIncidentValidation` (replay recorded request).
- `lib/server/repair/patch-engine.ts` — no oracle/disarm; checkpoint/write/validate/rollback.
- `lib/server/repair/canonical.ts` — removed from the apply gate.
- `lib/server/repair/risk.ts` — structural risk only.
- `lib/server/repair/evidence.ts` — real stack/source evidence.
- `lib/server/repair/engine.ts` + `conversation.ts` — no fault answers; dispatch unchanged shape.
- `lib/server/fault-injection.ts` — patch-on-activate harness + checkpoint/restore.
- `app/api/faults/route.ts` (+ `random`) — activation writes the real defect; **no incident fabrication**.

Route handlers (defects become real code, errors get real logs)

- `app/api/posts/route.ts`, `app/api/posts/[id]/route.ts`,
  `app/api/projects/[id]/route.ts`, `app/api/auth/login/route.ts`.

Tests / docs

- `frontend/scripts/verify-self-healing.mjs`, `frontend/scripts/e2e_phase9_full.py` — real flow.
- `frontend/scripts/e2e_real_self_healing.py` — **new** acceptance evidence.
- `REAL_SELF_HEALING_ARCHITECTURE.md` (new), `README.md`, `AI_CODEBASE_MAP.md`,
  `PHASE9_FAULT_TEST_PLAN.md`, `PLAN.md`.

---

## 7. Remaining known limitations (honest)

- **Behavioral faults without an exception** (LOW-02 response typo, LOW-03 validation,
  MEDIUM-03 inverted authz, HIGH-02 authz bypass) change behavior but do not throw. The *log-driven*
  discover path targets **crash-type runtime errors**. Detecting a silently-wrong-but-2xx behavior
  from logs requires response-contract/anomaly rules; that layer is outside this rework and must be
  reported as out of scope (see PLAN.md).
- HIGH-03 (database connectivity) mutates `lib/server/db.ts`; hot-reload timing in `next dev` can
  be racy, so its harness path is exercised with a settle delay and its failure is a **real** Prisma
  connection error once recompiled.
- The `test` provider keeps deterministic output for hermetic engine tests but derives it from the
  **real recorded stack/source evidence**, not from catalog answers.