# Phase 9 — Fault Test Plan

> Exact fault definitions for the controlled failure scenarios (3 LOW, 3 MEDIUM, 3 HIGH, plus LOW-04 and COMMENT-01 on the comment creation surface).
> Each fault is injected at a specific file:line, triggered by a specific API call,
> and validated by the self-healing system.

---

## Fault Injection Architecture

Faults are injected via a **fault injection layer** that wraps target functions.
The layer is **localhost-only**, **controlled**, and **reversible**.

```
BuildHub App
    │
    ├── Normal Application Logic
    │
    └── Fault Injection Layer (dev/test only)
         │
         ├── Fault Registry (fault ID → config + risk)
         ├── Activation API           POST /api/faults {faultId} → applies patch + creates fault incident
         ├── Deactivation API         POST /api/faults/deactivate {faultId} / deactivate-all
         ├── Random selection         GET  /api/faults/random (one inactive fault, 409 if all active)
         └── Status API               GET  /api/faults (id, severity, difficulty, trigger, symptom, active)
```

**Fault lifecycle (ADR-015):**
- `POST /api/faults {faultId}` activates the runtime guard, applies the fault patch to the target file, and creates a fault incident (`metadata.faultId`) — from here `POST /api/security/run` dispatches the incident to the iterative repair engine.
- Runtime triggering stays behind the `isFaultGaurded` guard; the engine **disarms** the guard to validate the patched file and **rearams** on rollback so the file is verifiably healthy.
- Rules: only active when `FAULT_INJECTION_ENABLED=true` (dev only), each fault has a unique ID + documented trigger, `deactivate-all` clears every guard, nothing persists across server restarts.

---

## LOW Faults (Auto-Remediation)

### LOW-01: Undefined Variable in Post Creation

| Property | Value |
|----------|-------|
| **Scenario ID** | LOW-01 |
| **Difficulty** | EASY |
| **Target Component** | Post Creation API |
| **File** | `frontend/app/api/posts/route.ts` |
| **Line** | ~45 |
| **Function** | `POST` handler |
| **Original Code** | `const authorId = session.user.id;` |
| **Fault** | `const authorId = session.user.undefinedProperty;` |
| **Trigger** | `POST /api/posts` with valid content |
| **Expected Error** | `TypeError: Cannot read property 'id' of undefined` |
| **Risk Reason** | Single file, single function, 1 line, no security impact, high test coverage |
| **AI Expected Fix** | Restore `session.user.id` |
| **Validation** | `POST /api/posts` → 201, post appears in feed |
| **Rollback** | Restore original line |
| **Cleanup** | Remove fault, verify original behavior |

---

### LOW-02: Field Typo in Post Response

| Property | Value |
|----------|-------|
| **Scenario ID** | LOW-02 |
| **Difficulty** | EASY |
| **Target Component** | Post Detail API |
| **File** | `frontend/app/api/posts/[id]/route.ts` |
| **Line** | ~62 |
| **Function** | `GET` handler |
| **Original Code** | `return NextResponse.json({ post: serialized });` |
| **Fault** | `return NextResponse.json({ poost: serialized });` (typo: `poost`) |
| **Trigger** | `GET /api/posts/[valid-id]` |
| **Expected Error** | Frontend: `post` is undefined, UI shows empty/error |
| **Risk Reason** | Single file, single function, 1 line, no security impact, UI-only |
| **AI Expected Fix** | Fix property name to `post` |
| **Validation** | `GET /api/posts/[id]` → 200, `{ post: {...} }`, UI renders |
| **Rollback** | Restore original property name |
| **Cleanup** | Remove fault, verify original behavior |

---

### LOW-03: Incorrect Validation Condition

| Property | Value |
|----------|-------|
| **Scenario ID** | LOW-03 |
| **Difficulty** | EASY |
| **Target Component** | Post Content Validation |
| **File** | `frontend/lib/server/validation.ts` |
| **Line** | ~28 |
| **Function** | `postContentSchema` |
| **Original Code** | `.min(1, 'Content is required').max(1000)` |
| **Fault** | `.min(1001, 'Content is required').max(1000)` (impossible condition) |
| **Trigger** | `POST /api/posts` with valid content (1-1000 chars) |
| **Expected Error** | `400: Content must be at least 1001 characters` |
| **Risk Reason** | Single file, single function, 1 line, validation logic only, high test coverage |
| **AI Expected Fix** | Restore `.min(1, ...)` |
| **Validation** | `POST /api/posts` with 50-char content → 201 |
| **Rollback** | Restore original min value |
| **Cleanup** | Remove fault, verify original behavior |

### COMMENT-01: Comment Creation Service Failure ("Cannot Comment")

| Property | Value |
|----------|-------|
| **Scenario ID** | COMMENT-01 |
| **Difficulty** | EASY |
| **Target Component** | Comment Creation API |
| **File** | `frontend/app/api/posts/[id]/comments/route.ts` |
| **Line** | ~87 |
| **Function** | `POST` handler |
| **Original Code** | `prisma.comment.create({ data: { content, postId: id, authorId: user.id } })` |
| **Fault** | `throw new Error('COMMENT-01: Injected comment service failure')` before create (runtime guard `isFaultActive('COMMENT-01')`, no source change) |
| **Trigger** | `POST /api/posts/[id]/comments` with valid content (authenticated) |
| **Expected Error** | `500: Internal Server Error` (structured error/log via `handleRouteError`) |
| **Expected Normal Behavior** | Fault inactive → real Prisma/database comment creation → `201` with `{ comment: { id, ... } }`, correct author + post association |
| **Risk/Severity** | LOW — single comment endpoint, isolated surface, no security impact (autonomous repair; Judge still rates the real patch) |
| **AI Expected Fix** | Restore normal runtime behavior (deactivate fault); repair must restore the genuine comment database operation, never fake success |
| **Validation (probe)** | Fault active → `POST` comment fails; after repair → `201`, real comment id, comment exists in PostgreSQL with correct author/post, no new server error + regression checks |
| **Activation** | `POST /api/faults {faultId: COMMENT-01}` (requires `FAULT_INJECTION_ENABLED=true`) |
| **Deactivation** | `POST /api/faults/deactivate {faultId: COMMENT-01}` or engine runtime restore; `deactivate-all` clears every guard |
| **Rollback** | Re-activate fault on validation failure → incident `ROLLED_BACK` + negative reward, never `RESOLVED` on failed validation |
| **Cleanup** | Deactivate fault, verify normal comment creation |

> COMMENT-01 shares the comment creation surface with LOW-04 (same trigger endpoint, same guard location) but runs under its own scenario id for Demo 3 ("Cannot Comment"). No parallel fault framework was introduced: activation, registry, severity mapping, risk policy, validation probes, and repair memory all reuse the existing engine.

---

## MEDIUM Faults (Auto-Remediation)

### MEDIUM-01: Broken Post API (Server Error)

| Property | Value |
|----------|-------|
| **Scenario ID** | MEDIUM-01 |
| **Difficulty** | MEDIUM |
| **Target Component** | Post Creation API |
| **File** | `frontend/app/api/posts/route.ts` |
| **Line** | ~38 |
| **Function** | `POST` handler |
| **Original Code** | `const post = await prisma.post.create({...})` |
| **Fault** | `throw new Error('Injected DB failure')` before create |
| **Trigger** | `POST /api/posts` with valid content |
| **Expected Error** | `500: Internal Server Error` |
| **Expected Investigation** | Frontend → API → Business Logic → Database |
| **Risk Reason** | Single file, API endpoint, server error, affects all post creation, reversible |
| **AI Expected Fix** | Remove thrown error, restore prisma.create |
| **Validation** | `POST /api/posts` → 201, post created, appears in feed |
| **Rollback** | Restore original code |
| **Cleanup** | Remove fault, verify original behavior |

---

### MEDIUM-02: Database Query Failure in Feed

| Property | Value |
|----------|-------|
| **Scenario ID** | MEDIUM-02 |
| **Difficulty** | MEDIUM |
| **Target Component** | Feed API |
| **File** | `frontend/app/api/posts/route.ts` |
| **Line** | ~85 |
| **Function** | `GET` handler |
| **Original Code** | `const posts = await prisma.post.findMany({...})` |
| **Fault** | `throw new Error('Injected DB query failure')` before findMany |
| **Trigger** | `GET /api/posts` (feed load) |
| **Expected Error** | `500: Internal Server Error` |
| **Expected Investigation** | Frontend → Feed API → Database error |
| **Risk Reason** | Single file, read endpoint, affects feed for all users, reversible |
| **AI Expected Fix** | Remove thrown error, restore prisma.findMany |
| **Validation** | `GET /api/posts` → 200, posts array returned |
| **Rollback** | Restore original code |
| **Cleanup** | Remove fault, verify original behavior |

---

### MEDIUM-03: Business Logic Error in Project Update

| Property | Value |
|----------|-------|
| **Scenario ID** | MEDIUM-03 |
| **Difficulty** | MEDIUM |
| **Target Component** | Project Update API |
| **File** | `frontend/app/api/projects/[id]/route.ts` |
| **Line** | ~72 |
| **Function** | `PATCH` handler |
| **Original Code** | `if (project.ownerId !== user.id) return 403` |
| **Fault** | `if (project.ownerId === user.id) return 403` (inverted condition) |
| **Trigger** | `PATCH /api/projects/[owned-project-id]` as owner |
| **Expected Error** | `403: Forbidden` (owner incorrectly denied) |
| **Risk Reason** | Authz logic, single file, business logic bug (not exception), reversible |
| **AI Expected Fix** | Restore `!==` comparison |
| **Validation** | Owner `PATCH` own project → 200, non-owner → 403 |
| **Rollback** | Restore original condition |
| **Cleanup** | Remove fault, verify original behavior |

---

## HIGH Faults (Approval Required)

### HIGH-01: Authentication Bypass

| Property | Value |
|----------|-------|
| **Scenario ID** | HIGH-01 |
| **Difficulty** | DIFFICULT |
| **Target Component** | Login API |
| **File** | `frontend/app/api/auth/login/route.ts` |
| **Line** | ~55 |
| **Function** | `POST` handler |
| **Original Code** | `if (!user || !verifyPassword) return 401` |
| **Fault** | `if (!user) return 401` (removed password verification) |
| **Trigger** | `POST /api/auth/login` with wrong password |
| **Expected Error** | `200: Login successful` (incorrectly allows wrong password) |
| **Risk Reason** | Authentication bypass, security-critical, affects all users, low reversibility |
| **AI Expected Fix** | Restore password verification check |
| **Validation** | Wrong password → 401, correct password → 200 |
| **Approval** | HIGH-risk → approval required |
| **Rollback** | Automatic on validation failure |
| **Cleanup** | Remove fault, verify original behavior |

---

### HIGH-02: Authorization Bypass in Project Deletion

| Property | Value |
|----------|-------|
| **Scenario ID** | HIGH-02 |
| **Difficulty** | DIFFICULT |
| **Target Component** | Project Delete API |
| **File** | `frontend/app/api/projects/[id]/route.ts` |
| **Line** | ~45 |
| **Function** | `DELETE` handler |
| **Original Code** | `if (project.ownerId !== user.id) return 403` |
| **Fault** | `// if (project.ownerId !== user.id) return 403` (commented out) |
| **Trigger** | `DELETE /api/projects/[other-user-project-id]` as non-owner |
| **Expected Error** | `200: Deleted` (incorrectly allows non-owner delete) |
| **Risk Reason** | Authorization bypass, data destruction, security-critical, affects project ownership |
| **AI Expected Fix** | Restore ownership check |
| **Validation** | Non-owner DELETE → 403, owner DELETE → 200 |
| **Approval** | HIGH-risk → approval required |
| **Rollback** | Automatic on validation failure |
| **Cleanup** | Remove fault, verify original behavior |

---

### HIGH-03: Database Connectivity Failure

| Property | Value |
|----------|-------|
| **Scenario ID** | HIGH-03 |
| **Difficulty** | DIFFICULT |
| **Target Component** | Database Connection |
| **File** | `frontend/lib/server/db.ts` |
| **Line** | ~11 |
| **Function** | `createPrismaClient()` |
| **Original Code** | `const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })` |
| **Fault** | `const adapter = new PrismaPg({ connectionString: 'postgresql://invalid:invalid@localhost:5432/invalid' })` |
| **Trigger** | Any API request requiring DB |
| **Expected Error** | `500: Database connection failed` across all endpoints |
| **Risk Reason** | Infrastructure failure, cascading, affects entire application, low reversibility |
| **AI Expected Fix** | Restore correct DATABASE_URL |
| **Validation** | `GET /api/health` → database: healthy, `GET /api/posts` → 200 |
| **Approval** | HIGH-risk → approval required |
| **Rollback** | Automatic on validation failure |
| **Cleanup** | Remove fault, verify original behavior |

---

## Test Execution Matrix

| Fault | Risk | Approval | Auto-Apply | Validate | Rollback on Fail |
|-------|------|----------|------------|----------|------------------|
| LOW-01 | LOW | No | Yes | Yes | Yes |
| LOW-02 | LOW | No | Yes | Yes | Yes |
| LOW-03 | LOW | No | Yes | Yes | Yes |
| LOW-04 | LOW | No | Yes | Yes | Yes |
| COMMENT-01 | LOW | No | Yes | Yes | Yes |
| MEDIUM-01 | MEDIUM | No | Yes | Yes | Yes |
| MEDIUM-02 | MEDIUM | No | Yes | Yes | Yes |
| MEDIUM-03 | MEDIUM | No | Yes | Yes | Yes |
| HIGH-01 | HIGH | Yes | After approval | Yes | Yes |
| HIGH-02 | HIGH | Yes | After approval | Yes | Yes |
| HIGH-03 | HIGH | Yes | After approval | Yes | Yes |

---

## Test Harness Requirements

### For Each Fault:
1. **Activate fault** via `POST /api/faults {faultId}` → runtime guard + file patch + fault incident created
2. **Trigger** the fault via specified API call (guard yields the documented failure)
3. **Verify** failure occurs as expected
4. **Run self-healing** (`POST /api/security/run {incidentId}`, dispatches to `repair/engine.ts`):
   - Evidence → up to 3 Coder/Critic/Judge rounds → risk classification → verified candidate
   - **LOW/MEDIUM**: auto-apply (write patch + disarm) → validate via real HTTP probe → RESOLVED or rollback (restore + rearm + `ROLLED_BACK`)
   - **HIGH**: `WAITING_APPROVAL` + `repairAttemptId`-bound approval → `POST /api/approvals/proceed` continues → apply → validate → RESOLVED/ROLLED_BACK
5. **Verify** original behavior restored (probe target `APP_URL || http://localhost:3000`)
6. **Deactivate fault** (`POST /api/faults/deactivate`) and clean up
7. **Learn**: real attempts persist `RepairMemory` + a normalized `RepairExperience` (Phase 10)

### Special Test Cases:
- **HIGH without approval**: Verify patch NOT applied
- **HIGH with approval + validation fail**: Verify automatic rollback
- **Telegram dedupe**: Same incident+type → max 1 msg per 5 min
- **Approval binding**: PROCEED APR-XXXXX only works for that approval
- **Approval expiration**: Expired approval cannot be consumed

---

## Validation Commands

```bash
# Start server with fault injection enabled
FAULT_INJECTION_ENABLED=true npm run dev

`# Activate fault (applies patch + creates fault incident)
curl -X POST http://localhost:3000/api/faults \
  -H "Content-Type: application/json" \
  -H "Cookie: buildhub_session=..." \
  -d '{"faultId": "LOW-01"}'

# Trigger fault
curl -X POST http://localhost:3000/api/posts \
  -H "Content-Type: application/json" \
  -H "Cookie: buildhub_session=..." \
  -d '{"content": "test", "tags": []}'

# Run self-healing (operator)
curl -X POST http://localhost:3000/api/security/run \
  -H "Content-Type: application/json" \
  -H "Cookie: buildhub_session=..." \
  -d '{"incidentId": "..."}'

# Simulate approval (test harness)
curl -X POST http://localhost:3000/api/approvals/proceed \
  -H "Content-Type: application/json" \
  -H "Cookie: buildhub_session=..." \
  -d '{"approvalId": "APR-123456", "action": "proceed"}'

# Verify fix
curl -X POST http://localhost:3000/api/posts \
  -H "Content-Type: application/json" \
  -H "Cookie: buildhub_session=..." \
  -d '{"content": "test", "tags": []}'

# Deactivate fault
curl -X POST http://localhost:3000/api/faults/deactivate \
  -H "Content-Type: application/json" \
  -H "Cookie: buildhub_session=..." \
  -d '{"faultId": "LOW-01"}'
```

---

## Final Verification (All 9 Faults)

After all faults tested:

```bash
# Run full Phase 9 verification (VERIFIED: 103 passed, 0 failed)
node scripts/verify-self-healing.mjs
# Portable HTTP E2E, real fault → incident → engine (VERIFIED: 69 passed, 0 failed)
python3 scripts/e2e_real_self_healing.py
# Browser E2E Phase 9 (requires Playwright)
python3 scripts/e2e_phase9_full.py
# Browser E2E Phase 10 — learning loop (VERIFIED: 50 passed, 0 failed)
python3 scripts/e2e_phase10_learning.py

# Regression tests
node scripts/verify-observability.mjs
node scripts/verify-security.mjs
python3 scripts/test_security_log_analyzer.py
node scripts/verify-posts-projects.mjs
python3 scripts/e2e_phase6_full.py
python3 scripts/e2e_phase7_full.py
python3 scripts/e2e_phase8_full.py

# Static checks
npm run lint
npx tsc --noEmit
npm run build
```

---

## Expected Results Summary

| Test | Expected |
|------|----------|
| LOW-01 repair | PASS |
| LOW-02 repair | PASS |
| LOW-03 repair | PASS |
| LOW rollback | PASS |
| MEDIUM-01 repair | PASS |
| MEDIUM-02 repair | PASS |
| MEDIUM-03 repair | PASS |
| MEDIUM rollback | PASS |
| HIGH-01 no approval | PASS (patch NOT applied) |
| HIGH-01 with approval | PASS |
| HIGH-02 no approval | PASS (patch NOT applied) |
| HIGH-02 with approval | PASS |
| HIGH-03 no approval | PASS (patch NOT applied) |
| HIGH-03 with approval | PASS |
| HIGH approved + validation fail | PASS (rollback) |
| Telegram dedupe | PASS |
| Telegram approval binding | PASS |
| Approval expiration | PASS |
| Real-time dashboard | PASS |
| AI chat | PASS |
| Repair memory | PASS |
| Exact file/line reporting | PASS |
| Phase 10 repair memory rows | PASS |
| Phase 10 RL dataset/experiences | PASS |
| Phase 10 Learning dashboard | PASS |
| Phase 10 Security console chat | PASS |

---

*Phase 9 + Phase 10 Fault Test Plan — BuildHub Self-Healing System*