# attack-demo — BuildHub localhost attack demonstration client

An **independent** attack client for the final BuildHub BEFORE/AFTER
demonstration. It lives OUTSIDE both applications (`attack-demo/` at the repo
root), imports nothing from `frontend/` or `buildhub-no-ai/`, needs only the
Python 3 standard library, and sends HTTP requests **only** to:

```
127.0.0.1:3000   WITH-AI BuildHub    (must detect + mitigate on its own)
127.0.0.1:3001   WITHOUT-AI BuildHub (must fail on its own)
```

The SAME forged-sign-in burst is fired at both ports. Only the port changes.

```
WITHOUT AI :3001   NORMAL → ATTACK → DEGRADED → SERVICE UNAVAILABLE
WITH AI    :3000   NORMAL → ATTACK → DETECTED → MITIGATING → HEALTHY
```

## Files

| File | Purpose |
|------|---------|
| `run_attack.py` | The single attack client (stdio-only, fail-closed) |
| `run-overload.py` | The hard-overload comparison client (rate-bounded, see below) |
| `test_attack_safety.py` | Safety contract tests for both clients (no network) |
| `README.md` | This quick runbook |
| `ATTACK_DEMO.md` | The full 12-point technical demo document |
| `HARD_OVERLOAD_DEMO.md` | The hard-overload BEFORE/AFTER demo document with real measured numbers |

## Prerequisites

- Python 3 (any stock build; only `urllib`/`threading` etc.)
- PostgreSQL container up: `docker start buildhub-pg`
- Both BuildHub servers running (see `ATTACK_DEMO.md` §1–§2)

## Quick run

```bash
# 1) Safety first (never touches a server)
python3 attack-demo/test_attack_safety.py

# 2) WITHOUT-AI — the service must fail and stay down
#    (recover afterwards with an operator reset/restart — see ATTACK_DEMO.md §11)
python3 attack-demo/run_attack.py --port 3001 --confirm-local

# 3) WITH-AI — detected, contained, service stays available
python3 attack-demo/run_attack.py --port 3000 --confirm-local
```

## Named scenarios (`run_attack.py --scenario`)

All three scenarios share the same hard caps (≤300 requests, ≤60 s, ≤5
in-flight), the same loopback-only target policy, and the same auto-stop
conditions. The default (`request-flood`) is byte-identical to the original
command above.

```bash
# REQUEST_FLOOD (default) — bounded forged-login burst on POST /api/auth/login
python3 attack-demo/run_attack.py --port 3001 --confirm-local

# RESOURCE_STRESS — controlled multi-endpoint load: forged logins (1:4)
# mixed with read-only GETs on /api/posts, /api/projects, /api/health
python3 attack-demo/run_attack.py --port 3001 --scenario resource-stress --confirm-local

# SERVICE_FAILURE ("crash demo" without any OS crash) — gentle paced probe
# (~15/s) observing the controlled app-level failure:
# NORMAL → DEGRADED → UNAVAILABLE (:3001) or → MITIGATING (:3000)
python3 attack-demo/run_attack.py --port 3001 --scenario service-failure --confirm-local
```

Measured 2026-09-14 against production builds (No-AI :3001):

| scenario | requests | mix | elapsed | result |
|---|---|---|---|---|
| request-flood | 70 | 70 login | 0.6 s | 60×401 → latch → 10×503 → `unavailable` |
| resource-stress | 240 | 60 login + 180 GET | 1.4 s | 60×401 → latch → 503s → `unavailable` |
| service-failure | 180 | 60 login + 120 GET (paced) | 11.9 s | 60×401 → latch → 503s → `unavailable` |

AI :3000 request-flood: 20 requests (10×401 → guard → 10×429), `ATTACK
CONTAINED`, 0×5xx, real incident + REAL FIXER/CRITIC/JUDGE runs, exactly 2
Telegram lifecycle messages (INCIDENT + ESCALATION).

Add `--telemetry-out PATH` to any scenario to write structured JSON telemetry
(scenario, target, start, duration, per-status/per-kind counts, 4xx/5xx,
timeouts, latency avg/p95/peak, error rate, final health, verdict). The
telemetry contains statuses + latencies only — no secrets, tokens, or cookies.
A single-line `TELEMETRY_JSON {...}` copy is also printed to stdout.

## Hard-overload comparison (`run-overload.py`)

The overload demo fires the SAME multi-endpoint workload at both builds: a
rate-bounded forged sign-in stream (default 12/s) plus sustained probing of
`/api/posts`, `/api/projects` and `/api/health`, capped at 20 s. It exists
for the BEFORE/AFTER demonstration and the live request/rps/latency/2xx/
4xx/5xx counters it prints are its own real HTTP observations.

```bash
# WITHOUT-AI first — it must degrade and latch UNAVAILABLE (503), then recover via operator reset
python3 attack-demo/run-overload.py --port 3001 --confirm-local

# Operator recovery (signed-in reset) — see HARD_OVERLOAD_DEMO.md §7
curl -b <noai-session-cookie> -X POST http://127.0.0.1:3001/api/demo/attack \
  -H 'Content-Type: application/json' -d '{"action":"reset"}'

# WITH-AI — same workload, contained with 429s, service never goes down
python3 attack-demo/run-overload.py --port 3000 --confirm-local
```

See `HARD_OVERLOAD_DEMO.md` for the exact commands, safety limits, expected
vs observed timelines, and the measured before/after results.

## Hard safety limits (enforced in code, fail-closed)

### `run_attack.py`

```
requests  ≤ 300      (MAX_REQUESTS, all scenarios)
duration  ≤  60 s    (MAX_DURATION, all scenarios)
in-flight ≤   5      (MAX_CONCURRENCY, all scenarios)
pacing    ≤ 0.5 s/req (SCENARIO_PACING_S, bounded — no slow-drip abuse)
host      = 127.0.0.1 | localhost | ::1  ONLY (--host validated, default 127.0.0.1)
target    = <allowed-host>:3000 or <allowed-host>:3001  ONLY
`--confirm-local` REQUIRED — the run aborts without it
```

### `run-overload.py`

```
duration  ≤ 20 s     (MAX_DURATION)
requests  ≤ 3000     (MAX_REQUESTS, hard ceiling 4000)
in-flight ≤ 16       (MAX_CONCURRENCY)
login stream ≤ 12/s  (DEFAULT_LOGIN_RATE, hard ceiling 100/s)
host      = 127.0.0.1 | localhost | ::1  ONLY
port      = 3000 or 3001  ONLY
`--confirm-local` REQUIRED — the run aborts without it
```

Both clients stop immediately on: `/api/health` UNAVAILABLE, HTTP 429 (AI
mitigation observed), request/time cap reached, or Ctrl+C.

The clients NEVER kill/restart/manipulate the server process and never touch
OS/network config. Every reported number is a real HTTP observation.