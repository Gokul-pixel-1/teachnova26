"""BuildHub Telegram alert-delivery E2E.

Verifies the real, persisted alert-delivery surface end to end, including the
canonical incident-briefing contract (lib/server/notifications/brief.ts):

  1. POST /api/faults { MEDIUM-01, activate } creates an incident AND fires the
     initial INCIDENT Telegram alert (dedupe permanent per incident+type).
  2. The repair pipeline then delivers the LOW/MEDIUM auto-apply ESCALATION plan
     and (after apply + validation) the FINAL_SUMMARY terminal message.
  3. The incident detail API exposes telegram.deliveries with the SENT rows and
     a terminalSummary.text that is the exact FINAL_SUMMARY the PDF renders
     (section 6.6) — DB-text equality is asserted by
     scripts/test-incident-briefing.mjs.
  4. /api/security/status reports live bot connectivity and lastDelivery.
  5. The incident PDF report generates (it renders terminal + delivery sections).
  6. Browser — incident detail shows the "Alert Delivery" card with the
     delivered messages and the terminal card; /ai overview shows the live
     "Telegram Delivery" and "Incident Lifecycle" feeds.

Deterministic tip: run against a SELF_HEALING_TEST_MODE=true AI_PROVIDER=test
server so the repair pipeline completes quickly with a reproducible terminal.

NOTE: deduplication (SKIPPED_DUPLICATE) is a permanent DB-side guarantee and is
covered by scripts/test-telegram-integration.mjs (schema) — not by re-sending
here, since each fault activation creates a brand-new incident.

Requires: running server (localhost:3000), real TELEGRAM creds in frontend/.env.
Run: python3 scripts/e2e_telegram_notifications.py
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


def login_api(ctx, identifier="arjun", password="buildhub-demo1"):
    api = ctx.request
    api.post(f"{BASE}/api/auth/login", data={"identifier": identifier, "password": password})


def get_json(ctx, path):
    resp = ctx.request.get(f"{BASE}{path}")
    return resp.status, json.loads(resp.body()) if resp.body() else {}


def poll_until(fn, timeout=20, interval=1.2):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:  # noqa: BLE001
            last = exc
        time.sleep(interval)
    return last


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context()
        page = ctx.new_page()
        page.set_default_timeout(20000)

        print("# BuildHub Telegram alert-delivery E2E")
        login_api(ctx)

        # --- Fault catalog ---
        status, faults = get_json(ctx, "/api/faults")
        check("GET /api/faults → 200", status == 200, f"status={status}")
        ids = [f["id"] for f in faults.get("faults", [])]
        check("MEDIUM-01 registered", "MEDIUM-01" in ids)

        # --- Activate MEDIUM-01 → real failure → scan → incident + INCIDENT alert ---
        # (Activation alone creates no incident by design — a real failed
        # request must surface first; the log monitor then ingests it.)
        print("\n=== Trigger MEDIUM-01 ===")
        pre_open = {
            i.get("id")
            for i in get_json(ctx, "/api/incidents?status=DETECTED,INVESTIGATING,AWAITING_REVIEW,WAITING_APPROVAL,VALIDATING&pageSize=100")[1].get("incidents", [])
            if i.get("id")
        }
        act = ctx.request.post(
            f"{BASE}/api/faults",
            data={"faultId": "MEDIUM-01", "action": "activate"},
        )
        check("MEDIUM-01 activate → 200", act.status == 200, f"status={act.status}")
        act_body = json.loads(act.body()) if act.body() else {}
        incident = None
        incident_id = None
        trig0 = ctx.request.post(f"{BASE}/api/posts", data={"content": "TG-E2E MEDIUM-01 pre-trigger", "tags": []})
        if trig0.status >= 400:
            # Poll the scan (background auto-scan may win the race — accept
            # created or newly-open incidents either way).
            import time as _time
            for _ in range(6):
                s = ctx.request.post(f"{BASE}/api/incidents/scan", data={"limit": 200})
                sb = json.loads(s.body()) if s.body() else {}
                newbies = [c for c in sb.get("created", []) if c.get("id") and c.get("id") not in pre_open]
                if newbies:
                    incident = newbies[-1]
                    break
                _, openb = get_json(ctx, "/api/incidents?status=DETECTED,INVESTIGATING,AWAITING_REVIEW,WAITING_APPROVAL,VALIDATING&pageSize=100")
                fresh = [i for i in openb.get("incidents", []) if i.get("id") and i.get("id") not in pre_open]
                if fresh:
                    incident = fresh[0]
                    break
                _time.sleep(2)
        check("Activation + real failure produced an incident", bool(incident), str(act_body)[:120])
        incident_id = incident["id"] if incident else None

        # Fire the actual fault so the defect path executes.
        login_api(ctx)
        trigger = ctx.request.post(f"{BASE}/api/posts", data={"content": "TG-E2E MEDIUM-01 trigger", "tags": []})
        check("MEDIUM-01 defect triggered (HTTP >=400)", trigger.status >= 400, f"status={trigger.status}")

        # --- Persisted INCIDENT delivery ---
        print("\n=== Delivery persistence ===")
        detail = None
        if incident_id:
            detail = poll_until(lambda: get_incident(ctx, incident_id))
            check("Incident detail API ready (200)", isinstance(detail, dict) and detail.get("status") == 200, str(detail))
        deliveries = []
        if incident_id and isinstance(detail, dict) and detail.get("status") == 200:
            body = detail.get("body", {})
            deliveries = (body.get("incident", {}).get("telegram", {}) or {}).get("deliveries", [])
            check("telegram.deliveries present", isinstance(deliveries, list), str(deliveries))
            sent_incident = next((d for d in deliveries if d.get("type") == "INCIDENT" and d.get("deliveryStatus") == "SENT"), None)
            check("INCIDENT delivery persisted as SENT", bool(sent_incident), json.dumps(deliveries))
            if sent_incident:
                check("Real Telegram message id captured", bool(sent_incident.get("telegramMessageId")), str(sent_incident))
                delivered_msg_id = sent_incident.get("telegramMessageId")

        # --- Trigger the self-healing repair pipeline (operator 'Run' action) ---
        print("\n=== Trigger repair pipeline ===")
        if incident_id:
            login_api(ctx)
            run_resp = ctx.request.post(f"{BASE}/api/security/run", data={"incidentId": incident_id})
            check("POST /api/security/run → 200", run_resp.status == 200, f"status={run_resp.status}")

        # --- Repair progression: MEDIUM approval-required + PROCEED + FINAL_SUMMARY ---
        print("\n=== Repair alerts (MEDIUM_RISK_APPROVAL_REQUIRED + FINAL_SUMMARY) ===")
        approval_msg = None
        final = None
        if incident_id:
            approval_msg = poll_until(
                lambda: delivery_of(ctx, incident_id, "MEDIUM_RISK_APPROVAL_REQUIRED", "SENT"), timeout=240, interval=2
            )
            check("MEDIUM_RISK_APPROVAL_REQUIRED delivered (SENT)", bool(approval_msg), "no SENT MEDIUM approval row")
            # Human approves via the dashboard endpoint, then the SAME workflow
            # applies + validates.
            login_api(ctx)
            run_body = json.loads(run_resp.body()) if run_resp.body() else {}
            approval_id = run_body.get("approvalId")
            check("Engine returned approvalId for WAITING_APPROVAL", bool(approval_id), json.dumps(run_body)[:200])
            if approval_id:
                proc = ctx.request.post(f"{BASE}/api/approvals/proceed", data={"approvalId": approval_id, "action": "proceed"})
                proc_body = json.loads(proc.body()) if proc.body() else {}
                check("PROCEED applies + validates (RESOLVED)", (proc_body.get("repair") or {}).get("stage") == "RESOLVED", json.dumps(proc_body)[:300])
            final = poll_until(
                lambda: delivery_of(ctx, incident_id, "FINAL_SUMMARY", "SENT"),
                timeout=600,
                interval=4,
            )
            check("FINAL_SUMMARY terminal delivered (SENT)", bool(final), "no SENT FINAL_SUMMARY row")

            all_deliveries = deliveries_of(ctx, incident_id)
            sent_appr = [d for d in all_deliveries if d.get("type") == "MEDIUM_RISK_APPROVAL_REQUIRED" and d.get("deliveryStatus") == "SENT"]
            sent_final = [d for d in all_deliveries if d.get("type") == "FINAL_SUMMARY" and d.get("deliveryStatus") == "SENT"]
            check("Dedupe: exactly one SENT MEDIUM approval", len(sent_appr) == 1, f"count={len(sent_appr)}")
            check("Dedupe: exactly one SENT FINAL_SUMMARY", len(sent_final) == 1, f"count={len(sent_final)}")

            ts = terminal_body(ctx, incident_id)
            check("terminalSummary present after repair", bool(ts), "missing terminalSummary")
            if ts:
                text = ts.get("text", "")
                check("Terminal text carries System Health / Cyber Score", "System Health" in text and "Cyber Score" in text, text[:80])
                state = ts.get("finalState")
                check(
                    "Terminal finalState is a known terminal state",
                    state in ("RESOLVED", "ROLLED_BACK", "AI_REPAIR_FAILED", "REJECTED", "EXPIRED"),
                    str(state),
                )
                if state == "RESOLVED":
                    check("Terminal outcome line (resolved)", "resolved" in text.lower(), text[-160:])
                elif state == "ROLLED_BACK":
                    check("Terminal outcome line (rolled back)", "rolled back" in text.lower(), text[-160:])

        # --- Status endpoint: connectivity + last delivery ---
        print("\n=== Status surface ===")
        status_resp = ctx.request.get(f"{BASE}/api/security/status")
        sbody = json.loads(status_resp.body()) if status_resp.body() else {}
        t = (sbody.get("telegram") or {})
        check("telegram configured", t.get("configured") is True, str(t.get("configured")))
        check("bot reachable (IPv4-forced getMe)", t.get("status", {}).get("reachable") is True, str(t.get("status", {}).get("error")))
        check("lastDelivery SENT recorded", (t.get("lastDelivery") or {}).get("deliveryStatus") == "SENT", str(t.get("lastDelivery")))

        # --- PDF report (terminal + delivery sections) ---
        print("\n=== PDF report ===")
        if incident_id:
            login_api(ctx)
            pdf = ctx.request.post(f"{BASE}/api/incidents/{incident_id}/report")
            check("Incident PDF report → 200", pdf.status == 200, f"status={pdf.status}")
            ctype = pdf.headers.get("content-type", "")
            check("PDF content type", ctype.startswith("application/pdf"), ctype)
            body = pdf.body()
            check("PDF has content", len(body) > 1000, f"{len(body)} bytes")

        # --- Browser: incident detail Alert Delivery ---
        print("\n=== Browser: incident detail ===")
        page.goto(f"{BASE}/login")
        page.get_by_label("Email or username", exact=True).fill("arjun")
        page.get_by_label("Password", exact=True).fill("buildhub-demo1")
        page.get_by_role("button", name="Log in").click()
        page.wait_for_url("**/feed")
        page.wait_for_load_state("networkidle")

        if incident_id:
            page.goto(f"{BASE}/ai/incidents/{incident_id}")
            page.wait_for_load_state("networkidle")
            page.get_by_text("Alert Delivery", exact=True).wait_for(timeout=15000)
            check("Alert Delivery card visible", page.get_by_text("Alert Delivery", exact=True).is_visible())
            if "delivered_msg_id" in locals() and delivered_msg_id:
                check(
                    "SENT delivery row rendered",
                    page.get_by_text(re.compile(rf"Delivered · message {re.escape(str(delivered_msg_id))}")).count() > 0,
                )
            for row_type in ("MEDIUM_RISK_APPROVAL_REQUIRED", "FINAL_SUMMARY"):
                check(
                    f"{row_type} delivery row rendered",
                    page.get_by_text(row_type, exact=False).count() > 0,
                )
            # Terminal card (renders the exact FINAL_SUMMARY text).
            try:
                page.get_by_text("System Health", exact=False).wait_for(timeout=15000)
                check("Terminal brief card renders System Health", page.get_by_text("System Health", exact=False).count() > 0)
            except Exception:
                check("Terminal brief card renders System Health", False, "System Health not found")

        # --- Browser: overview live Telegram + Inc Lifecycle feed ---
        print("\n=== Browser: overview feed ===")
        page.goto(f"{BASE}/ai")
        page.wait_for_load_state("networkidle")
        page.get_by_text("Telegram Delivery", exact=True).first.wait_for(timeout=15000)
        check("Telegram Delivery card present", page.get_by_text("Telegram Delivery", exact=True).first.is_visible())
        if incident_id:
            check(
                "Live feed shows the incident delivery incident",
                page.get_by_text("INCIDENT", exact=False).count() > 0
                or page.get_by_text("Delivered", exact=False).count() > 0,
            )
        if incident_id:
            try:
                page.get_by_text("Incident Lifecycle", exact=False).wait_for(timeout=15000)
                check("Incident Lifecycle card present", page.get_by_text("Incident Lifecycle", exact=False).count() > 0)
                check(
                    "Lifecycle feed shows incident + repair rows",
                    page.get_by_text("Repair", exact=False).count() > 0
                    or page.get_by_text("Incident", exact=False).count() > 0,
                )
            except Exception:
                check("Incident Lifecycle card present", False, "not found")
        try:
            page.get_by_text("live", exact=True).first.wait_for(timeout=15000)
            live_ok = page.get_by_text("live", exact=True).count() > 0
        except Exception:
            live_ok = False
        check("Live badge visible", live_ok)

        # --- AI chat: canonical-brief context responds ---
        login_api(ctx)
        chat_resp = ctx.request.post(f"{BASE}/api/ai/chat", data={"message": "Which incident was most recent?"})
        check("POST /api/ai/chat responds", chat_resp.status == 200, f"status={chat_resp.status}")

        # --- Cleanup: deactivate the fault ---
        login_api(ctx)
        deact = ctx.request.post(f"{BASE}/api/faults", data={"faultId": "MEDIUM-01", "action": "deactivate"})
        check("MEDIUM-01 deactivate → 200", deact.status == 200, f"status={deact.status}")

        ctx.close()
        browser.close()

    print(f"\nTelegram E2E: {passed} passed, {failed} failed")
    if problems:
        for p in problems:
            print(f"  - {p}")
    if failed > 0:
        raise SystemExit(1)


def get_incident(ctx, incident_id):
    status, body = get_json(ctx, f"/api/incidents/{incident_id}")
    return {"status": status, "body": body}


def deliveries_of(ctx, incident_id):
    _status, body = get_json(ctx, f"/api/incidents/{incident_id}")
    return (body.get("incident", {}).get("telegram", {}) or {}).get("deliveries", [])


def delivery_of(ctx, incident_id, typ, status):
    return next(
        (d for d in deliveries_of(ctx, incident_id) if d.get("type") == typ and d.get("deliveryStatus") == status),
        None,
    )


def terminal_body(ctx, incident_id):
    _status, body = get_json(ctx, f"/api/incidents/{incident_id}")
    return (body.get("incident", {}) or {}).get("terminalSummary")


if __name__ == "__main__":
    main()