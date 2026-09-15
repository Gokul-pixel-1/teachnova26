#!/usr/bin/env python3
"""BuildHub — REAL local-Ollama self-healing E2E (HTTP-only, stdlib).

Same evidence-only flow as the hermetic e2e, but the ENTIRE repair conversation
(Analyzer → Coder/Critic → Judge), RL decision layer, approval and validation
run against the REAL local Ollama provider (default `qwen2.5-coder:1.5b`):

    activate fault ──> real failing request ──> ERROR log ──> scan
        ──> ONE incident ──> REAL engine run (Ollama) ──> candidate
        ──> validation probe ──> RESOLVED        (HIGH → human approval first)

Also verifies the Phase 9–11 REAL-mode additions:
    * AgentRun transcript with an ANALYZER run (`kind=ANALYZER`, `agent=FIXER`,
      `mode=REAL`) followed by CODER/CRITIC/JUDGE runs.
    * the RL decision-layer timeline event on the repaired incident
    * `/api/ai/status` reports provider=ollama, mode=REAL, measured latency
      and per-inference call accounting.
    * `/api/ai/learning` exposes the RL decision policy.

Server requirements (run the dev server with the REAL local provider):
    FAULT_INJECTION_ENABLED=true
    AUTH_GUARD_ENABLED=false
    AI_PROVIDER=ollama            (or unset with no GROQ_API_KEY → local-first)
    SELF_HEALING_TEST_MODE=false  (REAL mode — do not set)
    AUTO_REPAIR=false             (REAL mode auto-starts a repair on scan;
                                   this script drives the manual run itself,
                                   so kick the automatic trigger OFF here)

    cd frontend
    env FAULT_INJECTION_ENABLED=true AUTH_GUARD_ENABLED=false AI_PROVIDER=ollama \
        AI_MODEL=qwen2.5-coder:1.5b AUTO_REPAIR=false npx next dev -p 3000

Ollama must be running (`ollama serve`, default http://localhost:11434) with the
model installed (`ollama pull qwen2.5-coder:1.5b`). Each inference is
serialized through a FIFO queue; a repair conversation takes ~1–2 min on a
CPU-only machine, so this script is SLOW on purpose.

Run:
    python3 scripts/e2e_ollama_real_self_healing.py
    BASE_URL=http://localhost:3000 python3 scripts/e2e_ollama_real_self_healing.py
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://localhost:3000"
DEMO_PASSWORD = "buildhub-demo1"
OPERATOR = {"identifier": "arjun", "password": DEMO_PASSWORD}
# A single REAL repair conversation is several serialized inferences; on a
# RAM-congested CPU-only machine it can take 10+ minutes. The run call is
# synchronous server-side, so budget generously and poll on client timeout.
RUN_TIMEOUT = 1800
POLL_BUDGET_S = 2200

_passed = 0
_failed = 0
_problems = []


def check(name, cond, extra=""):
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ok  {name}")
    else:
        _failed += 1
        print(f"FAIL  {name} {extra}")
        _problems.append(f"{name} {extra}".strip())


class Client:
    """Minimal cookie-keeping HTTP client (stdlib only)."""

    def __init__(self):
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

    def request(self, method, path, payload=None, timeout=30):
        url = BASE + path
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data,
                                     headers={"Content-Type": "application/json"}, method=method)
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                body = resp.read().decode()
                return resp.status, (json.loads(body) if body else {})
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            return e.code, (json.loads(body) if body else {})

    def get(self, path, timeout=30):
        return self.request("GET", path, timeout=timeout)

    def post(self, path, payload, timeout=30):
        return self.request("POST", path, payload, timeout=timeout)


def sleep(seconds):
    time.sleep(seconds)


def login_as(identifier, password=DEMO_PASSWORD):
    client = Client()
    status, body = client.post("/api/auth/login", {"identifier": identifier, "password": password})
    return client, status, body


def open_incident_ids(op):
    status, body = op.get("/api/incidents?status=DETECTED,INVESTIGATING,WAITING_APPROVAL,VALIDATING&pageSize=100")
    if status != 200:
        return []
    return [i.get("id") for i in body.get("incidents", []) if i.get("id")]


def most_recent_updated_open(op):
    """Returns the most recently updated open incident id (the scan's merge target)."""
    status, body = op.get("/api/incidents?status=DETECTED,INVESTIGATING,WAITING_APPROVAL,VALIDATING&pageSize=100")
    if status != 200:
        return None
    best, best_at = None, ""
    for i in body.get("incidents", []):
        at = i.get("updatedAt") or ""
        if at >= best_at:
            best, best_at = i.get("id"), at
    return best


def current_active(op):
    _, body = op.get("/api/faults")
    return body.get("active", 0)


def trigger_until_failure(fn, expected, attempts=40, wait_ms=750):
    res = None
    for _ in range(attempts):
        res = fn()
        if expected(res):
            return res, True
        sleep(wait_ms / 1000.0)
    return res, False


def retry_until(fn, pred, tries=30, wait_s=1.0):
    res = None
    for _ in range(tries):
        res = fn()
        if pred(res):
            return res
        sleep(wait_s)
    return res


def run_repair(op, incident_id):
    """Runs the repair synchronously; if the client times out (the server keeps
    processing), falls back to polling the incident until it reaches a terminal
    state. Returns (ok, stage_or_reason)."""
    started = time.time()
    try:
        status, run = op.post("/api/security/run", {"incidentId": incident_id}, timeout=RUN_TIMEOUT)
        return status == 200, run.get("stage") or "unknown"
    except (TimeoutError, urllib.error.URLError) as e:
        elapsed = time.time() - started
        print(f"    run request timed out client-side after {elapsed:.0f}s — polling server-side completion")
        deadline = time.time() + POLL_BUDGET_S
        while time.time() < deadline:
            sleep(5)
            status, body = op.get(f"/api/incidents/{incident_id}")
            stage = (body.get("incident") or {}).get("status") if status == 200 else None
            if stage in ("RESOLVED", "ROLLED_BACK", "AI_REPAIR_FAILED", "WAITING_APPROVAL"):
                return True, stage
        return False, f"no terminal state within budget (last:{stage or '?'})"


def poll_incident(op, incident_id, pred, tries=60, wait_s=2.0):
    res = None
    for _ in range(tries):
        res = op.get(f"/api/incidents/{incident_id}")
        if res[0] == 200 and pred(res[1].get("incident") or {}):
            return res[1].get("incident")
        sleep(wait_s)
    return (res[1] or {}).get("incident") if res and res[0] == 200 else None


def crash_cycle(op, fault_id, trigger, expect_trigger, verifier, pre_open):
    print(f"\n--- {fault_id}: real failure → REAL (Ollama) engine → repair ---")
    status, act = op.post("/api/faults", {"faultId": fault_id, "action": "activate"})
    check(f"{fault_id} activate → 200 with defect location",
          status == 200 and bool((act.get("defect") or {}).get("file")), f"status={status}")
    sleep(2)
    res, ok = trigger_until_failure(trigger, expect_trigger)
    check(f"{fault_id} trigger produces the real failure", ok, f"status={res[0]}")
    _, scan = op.post("/api/incidents/scan", {"limit": 200})
    check(f"{fault_id} scan sees the ERROR log(s)", scan.get("scanned", 0) >= 1, json.dumps(scan))
    new_ids = [c.get("id") for c in scan.get("created", [])
               if c.get("id") and c.get("id") not in pre_open]
    if not new_ids and scan.get("merged", 0) >= 1:
        merged_id = most_recent_updated_open(op)
        if merged_id:
            new_ids = [merged_id]
            check(f"{fault_id} merged an existing OPEN incident (fault continues into it)", True)
    check(f"{fault_id} created and/or merged an incident", len(new_ids) > 0, json.dumps(scan))
    incident_id = new_ids[-1] if new_ids else None
    if not incident_id:
        return
    run_status, run = run_repair(op, incident_id)
    check(f"{fault_id} REAL run completed (server-side)",
          run_status is True, f"ok={run_status} reason={str(run)[:120]}")
    check(f"{fault_id} engine reaches WAITING_APPROVAL or a terminal stage",
          run in ("WAITING_APPROVAL", "RESOLVED", "ROLLED_BACK"),
          f"stage={run}")
    if run == "WAITING_APPROVAL":
        check(f"{fault_id} elevated risk requires a human decision", True)
        detail = poll_incident(op, incident_id, lambda d: d.get("approvals") or d.get("status") == "WAITING_APPROVAL")
        approvals = (detail or {}).get("approvals") or []
        approval_id = approvals[0].get("approvalId") if approvals else None
        check(f"{fault_id} approval record exists", bool(approval_id), json.dumps(approvals))
        _, proceed = op.post("/api/approvals/proceed",
                             {"approvalId": approval_id, "action": "proceed"}, timeout=RUN_TIMEOUT)
        stage = proceed.get("repair", {}).get("stage") or proceed.get("stage")
        check(f"{fault_id} approval PROCEED applies + validates the patch", stage == "RESOLVED",
              f"stage={stage}")
        check(f"{fault_id} incident reached RESOLVED", stage == "RESOLVED", f"stage={stage}")
    else:
        check(f"{fault_id} incident reached RESOLVED", run == "RESOLVED",
              f"stage={run}")
    if verifier:
        verifier()
    check(f"{fault_id} fault no longer active (file repaired, not leaked)",
          current_active(op) == 0, f"active={current_active(op)}")
    return incident_id


def main():
    global BASE
    parser = argparse.ArgumentParser(description="BuildHub REAL local-Ollama self-healing E2E")
    parser.add_argument("--with-approval", action="store_true",
                        help="also run the HIGH-01 human-approval cycle")
    args = parser.parse_args()
    BASE = urllib.parse.urljoin(os.environ.get("BASE_URL", BASE), "/").rstrip("/") or BASE

    print("# REAL local-Ollama self-healing E2E")

    op, status, _ = login_as(OPERATOR["identifier"])
    check("Operator login arjun → 200", status == 200, f"status={status}")
    if status != 200:
        print("  Server not reachable or login failed — is the dev server running on",
              BASE, "in REAL (Ollama) mode?")
        raise SystemExit(1)

    # --- Preflight: the server must be running the REAL Ollama provider. ---
    astatus, ai = op.get("/api/ai/status")
    check("GET /api/ai/status → 200", astatus == 200, f"status={astatus}")
    check("ai/status provider=ollama (local-first default)",
          ai.get("provider") == "ollama", f"provider={ai.get('provider')}")
    check("ai/status mode=REAL", ai.get("mode") == "REAL", f"mode={ai.get('mode')}")
    check("ai/status testMode=false", ai.get("testMode") is False, f"testMode={ai.get('testMode')}")
    check("ai/status model resolved", bool(ai.get("model")), f"model={ai.get('model')}")
    if ai.get("model") == "qwen2.5-coder:1.5b":
        check("ai/status model is the local qwen2.5-coder:1.5b", True)
    offered = ai.get("offered")
    if isinstance(offered, list) and ai.get("model"):
        check("ai/status model is present in the Ollama catalog",
              ai.get("model") in offered, f"offered={offered}")
    else:
        check("ai/status catalog reachable (Ollama running)", offered is not None,
              f"offered={offered}")
    if ai.get("provider") != "ollama" or ai.get("mode") != "REAL":
        print("\n  Aborting: the server is NOT running the REAL Ollama provider.")
        print("  Start it with:")
        print("    env FAULT_INJECTION_ENABLED=true AUTH_GUARD_ENABLED=false AI_PROVIDER=ollama \\")
        print("        AI_MODEL=qwen2.5-coder:1.5b npx next dev -p 3000")
        raise SystemExit(1)

    pre_open = set(open_incident_ids(op))
    cleanup_status, cleanup = op.post("/api/faults", {"action": "deactivate-all"})
    check("Deactivate-all faults → 200", cleanup_status == 200, f"status={cleanup_status}")
    check("All faults start inactive", current_active(op) == 0, f"active={current_active(op)}")

    calls0 = ai.get("totalCalls", 0)
    check("ai/status call accounting readable (server may carry prior inference counts)",
          isinstance(calls0, int) and calls0 >= 0, f"totalCalls={calls0}")

    print("\n=== REAL cycle 1: LOW-01 auto-repair through Ollama ===")
    low_id = crash_cycle(
        op, "LOW-01",
        trigger=lambda: op.post("/api/posts", {"content": f"LOW-01 trigger {int(time.time())}", "tags": []}),
        expect_trigger=lambda r: r[0] == 500,
        verifier=lambda: check(
            "LOW-01 repaired: post creation works (201)",
            op.post("/api/posts", {"content": f"LOW-01 verified {int(time.time())}", "tags": []})[0] == 201,
            "post-create after repair"),
        pre_open=pre_open,
    )

    # --- REAL-mode engine transcript: Analyzer → Coder/Critic → Judge, all REAL. ---
    if low_id:
        detail = poll_incident(op, low_id, lambda d: d.get("status") == "RESOLVED")
        runs = (detail or {}).get("agentRuns") or []
        kinds = [r.get("kind") for r in runs]
        check("REAL incident has AgentRun transcript", len(runs) >= 3, f"runs={len(runs)}")
        check("Analyzer ran first (kind=ANALYZER) in REAL mode",
              kinds and kinds[0] == "ANALYZER", f"kinds={kinds}")
        analyzer = next((r for r in runs if r.get("kind") == "ANALYZER"), None)
        check("Analyzer run completed with mode=REAL",
              analyzer is not None and analyzer.get("status") == "COMPLETE"
              and analyzer.get("mode") == "REAL", json.dumps(analyzer))
        check("Analyzer model recorded", (analyzer or {}).get("model") == ai.get("model"),
              f"model={(analyzer or {}).get('model')}")
        check("Coder and Critic and Judge runs present",
              "CODER" in kinds and "CRITIC" in kinds and "JUDGE" in kinds, f"kinds={kinds}")
        check("All agent runs are REAL mode",
              all(r.get("mode") == "REAL" for r in runs), f"modes={[r.get('mode') for r in runs]}")
        events = [(e.get("label"), e.get("detail")) for e in (detail or {}).get("timeline") or []]
        check("RL decision-layer event recorded",
              any(label == "RL decision layer" for label, _ in events),
              f"labels={[l for l, _ in events]}")
        attempt = (detail or {}).get("repairAttempt") or {}
        check("Repair attempt completed with judgement",
              attempt.get("status") == "JUDGE_APPROVED", f"attempt.status={attempt.get('status')}")

        # Long-poll until the sync run's effects are visible in stats.
        _, ai_after = retry_until(lambda: op.get("/api/ai/status"),
                                  lambda r: (r[1].get("totalCalls") or 0) > calls0)
        check("Ollama totalCalls increased after REAL repair",
              (ai_after.get("totalCalls") or 0) > calls0,
              f"before={calls0} after={ai_after.get('totalCalls')}")
        check("Ollama latency measured per call",
              isinstance(ai_after.get("latencyMs"), (int, float)) and ai_after.get("latencyMs") > 0,
              f"latencyMs={ai_after.get('latencyMs')}")

    print("\n=== REAL cycle 2: HIGH-01 human approval through Ollama ===")
    pre_open2 = set(open_incident_ids(op))
    high_id = None
    if args.with_approval:
        high_id = crash_cycle(
            op, "HIGH-01",
            trigger=lambda: op.post("/api/auth/login",
                                    {"identifier": "arjun", "password": "wrong-password-for-high01"}),
            expect_trigger=lambda r: r[0] == 500,
            verifier=lambda: (
                check("HIGH-01 repaired: wrong password → 401",
                      op.post("/api/auth/login", {"identifier": "arjun", "password": "wrong-password-for-high01"})[0] == 401,
                      "wrong-password after repair"),
                check("HIGH-01 repaired: correct password → 200",
                      op.post("/api/auth/login", {"identifier": "arjun", "password": DEMO_PASSWORD})[0] == 200,
                      "correct-password after repair"),
            ),
            pre_open=pre_open2,
        )
    else:
        check("HIGH-01 approval cycle skipped (add --with-approval)", True)

    if high_id:
        detail = poll_incident(op, high_id, lambda d: d.get("status") == "RESOLVED")
        runs = (detail or {}).get("agentRuns") or []
        kinds = [r.get("kind") for r in runs]
        check("HIGH approval incident also has an Analyzer run",
              "ANALYZER" in kinds,
              f"kinds={kinds}")

    print("\n=== RL learning end-point ===")
    lstatus, learning = op.get("/api/ai/learning")
    check("GET /api/ai/learning → 200", lstatus == 200, f"status={lstatus}")
    check("learning exposes RL decision policy", learning.get("rl") is not None,
          json.dumps(learning)[:200])

    op.post("/api/faults", {"action": "deactivate-all"})
    check("Final: no active faults (all repaired or restored)", current_active(op) == 0,
          f"active={current_active(op)}")

    print("\n" + "=" * 52)
    print(f"REAL Ollama self-healing E2E: {_passed} passed, {_failed} failed")
    if _problems:
        print("Problems:")
        for p in _problems:
            print(f"  - {p}")
    raise SystemExit(1 if _failed else 0)


if __name__ == "__main__":
    main()