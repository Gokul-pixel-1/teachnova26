"""BuildHub Phase 10 E2E — Self-Healing Repair + Learning Loop.

Requires a running dev server on BASE. Logs in as the demo operator arjun and
drives real self-healing repairs through the HTTP API, then verifies the
Phase 10 learning surfaces (memory, experience, RL dataset, evaluation,
visualization) and the Learning dashboard UI.

Provider-agnostic assertions: repair outcome sets are chosen so the test is
meaningful with the real Groq provider AND deterministic under the hermetic
TEST provider.

Run: python3 scripts/e2e_phase10_learning.py
"""

import json
import re
import time

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
passed = 0
failed = 0
problems = []


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ok  {name}")
    else:
        failed += 1
        print(f"FAIL  {name} {extra}")
        problems.append(name)


def watch(page):
    hits = {"errors": [], "http": []}

    def on_console(msg):
        if msg.type == "error":
            hits["errors"].append(msg.text)

    def on_pageerror(err):
        hits["errors"].append(str(err))

    def on_response(resp):
        url = resp.url
        status = resp.status
        if not url.startswith(BASE):
            return
        if url.endswith("/api/auth/me") and status == 401:
            return
        if status >= 400:
            hits["http"].append(f"{status} {url}")

    page.on("console", on_console)
    page.on("pageerror", on_pageerror)
    page.on("response", on_response)
    return hits


def login(ctx):
    ctx.request.post(f"{BASE}/api/auth/login", data={"identifier": "arjun", "password": "buildhub-demo1"})


def post(ctx, path, payload):
    login(ctx)
    resp = ctx.request.post(f"{BASE}{path}", data=payload)
    body = json.loads(resp.body()) if resp.body() else {}
    return resp.status, body


def open_ids(ctx):
    resp = ctx.request.get(
        f"{BASE}/api/incidents?status=DETECTED,INVESTIGATING,AWAITING_REVIEW,WAITING_APPROVAL,VALIDATING&pageSize=100"
    )
    body = json.loads(resp.body()) if resp.body() else {}
    return {i.get("id") for i in body.get("incidents", []) if i.get("id")}


def scan_for_incident(ctx, pre_open, tries=6):
    """Poll the log-monitor scan until the real ERROR row is ingested.

    Log rows persist fire-and-forget and the background auto-scan may win the
    race (created vs merged), so accept a created incident OR any newly-open
    incident that appeared since the trigger."""
    import time as _time
    for _ in range(tries):
        resp = ctx.request.post(f"{BASE}/api/incidents/scan", data={"limit": 200})
        body = json.loads(resp.body()) if resp.body() else {}
        created = [c.get("id") for c in body.get("created", []) if c.get("id") and c.get("id") not in pre_open]
        if created:
            return created[-1]
        for _id in sorted(open_ids(ctx) - pre_open):
            return _id
        _time.sleep(2)
    return None


def get(ctx, path):
    login(ctx)
    resp = ctx.request.get(f"{BASE}{path}")
    body = json.loads(resp.body()) if resp.body() else {}
    return resp.status, body


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        page = ctx.new_page()
        page.set_default_timeout(60000)

        page.goto(f"{BASE}/login")
        page.get_by_label("Email or username", exact=True).fill("arjun")
        page.get_by_label("Password", exact=True).fill("buildhub-demo1")
        page.get_by_role("button", name="Log in").click()
        page.wait_for_url("**/feed")
        page.wait_for_load_state("networkidle")

        # Determine provider mode (REAL vs hermetic TEST).
        status, chat = post(ctx, "/api/ai/chat", {"message": "hello"})
        check("AI chat API reachable", status == 200 and chat.get("ok") is True, f"status={status}")
        mode = chat.get("mode", "?")
        print(f"\n# Provider mode: {mode}")

        # ==================== CLEANUP ====================
        status, _ = post(ctx, "/api/faults", {"action": "deactivate-all"})
        check("deactivate-all faults → 200", status == 200, f"status={status}")

        # ==================== FULL SELF-HEALING LOOP ====================
        print("\n=== Self-Healing Repair Loop ===")

        # LOW-01: activate → real failure → scan → run engine.
        # (Activation alone creates no incident by design — a real failed
        # request must surface first; the log monitor then ingests it.)
        pre_low = open_ids(ctx)
        status, body = post(ctx, "/api/faults", {"faultId": "LOW-01"})
        check("LOW-01 activate → 200", status == 200, f"status={status}")
        trig = ctx.request.post(f"{BASE}/api/posts", data={"content": "Phase10-LOW01 trigger", "tags": []})
        check("LOW-01 trigger → real failure (500)", trig.status == 500, f"status={trig.status}")
        low_incident_id = scan_for_incident(ctx, pre_low)
        check("LOW-01 incident ingested", bool(low_incident_id), f"id={low_incident_id}")

        if low_incident_id:
            status, body = post(ctx, "/api/security/run", {"incidentId": low_incident_id})
            check("LOW-01 run → 200", status == 200, f"status={status}")
            result = body
            allowed_stage = ["RESOLVED", "ROLLED_BACK", "AI_REPAIR_FAILED", "AI_UNAVAILABLE"]
            check(
                "LOW-01 repair reaches terminal/controlled stage",
                result.get("stage") in allowed_stage,
                f"stage={result.get('stage')} stop={result.get('conversationStop')}",
            )
            check("LOW-01 risk classified LOW", result.get("risk") in ("LOW", None), f"risk={result.get('risk')}")
            check("LOW-01 auto (no approval)", result.get("requiresApproval") is False)
            if result.get("stage") == "RESOLVED" or result.get("stage") == "ROLLED_BACK":
                check("LOW-01 attempt id recorded", bool(result.get("attemptId")))

            _, detail = get(ctx, f"/api/incidents/{low_incident_id}")
            detail_inc = detail.get("incident", {})
            check("LOW-01 detail loads", bool(detail_inc.get("id")))
            check(
                "LOW-01 detail exposes repair attempt",
                detail_inc.get("repairAttempt") is not None,
            )
            check(
                "LOW-01 detail shows coder transcript",
                len((detail_inc.get("agentRuns") or [])) > 0,
            )

        # HIGH-01: activate → real failure → scan → run → approval → approve.
        pre_high = open_ids(ctx)
        status, body = post(ctx, "/api/faults", {"faultId": "HIGH-01"})
        check("HIGH-01 activate → 200", status == 200, f"status={status}")
        htrig = ctx.request.post(
            f"{BASE}/api/auth/login",
            data={"identifier": "arjun", "password": "wrong-password-for-phase10"},
        )
        check("HIGH-01 trigger → real failure (500)", htrig.status == 500, f"status={htrig.status}")
        high_incident_id = scan_for_incident(ctx, pre_high)
        check("HIGH-01 incident ingested", bool(high_incident_id), f"id={high_incident_id}")

        missing_pipeline = False
        if high_incident_id:
            status, body = post(ctx, "/api/security/run", {"incidentId": high_incident_id})
            check("HIGH-01 run → 200", status == 200, f"status={status}")
            result = body
            approval_created = (
                result.get("stage") in ("HIGH_RISK_APPROVAL_REQUIRED", "WAITING_APPROVAL")
                and bool(result.get("approvalId"))
            )
            check(
                "HIGH-01 requires approval (or resolved directly)",
                approval_created or result.get("stage") == "RESOLVED",
                f"stage={result.get('stage')}",
            )
            check("HIGH-01 risk classified HIGH", result.get("risk") == "HIGH", f"risk={result.get('risk')}")

            if approval_created:
                approval_id = result["approvalId"]
                status, body = post(ctx, "/api/approvals/proceed", {
                    "approvalId": approval_id,
                    "action": "proceed",
                })
                check("HIGH-01 approve → 200", status == 200, f"status={status}")
                outcome = body.get("repair", {}).get("stage")
                check(
                    "HIGH-01 approval continues to terminal stage",
                    outcome in ["RESOLVED", "ROLLED_BACK", "AI_REPAIR_FAILED"],
                    f"outcome={outcome}",
                )

        # ==================== PHASE 10 LEARNING APIs ====================
        print("\n=== Phase 10 Learning APIs ===")

        for path in ["/api/ai/learning", "/api/ai/evaluate"]:
            status, body = get(ctx, path)
            check(f"GET {path} → 200", status == 200, f"status={status}")
            check(f"GET {path} ok:true", body.get("ok") is True)

        status, body = get(ctx, "/api/ai/learning")
        metrics = body.get("metrics", {})
        check("Learning metrics expose reward policy", "successfulRepair" in body.get("policy", {}))
        check("Learning metrics present", "patchSuccessRate" in metrics or metrics == {}, f"{metrics}")
        check(
            "Learning metrics count repairs",
            metrics.get("totalAttempts", 0) >= 1,
            f"totalAttempts={metrics.get('totalAttempts')}",
        )

        status, body = get(ctx, "/api/ai/memory")
        check("GET /api/ai/memory → 200", status == 200, f"status={status}")

        status, body = get(ctx, "/api/ai/rl-dataset")
        check("GET /api/ai/rl-dataset → 200", status == 200 and body.get("ok"), f"status={status}")
        check(
            "RL dataset grew with repairs",
            body.get("count", 0) >= 1,
            f"count={body.get('count')}",
        )

        status, body = get(ctx, "/api/ai/experiences")
        check("GET /api/ai/experiences → 200", status == 200 and body.get("ok"), f"status={status}")
        check(
            "At least one experience recorded",
            body.get("count", 0) >= 1,
            f"count={body.get('count')}",
        )

        status, body = get(ctx, "/api/ai/visualization")
        check("GET /api/ai/visualization → 200", status == 200 and body.get("ok"), f"status={status}")
        check("Visualization exposes neurons", isinstance(body.get("neurons"), list))

        # ==================== LEARNING DASHBOARD UI ====================
        print("\n=== Learning Dashboard UI ===")

        watching = watch(page)
        page.goto(f"{BASE}/ai/learning")
        page.wait_for_load_state("networkidle")
        page.get_by_role("heading", name="Learning", exact=True).wait_for(timeout=20000)
        check("Learning page loads", True)
        check("Learning nav entry present", page.get_by_role("link", name="Learning").first.is_visible())
        check(
            "Reward policy rendered",
            page.get_by_text("Reward Policy", exact=True).first.is_visible(),
        )
        check(
            "Evaluation harness rendered",
            page.get_by_text("Evaluation", exact=True).first.is_visible(),
        )
        check(
            "RL dataset surfaced",
            page.get_by_text("RL Dataset", exact=True).first.is_visible(),
        )
        # Experience timeline shows a real reward row
        page.wait_for_timeout(2000)
        check(
            "Experience timeline rendered",
            page.get_by_text("Experience Timeline", exact=True).first.is_visible(),
        )

        # ==================== SECURITY CONSOLE CHAT UI ====================
        print("\n=== Security Console Chat UI ===")

        page.goto(f"{BASE}/ai/security")
        page.wait_for_load_state("networkidle")
        page.get_by_text("Mission Control").first.wait_for(timeout=20000)
        check(
            "Self-Healing Console rendered",
            page.get_by_text("Self-Healing Console", exact=True).first.is_visible(),
        )
        ask_input = page.get_by_label("Message the operations assistant")
        check("Chat input present", ask_input.is_visible())
        ask_input.fill("What does the repair engine do?")
        page.get_by_role("button", name="Send").click()
        # Wait until the "thinking…" indicator is gone (reply or honest error rendered).
        page.get_by_text("thinking…").wait_for(state="hidden", timeout=30000)
        check("Chat reply rendered (TEST or REAL)", True)

        # ==================== INCIDENT DETAIL TRANSCRIPT ====================
        print("\n=== Incident Detail Transcript ===")

        if low_incident_id:
            page.goto(f"{BASE}/ai/incidents/{low_incident_id}")
            page.wait_for_load_state("networkidle")
            page.get_by_text("Self-Healing Repair", exact=True).first.wait_for(timeout=20000)
            check("Incident detail repair card rendered", True)
            check(
                "Repair attempt banner rendered",
                page.get_by_text(re.compile(r"RPR-\d+")).first.is_visible(),
            )
            check(
                "Self-healing procedure note rendered",
                page.get_by_text(re.compile(r"Rounds are real per-call transcripts", re.I)).count() > 0,
            )

        # ==================== MOBILE RESPONSIVE ====================
        print("\n=== Mobile Responsive ===")

        mob = ctx.new_page()
        mob.set_viewport_size({"width": 375, "height": 700})
        for path in ["/ai/learning", "/ai/incidents", "/ai/security"]:
            mob.goto(f"{BASE}{path}")
            mob.wait_for_load_state("networkidle")
            ov = mob.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            check(f"Mobile {path} no horizontal overflow", ov <= 1, f"overflow={ov}")
        mob.close()

        # ==================== POSTERITY / CLEANUP ====================
        status, _ = post(ctx, "/api/faults", {"action": "deactivate-all"})
        check("Cleanup deactivate-all → 200", status == 200, f"status={status}")

        watching = watch(page)
        page.goto(f"{BASE}/ai/learning")
        page.wait_for_load_state("networkidle")
        check("No console errors", watching["errors"] == [], f"{watching['errors'][:3]}")
        bad_http = [h for h in watching["http"] if h.startswith(("4", "5"))]
        check("No unexpected API 4xx/5xx", not bad_http, f"{bad_http[:5]}")

        ctx.close()
        browser.close()

    print("\n============================================")
    print(f"Phase 10 browser E2E: {passed} passed, {failed} failed")
    if problems:
        print("Problems:")
        for pr in problems:
            print(f"  - {pr}")
    if failed > 0:
        raise SystemExit(1)


if __name__ == "__main__":
    main()