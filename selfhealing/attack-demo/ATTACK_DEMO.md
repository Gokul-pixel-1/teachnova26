# attack-demo — ATTACK_DEMO.md

BuildHub final "same attack on both builds" demonstration — the complete,
verified operating document for `attack-demo/run_attack.py`.

Every value below was read from the actual repository source (not invented).
The "verified run" numbers under each section are from the live runs recorded
on 2026-08-30 with `attack-demo/run_attack.py`.

---

## Summary of the demonstration (BEFORE / AFTER)

The identical controlled forged-sign-in burst is fired at both builds. Only
the port changes. The WITHOUT-AI build has an intentionally injected LOCAL
DEMO limitation — no auto-mitigation — so under the bounded attack it degrades
and the service goes down. The WITH-AI build runs its real security pipeline:
it detects the burst, creates a real incident + agent runs, temporarily blocks
the source, contains the attack, and stays available.

```
WITHOUT AI (:3001)   NORMAL → ATTACK → DEGRADED → SERVICE UNAVAILABLE
WITH AI    (:3000)   NORMAL → ATTACK → DETECTED → MITIGATING → HEALTHY
```

Verified live run:

| | WITHOUT AI (:3001) | WITH AI (:3000) |
|---|---|---|
| Requests sent | 70 | 20 |
| HTTP 401 | 60 | 10 |
| HTTP 429 | 0 | 10 |
| HTTP 5xx / conn errors | 10 (503) / 0 | 0 / 0 |
| Peak latency | 140 ms | 56 ms |
| Health at stop | `unavailable` (HTTP 503) | `degraded` (HTTP 200, service available) |
| Health shortly after | still `unavailable` (latched) | `ok` (HTTP 200, ~35 s later) |
| Stop reason | HTTP 503 from login — service down | AI mitigation (429) — ATTACK CONTAINED |
| App SELF-HEALED | No — operator must recover | Yes — automatic (block expires, health ok) |

---

## 1. How to start :3000 (WITH-AI BuildHub)

```bash
docker start buildhub-pg                                    # PostgreSQL container
cd /home/dharshan/selfhealing/frontend
npm run dev                                                 # http://127.0.0.1:3000
```

`frontend/.env` must include (see `.env.example`): the `DATABASE_URL`,
`FAULT_INJECTION_ENABLED=true` and `AUTH_GUARD_ENABLED=true`, and for real AI
analysis a Groq provider (`AI_PROVIDER=groq`, `AI_MODEL`, `GROQ_API_KEY`) plus
optional `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`.

Production-style (same behavior, different process):
```bash
cd /home/dharshan/selfhealing/frontend && npm run build && npm run start -- --port 3000
```

Guard defaults (env-tunable, `frontend/lib/server/auth-guard.ts` lines 33–35):
`AUTH_GUARD_FAIL_THRESHOLD=10`, `AUTH_GUARD_WINDOW_MS=60000`,
`AUTH_GUARD_BLOCK_MS=120000`.

## 2. How to start :3001 (WITHOUT-AI BuildHub)

```bash
cd /home/dharshan/selfhealing/buildhub-no-ai
npm run build   # once (or after code changes)
npm run demo    # next start -p 3001 (production, watcher-free)
```

(`"demo": "next start -p 3001"` in `buildhub-no-ai/package.json`;
`"demo:dev": "next dev --webpack -p 3001"` keeps hot-reload for development
when the OS file-watch budget allows. Production serving is the reliable
hackathon path: dev watchers — Turbopack AND webpack — exhaust the host's
`fs.inotify` budget in this environment (`OS file watch limit reached` /
`ENOSPC`), while `next start` needs no watchers. `next.config.ts` also sets
`turbopack.root` + `outputFileTracingRoot` to the project directory so Next.js
no longer walks up to `/home/dharshan/package-lock.json`.)
Uses the isolated `buildhub_no_ai` database in the same `buildhub-pg`
container. Production-style: `npm run build && npm run start -- --port 3001`.

Availability defaults (`buildhub-no-ai/lib/server/demo-availability.ts`
lines 36–38): `DEMO_AUTH_DEGRADE_THRESHOLD=40`,
`DEMO_AUTH_FAIL_THRESHOLD=60`, `DEMO_AUTH_WINDOW_MS=60000`.

## 3. How to run the attack

```bash
# 1) Safety contract first (never touches a server)
python3 attack-demo/test_attack_safety.py

# 2) WITHOUT-AI first — it must fail (then recover, step 11)
python3 attack-demo/run_attack.py --port 3001 --confirm-local

# 2b) Named scenarios (same caps, same loopback policy, same auto-stop)
python3 attack-demo/run_attack.py --port 3001 --scenario resource-stress --confirm-local
python3 attack-demo/run_attack.py --port 3001 --scenario service-failure --confirm-local
# optional structured telemetry for any scenario:
python3 attack-demo/run_attack.py --port 3001 --scenario service-failure --confirm-local \
  --telemetry-out /tmp/telemetry-failure-3001.json

# 3) Recover the WITHOUT-AI server (operator reset — step 11)

# 4) WITH-AI second — it must detect + contain
python3 attack-demo/run_attack.py --port 3000 --confirm-local
```

Optional, still hard-capped: `--max-requests`, `--max-duration`, `--concurrency`
(larger values are clamped down to the hard limits).

To watch live: open `http://127.0.0.1:3001/demo/attack` (No-AI build) — the
comparison page auto-refreshes every 2.5s and renders both panels from real
telemetry on the bridge.

## 4. Exact attack endpoint

```
POST http://127.0.0.1:<port>/api/auth/login
Content-Type: application/json
X-Request-Id: cd34a7-<16 hex digits>

{"identifier": "burst<5 digits>@local.invalid", "password": "7aX-contr0l-local"}
```

- Discovered from the real source: `buildhub-no-ai/app/api/auth/login/route.ts`
  and `frontend/app/api/auth/login/route.ts` (both parse `signInSchema`
  `{identifier, password}`).
- The identifier is a fully forged address (`burst…@local.invalid`) that no
  seeded account matches; the password is the fixed demo constant used by the
  repository's existing scripts.
- The request pattern is byte-identical for both ports — same endpoint, same
  body shape, same username generator, same limits, same concurrency, same
  duration. Only the port changes (this is the fairness guarantee).

## 5. Exact No-AI fault location (LOCAL DEMO ONLY)

The intentional, clearly-labelled, LOCAL DEMO limitation is the **safe
degradation latch** in:

```
File:     buildhub-no-ai/lib/server/demo-availability.ts
Function: availabilityInfo()              (lines 93–139)
          availabilityPhase()             (lines 141–143)
          registerAuthFailure()           (lines 151–176)
Documented at the top of the file, lines 3–24
("LOCAL DEMO LIMITATION (intentional and documented)").
```

Wired into:
- `buildhub-no-ai/app/api/auth/login/route.ts` — lines 25–27 return HTTP 503
  when the latch is `unavailable`; lines 53–65 log `AUTH_FAILED` and call
  `registerAuthFailure` on every bad sign-in.
- `buildhub-no-ai/app/api/health/route.ts` — lines 29–33 read the latch;
  lines 84–97 return HTTP 503 when unavailable.

It is **not** a kill/restart/firewall mechanism. It is an application-level,
state-machine failure: the app counts its own failed sign-ins (real persisted
`AUTH_FAILED` `LogEvent` rows) and, past the safe threshold, refuses to serve —
exactly like an app that exhausted its backend with no supervisor to recover
it. State is derived from shared DB rows so every route handler observes the
same truth (Next.js runs routes in isolated worker contexts).

## 6. Exact error

Normal bad sign-in (during the attack, before the latch):
```
HTTP 401
{"error":"Unable to sign in. Please check your credentials and try again."}
```
(`GENERIC_ERROR`, login route line 16.)

Once the latch trips, every bad sign-in and every health probe:
```
HTTP 503
{"error":"Service temporarily unavailable (without-AI build: safe degradation threshold reached, no auto-mitigation)."}
```
(`UNAVAILABLE_MESSAGE`, login route line 17–18.)
```
GET /api/health -> HTTP 503
{"status":"unavailable", ..., "components":[{"id":"app","status":"unavailable",...},
{"id":"availability","status":"unavailable","detail":"Latched UNAVAILABLE — failed sign-in burst exceeded the safe threshold"}, ...]}
```
(health route lines 36–97.) The `ATTACK_UNAVAILABLE` log row is written once at
latch time (`registerAuthFailure`, lines 154–163).

## 7. Exact trigger

A burst of deliberately invalid sign-ins: **≥ 40** failed attempts in the last
**60 s** window flips the phase to `degraded`; **≥ 60** flips it to
`unavailable`. The news feed of a single source is irrelevant — the latch is
global for this loopback demo build.

The client generates at most 300 such attempts, ≤ 5 concurrent, for ≤ 60 s.
Verified: the latch flipped on request #60 and request #61 onward returned 503.

## 8. Expected No-AI failure

```
NORMAL      (health ok)
  → ATTACK  (HTTP 401s, health still ok)
  → DEGRADED (failCount ≥ 40 → health.status = degraded, HTTP 200)
  → SERVICE UNAVAILABLE (failCount ≥ 60 → login 503, health 503, latched)
```

The service **stays** unavailable until an operator acts (see §11). The attack
client stops the moment it observes the 503 (health/unavailable) and DOES NOT
continue sending.

Verified run (:3001): pre-flight `ok` → 60×401 → degraded from request #41 →
request #60 latched → 10×503 → stopped at 70 requests / 1.0 s, final
`/api/health` = `unavailable` (HTTP 503), exit 0.

## 9. Exact AI detection behavior (WITH-AI)

In `frontend/lib/server/auth-guard.ts`, `registerAuthFailure(ip, requestId)`
(lines 172–205):
- counts real failed sign-ins per source in a sliding window
  (threshold **10** within **60 s**);
- on crossing the threshold logs the real `AUTH_BURST` event, sets a temporary
  in-memory block, and — detached — `escalateBurst()` (lines 125–165) persists a
  real `SecurityFinding` (`ruleId: 'AUTH_BURST'`, severity HIGH) and promotes it
  to a real **Incident**, then executes the REAL running pipeline
  (`runAgentPipeline`) of FIXER/CRITIC/JUDGE agent runs (real Groq calls,
  persisted `AgentRun` rows).

The `/api/demo/attack` telemetry phase is a pure function of real state
(`attackOverview()`, lines 233–282, and the route at
`frontend/app/api/demo/attack/route.ts` lines 110–120):
`normal → attack → detected (AUTH_BURST row) → mitigating (block) → recovered`.

Verified run (:3000): 10×401 crossed the threshold → block armed → 10×429 for
the remaining in-flight requests → stopped at 20 requests / 0.1 s. Real
incident `INC-00002` (HIGH, riskScore 24, status `AWAITING_REVIEW`) with
`FIXER`/`CRITIC`/`JUDGE` agent runs all `COMPLETE`.

## 10. Exact mitigation (WITH-AI)

- `isSourceBlocked(sourceIp)` at `frontend/app/api/auth/login/route.ts`
  lines 28–40 rejects the blocked source with
  ```
  HTTP 429 {"error":"Too many failed sign-in attempts. This source is temporarily blocked."}
  ```
  and logs one real `IP_BLOCKED` row per rejection.
- The block is **temporary** — 120 s (`AUTH_GUARD_BLOCK_MS`) — in-memory plus
  DB-derived telemetry; no OS firewall, no network configuration, no process
  instrumentation.
- The application never becomes unavailable: 0×5xx during the attack. At stop
  the health probe read `degraded` (HTTP 200 — the Authentication component
  was still inside its own 60 s live window), and the Authentication health
  component normalized ~35 s after the burst ended.

Verified: `ATTACK CONTAINED`, 0×5xx, service never `unavailable`; ~35 s after
the burst a fresh `GET /api/health` returned `ok` (HTTP 200) with
`systemHealth: 100` and all five components `healthy` (frontend, api,
database, authentication, monitoring).

## 11. Exact recovery

**WITH-AI — automatic (no operator action):**
- source block expires after 120 s,
- telemetry returns to `recovered`, health stays `ok`.
- Optional operator reset for the next deterministic run
  (signed-in operator only, not exposed to the attack tool):
  ```bash
  curl -b /tmp/ai-cookies.txt -X POST http://127.0.0.1:3000/api/demo/attack \
    -H 'Content-Type: application/json' -d '{"action":"reset"}'
  ```
  clears the guard + the demo's own AUTH_FAILED/AUTH_BURST/IP_BLOCKED rows and
  the AUTH_BURST incident/finding.

**WITHOUT-AI — operator-only (by design there is no self-healing):**
1. Any signed-in session (login BEFORE the attack, because login itself 503s
   while latched) can reset:
   ```bash
   curl -b /tmp/noai-cookies.txt -X POST http://127.0.0.1:3001/api/demo/attack \
     -H 'Content-Type: application/json' -d '{"action":"reset"}'
   ```
   (`buildhub-no-ai/app/api/demo/attack/route.ts` POST lines 129–155 — clears
   the latch + the demo's attack rows.) Verified: after the reset the service
   returns to `/api/health` 200, telemetry phase `normal`, failCount 0 —
   WITHOUT restarting the process.
2. Or restart the process. Every boot re-arms a clean state (`ensureBootClean`,
   `demo-availability.ts` lines 52–68 deletes the previous 24 h attack rows).

The attack client NEVER performs recovery or touches the server process.

## 12. Safety limits

| Limit | Value | Enforced where |
|-------|-------|----------------|
| Max requests | **300** (`MAX_REQUESTS`) | `run_attack.py`, fail-closed |
| Max duration | **60 s** (`MAX_DURATION`) | `run_attack.py` |
| Max in-flight | **5** (`MAX_CONCURRENCY`) | `run_attack.py` |
| Target | `127.0.0.1:3000` **or** `127.0.0.1:3001` only | port whitelist + hard-coded host |
| Operator confirmation | `--confirm-local` REQUIRED | aborts before any request |
| Stop conditions | health UNAVAILABLE · HTTP 429 (contained) · request limit · timeout · Ctrl+C | check after each response + health watcher |

The client also:
- imports stdlib only — no `subprocess`, no `os.kill`, no shell, no raw
  sockets, no IP spoofing, no destructive payloads;
- NEVER kills, restarts, or manipulates any server process and never modifies
  OS/network configuration;
- reports only real HTTP observations (per-request timestamp · number · status
  · latency · health) and an honest `ATTACK RESULT` block:
  Target, Requests, 401, 403, 429, 5xx, Peak latency, Final health, Stop
  reason.

Verified by `python3 attack-demo/test_attack_safety.py` — all checks passed
(source integrity, stdlib-only imports, absence of all
process/OS/network primitives, hard limits incl. bounded per-scenario pacing,
loopback-only target policy with `--host` allowlist + `--scenario` whitelist,
fail-closed CLI behaviour, structured telemetry with no secrets).

## Demo UI (real telemetry, no fake AI progress)

`http://127.0.0.1:3001/demo/attack` (No-AI build) renders both panels every
2.5 s from the real backend telemetry
(`buildhub-no-ai/app/(app)/demo/attack/page.tsx`):

- **WITHOUT-AI panel** step trail (from `noaiSteps`, lines 114–127):
  `NORMAL → ATTACK → DEGRADED → SERVICE DOWN`, driven by the real phase.
- **WITH-AI panel** step trail (from `aiSteps`, lines 129–154):
  `NORMAL → ATTACK → DETECTED → AI ANALYSIS → MITIGATION → HEALTHY`, driven by
  the real phase, `timestamps.detectedAt`, `state.blockedCount`, real agent-run
  rows, and real `incident` data.

Nothing is simulated: `reached`/`current` states are pure functions of the real
`/api/demo/attack` responses (guard state, real log rows, real incidents, real
agent runs).