#!/usr/bin/env python3
"""run_attack.py — BuildHub localhost attack demonstration client.

A SINGLE, fully independent attack client for the "same attack on both
builds" demo. It lives OUTSIDE both applications (repo root `attack-demo/`),
imports nothing from `frontend/` or `buildhub-no-ai/`, and needs only the
Python 3 standard library.

It ONLY sends HTTP requests to loopback:

    127.0.0.1:3000   (AI BuildHub — must detect + mitigate on its own)
    127.0.0.1:3001   (No-AI BuildHub — must fail on its own)

Named scenarios (all bounded, deterministic, localhost-only):

    REQUEST_FLOOD    (--scenario request-flood; DEFAULT)
        Bounded burst of forged sign-ins against POST /api/auth/login.
        WITHOUT-AI (:3001)  NORMAL -> ATTACK -> DEGRADED -> UNAVAILABLE
        WITH-AI     (:3000)  NORMAL -> ATTACK -> DETECTED -> MITIGATING -> HEALTHY

    RESOURCE_STRESS  (--scenario resource-stress)
        Controlled application-level load: the same forged sign-ins mixed
        with read-only GET probes (/api/posts, /api/projects, /api/health)
        so the target slows/degrades under a realistic multi-endpoint load.
        Same hard caps as REQUEST_FLOOD (<=300 requests, <=60 s, <=5
        in-flight). No host CPU/RAM exhaustion, no subprocesses, no OS
        effects — only bounded HTTP traffic to loopback.

    SERVICE_FAILURE  (--scenario service-failure)
        Controlled application-level failure observation ("crash demo"
        without any OS process crash): a gentle phased probe that watches
        the target transition NORMAL -> DEGRADED -> UNAVAILABLE (No-AI latch)
        or NORMAL -> ATTACK -> MITIGATING (AI guard) via real /api/health
        responses and HTTP 5xx/429 signals. It NEVER kills a process,
        NEVER touches fault-injection state, and NEVER touches the OS — it
        only observes the failure the applications produce on their own.
        (Operators may additionally activate a LOW-xx/MEDIUM-xx fault through
        the app's own fault-injection UI; this client then observes the 5xx.)

=== HARD SAFETY LIMITS (enforced, fail-closed) =============================
* MAX_REQUESTS    300    absolute request cap (all scenarios)
* MAX_DURATION    60s    absolute wall-clock cap (all scenarios)
* MAX_CONCURRENCY 5      absolute in-flight cap (all scenarios)
* host is ALWAYS one of {127.0.0.1, localhost, ::1} (default 127.0.0.1);
  only ports 3000/3001 are accepted.
* `--confirm-local` is REQUIRED or the run aborts before a single request.
* STOP immediately when the designed terminal signal is observed:
    - /health becomes UNAVAILABLE,
    - the mitigation is observed (HTTP 429 from /api/auth/login),
    - the request or time limit is reached,
    - Ctrl+C.
* This script NEVER: kills/restarts/pokes any process, touches the OS/network
  config, activates/deactivates faults, spoofs an IP address, sends
  destructive payloads, logs secrets/tokens/cookies, or touches anything
  outside loopback:3000/3001.
* Every reported number is computed ONLY from real HTTP observations — nothing
  is fabricated. `--telemetry-out PATH` writes the same numbers as JSON.

Usage:
    python3 attack-demo/run_attack.py --port 3001 --confirm-local
    python3 attack-demo/run_attack.py --port 3001 --max-duration 10 --confirm-local
    python3 attack-demo/run_attack.py --port 3001 --scenario resource-stress --confirm-local
    python3 attack-demo/run_attack.py --port 3000 --scenario service-failure --confirm-local
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime

# --- Hard limits (never exceeded regardless of CLI overrides) --------------
MAX_REQUESTS = 300
MAX_DURATION = 60.0
MAX_CONCURRENCY = 5
HEALTH_POLL_INTERVAL = 0.5
HTTP_TIMEOUT = 8.0

ALLOWED_PORTS = (3000, 3001)
ALLOWED_HOSTS = ("127.0.0.1", "localhost", "::1")
SOURCE = "127.0.0.1"

SCENARIOS = ("request-flood", "resource-stress", "service-failure")

# The one attack vector (mirrors the repository's existing demo):
# valid-shape but wholly forged credentials against the real sign-in endpoint.
LOGIN_PATH = "/api/auth/login"
HEALTH_PATH = "/api/health"
POSTS_PATH = "/api/posts"
PROJECTS_PATH = "/api/projects"
PASSWORD = "7aX-contr0l-local"

# Read-only GET mix for resource-stress / service-failure (deterministic
# schedules so the forged-sign-in thresholds still trip inside the
# 300-request cap while GET traffic dominates the observed load).
GET_PATHS = (POSTS_PATH, PROJECTS_PATH, HEALTH_PATH)

# Per-scenario pacing (seconds between submissions; 0 = as fast as the
# concurrency cap allows). service-failure probes gently so the health
# NORMAL -> DEGRADED -> UNAVAILABLE transitions unfold observably.
SCENARIO_PACING_S = {
    "request-flood": 0.0,
    "resource-stress": 0.0,
    "service-failure": 0.066,
}

# Per-scenario login share: request-flood is a pure forged-login burst;
# resource-stress spreads logins 1:4 across read-only GETs (heavier
# multi-endpoint load, still trips the 60-failure latch inside the cap);
# service-failure interleaves 1:3 while pacing gently.
SCENARIO_LOGIN_EVERY = {
    "request-flood": 1,
    "resource-stress": 4,
    "service-failure": 3,
}


def iso_now() -> str:
    return datetime.now().isoformat(timespec="milliseconds")


def forged_identifier() -> str:
    return f"burst{time.time_ns() % 100000:03d}@local.invalid"


def forged_request_id() -> str:
    return f"cd34a7-{time.time_ns():016d}"


# ---------------------------------------------------------------------------
# HTTP primitives (urllib only — no raw sockets, no spoofing, no subprocess)
# ---------------------------------------------------------------------------

def http_json(method: str, base: str, path: str, body: dict | None = None) -> tuple[int | None, dict | None, float]:
    """Returns (http_status_or_None, parsed_json_or_None, latency_ms)."""
    url = base + path
    start = time.monotonic()
    headers = {"X-Request-Id": forged_request_id()}
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode("utf-8")
    else:
        payload = None
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            status = int(resp.status)
            raw = resp.read().decode("utf-8", "replace")
            latency = (time.monotonic() - start) * 1000.0
            return status, _try_json(raw), latency
    except urllib.error.HTTPError as err:
        raw = err.read().decode("utf-8", "replace")
        latency = (time.monotonic() - start) * 1000.0
        return int(err.code), _try_json(raw), latency
    except Exception:
        return None, None, (time.monotonic() - start) * 1000.0


def _try_json(raw: str) -> dict | None:
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def probe_health(base: str) -> tuple[str, int | None, float]:
    """Returns (status_label, http_code, latency_ms) for GET /api/health."""
    code, payload, latency = http_json("GET", base, HEALTH_PATH)
    if code is None:
        return "unreachable", None, latency
    label = "unknown"
    if isinstance(payload, dict):
        label = str(payload.get("status", "unknown"))
    if code >= 500 and label == "unknown":
        label = "unavailable"
    if label == "ok":
        return "ok", code, latency
    return label, code, latency


# ---------------------------------------------------------------------------
# One forged sign-in attempt (identical for both ports)
# ---------------------------------------------------------------------------

def login_once(base: str) -> tuple[int | None, float]:
    code, _payload, latency = http_json(
        "POST",
        base,
        LOGIN_PATH,
        body={"identifier": forged_identifier(), "password": PASSWORD},
    )
    return code, latency


def get_once(base: str, path: str) -> tuple[int | None, float]:
    code, _payload, latency = http_json("GET", base, path)
    return code, latency


def plan_request(scenario: str, req_num: int) -> tuple[str, str]:
    """Deterministic per-request plan: (kind, path-or-method-target).

    request-flood: every request is a forged login (original behavior).
    resource-stress: 1 forged login per 4 requests, the rest cycle through
        the read-only GET paths (heavier multi-endpoint load).
    service-failure: 1 forged login per 3 requests, paced gently so the
        controlled app-level failure unfolds observably.
    """
    every = SCENARIO_LOGIN_EVERY.get(scenario, 1)
    if scenario == "request-flood" or (req_num - 1) % every == 0:
        return ("login", LOGIN_PATH)
    path = GET_PATHS[((req_num - 1) // every) % len(GET_PATHS)]
    return ("get", path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="BuildHub final attack demonstration client (loopback only).",
    )
    parser.add_argument(
        "--port",
        type=int,
        required=True,
        help=f"Loopback port to attack — must be one of {ALLOWED_PORTS}. "
        f"3001 = No-AI build (expected to fail), 3000 = AI build (expected to contain).",
    )
    parser.add_argument(
        "--host",
        default=SOURCE,
        help=f"Loopback host — one of {ALLOWED_HOSTS} (default {SOURCE}).",
    )
    parser.add_argument(
        "--scenario",
        default="request-flood",
        choices=list(SCENARIOS),
        help="Attack scenario: request-flood (default, forged-login burst), "
        "resource-stress (bounded multi-endpoint load), service-failure "
        "(gentle phased probe observing the controlled app-level failure).",
    )
    parser.add_argument(
        "--telemetry-out",
        default=None,
        help="Optional path to write structured JSON telemetry (scenario, target, "
        "counts, latency, error rate, final health). Contains no secrets.",
    )
    parser.add_argument(
        "--confirm-local",
        action="store_true",
        required=True,
        help="MANDATORY confirmation the target is loopback. The run aborts without it.",
    )
    parser.add_argument(
        "--max-requests",
        type=int,
        default=MAX_REQUESTS,
        help=f"Request cap (hard max {MAX_REQUESTS}; larger values are clamped down).",
    )
    parser.add_argument(
        "--max-duration",
        type=float,
        default=MAX_DURATION,
        help=f"Wall-clock cap in seconds (hard max {MAX_DURATION:.0f}s; clamped).",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=MAX_CONCURRENCY,
        help=f"In-flight request cap (hard max {MAX_CONCURRENCY}; clamped).",
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    args = parse_args()

    # Safety gate 1 — explicit operator confirmation.
    if not args.confirm_local:
        print("ABORT: --confirm-local is required. The target must be loopback (127.0.0.1).")
        return 2

    # Safety gate 1b — host allowlist (localhost only, fail-closed).
    if args.host not in ALLOWED_HOSTS:
        print(
            f"ABORT: host must be one of {ALLOWED_HOSTS} (loopback only). "
            "Refusing to continue."
        )
        return 2

    # Safety gate 2 — only the two defined local demo ports, nothing else.
    if args.port not in ALLOWED_PORTS:
        print(
            f"ABORT: port must be one of {ALLOWED_PORTS} "
            f"(3001 No-AI / 3000 AI), loopback only. Refusing to continue."
        )
        return 2

    if args.scenario not in SCENARIOS:
        print(f"ABORT: --scenario must be one of {SCENARIOS}. Refusing to continue.")
        return 2

    # Hard caps — never exceed them even if overridden.
    max_requests = min(args.max_requests, MAX_REQUESTS)
    max_duration = min(args.max_duration, MAX_DURATION)
    concurrency = min(args.concurrency, MAX_CONCURRENCY)

    base = f"http://{args.host}:{args.port}"
    expected = "contained by AI" if args.port == 3000 else "fails (unavailable)"
    scenario = args.scenario
    started_at = iso_now()

    # Pre-flight — refuse to fire at a server that is already down.
    boot_health, boot_code, _ = probe_health(base)
    if boot_code is None:
        print(f"ABORT: nothing listening at {base} (/api/health unreachable). Start the server first.")
        return 2
    if boot_health == "unavailable":
        print(
            f"ABORT: {base} is ALREADY unavailable ({boot_health}). "
            "Reset/recover the server before running the attack."
        )
        return 2
    print(f"pre-flight /api/health @ {base} -> {boot_health} (HTTP {boot_code})")
    if args.port == 3001 and boot_health == "degraded":
        print("  note: already degraded; an operator reset may be needed for a clean run.")

    # -----------------------------------------------------------------------
    print("=" * 78)
    print(f"SAME-CONTROLLED-ATTACK DEMO   target={base}   expected: {expected}")
    print(f"scenario: {scenario}")
    print(
        f"limits: requests<={max_requests}  duration<={max_duration:.0f}s  "
        f"concurrency<={concurrency}  source={args.host}   vector=POST {LOGIN_PATH}"
        + (f" + GET {POSTS_PATH} {PROJECTS_PATH} {HEALTH_PATH}" if scenario != "request-flood" else "")
    )
    print("=" * 78, flush=True)

    start = time.monotonic()
    stop = threading.Event()
    lock = threading.Lock()

    state = {
        "completed": 0,  # responses received (the honest "requests sent" count)
        "rows": [],  # per-request observations
        "hist": {},  # http status histogram
        "per_kind": {},  # login vs get counts
        "latencies": [],  # raw latency samples (ms)
        "conn_errors": 0,
        "peak_latency_ms": 0,
        "reason": "max requests / duration reached",
    }
    health_latest = {"status": boot_health, "http": boot_code, "at": iso_now()}
    health_history: list[tuple[float, str, int | None, float]] = []

    def snapshot_health() -> dict:
        with lock:
            return dict(health_latest)

    def watch_health() -> None:
        # Independent observer: polls /api/health and stops the run the moment
        # the service reports UNAVAILABLE (the WITHOUT-AI terminal outcome).
        while not stop.is_set():
            status, code, latency = probe_health(base)
            with lock:
                health_latest.update({"status": status, "http": code, "at": iso_now()})
                health_history.append((time.monotonic() - start, status, code, latency))
                if status == "unavailable":
                    state["reason"] = "/health UNAVAILABLE observed — service down"
                    stop.set()
            stop.wait(HEALTH_POLL_INTERVAL)

    watcher = threading.Thread(target=watch_health, daemon=True)
    watcher.start()

    def fire_once(base: str, kind: str, path: str) -> tuple[int | None, float, str]:
        """Executes one planned request. Returns (status, latency_ms, kind)."""
        if kind == "login":
            code, latency = login_once(base)
        else:
            code, latency = get_once(base, path)
        return code, latency, kind

    def handle_result(req_num: int, code: int | None, latency: float, kind: str) -> None:
        health_now = snapshot_health()["status"]
        with lock:
            hist = state["hist"]
            hist[code] = hist.get(code, 0) + 1
            state["per_kind"][kind] = state["per_kind"].get(kind, 0) + 1
            state["latencies"].append(latency)
            if code is None:
                state["conn_errors"] += 1
                state["reason"] = "connection error — target unreachable (not responding)"
                stop.set()
            elif code == 429 and args.port == 3000:
                state["reason"] = "AI mitigation observed (HTTP 429 from /api/auth/login) — ATTACK CONTAINED"
                stop.set()
            elif code == 503:
                state["reason"] = "HTTP 503 observed — service unavailable (no-AI latch / controlled failure)"
                stop.set()
            state["completed"] += 1
            state["peak_latency_ms"] = max(state["peak_latency_ms"], int(latency))
            state["rows"].append(
                {
                    "num": req_num,
                    "ts": iso_now(),
                    "kind": kind,
                    "status": code,
                    "latency_ms": int(latency),
                    "health": health_now,
                }
            )

    def emit_observation(row: dict) -> None:
        status = row["status"] if row["status"] is not None else "ERR"
        print(
            f"[{row['ts']}]  #{row['num']:>3}  kind={row.get('kind', 'login'):>5}  "
            f"status={status:>3}  "
            f"latency={row['latency_ms']:>4}ms  health={row['health']}"
        )

    try:
        pacing = SCENARIO_PACING_S.get(scenario, 0.0)
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            pending: list[tuple[int, str, str, Future]] = []
            submitted = 0
            while not stop.is_set():
                if submitted >= max_requests:
                    state["reason"] = f"request limit reached ({max_requests})"
                    break
                if (time.monotonic() - start) >= max_duration:
                    state["reason"] = f"timeout reached ({max_duration:.0f}s)"
                    break
                submitted += 1
                kind, path = plan_request(scenario, submitted)
                pending.append((submitted, kind, path, pool.submit(fire_once, base, kind, path)))
                if pacing > 0:
                    time.sleep(pacing)
                if len(pending) >= concurrency * 2:
                    for num, kind, path, fut in pending:
                        code, latency, _k = fut.result()
                        handle_result(num, code, latency, kind)
                        with lock:
                            last_row = state["rows"][-1]
                        emit_observation(last_row)
                    pending = []
            for num, kind, path, fut in pending:
                code, latency, _k = fut.result()
                handle_result(num, code, latency, kind)
                with lock:
                    last_row = state["rows"][-1]
                emit_observation(last_row)
    except KeyboardInterrupt:
        state["reason"] = "interrupted by operator (Ctrl+C)"
        stop.set()

    stop.set()
    watcher.join(timeout=2)

    elapsed = time.monotonic() - start
    reason = state["reason"]

    # Post-stop verification of the real /api/health response.
    final_health = probe_health(base)
    final_code = final_health[1]

    with lock:
        rows_all = list(state["rows"])
        hist = dict(state["hist"])
        per_kind = dict(state["per_kind"])
        latencies = list(state["latencies"])
        conn_errors = state["conn_errors"]
        peak = state["peak_latency_ms"]
        completed = state["completed"]

    print("-" * 78)
    print("REAL OBSERVATION (per completed request: timestamp · number · status · latency · health)")
    for row in sorted(rows_all, key=lambda r: r["num"]):
        emit_observation(row)

    # -----------------------------------------------------------------------
    print("-" * 78)
    print("ATTACK RESULT")
    print(f"  Target:              {base}")
    print(f"  Requests:            {completed}")
    print(f"  401:                 {hist.get(401, 0)}")
    print(f"  403:                 {hist.get(403, 0)}")
    print(f"  429:                 {hist.get(429, 0)}")
    fivexx = sum(n for code, n in hist.items() if code is not None and code >= 500)
    print(f"  5xx:                 {fivexx}")
    if conn_errors:
        print(f"  Connection errors:   {conn_errors}")
    print(f"  Peak latency:        {peak} ms")
    print(f"  Final health:        {final_health[0]} (HTTP {final_code if final_code is not None else 'n/a'})")
    print(f"  Elapsed:             {elapsed:.1f}s")
    print(f"  Stop reason:         {reason}")
    print("=" * 78, flush=True)

    # --- Structured telemetry (no secrets: statuses + latencies only) --------
    count_4xx = sum(n for code, n in hist.items() if code is not None and 400 <= code < 500)
    count_5xx = sum(n for code, n in hist.items() if code is not None and code >= 500)
    count_2xx = sum(n for code, n in hist.items() if code is not None and 200 <= code < 300)
    avg_latency = round(sum(latencies) / len(latencies), 1) if latencies else 0.0
    p95_latency = round(sorted(latencies)[int(len(latencies) * 0.95)], 1) if latencies else 0.0
    error_rate = round((count_4xx + count_5xx + conn_errors) / completed, 4) if completed else 0.0
    telemetry = {
        "scenario": scenario,
        "target": {"host": args.host, "port": args.port, "url": base},
        "startedAt": started_at,
        "durationS": round(elapsed, 2),
        "limits": {"maxRequests": max_requests, "maxDurationS": max_duration, "concurrency": concurrency},
        "requests": {
            "completed": completed,
            "byStatus": {str(k) if k is not None else "timeout": v for k, v in sorted(hist.items(), key=lambda kv: str(kv[0]))},
            "byKind": per_kind,
            "count2xx": count_2xx,
            "count4xx": count_4xx,
            "count5xx": count_5xx,
            "count401": hist.get(401, 0),
            "count403": hist.get(403, 0),
            "count429": hist.get(429, 0),
            "timeouts": conn_errors,
        },
        "latencyMs": {"avg": avg_latency, "p95": p95_latency, "peak": peak},
        "errorRate": error_rate,
        "finalHealth": {"status": final_health[0], "http": final_code},
        "stopReason": reason,
    }

    if args.port == 3000:
        contained = hist.get(429, 0) > 0 and final_health[0] != "unavailable"
        print("ATTACK CONTAINED." if contained else "ATTACK NOT CONTAINED.", flush=True)
        print("Post-stop verification: GET /api/health ->", final_health, flush=True)
        ok = contained
    else:
        print("The WITHOUT-AI service failed on its own (no auto-mitigation).", flush=True)
        print("Recovery is an OPERATOR action (reset or restart) — never done by this script.", flush=True)
        ok = final_health[0] == "unavailable"

    telemetry["verdict"] = "contained" if (args.port == 3000 and ok) else ("failed-unhealthy" if ok else "unexpected")
    telemetry["ok"] = ok
    print("TELEMETRY_JSON " + json.dumps(telemetry), flush=True)
    if args.telemetry_out:
        try:
            with open(args.telemetry_out, "w", encoding="utf-8") as handle:
                json.dump(telemetry, handle, indent=2)
            print(f"telemetry written to {args.telemetry_out}", flush=True)
        except OSError as err:
            print(f"WARNING: could not write telemetry file: {err}", flush=True)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())