# REAL Self-Healing Architecture (Phase 9)

How BuildHub's self-healing engine works in the REAL runtime loop — no fault
catalog, no canned answers, no oracle. Everything the engine sees is produced
by a genuinely failing application.

## The loop

```text
activate fault      → real defect is written into a real source file
real failing request → route handler throws → structured ERROR log persists
                       errorName / stackTrace / sourceFile / sourceLine / requestId
scan                → log monitor groups UNLINKED ERROR logs by signature
                       (message head, route) → creates ONE incident
run                 → engine builds real evidence from the REAL file + stack,
                       Coder/Critic/Judge rounds → candidate patch → risk
apply + validate    → candidate anchored to the real file → health probes
                       against the real API → VALIDATED → RESOLVED
HIGH risk           → WAITING_APPROVAL → human PROCEED → resume → RESOLVED
failed probe        → exact rollback → ROLLED_BACK
```

The engine never receives a fault id. It must answer from what the app
actually did, in the actual file, on the actual route.

## Engine invariants (honest)

- **Evidence is real.** `INC-…` descriptions carry the real error message,
  real stack and real source file. When a library (Prisma) rewrites the stack
  so no app frame survives, `suspectSourceFor(endpoint)` supplies the file the
  routes map already knows, and the real current file content is rendered.
- **The agent sees the real file.** `evidence.ts` reads the actual source and
  renders the faulty window; patch application requires a matching anchor in
  the real file.
- **Validation probes the real app.** After the candidate is written, the
  engine replays the recorded request against the live API and checks the
  expected status; any failure rolls back the exact bytes.
- **Risk gates humans.** Structural risk → LOW/MEDIUM auto-apply with an
  ESCALATION plan, HIGH → `WAITING_APPROVAL` + approval id; `PROCEED`
  continues the same repair attempt, and the nonce is consumed exactly once.

## Component map

| Piece | File | Responsibility |
| --- | --- | --- |
| Fault harness (patch-on-activate) | `lib/server/fault-injection.ts` | writes the real defect, records checkpoints, reconciles active faults from disk |
| External file writes | `lib/server/external-write.ts` | patch/rollback/activation writes seen by Turbopack's watcher (child-process write) |
| ERROR logging | `lib/server/logger.ts` | structured `ERROR` log with `errorName`, redacted `stackTrace`, `sourceFile`/`sourceLine` |
| Incident discovery | `lib/server/repair/log-monitor.ts` + `app/api/incidents/scan/route.ts` | signature-group unlinked ERROR logs → one incident; merges repeats |
| Automatic trigger | `lib/server/repair/auto-trigger.ts` | closes the loop: creating/merging an incident auto-starts the engine (FIFO-serialized, in-flight guard, DETECTED + zero-attempt admission); `AUTO_REPAIR` env override, default ON in REAL / OFF in TEST mode |
| Evidence build | `lib/server/repair/evidence.ts` | real file window + source fallback for library stacks |
| Engine | `lib/server/repair/engine.ts`, `conversation.ts`, `risk.ts` | Coder/Critic/Judge rounds → candidate → risk → result |
| Patch execute | `lib/server/repair/patch-engine.ts` | anchored apply, live validation probes, byte-exact rollback |
| Providers | `lib/server/providers/test.ts` (+ groq/openai) | TEST: deterministic candidate from evidence markers; NEVER from fault ids |
| Human approval | `app/api/approvals/proceed/route.ts` | consume-one-shot approval; continue or roll back |

## Behavioural (no-exception) faults

LOW-02 (key rename), LOW-03 (validation), MEDIUM-03 (inverted authz),
HIGH-02 (authz-disabled) change behaviour but never throw, so the log-driven
discovery path does not create incidents for them by design. Their harness
symptoms are asserted directly by the verification suites.

## Verification (evidence)

```text
node scripts/verify-auto-repair.mjs        → 48 passed, 0 failed
        (automatic trigger: LOW-01 → auto RESOLVED, HIGH-01 → auto WAITING_APPROVAL,
         bad-fix → ROLLED_BACK, reject-all → AI_REPAIR_FAILED; needs AUTO_REPAIR=true)
node scripts/verify-self-healing.mjs        → 103 passed, 0 failed
python3 scripts/e2e_real_self_healing.py     → 69 passed, 0 failed
```

Requires (dev server):
`SELF_HEALING_TEST_MODE=true AI_PROVIDER=test FAULT_INJECTION_ENABLED=true AUTH_GUARD_ENABLED=false`

`AUTO_REPAIR` behaviour: unset → enabled in REAL mode, disabled in hermetic
TEST mode. Set `AUTO_REPAIR=true` to exercise the automatic trigger in TEST
mode (see `verify-auto-repair.mjs`); REAL-mode scripts that still drive the
manual `POST /api/security/run` themselves (e.g. `e2e_ollama_real_self_healing.py`)
must set `AUTO_REPAIR=false` so the auto-trigger does not preempt them
(manual runs return `409 ALREADY_RUNNING` while an auto-run is in flight).

## Automatic trigger (Phase 11)

```text
real ERROR log ──> scan ──> incident created/merged ──> auto-trigger
   ──> (admission: DETECTED, 0 RepairAttempt rows, source=log-monitor, not in-flight)
   ──> FIFO-serialized engine run ──> LOW/MEDIUM auto-apply ──> RESOLVED
                                   ──> HIGH ──> WAITING_APPROVAL (human)
   ──> terminal states are NEVER auto-retried
```

Admission is re-checked inside the run (state-based), so repeated scans are
idempotent; the in-flight Set is only used for enqueue-time deduplication and
for the `409 ALREADY_RUNNING` guard on the manual run endpoint.

Two dev-mode facts T your verification must respect (ADR-018):

1. Turbopack dev recompiles repeatedly-rewritten routes unreliably after the
   server has been up a while. Restart the server freshly before a suite run;
   the suites also restart it before the harness-only behavioural block and
   "nudge" edited files (a `// bh-nudge-…` comment written from a separate
   process) to force recompilation of the current on-disk state.
2. Writes originating inside the `next dev` process are not seen by its own
   watcher; all patch/fault writes go through a child process
   (`external-write.ts`).

## Human approval demo path

HIGH-01 (wrong-password crash) → REAL auth `500` → scan → HIGH incident →
run → `WAITING_APPROVAL` (`requiresApproval:true`, `approvalId`) → operator
`POST /api/approvals/proceed` → `repair.stage === 'RESOLVED'` → wrong password
now returns `401`, correct password `200`, fault no longer active on disk.

## Merge behaviour

Two identical failures while an incident is still open fold into the same
incident (`scanned/linked/merged/created`), so a storm of identical 500s does
not spam the queue. A distinct failure still creates its own incident.