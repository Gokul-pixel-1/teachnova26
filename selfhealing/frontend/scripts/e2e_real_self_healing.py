#!/usr/bin/env python3
"""BuildHub — REAL runtime self-healing E2E (HTTP-only, no framework deps).

Proves the self-healing engine works from REAL runtime evidence only — no fault
id or canned answer is available to the repair path:

    activate fault ──> real failing request ──> ERROR log ──> scan
        ──> ONE incident ──> run (engine) ──> candidate applied to REAL file
        ──> validation probe ──> RESOLVED   (HIGH → human approval first)

Also verifies:
    * the merge behaviour  (identical failures fold into ONE incident)
    * harness-only behavioural faults (no exception → no incident)
    * every target file left clean at the end

Requirements on the server:
    FAULT_INJECTION_ENABLED=true
    AUTH_GUARD_ENABLED=false        (HIGH-01's wrong-password defect is 500 not 401)
    AI_PROVIDER=test SELF_HEALING_TEST_MODE=true   (hermetic, deterministic)

Dev-mode warning: Turbopack dev may take a moment to recompile an edited route.
This script retries state transitions, but for a deterministic run start the
server fresh, e.g.:

    cd frontend
    env SELF_HEALING_TEST_MODE=true AI_PROVIDER=test FAULT_INJECTION_ENABLED=true \
        AUTH_GUARD_ENABLED=false npx next dev -p 3000
    # (AUTO_REPAIR is OFF by default in TEST mode, so this script's explicit
    #  `POST /api/security/run` stays the only trigger. Set AUTO_REPAIR=true
    #  to exercise the automatic trigger instead — see verify-auto-repair.mjs.)

Run:
    python3 scripts/e2e_real_self_healing.py            # full
    python3 scripts/e2e_real_self_healing.py --quick   # crash cycles only
    BASE_URL=http://localhost:3000 python3 scripts/e2e_real_self_healing.py
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://localhost:3000"
DEMO_PASSWORD = "buildhub-demo1"
OPERATOR = {"identifier": "arjun", "password": DEMO_PASSWORD}
MEERA = {"identifier": "meera", "password": DEMO_PASSWORD}

CRASH_FAULTS = ["LOW-01", "MEDIUM-01", "MEDIUM-02", "HIGH-01"]
BEHAVIOURAL_FAULTS = ["LOW-02", "LOW-03", "MEDIUM-03", "HIGH-02"]
ALL_FAULTS = ["LOW-01", "LOW-02", "LOW-03", "MEDIUM-01", "MEDIUM-02",
              "MEDIUM-03", "HIGH-01", "HIGH-02", "HIGH-03"]

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
        _problems.append(name)


class Client:
    """Minimal cookie-keeping HTTP client (stdlib only)."""

    def __init__(self):
        self._jar = {}
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())

    def _headers(self):
        return {"Content-Type": "application/json"}

    def request(self, method, path, payload=None):
        url = BASE + path
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with self._opener.open(req, timeout=30) as resp:
                body = resp.read().decode()
                return resp.status, (json.loads(body) if body else {})
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            return e.code, (json.loads(body) if body else {})

    def get(self, path):
        return self.request("GET", path)

    def post(self, path, payload):
        return self.request("POST", path, payload)

    def patch(self, path, payload):
        return self.request("PATCH", path, payload)

    def delete(self, path):
        return self.request("DELETE", path)


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


def activate_fault(op, fault_id):
    return op.post("/api/faults", {"faultId": fault_id, "action": "activate"})


def deactivate_fault(op, fault_id):
    return op.post("/api/faults", {"faultId": fault_id, "action": "deactivate"})


def current_active(op):
    _, body = op.get("/api/faults")
    return body.get("active", 0)


APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NUDGE_RE = re.compile(r"[ \t]*// bh-nudge-[0-9]+[ \t]*\n")
NUDGED_FILES = [
    "app/api/posts/[id]/route.ts",
    "lib/server/validation.ts",
    "app/api/projects/[id]/route.ts",
]


def bump_file(rel):
    """Nudge a source file so Turbopack recompiles its CURRENT on-disk state.

    Dev-server quirk: a fast activate→deactivate write pair can be coalesced
    into one (stale) compile. Touching the file from this separate process
    forces the fresh state into the served module. Only meaningful locally.
    """
    path = os.path.join(APP_ROOT, rel)
    with open(path, "r", encoding="utf-8") as fh:
        src = NUDGE_RE.sub("", fh.read())
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src.rstrip() + f"\n// bh-nudge-{int(time.time() * 1000)}\n")
    sleep(1.2)


def strip_nudges():
    for rel in NUDGED_FILES:
        try:
            path = os.path.join(APP_ROOT, rel)
            with open(path, "r", encoding="utf-8") as fh:
                src = fh.read()
            clean = NUDGE_RE.sub("", src).rstrip() + "\n"
            if clean != src:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(clean)
        except OSError:
            pass


def trigger_until_failure(fn, expected, attempts=40, wait_ms=500):
    res = None
    for _ in range(attempts):
        res = fn()
        if expected(res):
            return res, True
        sleep(wait_ms / 1000.0)
    return res, False


def retry_until(fn, pred, tries=10, wait_s=1.0):
    res = None
    for _ in range(tries):
        res = fn()
        if pred(res):
            return res
        sleep(wait_s)
    return res


def scan_incidents(op):
    status, body = op.post("/api/incidents/scan", {"limit": 200})
    return status, body


def run_repair(op, incident_id):
    return op.post("/api/security/run", {"incidentId": incident_id})


def run_crash_cycle(op, fault_id, trigger, expect_trigger, verifier, pre_open):
    print(f"\n--- {fault_id}: real failure → incident → repair ---")
    status, act = activate_fault(op, fault_id)
    check(f"{fault_id} activate → 200 with defect location",
          status == 200 and bool((act.get("defect") or {}).get("file")), f"status={status}")
    sleep(2)
    res, ok = trigger_until_failure(trigger, expect_trigger)
    check(f"{fault_id} trigger produces the real failure", ok, f"status={res[0]}")
    _, scan = scan_incidents(op)
    created = scan.get("created", [])
    check(f"{fault_id} scan sees the ERROR log(s)", scan.get("scanned", 0) >= 1, json.dumps(scan))
    new_ids = [c.get("id") for c in created if c.get("id") and c.get("id") not in pre_open]
    check(f"{fault_id} created and/or merged an incident", len(new_ids) > 0, json.dumps(scan))
    incident_id = new_ids[-1] if new_ids else None
    if not incident_id:
        return
    run_status, run = run_repair(op, incident_id)
    check(f"{fault_id} incident resolved for running",
          run_status == 200 and run.get("stage") in ("WAITING_APPROVAL", "RESOLVED", "ROLLED_BACK", "AI_REPAIR_FAILED"),
          f"status={run_status}")
    check(f"{fault_id} engine reaches WAITING_APPROVAL or a terminal stage",
          run.get("stage") in ("WAITING_APPROVAL", "RESOLVED", "ROLLED_BACK"),
          f"stage={run.get('stage')}")
    if run.get("stage") == "WAITING_APPROVAL":
        check(f"{fault_id} HIGH risk requires a human decision",
              run.get("requiresApproval") is True and bool(run.get("approvalId")),
              json.dumps(run))
        _, proceed = op.post("/api/approvals/proceed",
                             {"approvalId": run["approvalId"], "action": "proceed"})
        stage = proceed.get("repair", {}).get("stage") or proceed.get("stage")
        check(f"{fault_id} approval PROCEED applies + validates the patch",
              stage == "RESOLVED", f"stage={stage}")
        check(f"{fault_id} incident reached RESOLVED", stage == "RESOLVED", f"stage={stage}")
    else:
        check(f"{fault_id} incident reached RESOLVED", run.get("stage") == "RESOLVED", f"stage={run.get('stage')}")
    if verifier:
        verifier(op)
    check(f"{fault_id} fault no longer active (file repaired, not leaked)",
          current_active(op) == 0, f"active={current_active(op)}")


def run_behavioural_checks(op):
    print("\n--- Behavioural (no-exception) faults: harness symptom only, NO incident ---")

    # LOW-02 — response-key typo on GET detail (200, never throws)
    activate_fault(op, "LOW-02")
    bump_file("app/api/posts/[id]/route.ts")
    _, created = op.post("/api/posts", {"content": "LOW-02 verification post", "tags": []})
    post_id = (created.get("post") or {}).get("id")
    check("LOW-02 activate + create a normal post (POST unchanged)", bool(post_id), json.dumps(created))
    if post_id:
        _, faulted = op.get(f"/api/posts/{post_id}")
        check("LOW-02 GET detail renames post → poost", "poost" in faulted,
              f"keys={sorted(faulted.keys())}")
        deactivate_fault(op, "LOW-02")
        bump_file("app/api/posts/[id]/route.ts")
        restored = retry_until(
            lambda: op.get(f"/api/posts/{post_id}"),
            lambda r: isinstance(r[1], dict) and r[1].get("post") is not None and "poost" not in r[1],
        )
        check("LOW-02 restored GET detail returns `post` (not poost)",
              "post" in (restored[1] or {}) and "poost" not in (restored[1] or {}),
              f"keys={sorted((restored[1] or {}).keys())}")

    # LOW-03 — validation minimum becomes impossible → 400, no exception
    activate_fault(op, "LOW-03")
    bump_file("lib/server/validation.ts")
    rejected = retry_until(
        lambda: op.post("/api/posts", {"content": "x", "tags": []}),
        lambda r: r[0] == 400,
    )
    check("LOW-03 short content rejected (400)", rejected[0] == 400, f"status={rejected[0]}")
    deactivate_fault(op, "LOW-03")
    bump_file("lib/server/validation.ts")
    accepted = retry_until(
        lambda: op.post("/api/posts", {"content": "x", "tags": []}),
        lambda r: r[0] == 201,
    )
    check("LOW-03 restored: short content accepted (201)", accepted[0] == 201, f"status={accepted[0]}")

    # MEDIUM-03 — ownership check inverted (no exception)
    activate_fault(op, "MEDIUM-03")
    bump_file("app/api/projects/[id]/route.ts")
    _, proj = op.post("/api/projects", {"name": f"M03-{int(time.time())}", "description": "medium-03 check", "status": "ACTIVE"})
    project_id = (proj.get("project") or {}).get("id")
    check("MEDIUM-03 create project", bool(project_id), json.dumps(proj))
    if project_id:
        _, denied = op.patch(f"/api/projects/{project_id}", {"name": "Owner update", "status": "ACTIVE"})
        check("MEDIUM-03 owner incorrectly denied (403)", denied and denied.get("error"), f"status={denied}")
        deactivate_fault(op, "MEDIUM-03")
        bump_file("app/api/projects/[id]/route.ts")
        allowed = retry_until(
            lambda: op.patch(f"/api/projects/{project_id}", {"name": "Owner update", "status": "ACTIVE"}),
            lambda r: r[0] == 200,
        )
        check("MEDIUM-03 restored: owner can edit (200)", allowed[0] == 200, f"status={allowed[0]}")

    # HIGH-02 — authorization guard disabled (no exception). Cross-user delete.
    meera, _, _ = login_as(MEERA["identifier"])
    activate_fault(op, "HIGH-02")
    bump_file("app/api/projects/[id]/route.ts")
    _, victim = meera.post("/api/projects", {"name": f"H02-victim-{int(time.time())}", "description": "guard bypass check"})
    victim_id = (victim.get("project") or {}).get("id")
    check("HIGH-02 victim project created by meera", bool(victim_id), json.dumps(victim))
    if victim_id:
        _, hijack = op.delete(f"/api/projects/{victim_id}")
        check("HIGH-02 guard OFF: arjun deletes meera project (200 bypass)", hijack.get("ok") is True,
              json.dumps(hijack))
    _, gate = meera.post("/api/projects", {"name": f"H02-gate-{int(time.time())}", "description": "guard check"})
    gate_id = (gate.get("project") or {}).get("id")
    deactivate_fault(op, "HIGH-02")
    bump_file("app/api/projects/[id]/route.ts")
    if gate_id:
        _, blocked = op.delete(f"/api/projects/{gate_id}")
        check("HIGH-02 restored: arjun cannot delete other user project (403)",
              blocked.get("error") is not None or not blocked.get("ok"), json.dumps(blocked))

    _, scan = scan_incidents(op)
    check("Behavioural faults produced no new ERROR-log incident", len(scan.get("created", [])) == 0,
          json.dumps(scan))


def main():
    global BASE
    parser = argparse.ArgumentParser(description="BuildHub REAL self-healing E2E")
    parser.add_argument("--quick", action="store_true", help="crash cycles only (skip behavioural)")
    args = parser.parse_args()
    BASE = urllib.parse.urljoin(os.environ.get("BASE_URL", BASE), "/").rstrip("/") or BASE

    print("# Phase 9 REAL self-healing E2E (HTTP-only)")
    op, status, _ = login_as(OPERATOR["identifier"])
    check("Operator login arjun → 200", status == 200, f"status={status}")
    if status != 200:
        sys.exit(1)
    pre_open = set(open_incident_ids(op))

    cleanup_status, cleanup = op.post("/api/faults", {"action": "deactivate-all"})
    check("Deactivate-all faults → 200", cleanup_status == 200, f"status={cleanup_status}")

    faults_status, faults = op.get("/api/faults")
    check("GET /api/faults → 200 + enabled",
          faults_status == 200 and faults.get("enabled") is True, f"status={faults_status}")
    check("9 faults registered", faults.get("total") == 9, f"got {faults.get('total')}")
    ids = [f.get("id") for f in faults.get("faults", [])]
    for fid in ALL_FAULTS:
        check(f"Fault registry has {fid}", fid in ids, "not found")

    print("\n=== Real failure → incident → engine (crash faults) ===")
    run_crash_cycle(
        op, "LOW-01",
        trigger=lambda: op.post("/api/posts", {"content": f"LOW-01 trigger {int(time.time())}", "tags": []}),
        expect_trigger=lambda r: r[0] == 500,
        verifier=lambda c: check(
            "LOW-01 repaired: post creation works (201)",
            c.post("/api/posts", {"content": f"LOW-01 verified {int(time.time())}", "tags": []})[0] == 201,
            "post-create after repair"),
        pre_open=pre_open,
    )
    run_crash_cycle(
        op, "MEDIUM-01",
        trigger=lambda: op.post("/api/posts", {"content": f"MEDIUM-01 trigger {int(time.time())}", "tags": []}),
        expect_trigger=lambda r: r[0] == 500,
        verifier=lambda c: check(
            "MEDIUM-01 repaired: post creation works (201)",
            c.post("/api/posts", {"content": f"MEDIUM-01 verified {int(time.time())}", "tags": []})[0] == 201,
            "post-create after repair"),
        pre_open=pre_open,
    )
    run_crash_cycle(
        op, "MEDIUM-02",
        trigger=lambda: op.get("/api/posts?pageSize=3"),
        expect_trigger=lambda r: r[0] == 500,
        verifier=lambda c: check(
            "MEDIUM-02 repaired: feed loads (200 + posts)",
            c.get("/api/posts?pageSize=3")[0] == 200,
            "feed after repair"),
        pre_open=pre_open,
    )
    run_crash_cycle(
        op, "HIGH-01",
        trigger=lambda: op.post("/api/auth/login", {"identifier": "arjun", "password": "wrong-password-for-high01"}),
        expect_trigger=lambda r: r[0] == 500,
        verifier=lambda c: (
            check("HIGH-01 repaired: wrong password → 401",
                  c.post("/api/auth/login", {"identifier": "arjun", "password": "wrong-password-for-high01"})[0] == 401,
                  "wrong-password after repair"),
            check("HIGH-01 repaired: correct password → 200",
                  c.post("/api/auth/login", {"identifier": "arjun", "password": DEMO_PASSWORD})[0] == 200,
                  "correct-password after repair"),
        ),
        pre_open=pre_open,
    )

    print("\n=== Merge behaviour ===")
    sleep(2)
    activate_fault(op, "LOW-01")
    sleep(2)
    pre_merge = set(open_incident_ids(op))
    z1, ok1 = trigger_until_failure(lambda: op.post("/api/posts", {"content": f"MERGE 1 {int(time.time())}", "tags": []}),
                                    lambda r: r[0] == 500)
    z2, ok2 = trigger_until_failure(lambda: op.post("/api/posts", {"content": f"MERGE 2 {int(time.time())}", "tags": []}),
                                    lambda r: r[0] == 500)
    check("Merge: two identical failures produced failure evidence", ok1 and ok2,
          f"status1={z1[0]} status2={z2[0]}")
    _, scan = scan_incidents(op)
    created = [c for c in scan.get("created", []) if c.get("id") not in pre_open and c.get("id") not in pre_merge]
    check("Two identical failures consolidate into ONE incident (created=1 or merged)",
          len(created) == 1 or scan.get("merged", 0) >= 1, json.dumps(scan))
    if created:
        _, merged = run_repair(op, created[0]["id"])
        check("Merged incident also repairs (RESOLVED)", merged.get("stage") == "RESOLVED",
              f"stage={merged.get('stage')}")
    op.post("/api/faults", {"action": "deactivate-all"})
    check("All faults clean after merge block", current_active(op) == 0, f"active={current_active(op)}")

    if not args.quick:
        run_behavioural_checks(op)

    strip_nudges()
    check("Final: no active faults (all repaired or restored)", current_active(op) == 0,
          f"active={current_active(op)}")

    print("\n" + "=" * 52)
    print(f"Self-Healing E2E: {_passed} passed, {_failed} failed")
    if _problems:
        print("Problems:")
        for p in _problems:
            print(f"  - {p}")
    raise SystemExit(1 if _failed else 0)


if __name__ == "__main__":
    main()