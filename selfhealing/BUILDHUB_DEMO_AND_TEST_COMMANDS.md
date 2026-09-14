# BuildHub — Operator / Demo / Test Commands (Phase 6–10)

**Project root:** `/home/dharshan/selfhealing`

> **Phase 10 FINAL PASS (2026-09-13):** the active demo path uses the **cloud
> Groq provider only** (`AI_PROVIDER=groq`, `AI_MODEL=qwen/qwen3.8-27b`); Ollama
> is still supported but NOT required. Real server errors (status ≥ 500) now
> **automatically** create an incident and start the self-healing pipeline
> (`logApiError` → auto-scan), so `POST /api/incidents/scan` is only a manual
> fallback. HIGH-risk patches are approved/rejected in the UI from the incident
> detail page (PROCEED/REJECT buttons). `/ai/learning` shows the RL decision
> policy before→after evaluation over a deterministic synthetic holdout split.
>
> Known reliability note (verified live 2026-09-13): on the small Groq model
> (`qwen/qwen3.8-27b`) the HIGH-01 login fix may be ROLLED_BACK because the
> model paraphrases the auth route instead of quoting it byte-for-byte — the
> anchor gate refuses the patch, which is the correct safe behavior. Retry the
> scenario (re-activate HIGH-01 + wrong-password 500) if the quote misses; the
> poster-child auto-heal demo (LOW-01 posts) succeeds reliably.

Two runnable application directories:

| Build | Directory | Port | DB | Has AI |
|-------|-----------|------|----|--------|
| **AI BuildHub** | `/home/dharshan/selfhealing/frontend` | 3000 | `buildhub` | Yes (Groq agents, self-healing, learning) |
| **No-AI BuildHub** | `/home/dharshan/selfhealing/buildhub-no-ai` | 3001 | `buildhub_no_ai` | No (same app, fault stays broken) |

Authoritative sources used for this document: actual source code,
`PHASE9_FAULT_TEST_PLAN.md`, `AI_CODEBASE_MAP.md`, `PLAN.md`,
`frontend/PHASE10_LEARNING_COMMANDS.md`, and the committed scripts in each
`scripts/` directory. Every command and location below was read from the
repository (not invented). Discrepancies found while writing this document are
called out explicitly in §22.

---

## 1. START EVERYTHING

### 1.1 PostgreSQL (no docker-compose exists in this repo)

PostgreSQL runs as a Docker container **`buildhub-pg`** (image `postgres:16-alpine`,
host port `5432`, user `buildhub`, password `buildhub_dev_pw`).
There is **no** `docker-compose.yml`/`.yaml` in the repository. The working
start command is plain Docker:

```bash
# Confirm the container exists and check state
docker ps -a --filter name=buildhub-pg

# Start it if/when it is stopped
docker start buildhub-pg

# Verify
docker exec buildhub-pg pg_isready -U buildhub
```

Databases inside `buildhub-pg` (verified):

```
buildhub          # the AI build's database
buildhub_no_ai    # the No-AI build's database
```

Connection strings used by the two apps:

```
AI BuildHub   postgresql://buildhub:buildhub_dev_pw@localhost:5432/buildhub
No-AI BuildHub postgresql://buildhub:buildhub_dev_pw@localhost:5432/buildhub_no_ai
```

### 1.2 AI BuildHub (port 3000)

```bash
cd /home/dharshan/selfhealing/frontend
npm install          # first time only (node_modules present already)
npm run dev          # next dev  →  http://localhost:3000
```

Required env in `frontend/.env` (already set): `DATABASE_URL`,
`FAULT_INJECTION_ENABLED=true`, `AUTH_GUARD_ENABLED=true`, and for real AI a
configured `AI_PROVIDER=groq`, `AI_MODEL`, `GROQ_API_KEY`, plus
`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`. See `frontend/.env.example`.

Production-style start (after `npm run build`):

```bash
cd /home/dharshan/selfhealing/frontend
npm run build
npm run start -- --port 3000
```

### 1.3 No-AI BuildHub (port 3001)

```bash
cd /home/dharshan/selfhealing/buildhub-no-ai
npm run demo        # next dev -p 3001  →  http://localhost:3001
```

(`"demo": "next dev -p 3001"` in `package.json`.)

Production-style start:

```bash
cd /home/dharshan/selfhealing/buildhub-no-ai
npm run build
npm run start -- --port 3001
```

Verify both are up:

```bash
curl -s http://localhost:3000/api/health   # expects ..."status":"ok"...
curl -s http://localhost:3001/api/health   # expects ..."status":"ok"...
```

---

## 2. LOGIN

| Build | URL |
|-------|-----|
| AI BuildHub | http://localhost:3000 |
| No-AI BuildHub | http://localhost:3001 |

### Seeded demo accounts (not invented — from `frontend/prisma/seed.mjs`)

All seeded accounts share the single demo password:

```
buildhub-demo1
```

Seed users and their login identifiers (the seed sets
`email = "<username>@buildhub.dev"`, and the login form accepts **email or
username** — `signInSchema.identifier` is `z.string().min(1)`, see
`frontend/lib/validation.ts`):

| Username | Login as | Role |
|----------|----------|------|
| arjun | `arjun@buildhub.dev` (or `arjun`) | **Security operator** (default operator, see below) |
| meera | `meera@buildhub.dev` | Normal user |
| karthik | `karthik@buildhub.dev` | Normal user |
| ananya | `ananya@buildhub.dev` | Normal user |
| rahul | `rahul@buildhub.dev` | Normal user |
| priya | `priya@buildhub.dev` | Normal user |

**Operator gating:** security endpoints (`/api/faults` POST, `/api/security/*`,
`/api/approvals/*`, `/api/ai/chat`, `/api/demo/attack` POST reset) require a
session whose username is in `SECURITY_OPERATOR_USERNAMES`, which **defaults to
`arjun`** unless overridden (`frontend/lib/server/security.ts`). Use **arjun**
for all operator demos.

The seed is idempotent and safe to re-run:

```bash
cd /home/dharshan/selfhealing/frontend
npx prisma db seed
```

### Creating a fresh account (if you do not want seeded credentials)

Open http://localhost:3000/signup (No-AI: http://localhost:3001/signup) and
register, or POST:

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo User","username":"demo","email":"demo@buildhub.dev","password":"buildhub-demo1"}'
```

To script curl calls as the operator, save the session cookie first:

```bash
curl -c /tmp/bh-cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifier":"arjun@buildhub.dev","password":"buildhub-demo1"}'
# then reuse the cookie jar on every operator call with:  -b /tmp/bh-cookies.txt
```

---

## 3. AI COMMAND CENTER — http://localhost:3000/ai

Signed in as `arjun`, open http://localhost:3000/ai. Side-bar navigation
(`app/(command)/ai/*`, rendered by `components/command/command-shell.tsx`):

| Page | URL |
|------|-----|
| Overview | `/ai` |
| Security | `/ai/security` |
| Incidents | `/ai/incidents` |
| Live Logs | `/ai/logs` |
| AI Pipeline | `/ai/pipeline` |
| History | `/ai/history` |
| Learning | `/ai/learning` |
| Reports | `/ai/reports` |
| (incident detail) | `/ai/incidents/[id]` |

### Overview
Live Mission-Control dashboard (`components/command/overview-client.tsx`,
fed by `/api/observability/summary` and `/api/security/status`).
Displays **Risk Score** (0–100), **Cyber Safety** (0–100), **System
Health** (%) and **Active Incidents**, plus **Component Health** for the 5
instrumented components — **Database, API, Authentication, Monitoring,
Frontend** (`frontend/lib/server/observability.ts`) — **Security
Observations** (real `SecurityFinding` rows), **Live Activity** (real recent
`log_event` rows), **Active Incidents** (real incidents), and an **AI Pipeline
Snapshot** (real `AgentRun`s of the most recent incident).

### Security
`/ai/security` (`components/command/security-client.tsx`, fed by
`GET /api/security/status`). Shows the risk tier table
(`dashboard | incident | heightened | critical`, thresholds 39/69/89), **Live
Findings** (real findings), the **AI + Alerting** card (real Groq model
online/configured state + Telegram configured state), **Active Incidents**
(real), and the **Self-Healing Console** chat (below).

### Incidents
`/ai/incidents` and `/ai/incidents/[id]`. List of **real** incidents from the
`incident` table, filterable by status/severity. The detail page
(`components/command/incident-detail-client.tsx`) shows **Timeline** (real
IncidentEvents), **Self-Healing Repair** (the real per-round transcript of
Coder→Critic→Judge AgentRuns for the incident), **Related Log Events** (real
log rows linked to the incident), **Human Approval History** (real `approval`
rows: PENDING/APPROVED/REJECTED/EXPIRED/CONSUMED), and **Previous Similar
Incidents** (real past repairs/history).

### Live Logs
`/ai/logs` — real `log_event` rows with search/filter by service, error code,
level, message. No generated rows; every entry is written by actual
application operations (`logger.*`).

### AI Pipeline
`/ai/pipeline` — the honest pipeline explanation + the currently running real
AgentRuns. The page shows "No active pipeline" unless actual agent runs exist
(`components/command/pipeline-client.tsx`). No placeholder progress.

### History
`/ai/history` — repair memory / prior repair records (wired to
`GET /api/ai/memory`, the `RepairMemory` table) — real prior repair summaries
for resolved/rolled-back incidents.

### Reports
`/ai/reports` — PDF incident reports (downloaded via
`POST /api/incidents/[id]/report`; a PDF is generated only when real incidents
exist — the page shows "No reports" otherwise).

### Learning / Memory
`/ai/learning` (and `/ai/learning` … `/ai/history`) — see §15/§16. Fed by
`GET /api/ai/learning`, `/api/ai/memory`, `/api/ai/experiences`,
`/api/ai/rl-dataset`, `/api/ai/evaluate`, `/api/ai/visualization`.

### AI Chat
Inside `/ai/security` → **Self-Healing Console**. `POST /api/ai/chat`
(`app/api/ai/chat/route.ts`) — operator Q&A with the configured model. See §13.

### Explicit honesty guarantees (enforced in the code, checked by tests)

```
NO fake telemetry.      ← every score is a pure function of real DB/log rows (ADR-012)
NO fake AI progress.    ← AgentRun.status/progress comes from real pipeline execution
NO fake incidents.      ← incidents are created only by real findings/fault activation
NO fake validation.     ← validation is a real HTTP probe; rollback only on real failure
```

`PHASE9_FAULT_TEST_PLAN.md`, `verify-observability.mjs`, `verify-security.mjs`
and the `e2e_phase7/8_full.py` suites assert this ("no-fake-data" rule,
ADR-013): the Phase 7-era "Simulation mode" copy no longer exists anywhere.

---

## 4. ATTACK DEMO

The **"same attack" comparison demo** fires the *identical* forged
sign-in burst at both builds on loopback.

| | WITH AI | WITHOUT AI |
|---|---|---|
| App | `frontend` (port 3000) | `buildhub-no-ai` (port 3001) |
| Comparison page | — (no UI page on 3000; see note) | http://localhost:3001/demo/attack |
| Telemetry API | `GET http://localhost:3000/api/demo/attack` | `GET http://localhost:3001/api/demo/attack` (+ bridge `.../api/demo/attack/ai`) |
| Attack script | `python3 scripts/run-port3000.py --confirm-local` (run from `frontend/`) | `python3 scripts/run-port3001.py --confirm-local` (run from `buildhub-no-ai/`) |

> **Discrepancy note (verified):** the repository has **no `/demo/attack`
> page on port 3000** — `frontend/app` contains only `app/api/demo/attack`. The
> side-by-side comparison UI is served by the **No-AI build at
> `http://localhost:3001/demo/attack`**, which polls the live No-AI telemetry
> and the AI build through the bridge route
> `GET http://localhost:3001/api/demo/attack/ai` (which forwards to the AI
> build's `/api/demo/attack`; if the AI server is down the bridge answers a
> truthful `build:"ai", phase:"down"` with HTTP 502). The WITH-AI panel on that
> page therefore always reflects the real AI build on 3000. See §22.

### The attack engine

Both `frontend/scripts/attack_common.py` and
`buildhub-no-ai/scripts/attack_common.py` (identical copies) implement the same,
rules-limited engine:

- stdlib only (no third-party deps)
- rejects any target that is not `127.0.0.1` / `localhost` / `::1` on **ports
  3000 or 3001** only
- `--confirm-local` is required before any request is sent
- limits: max 500 requests, max 60s duration, concurrency 4, health poll every
  0.5s
- forged logins: usernames `burst<nnn>@local.invalid`, password constant
  `7aX-contr0l-local`, `X-Request-Id` stamped, JSON body
- stops the moment the designed terminal signal is observed:
  - **No-AI mode:** 3 consecutive `/health` `unavailable` (503)
  - **AI mode:** 20 consecutive HTTP `429` from `/api/auth/login` (mitigation
    active)
- AI mode then waits for recovery (health returns `ok`, up to 180s)
- prints a JSON summary; **exit code 0 = expected outcome observed**

Exact invocation:

```bash
# WITH AI — run from /home/dharshan/selfhealing/frontend
cd /home/dharshan/selfhealing/frontend
python3 scripts/run-port3000.py --confirm-local

# WITHOUT AI — run from /home/dharshan/selfhealing/buildhub-no-ai
cd /home/dharshan/selfhealing/buildhub-no-ai
python3 scripts/run-port3001.py --confirm-local
```

Each wrapper prints the real `/api/demo/attack` telemetry of its build after
the run.

---

## 5. ATTACK DEMO SEQUENCE

### STEP 1 — Start both servers
```bash
docker start buildhub-pg
cd /home/dharshan/selfhealing/frontend && npm run dev      # :3000 (AI)
cd /home/dharshan/selfhealing/buildhub-no-ai && npm run demo  # :3001 (No-AI)
```

### STEP 2 — Open the comparison page
```
http://localhost:3001/demo/attack
```
(login as `arjun` if redirected — the page is inside the authenticated shell).
The page auto-refreshes every 2.5s and shows **WITHOUT-AI** and **WITH-AI**
panels side by side.

### STEP 3 — Run the No-AI attack (port 3001)
```bash
cd /home/dharshan/selfhealing/buildhub-no-ai
python3 scripts/run-port3001.py --confirm-local
```
Expected sequence (implementation thresholds, default env):

```
authentication failure burst (forged logins → 401)
  → degraded   at 40 AUTH_FAILED within the 60 s window
                (DEMO_AUTH_DEGRADE_THRESHOLD=40, DEMO_AUTH_WINDOW_MS=60000)
  → UNAVAILABLE at 60 AUTH_FAILED within the window
                (DEMO_AUTH_FAIL_THRESHOLD=60)
  → /api/auth/login and /api/health both return 503
  → phase latches "unavailable" until operator action
```

(Observed reference run: 61×401 then 323×503; health
`unavailable`/503; telemetry `phase=unavailable` with
`degradedAt`/`unavailableAt` set; script exit 0. State is DB-derived from real
`AUTH_FAILED`/`ATTACK_DEGRADED`/`ATTACK_UNAVAILABLE` log rows — see
`buildhub-no-ai/lib/server/demo-availability.ts`.)

Because there is **no AI**, the failure is not detected or mitigated — that is
the honest counter-example.

### STEP 4 — Restart the No-AI server (the only recovery path)
```bash
# Ctrl-C the 3001 dev server, then:
cd /home/dharshan/selfhealing/buildhub-no-ai && npm run demo
```
A fresh process start performs a clean boot (deletes the previous run's demo
attack rows within the last 24h, `lib/server/demo-availability.ts`
`ensureBootClean`) — operator restart = clean recovery. Alternatively a
signed-in operator can POST `/api/demo/attack {action:"reset"}` (only resets
the demo rows; the process keeps running).

### STEP 5 — Open the WITH-AI panel
Same page: `http://localhost:3001/demo/attack` (WITH-AI column, via the bridge
to :3000), or inspect the AI build directly at
`http://localhost:3000/api/demo/attack`.

### STEP 6 — Run the same attack against port 3000
```bash
cd /home/dharshan/selfhealing/frontend
python3 scripts/run-port3000.py --confirm-local
```
Expected sequence (implementation thresholds, default env):

```
authentication failure burst (401, each logged as AUTH_FAILED)
  → detection   at 10 failures within the 60 s window
               (AUTH_GUARD_FAIL_THRESHOLD=10, AUTH_GUARD_WINDOW_MS=60000)
  → AUTH_BURST finding + real incident created (errorCode AUTH_BURST)
  → escalation runs the real pipeline (ingest → promote → agent runs)
  → mitigation: source IP blocked with HTTP 429 + IP_BLOCKED log rows
  → temporary block duration 120 s (AUTH_GUARD_BLOCK_MS=120000)
  → application stays HEALTHY (no 5xx; overall health returns ok ~60 s after
    the burst because the Authentication health component uses a 60 s live
    signal window, AUTH_HEALTH_SIGNAL_WINDOW_MS=60000)
```

(Observed reference run: 12×401 then 148×429, **0 5xx**, peak latency 98 ms,
recovery to `/health ok` ≈ 61 s, script exit 0; real incident `INC-00002`
HIGH `AWAITING_REVIEW` risk score 24 with completed FIXER/CRITIC/JUDGE agent
runs, and the telemetry `phase` moved through
normal → attack → detected → mitigating → recovered.)

---

## 6. LOW-01 SELF-HEALING DEMO — CREATE POST (primary demo)

Fault catalog sheet (authoritative values are in the registry,
`frontend/lib/server/fault-injection.ts` — matches `PHASE9_FAULT_TEST_PLAN.md`):

| Property | Value |
|----------|-------|
| ID | `LOW-01` |
| Name | Undefined Variable in Post Creation |
| Difficulty | EASY |
| File | `frontend/app/api/posts/route.ts` |
| Line | 45 |
| Function | `POST` handler |
| Original code | `const authorId = session.user.id;` |
| Fault code | `const authorId = session.user.undefinedProperty;` |
| Trigger | `POST /api/posts` (valid content, authenticated) |
| Expected error | `TypeError: Cannot read property 'id' of undefined` (HTTP 500) |
| Risk | LOW — auto-apply, no approval |
| AI expected fix | Restore `session.user.id` |
| Validation probe | `POST /api/posts` → 201 (`lib/server/repair/validation.ts` case `LOW-01`) |
| Rollback | restore original line on validation failure |

**How the fault actually behaves in the current implementation (verified):**
activation does **not** rewrite `posts/route.ts` on disk. It stores the pads
`{LOW-01: originalCode→faultCode}` and flips the in-memory guard. The handler
is wrapped in `withFaultInjection('LOW-01', …)` at `app/api/posts/route.ts`
(line 19); while the guard is armed it returns the documented
`500 { error: "Cannot read property 'id' of undefined" }` without running the
create. The repair engine separately classifies the candidate, disarms the
guard and **physically writes** the fixed file (via
`lib/server/repair/patch-engine.ts`, which checkpoints the original content
and `writeFileSync`s the repaired content), then runs a **real HTTP probe**
against `APP_URL || http://localhost:3000`. On probe success the incident is
`RESOLVED`; on failure the original file is restored and the incident is
`ROLLED_BACK`.

### Live demo steps

```
1. Activate LOW-01
   curl -X POST http://localhost:3000/api/faults -b /tmp/bh-cookies.txt \
     -H 'Content-Type: application/json' -d '{"faultId":"LOW-01"}'
   → returns { success:true, incident:{ ref:"INC-…", status:"DETECTED", severity:"LOW" } }
2. Login        → http://localhost:3000/login  (arjun@buildhub.dev / buildhub-demo1)
3. Open feed    → http://localhost:3000/feed   (composer)
4. Trigger      → type a post (title+content), press Publish.
5. Observe      → real HTTP 500 with the documented error
                  ("Cannot read property 'id' of undefined").
6. Open /ai     → http://localhost:3000/ai → Incidents → open the LOW incident.
7. Observe the incident (real row: ref, severity LOW, detected status).
8. Run repair   → on the incident detail page press the repair/run action
                  (equivalently: POST /api/security/run
                  with {"incidentId":"<id>"}).
9. Observe Coder   → round 1 candidate transcript (real Groq call).
10. Observe Critic → reviews the candidate (ACCEPT or REVISE; if REVISE a
                     round 2 Coder revision follows).
11. Observe Judge  → final decision + risk classification.
12. Observe risk   → LOW (deterministic risk engine, `lib/server/risk.ts`).
13. Observe patch  → auto-applied (LOW/MEDIUM need no approval); the fixed
                     source is written to disk.
14. Observe validation → the real HTTP probe "Post creation succeeds"
                     (POST /api/posts → 201).
15. Observe RESOLVED  → incident status RESOLVED, patch record persisted,
                     Telegram "Repair applied & validated", and a repair
                     experience is written (Phase 10).
```

For a *deterministic* run in hermetic TEST mode (no Groq needed) see §10.

---

## 7. MEDIUM-01 .. MEDIUM-03

All data below is from the actual registry
(`frontend/lib/server/fault-injection.ts`), the wrappers in the handlers
(`frontend/lib/server/fault-injection-handlers.ts`), and the validation probes
(`frontend/lib/server/repair/validation.ts`).

### MEDIUM-01 — Broken Post API (Server Error)

| Property | Value |
|----------|-------|
| File / Line / Function | `frontend/app/api/posts/route.ts` · 38 · `POST` handler |
| Original code | `const post = await prisma.post.create({...})` |
| Fault injection | `throw new Error('Injected DB failure')` (guard returns `500 { error:"Injected DB failure" }`) |
| Trigger | `POST /api/posts` (authenticated, valid content) |
| Expected error | `500: Internal Server Error` |
| Expected root cause | API handler throws before post creation |
| Expected patch | remove throw; restore `prisma.post.create` |
| Validation | probe `POST /api/posts` → 201 |
| Expected result | RESOLVED (auto-apply, no approval). |
| Rollback test | patch then probe fail → original restored, `ROLLED_BACK` |

### MEDIUM-02 — Database Query Failure in Feed

| Property | Value |
|----------|-------|
| File / Line / Function | `frontend/app/api/posts/route.ts` · 85 · `GET` handler |
| Original code | `const posts = await prisma.post.findMany({...})` |
| Fault injection | `throw new Error('Injected DB query failure')` (guard returns `500 { error:"Injected DB query failure" }`) |
| Trigger | `GET /api/posts` (feed loads) |
| Expected error | `500: Internal Server Error` |
| Expected root cause | feed read endpoint throws before the query |
| Expected patch | remove throw; restore `prisma.post.findMany` |
| Validation | probe `GET /api/posts` → 200 (`"Feed loads"`) |
| Expected result | RESOLVED (auto-apply). |
| Rollback test | probe fail → `ROLLED_BACK` |

### MEDIUM-03 — Business Logic Error in Project Update

| Property | Value |
|----------|-------|
| File / Line / Function | `frontend/app/api/projects/[id]/route.ts` · 72 · `PATCH` handler |
| Original code | `if (project.ownerId !== user.id) return 403` |
| Fault injection | `if (project.ownerId === user.id) return 403` (inverted; applied via `applyMedium03InvertedAuthz`) |
| Trigger | `PATCH /api/projects/[id]` as the owner |
| Expected error | `403: Forbidden` (owner incorrectly denied) |
| Expected root cause | inverted authorization condition |
| Expected patch | restore `!==` comparison |
| Validation | probe `Owner can update own project` → `PATCH /api/projects/{id}` → 200 |
| Expected result | RESOLVED (auto-apply). |
| Rollback test | probe fail → `ROLLED_BACK` |

Activate/trigger commands for each mirror §9 with `"faultId":"MEDIUM-0X"`.

---

## 8. HIGH-01 .. HIGH-03

All HIGH-risk repairs require human approval before the patch is applied.
When a HIGH candidate is produced by Judge, the engine halts the incident in
**`WAITING_APPROVAL`**, creates an approval (`APR-XXXXXX`,
**5-minute timeout**), sends a Telegram message ("PROCEED <id>" to propose), and
persists the incident summary "Awaiting human approval …". Applying the patch
is only possible after `POST /api/approvals/proceed`. **Human approval never
disables rollback** (see §12).

### HIGH-01 — Authentication Bypass

| Property | Value |
|----------|-------|
| File / Line / Function | `frontend/app/api/auth/login/route.ts` · 55 · `POST` handler |
| Original code | `if (!user || !verifyPassword) return 401` |
| Fault code | `if (!user) return 401` (password check removed; applied via `applyHigh01AuthBypass`) |
| Trigger | `POST /api/auth/login` with a wrong password |
| Error | `200: Login successful` (wrong password accepted) |
| Expected root cause | missing password verification in the login handler |
| Expected patch | restore the password verification check |
| Risk | HIGH |
| Approval required | YES (`WAITING_APPROVAL`, approval `APR-…`, PROCEED to apply) |
| Validation | probe `Wrong password rejected` → `POST /api/auth/login` w/ bad password → 401 |
| Rollback | automatic on validation failure |

### HIGH-02 — Authorization Bypass in Project Deletion

| Property | Value |
|----------|-------|
| File / Line / Function | `frontend/app/api/projects/[id]/route.ts` · 45 · `DELETE` handler |
| Original code | `if (project.ownerId !== user.id) return 403` |
| Fault code | comment out the ownership check (applied via `applyHigh02AuthzBypass`) |
| Trigger | `DELETE /api/projects/[id]` as a non-owner |
| Error | `200: Deleted` (non-owner delete allowed) |
| Expected root cause | missing ownership check on DELETE |
| Expected patch | restore the ownership check |
| Risk | HIGH |
| Approval required | YES |
| Validation | probe `Non-owner cannot delete project` → `DELETE /api/projects/{foreignId}` → 403 |
| Rollback | automatic on validation failure |

### HIGH-03 — Database Connectivity Failure

| Property | Value |
|----------|-------|
| File / Line / Function | `frontend/lib/server/db.ts` · 11 · `createPrismaClient()` |
| Original code | `const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })` |
| Fault code | `new PrismaPg({ connectionString: 'postgresql://invalid:invalid@localhost:5432/invalid' })` (guard returns `503 { error:"Database connection failed (HIGH-03 simulated outage)" }` for wrapped endpoints) |
| Trigger | any DB-backed endpoint (e.g. `GET /api/posts`) |
| Error | `503/500: Database connection failed` |
| Expected root cause | database connectivity/infrastructure failure |
| Expected patch | restore the correct `DATABASE_URL` |
| Risk | HIGH |
| Approval required | YES |
| Validation | probe `Database-backed endpoint healthy` → `GET /api/posts` → 200 |
| Rollback | automatic on validation failure |

### Approval in production vs. automated E2E

- **Production** (real provider): HIGH patch requires the configured operator's
  **approval**; `POST /api/approvals/proceed` is operator-gated
  (`requireSecurityOperator`), bound to the exact `repairAttemptId`, and
  rejected if expired (`5 * 60 * 1000` ms). `apply-patch` refuses without an
  `APPROVED` approval (`app/api/incidents/[id]/apply-patch/route.ts`).
- **Automated E2E** (`verify-self-healing.mjs`, `e2e_phase9_full.py`,
  `e2e_phase10_learning.py`): the harness drives the SAME path through
  `POST /api/approvals/proceed` (JSON
  `{ "approvalId": "APR-…", "action": "proceed" }`), then asserts the terminal
  `RESOLVED`/`ROLLED_BACK` stage. This is the "existing test approval
  mechanism".

---

## 9. EXACT FAULT COMMANDS (current API)

All operator endpoints require the `buildhub_session` cookie
(**arjun** by default). Save it as in §2 first. `GET /api/faults` is public.

```bash
COOKIES=/tmp/bh-cookies.txt

# 1) List faults (public)
curl -s http://localhost:3000/api/faults

# 2) Activate a fault (operator) → creates the fault incident + returns it
curl -X POST http://localhost:3000/api/faults -b $COOKIES \
  -H 'Content-Type: application/json' -d '{"faultId":"LOW-01"}'

# 3) Trigger the fault — hit the documented endpoint, e.g. for LOW-01:
curl -X POST http://localhost:3000/api/posts -b $COOKIES \
  -H 'Content-Type: application/json' \
  -d '{"content":"trigger the fault","tags":["demo"]}'
#   (MEDIUM-03/HIGH-02: PATCH/DELETE /api/projects/[id]; HIGH-01: POST /api/auth/login)

# 4) Run the self-healing pipeline on the resulting incident (operator)
curl -X POST http://localhost:3000/api/security/run -b $COOKIES \
  -H 'Content-Type: application/json' -d '{"incidentId":"<incident-id>"}'
#   optional hermetic scenario (TEST provider only):
#   -d '{"incidentId":"<id>","scenario":"accept-round-1"}'
#   scenarios: accept-round-1 | accept-round-2 | accept-round-3 | reject-all | judge-reject

# 5) HIGH risk — approve to continue apply/validate/rollback
curl -X POST http://localhost:3000/api/approvals/proceed -b $COOKIES \
  -H 'Content-Type: application/json' -d '{"approvalId":"APR-123456","action":"proceed"}'

# 6) Deactivate a fault (operator)
curl -X POST http://localhost:3000/api/faults -b $COOKIES \
  -H 'Content-Type: application/json' -d '{"action":"deactivate","faultId":"LOW-01"}'

# 7) Deactivate ALL faults (operator)
curl -X POST http://localhost:3000/api/faults -b $COOKIES \
  -H 'Content-Type: application/json' -d '{"action":"deactivate-all"}'
```

Fault list format: `{ enabled, total, active, faults:[{id,severity,difficulty,
trigger,symptom,active}] }`.

**No-AI build** exposes only the shared `LOW-01` via a demo auth-gated API
(`buildhub-no-ai/app/api/demo/fault/route.ts`, authenticated — any session):

```bash
curl -s http://localhost:3001/api/demo/fault -b /tmp/bh-cookies.txt            # state
curl -X POST http://localhost:3001/api/demo/fault -b /tmp/bh-cookies.txt \
  -H 'Content-Type: application/json' -d '{"action":"activate"}'               # activate LOW-01
curl -X POST http://localhost:3001/api/demo/fault -b /tmp/bh-cookies.txt \
  -H 'Content-Type: application/json' -d '{"action":"deactivate"}'
curl -X POST http://localhost:3001/api/demo/fault -b /tmp/bh-cookies.txt \
  -H 'Content-Type: application/json' -d '{"action":"reset"}'                  # deactivate + clear demo logs
```

---

## 10. RANDOM CONTROLLED FAULT

There is **no `scripts/fault_injection.py`** in the repository. The random
selector is the API **`GET /api/faults/random`**
(`frontend/app/api/faults/random/route.ts`): it picks one currently **inactive**
fault using `crypto.randomInt`, operator-gated, and returns `{ ok, faultId }`.
It refuses (`409`) when all faults are active.

```bash
# Pick a random inactive fault (safe, local)
curl -s http://localhost:3000/api/faults/random -b /tmp/bh-cookies.txt
# → {"ok":true,"faultId":"MEDIUM-02"}   (example; random each call)

# Then complete the cycle manually:
curl -X POST http://localhost:3000/api/faults -b /tmp/bh-cookies.txt \
  -H 'Content-Type: application/json' -d '{"faultId":"<from-answer>"}'   # activate
# … trigger the endpoint from the catalog (§21) …
curl -X POST http://localhost:3000/api/security/run -b /tmp/bh-cookies.txt \
  -H 'Content-Type: application/json' -d '{"incidentId":"<incident-id>"}' # detect + Coder → Critic → Judge → risk
# (HIGH: PROCEED via §9 step 5) → patch → validation
curl -X POST http://localhost:3000/api/faults -b /tmp/bh-cookies.txt \
  -H 'Content-Type: application/json' -d '{"action":"deactivate-all"}'    # cleanup
```

**It selects ONLY from the nine predefined safe local faults** in the registry
(LOW-01..03, MEDIUM-01..03, HIGH-01..03) — never a random mutation, never a
remote target, never a real network failure. `FAULT_INJECTION_ENABLED=true` is
required.

---

## 11. MULTI-AGENT CONVERSATION DEMO

For fault incidents the repair engine runs a real, persisted
**Coder → Critic → (revise →) … → Judge** conversation over up to 3 rounds
(`frontend/lib/server/repair/engine.ts`; agent kinds `CODER`/`CRITIC`/`JUDGE`
in `AgentRun`). Each agent is one real model call. The four cases map to the
hermetic scenario contract (`accept-round-1 | accept-round-2 | accept-round-3
| reject-all | judge-reject`) used by `POST /api/security/run` with
`SELF_HEALING_TEST_MODE=true` + `AI_PROVIDER=test`, or to real GROQ runs:

| Case | Flow | Hermetic scenario |
|------|------|-------------------|
| A | Coder → Critic **ACCEPT** → Judge | `accept-round-1` |
| B | Coder → Critic **REVISE** → Coder → Critic **ACCEPT** → Judge | `accept-round-2` |
| C | Coder → Critic **REVISE** → Coder → Critic **REVISE** → Coder → Critic **ACCEPT** → Judge | `accept-round-3` |
| D | three rounds, Critic keeps **REJECT** → **no patch**, incident terminal `AI_REPAIR_FAILED` (stop reason `CODER_REJECTED`) | `reject-all` |

**Where it appears:** `/ai → Incidents → <incident id>` in the **Self-Healing
Repair** card: the transcript is rendered as **Round 1 / Round 2 / Round 3**
buckets of real AgentRuns with each agent's decision and reasoning
(`components/command/incident-detail-client.tsx` — labels "Round {n}", agent
statuses `COMPLETE`/`REJECTED`/`FAILED`). The **AI Pipeline** page shows the
same runs streaming. Nothing on those screens is fabricated — each row is an
`AgentRun` row written by a real provider completion.

Running a multi-round demonstration:

```bash
# 1. start the AI build with hermetic TEST provider
cd /home/dharshan/selfhealing/frontend
SELF_HEALING_TEST_MODE=true npm run dev

# 2. activate a LOW fault + run with a scenario, e.g. case B:
curl -X POST http://localhost:3000/api/faults -b /tmp/bh-cookies.txt \
  -H 'Content-Type: application/json' -d '{"faultId":"LOW-01"}'
curl -X POST http://localhost:3000/api/security/run -b /tmp/bh-cookies.txt \
  -H 'Content-Type: application/json' -d '{"incidentId":"<id>","scenario":"accept-round-2"}'

# 3. open http://localhost:3000/ai/incidents/<id> and show Round 1 → Revision → Round 2 → Judge.
```

---

## 12. ROLLBACK DEMO

Rollback is driven **only** by a real validation-probe failure
(`lib/server/repair/validation.ts` + `patch-engine.ts`). A rolled-back incident
is stored with status `ROLLED_BACK`, its original file content is restored on
disk, and the fault is re-armed (searchable via the incident's code, e.g. too-
small/large content or retrieving the rejected write path).

Guided rollback scenarios:

**LOW — patch → validation failure → rollback**
```
1. Activate a LOW fault (e.g. LOW-01).
2. Run repair with a scenario whose probe is arranged to fail, or let the
   real probe fail (e.g. run the dependency missing → probe times out/fails).
3. Engine auto-applies the patch, probe fails → original file restored →
   incident ROLLED_BACK (Telegram "BuildHub ROLLED BACK").
```

**MEDIUM — patch → validation failure → rollback**
Same path for MEDIUM-01..03 (e.g. MEDIUM-01's `POST /api/posts → 201` probe).

**HIGH — approval → patch → validation failure → rollback**
Same path but approval-gated:
```
1. Activate HIGH-01; run repair → incident WAITING_APPROVAL; approve
   (POST /api/approvals/proceed {"approvalId":"APR-…","action":"proceed"}).
2. Engine applies the approved patch → real probe fails → ROLLED_BACK.
```

**Human approval NEVER disables rollback** — approval only gates *apply*; the
apply/validate/rollback leg is identical for LOW, MEDIUM and HIGH
(`continueApprovedRepair` routes into the same `applyCandidate`, and the engine
explicitly notes rollback is automatic on validation failure). This is asserted
by `verify-self-healing.mjs` (`ROLLED_BACK` cases) and `e2e_phase9_full.py`.

---

## 13. AI CHAT DEMO

**Location:** http://localhost:3000/ai → **Security** → **Self-Healing
Console** (bottom card), or the API `POST /api/ai/chat`
(`frontend/app/api/ai/chat/route.ts`, operator-gated).

Example questions to ask the assistant:

```
"What went wrong?"
"Which file caused the error?"
"What did Coder propose?"
"Why did Critic reject the first proposal?"
"What changed in round 2?"
"Why did Judge approve the repair?"
"What is the risk?"
"Was the repair validated?"
"Did the system rollback?"
"Summarize this incident."
```

**Honest behavior:** the chat is grounded — the system prompt instructs the
model: *"Do not claim any specific system state unless the operator provides
it."* The chat does **not** fabricate incident data into the prompt; to get
accurate incident-specific answers the operator references the live incident
(copy the ref/candidate from the incident screen). The authoritative,
persisted, real incident data lives in **Incidents → detail** (timeline,
transcript, risk, patch, validation, approval history) and in **Learning /
Memory**; the console chat is the operator's Q&A surface on top of that real
context. In TEST mode (`SELF_HEALING_TEST_MODE=true`) the provider is never
called and the API returns a deterministic TEST-mode reply (no fabrication).

---

## 14. TELEGRAM DEMO

Telegram pipeline implemented in `frontend/lib/server/telegram.ts` (outbound
only — there is **no inbound bot poller/webhook in the repo**; see §22).

**Workflow (real, implemented):**

```
HIGH incident (risk=HIGH) with a Judge-accepted candidate
  → createApproval() → approval APR-XXXXXX (PENDING, 5-min expiry)
  → incident status WAITING_APPROVAL
  → sendTelegram(type='HIGH_RISK_APPROVAL_REQUIRED') message:
      Incident: <ref> (<severity>)
      Approval: <approvalId>
      Candidate: <file>:<line>
      Fault: <expectedError>
      Reply: PROCEED <approvalId>
  → authorized PROCEED (POST /api/approvals/proceed, JSON
      {"approvalId":"APR-…","action":"proceed"} OR raw body "PROCEED APR-…")
  → approval state flips APPROVED (persisted), repair continues on the SAME
    apply/validate/rollback path
  → approval consumed (CONSUMED) after the terminal stage
```

Other messages: **INCIDENT** (new security/fault incidents), **REPAIR_APPLIED**
("Repair applied & validated"), **REPAIR_FAILED**, **ROLLBACK_COMPLETED**, and
a manual **test** (`POST /api/telegram/test`, operator).

**Command/format supported by the implementation (`/api/approvals/proceed`):**
```bash
# JSON
curl -X POST http://localhost:3000/api/approvals/proceed -b /tmp/bh-cookies.txt \
  -H 'Content-Type: application/json' -d '{"approvalId":"APR-123456","action":"proceed"}'
# or raw text "PROCEED APR-123456" / "REJECT APR-123456"
curl -X POST http://localhost:3000/api/approvals/proceed -b /tmp/bh-cookies.txt \
  -H 'Content-Type: text/plain'   --data-binary 'PROCEED APR-123456'
```

**5-minute deduplication (implemented):** Telegram outbound is deduped per
`(incidentId, alertType)` — max **one message per incident+type per 5-minute
window** (`isCooldownActive` in `telegram.ts`, persisted `TelegramNotification`
with `incidentId_type` and `lastSentAt`), and `telegramAlreadySent` prevents
duplicate INCIDENT messages in the security pipeline
(`frontend/lib/server/security.ts`). Consequence: the AUTH_BURST attack (dozens
of failing login requests) produces **one** incident and therefore one
notification — never one message per request. ASSERTED BY
`verify-security.mjs` / `verify-self-healing.mjs` (dedupe + cooldown tests).

Manual Telegram sanity test:
```bash
curl -X POST http://localhost:3000/api/telegram/test -b /tmp/bh-cookies.txt
```

---

## 15. LEARNING / MEMORY

**Where:** http://localhost:3000/ai → **Learning** (metrics) and **History**
(repair memory), wired to `GET /api/ai/learning`, `/api/ai/memory`,
`/api/ai/experiences`, `/api/ai/rl-dataset`, `/api/ai/evaluate`,
`/api/ai/visualization`.

**What the Learning surface shows (all real, persisted rows produced by actual
repairs — `RepairMemory` and `RepairExperience` are written by
`recordRepairMemory`/`recordRepairExperience` in
`frontend/lib/server/learning/memory.ts`, invoked from `repair/engine.ts`
`persistLearning` on every terminal repair):**

| Data | Meaning |
|------|---------|
| Repair experiences | one normalized `RepairExperience` per completed repair (state/action/reward/nextState) |
| Successful repairs | terminal stage `RESOLVED` |
| Failed repairs | terminal stage `AI_REPAIR_FAILED` (Coder/Critic reject or AI unavailable) |
| Rollbacks | terminal stage `ROLLED_BACK` (validation failure) |
| Human approvals | approvals with decision `APPROVED` (reward +5) |
| Human rejections | approvals with decision `REJECTED` (reward +2) |
| Agent rounds | number of Coder/Critic rounds used per attempt (`AgentRun.round`) |
| Risk | deterministic risk classification per attempt (LOW/MEDIUM/HIGH) |
| Validation outcomes | outcome of the real HTTP probes (all passed → RESOLVED) |

**Scope honesty:** Phase 10 provides the **learning/RL-ready foundation** —
normalized experiences, an inspectable reward policy, LR dataset + evaluation
harness — but the repository does **not** run/train an RL agent on this data.
No claim of "model training" is made in the docs and none should be made in a
demo. Reward policy defaults (env-tunable): success +10, validation failure
−15, rollback −20, security regression −40, rejection −8, human approval +5,
human rejection +2.

---

## 16. RL DATA — experience generation, dataset export, evaluation

There is no standalone CLI for RL data; the harness scripts drive the *real*
repair loop, which persists the learning rows; the exports are read-only JSON
APIs.

**Verify the real self-healing loop (fault → incident → engine):**
```bash
cd /home/dharshan/selfhealing/frontend
# hermetic deterministic cycles — restart the dev server freshly first:
node scripts/verify-self-healing.mjs        # 103 checks; writes real rows
python3 scripts/e2e_real_self_healing.py    # 69 checks; stdlib-only HTTP E2E
```
(Require the dev server on `localhost:3000` and the env
`SELF_HEALING_TEST_MODE=true AI_PROVIDER=test FAULT_INJECTION_ENABLED=true AUTH_GUARD_ENABLED=false`.
For a deterministic run start the dev server freshly; the suite restarts it again
before its harness-only behavioural block. Browser UI checks use
`python3 scripts/e2e_phase9_full.py` (Playwright).)

**Dataset export (JSON reads):**
```bash
curl -s http://localhost:3000/api/ai/learning      # metrics + reward policy
curl -s http://localhost:3000/api/ai/experiences   # normalized experience timeline
curl -s http://localhost:3000/api/ai/rl-dataset    # RL rows (state, action, reward, nextState)
curl -s http://localhost:3000/api/ai/evaluate      # evaluation harness (location/patch/validation/rollback)
curl -s http://localhost:3000/api/ai/visualization # 3D dashboard aggregates (neurons/edges, trends)
curl -s http://localhost:3000/api/ai/memory        # repair memory records
```
All `GET /api/ai/*` endpoints are session-gated (authenticated operator).

---

## 17. COMPLETE TEST COMMANDS

Run from `frontend/` unless noted. `verify-*` and `e2e_phase7_full.py` expect a
**clean baseline** (see §18); the current working DB contains prior demo
artifacts, so those two suites must be run after a reset to report their full
counts.

### Static checks (no server required)
```bash
cd /home/dharshan/selfhealing/frontend
npm run lint
npx tsc --noEmit
npm run build
```
No-AI build equivalent:
```bash
cd /home/dharshan/selfhealing/buildhub-no-ai
npm run lint && npx tsc --noEmit && npm run build
```

### API verifiers (server on :3000, DB seeded)
```bash
node scripts/verify-posts-projects.mjs        # posts/projects/likes/comments: 88 passed, 0 failed (latest)
node scripts/verify-observability.mjs         # CLEAN baseline (after reset): 28 passed, 0 failed
node scripts/verify-security.mjs              # CLEAN baseline (after reset): 32 passed, 0 failed
node scripts/verify-self-healing.mjs          # real fault→incident→engine: 103 passed, 0 failed
python3 scripts/e2e_real_self_healing.py      # 69 passed, 0 failed (stdlib-only HTTP E2E, --quick)
```

### Browser E2E suites (Playwright; server on :3000)
```bash
python3 scripts/e2e_phase6_full.py            # Phase 6 full flow: 44 passed, 0 failed
python3 scripts/e2e_phase7_full.py            # Command Center on CLEAN DB: 25 passed, 0 failed
python3 scripts/e2e_phase8_full.py            # Security Command Center (real Groq): see e2e_phase8_full.py
python3 scripts/e2e_phase9_full.py            # Self-Healing browser: 64 passed, 0 failed
python3 scripts/e2e_real_self_healing.py      # Real self-healing HTTP E2E: 69 passed, 0 failed
python3 scripts/e2e_phase10_learning.py       # Learning loop: 50 passed, 0 failed
```
> Test-mode / provider note: suites that drive the repair engine (phase
> 9/10) use the defined hermetic scenarios when `AI_PROVIDER=test` +
> `SELF_HEALING_TEST_MODE=true`, otherwise they call the real configured
> provider.

### No-AI build tests
```bash
cd /home/dharshan/selfhealing/buildhub-no-ai
node scripts/verify-posts-projects.mjs
python3 scripts/e2e_no_ai_demo.py [--base http://localhost:3001]   # 28 passed, 0 failed
npm run demo:reset                                                 # deactivate LOW-01 + clear demo log trail
```

---

## 18. CLEAN BASELINE

```bash
COOKIES=/tmp/bh-cookies.txt

# 1) Deactivate every fault (guards removed; repaired files stay as the engine wrote them)
curl -X POST http://localhost:3000/api/faults -b $COOKIES \
  -H 'Content-Type: application/json' -d '{"action":"deactivate-all"}'

# 1b) No-AI equivalent
curl -X POST http://localhost:3001/api/demo/fault -b $COOKIES \
  -H 'Content-Type: application/json' -d '{"action":"reset"}'

# 2) Verify zero active faults
curl -s http://localhost:3000/api/faults | python3 -m json.tool   # look for "active": 0

# 3) Verify no pending demo attack block
curl -s http://localhost:3000/api/demo/attack | python3 -m json.tool   # "blocked": false
curl -s http://localhost:3001/api/demo/attack | python3 -m json.tool   # "phase": "normal"
# (A fresh server start also clears the in-memory AI guard and the No-AI latch;
#  the AI operator reset POST /api/demo/attack {"action":"reset"} clears guard
#  + AUTH_BURST artifacts on a running server.)

# 4) Verify clean health
curl -s http://localhost:3000/api/health | python3 -m json.tool   # "status":"ok"
curl -s http://localhost:3001/api/health | python3 -m json.tool   # "status":"ok"
```

### WARNING — DESTRUCTIVE (only if you truly want an empty runtime DB)

```bash
# Deletes approvals, telegram notifications, incident events, ALL log events,
# agent runs, security findings and incidents from DATABASE_URL. Use ONLY to
# restore the pristine baseline before verify-observability / verify-security /
# e2e_phase7_full.py.
cd /home/dharshan/selfhealing/frontend
node scripts/reset-observability.mjs
```
It does **not** touch users/posts/projects and does **not** re-seed incidents.
After it, run `node scripts/verify-observability.mjs`.

---

## 19. STOP EVERYTHING

Never use `pkill node` (other Node processes belong to unrelated apps). Identify
the precise PID by port, then kill only it:

```bash
# AI BuildHub (:3000)
PID=$(ss -ltnp | grep ':3000' | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$PID" ] && kill "$PID"

# No-AI BuildHub (:3001)
PID=$(ss -ltnp | grep ':3001' | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$PID" ] && kill "$PID"

# Confirm gone
ss -ltnp | grep -E ':300[01]' || echo "both stopped"
```

Friendly alternative (shows the matching command line first):

```bash
pgrep -af "next"        # review the list, then kill only the PID of the :3000/:3001 server
```

Stop PostgreSQL if required (Docker):

```bash
docker stop buildhub-pg
```

---

## 20. 5-MINUTE HACKATHON DEMO

```
1. Start AI server.      docker start buildhub-pg (if down)
                          cd frontend && npm run dev          # :3000
2. Start No-AI server.    cd buildhub-no-ai && npm run demo   # :3001
3. Open both live pages.  http://localhost:3000/ai  (AI story)
                          http://localhost:3001/demo/attack  (comparison)
4. Attack :3001.          cd buildhub-no-ai && python3 scripts/run-port3001.py --confirm-local
5. Show degradation / unavailable (503 health, latched "unavailable"; no AI).
6. Restart :3001 (Ctrl-C, npm run demo again → clean).
7. Same attack on :3000.  cd frontend && python3 scripts/run-port3000.py --confirm-local
8. Show detection.        /api/demo/attack shows phase detected + real AUTH_FAILED rows.
9. Show mitigation.       429 block (IP_BLOCKED), incident INC-AUTH_BURST, service stays up.
10. Show healthy service. health ok; recovered phase.
11. Trigger LOW fault.    login arjun@buildhub.dev / buildhub-demo1 → http://localhost:3000/feed
                          curl -X POST localhost:3000/api/faults {"faultId":"LOW-01"} → compose a post → Publish → 500
12. Open /ai.             http://localhost:3000/ai → Incidents → the LOW incident.
13. Show Coder.           round 1 candidate.
14. Show Critic.          review/accept/revise.
15. Show Judge.           decision + LOW risk.
16. Show patch.           applied (no approval needed for LOW).
17. Show validation.      real probe "Post creation succeeds".
18. Show RESOLVED.        incident terminal stage.
19. Open Learning/Memory. http://localhost:3000/ai/learning.
20. Show recorded experience (normalized RepairExperience for the repair).
```

---

## 21. EXACT FILE/LINE REFERENCE TABLE

From `frontend/lib/server/fault-injection.ts` (line = catalog target line).

| Fault | Risk | File | Line | Function | Trigger | Error |
|-------|------|------|------|----------|---------|-------|
| LOW-01 | LOW | `app/api/posts/route.ts` | 45 | `POST` handler | `POST /api/posts` | `TypeError: Cannot read property 'id' of undefined` (500) |
| LOW-02 | LOW | `app/api/posts/[id]/route.ts` | 62 | `GET` handler | `GET /api/posts/[id]` | frontend: `post` undefined (`poost` typo) |
| LOW-03 | LOW | `lib/server/validation.ts` | 28 | `postContentSchema` | `POST /api/posts` | 400: content must be ≥1001 chars |
| MEDIUM-01 | MEDIUM | `app/api/posts/route.ts` | 38 | `POST` handler | `POST /api/posts` | 500: `Injected DB failure` |
| MEDIUM-02 | MEDIUM | `app/api/posts/route.ts` | 85 | `GET` handler | `GET /api/posts` | 500: `Injected DB query failure` |
| MEDIUM-03 | MEDIUM | `app/api/projects/[id]/route.ts` | 72 | `PATCH` handler | Owner `PATCH /api/projects/[id]` | 403 (owner denied) |
| HIGH-01 | HIGH | `app/api/auth/login/route.ts` | 55 | `POST` handler | `POST /api/auth/login` wrong password | 200 (bypass) |
| HIGH-02 | HIGH | `app/api/projects/[id]/route.ts` | 45 | `DELETE` handler | Non-owner `DELETE /api/projects/[id]` | 200 (bypass) |
| HIGH-03 | HIGH | `lib/server/db.ts` | 11 | `createPrismaClient()` | any DB-backed endpoint | 503/500 DB connection failed |

| Fault | Expected Fix | Validation | Rollback |
|-------|--------------|------------|----------|
| LOW-01 | restore `session.user.id` | `POST /api/posts` → 201 | restore original line |
| LOW-02 | fix `post` key name | `GET /api/posts/[id]` → `{ post: {...} }` | restore property name |
| LOW-03 | restore `.min(1, …)` | short post → 201 | restore min value |
| MEDIUM-01 | remove throw, restore `prisma.post.create` | `POST /api/posts` → 201 | restore original code |
| MEDIUM-02 | remove throw, restore `prisma.post.findMany` | `GET /api/posts` → 200 | restore original code |
| MEDIUM-03 | restore `!==` ownership check | owner `PATCH` → 200 | restore original condition |
| HIGH-01 | restore password check | wrong password → 401 | automatic on validation failure |
| HIGH-02 | restore ownership check | non-owner DELETE → 403 | automatic on validation failure |
| HIGH-03 | restore `DATABASE_URL` | `GET /api/posts` → 200 | automatic on validation failure |

Approval matrix (from the plan, matches the engine): LOW/MEDIUM = no approval,
auto-apply; HIGH = approval required, apply only after PROCEED; every risk level
validates and rolls back on failure.

---

## 22. IMPORTANT — SOURCE OF TRUTH

Authoritative: **actual source code**, `PHASE9_FAULT_TEST_PLAN.md`,
`AI_CODEBASE_MAP.md`, `PLAN.md`. Where they disagree the implementation wins;
discrepancies found while writing this document:

1. **`/demo/attack` exists only on port 3001.** The prompt-style URL
   `http://localhost:3000/demo/attack` returns 404 — the AI build has only the
   API `/api/demo/attack`. The comparison UI is served by the No-AI build
   (`http://localhost:3001/demo/attack`) and live-reads the AI build through
   its bridge. Both panels show real data; the page is the correct demo page.
   (§4, §5.)
2. **Telegram is outbound only.** There is no inbound bot poller/webhook in the
   repository (`app/api/telegram/` contains only `test`). The
   `Reply: PROCEED <id>` instruction in the outbound message is the command
   format that `POST /api/approvals/proceed` accepts (raw body
   `"PROCEED APR-…"` or JSON). The outbound notification, dedupe, and the
   proceed mechanism are all implemented and validated. (§14.)
3. **Fault "code" is a runtime guard, not a literal on-disk edit.** The
   catalog lists `originalCode`/`faultCode`/line numbers; at activation the
   registry pads the values but the documented failure is produced by the
   `withFaultInjection(...)` guards in the handlers (`fault-injection-handlers.ts`)
   while armed. The repair engine's patch path is real: it checkpoints the file,
   writes the repaired content, and uses real HTTP validation probes. (§6–8.)
4. **`verify-observability.mjs` / `verify-security.mjs` / `e2e_phase7_full.py`
   require a wiped runtime DB.** The current dev DB holds prior demo artifacts
   (e.g. `INC-00001`, `INC-00002` AUTH_BURST), so these suites only report
   their full counts after `node scripts/reset-observability.mjs`. Not a
   regression — a clean-state precondition. (§17, §18, §23.)
5. **RL training is not executed.** Phase 10 implements the data substrate
   (experiences, policy, dataset, evaluation) and the E2E *harness*, but no RL
   training loop runs in the repo. (§15, §16.)

---

## 23. FINAL STATUS

```
PHASE 6 — COMPLETE
PHASE 7 — COMPLETE
PHASE 8 — COMPLETE
PHASE 9 — COMPLETE
PHASE 10 — COMPLETE
```

Latest verification counts (from `PLAN.md` change log 2026-08-30, plus the
attack-demo runs recorded there; all numbers are the counts of checks the
suites printed when last run green):

| Suite | Count |
|-------|-------|
| `verify-posts-projects.mjs` | 88 passed, 0 failed |
| `verify-observability.mjs` (clean baseline) | 28 passed, 0 failed |
| `verify-security.mjs` (clean baseline) | 32 passed, 0 failed |
| `verify-self-healing.mjs` | 103 passed, 0 failed |
| `e2e_real_self_healing.py` | 69 passed, 0 failed |
| `e2e_phase6_full.py` | 44 passed, 0 failed |
| `e2e_phase7_full.py` (clean DB) | 25 passed, 0 failed |
| `e2e_phase9_full.py` (browser) | 64 passed, 0 failed |
| `e2e_phase10_learning.py` | 50 passed, 0 failed |
| `e2e_no_ai_demo.py` (No-AI) | 28 passed, 0 failed |
| Attack demo — No-AI (3001) | observed: 61×401 → 323×503, health unavailable, exit 0 |
| Attack demo — AI (3000) | observed: 12×401 → 148×429, 0×5xx, recovery ≈61 s, exit 0 |
| Static (both builds) | `npm run lint` 0 errors; `npx tsc --noEmit` exit 0; `npm run build` green |

### Capability classification

| Status | Meaning / items |
|--------|-----------------|
| **IMPLEMENTED** | All 9 faults, runtime guards, incident ingestion, Phase 9 iterative engine (Coder/Critic/Judge, risk, approval, real HTTP validation, rollback), Phase 10 learning substrate (memory, experiences, RL dataset, evaluation, visualization), Telegram outbound + dedupe, AI chat, fault API + `/api/faults/random`, attack-demo (guard + telemetry + comparison page + scripts), health/observability, PDF reports, No-AI build with LOW-01 |
| **VERIFIED** | The counts above (Phase 6–10 suites), plus the attack-demo runs against the live servers; phase 8/9/10 browser E2E with real Groq/Telegram where configured |
| **DEMO-ONLY** | `/api/demo/*` (fault control, attack telemetry, logs) on both builds; `run-port3000/3001.py` attack tooling; attacker must be aware: runs against `127.0.0.1:3000/3001` only |
| **FUTURE** | RL training/rollout on the learning substrate (data exists, no trainer), a Telegram inbound bot/webhook, the full self-healing supervisor controlling BuildHub (BuildHub is the target app) |

---

## 24. IMPORTANT — AUTHORITATIVE BOUNDARY

This document was written **without modifying application code, migrations,
`.env`, or the database**, and without starting servers (inspection only; both
servers were verified already stopped/running as observed at write time).
For any discrepancy, the source of truth is:
actual source code → `PHASE9_FAULT_TEST_PLAN.md` → `AI_CODEBASE_MAP.md` →
`PLAN.md` → this document.