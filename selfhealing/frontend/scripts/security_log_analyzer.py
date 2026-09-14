#!/usr/bin/env python3
"""BuildHub Phase 8 — security log analyzer (pure Python stdlib, no deps).

Reads the JSON dump produced by `node scripts/dump-log-events.mjs` and emits
structured security findings for `POST /api/security/findings`.

Usage:
    node scripts/dump-log-events.mjs -o /tmp/logs.json
    python3 scripts/security_log_analyzer.py /tmp/logs.json > /tmp/findings.json

The analyzer is a dumb, pure emitter: it never touches the database and never
invents rows that are not present in the input dump. Correlation, deduplication
and incident creation are owned by Next.js.

Finding contract (must match AnalyzerFinding in lib/server/security.ts):
    ruleId, title, severity, endpoint, method, detail,
    windowStartMs, bucketKey, count, requestIds
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable, Iterable

CONTRACT_VERSION = 2

Event = dict[str, Any]


def parse_isodate(value: str) -> int:
    """ISO-8601 string -> epoch milliseconds (UTC). Accepts Node's 'Z' suffix."""
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def load_events(path: str) -> list[Event]:
    with open(path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    rows = payload.get("rows", []) if isinstance(payload, dict) else payload
    events: list[Event] = []
    for row in rows:
        events.append(
            {
                "ts": parse_isodate(row.get("createdAt", "")),
                "level": str(row.get("level", "")).upper(),
                "service": str(row.get("service", "")).lower(),
                "message": str(row.get("message", "")),
                "route": row.get("route") or None,
                "method": (row.get("method") or "GET").upper(),
                "status": row.get("status"),
                "error_code": row.get("errorCode") or None,
                "request_id": row.get("requestId") or None,
            }
        )
    events.sort(key=lambda ev: ev["ts"])
    return events


def find_bursts(
    events: Iterable[Event],
    key_func: Callable[[Event], str],
    window_ms: int,
    threshold: int,
) -> list[tuple[str, list[Event]]]:
    """Deterministic sliding-window burst detector.

    Returns one finding per distinct burst (greedy window consumption so
    overlapping windows do not emit duplicate findings for the same cluster).
    """
    groups: dict[str, list[Event]] = defaultdict(list)
    for ev in events:
        groups[key_func(ev)].append(ev)

    bursts: list[tuple[str, list[Event]]] = []
    for key, items in groups.items():
        items.sort(key=lambda ev: ev["ts"])
        start = 0
        while start < len(items):
            end = start
            while end < len(items) and items[end]["ts"] - items[start]["ts"] <= window_ms:
                end += 1
            if end - start >= threshold:
                bursts.append((key, items[start:end]))
                start = end
            else:
                start += 1
    return bursts


def _status(ev: Event, *values: int) -> bool:
    return ev["status"] in values


def _error_code(ev: Event, code: str) -> bool:
    return ev["error_code"] == code


def build_finding(
    rule_id: str,
    title: str,
    severity: str,
    window_events: list[Event],
    bucket_key: str,
    detail: str,
) -> dict[str, Any]:
    window_events.sort(key=lambda ev: ev["ts"])
    request_ids = [
        ev["request_id"]
        for ev in window_events
        if ev["request_id"] and len(ev["request_id"]) <= 128
    ]
    first = window_events[0]
    return {
        "ruleId": rule_id,
        "title": title,
        "severity": severity,
        "endpoint": first.get("route"),
        "method": first.get("method") if first.get("route") else None,
        "detail": detail,
        "windowStartMs": first["ts"],
        "bucketKey": bucket_key,
        "count": len(window_events),
        "requestIds": request_ids[:8],
    }


def analyze(events: list[Event]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    emitted: set[str] = set()

    def emit(rule_id: str, title: str, severity: str, window_events: list[Event],
             bucket_key: str, detail: str) -> None:
        dedupe_key = f"{rule_id}|{bucket_key}|{window_events[0]['ts']}"
        if dedupe_key in emitted:
            return
        emitted.add(dedupe_key)
        findings.append(build_finding(rule_id, title, severity, window_events, bucket_key, detail))

    # 1. Authentication failure burst (HIGH) — ≥3 AUTH_FAILED in 60 s/route.
    auth_failures = [ev for ev in events if _error_code(ev, "AUTH_FAILED")]
    for key, window in find_bursts(auth_failures, lambda ev: ev["route"] or "unknown", 60_000, 3):
        emit(
            "auth-failure-burst", "Authentication failure burst", "HIGH",
            window, key,
            f"{len(window)} AUTH_FAILED events on {key} within 60s —"
            " possible credential-stuffing attack.",
        )

    # 2. Repeated 401 (MEDIUM) — ≥5 rows with status 401 in 15 min.
    r401 = [ev for ev in events if _status(ev, 401)]
    for key, window in find_bursts(r401, lambda ev: ev["route"] or "unknown", 15 * 60_000, 5):
        emit(
            "repeated-401", "Repeated unauthenticated requests", "MEDIUM",
            window, key,
            f"{len(window)} HTTP 401 responses on {key} within 15 minutes.",
        )

    # 3. Repeated 403 (HIGH) — ≥5 rows with status 403 in 15 min.
    r403 = [ev for ev in events if _status(ev, 403)]
    for key, window in find_bursts(r403, lambda ev: ev["route"] or "unknown", 15 * 60_000, 5):
        emit(
            "repeated-403", "Repeated authorization denials", "HIGH",
            window, key,
            f"{len(window)} HTTP 403 responses on {key} within 15 minutes.",
        )

    # 4. Not-found burst (MEDIUM) — ≥8 rows with status 404 in 5 min.
    r404 = [ev for ev in events if _status(ev, 404)]
    for key, window in find_bursts(r404, lambda ev: ev["route"] or "unknown", 5 * 60_000, 8):
        emit(
            "not-found-burst", "Route probing / not-found burst", "MEDIUM",
            window, key,
            f"{len(window)} HTTP 404 responses on {key} within 5 minutes — endpoint scanning.",
        )

    # 5. Server-error spike (HIGH) — ≥5 ERROR-level rows in 5 min.
    errors = [ev for ev in events if ev["level"] == "ERROR"]
    for key, window in find_bursts(errors, lambda ev: ev["route"] or "unknown", 5 * 60_000, 5):
        emit(
            "server-error-spike", "Server-error spike", "HIGH",
            window, key,
            f"{len(window)} ERROR-level rows on {key} within 5 minutes.",
        )

    # 6. Invalid-request burst (MEDIUM) — ≥10 rows with status 400 in 10 min.
    r400 = [ev for ev in events if _status(ev, 400)]
    for key, window in find_bursts(r400, lambda ev: ev["route"] or "unknown", 10 * 60_000, 10):
        emit(
            "invalid-request-burst", "Invalid-request burst", "MEDIUM",
            window, key,
            f"{len(window)} HTTP 400 responses on {key} within 10 minutes.",
        )

    # 7. Request-frequency anomaly (MEDIUM) — >60 rows/min app-wide.
    for key, window in find_bursts(events, lambda _ev: "global", 60_000, 61):
        emit(
            "request-frequency-anomaly", "Request frequency anomaly", "MEDIUM",
            window, key,
            f"{len(window)} requests within one minute — abnormal traffic volume.",
        )

    # 8. Endpoint abuse (MEDIUM) — ≥15 auth-denied rows on one route+method in 10 min.
    denied = [ev for ev in events if _status(ev, 401, 403)]
    for key, window in find_bursts(denied, lambda ev: f"{ev['route'] or 'unknown'}|{ev['method']}", 10 * 60_000, 15):
        emit(
            "endpoint-abuse-pattern", "Endpoint abuse pattern", "MEDIUM",
            window, key,
            f"{len(window)} auth-denied responses for {key} within 10 minutes.",
        )

    # 9. Repeated unauthorized mutations (HIGH) — ≥5 401/403 POST/PUT/PATCH/DELETE
    #    rows on one route in 10 min.
    mutation_denied = [
        ev for ev in denied
        if ev["method"] in ("POST", "PUT", "PATCH", "DELETE")
    ]
    for key, window in find_bursts(mutation_denied, lambda ev: ev["route"] or "unknown", 10 * 60_000, 5):
        emit(
            "repeated-unauthorized-mutations", "Repeated unauthorized mutations", "HIGH",
            window, key,
            f"{len(window)} unauthorized {key} mutations within 10 minutes.",
        )

    # 10. Suspicious / payload-embedded input heuristics. These rules read ONLY
    #     the fields the logger stores (route, method, message) — request bodies
    #     are never persisted, so these are best-effort signal rules, not
    #     proof of exploitation. One finding per rule per endpoint+method.
    def payload_rule(rule_id: str, title: str, severity: str, regex: object) -> None:
        by_key: dict[str, list[Event]] = defaultdict(list)
        for ev in events:
            hay = f"{ev['route'] or ''} {ev['method'] or ''} {ev['message'] or ''}"
            if regex.search(hay):
                by_key[f"{ev['route'] or 'unknown'}|{ev['method'] or 'GET'}"].append(ev)
        for key, window in by_key.items():
            emit(
                rule_id, title, severity, window, key,
                f"{len(window)} matching row(s) for {key}.",
            )

    payload_rule(
        "path-traversal-input",
        "Path traversal-like input",
        "MEDIUM",
        re.compile(r"(?:^|[/?&;])\.\.+[/\\]?|%2e%2e|%252e%252e|\.\./|\.\.[\\/]", re.IGNORECASE),
    )
    payload_rule(
        "sql-injection-like-input",
        "SQL injection-like input",
        "MEDIUM",
        re.compile(
            r"(\bunion\b\s+\bselect\b)|('(\s*or\s*)?'[^=]*=')|('--)|(;\s*\bdrop\b\s+table)|(\bxp_cmdshell\b)|(information_schema)|(/\*.*\*/)|(\bsleep\s*\()",
            re.IGNORECASE,
        ),
    )
    payload_rule(
        "xss-like-input",
        "Cross-site scripting-like input",
        "MEDIUM",
        re.compile(r"(<script)|(javascript:)|(onerror\s*=)|(onload\s*=)|(%3cscript)|(<img)|(<svg)", re.IGNORECASE),
    )
    payload_rule(
        "command-injection-like-input",
        "Command injection-like input",
        "MEDIUM",
        re.compile(
            r"(\$\(\s*)|(`\s*(id|cat|ls|env))|((;|&&|\||\n)\s*(rm|cat|ls|nc|wget|curl|python|bash|sh)\b)|(chmod\s+\+x)|(--install-module)",
            re.IGNORECASE,
        ),
    )

    # 11. Sensitive-config / secret endpoint access (HIGH) — direct requests to
    #     well-known config or environment files.
    sensitive_paths = (
        "/.env", "/.git/config", "/config.json", "/application.yml", "/application.yaml",
        "/docker-compose.yml", "/docker-compose.yaml", "/.env.production", "/.env.local",
        "/proc/self/environ", "/etc/passwd", "/v1/config", "/.aws/credentials",
    )
    sensitive_hits: list[Event] = [
        ev for ev in events
        if ev["route"] and any(ev["route"].lower() == p or ev["route"].lower().endswith(p) for p in sensitive_paths)
    ]
    for ev in sensitive_hits:
        key = f"{ev['route'] or 'unknown'}|{ev['method'] or 'GET'}"
        emit(
            "sensitive-endpoint-access",
            "Sensitive endpoint access attempt",
            "HIGH",
            [ev],
            key,
            f"Request to {ev['route']} ({ev['method']}) — possible config/exposure probe.",
        )

    # 12. Server crash-loop (HIGH) — ≥3 rows with status 500 on the same route
    #     within 10 minutes (status-based complement to server-error-spike).
    status500 = [ev for ev in events if _status(ev, 500)]
    for key, window in find_bursts(status500, lambda ev: ev["route"] or "unknown", 10 * 60_000, 3):
        emit(
            "application-crash-loop",
            "Application crash-loop",
            "HIGH",
            window, key,
            f"{len(window)} HTTP 500 rows on {key} within 10 minutes.",
        )

    # 13. Secret-string leakage in SECURITY-level logs (HIGH) — only matches
    #     explicitly-tagged SECURITY rows so normal messages never trigger it.
    secret_re = re.compile(r"(password\s*[=:]|api[_-]?key\s*[=:]|secret\s*[=:]|DATABASE_URL\s*[=:])", re.IGNORECASE)
    secret_hits = [ev for ev in events if ev["level"] == "SECURITY" and secret_re.search(ev["message"] or "")]
    for ev in secret_hits:
        key = f"{ev['route'] or 'unknown'}|{ev['method'] or 'GET'}"
        emit(
            "secret-string-in-security-log",
            "Secret-like string in security log",
            "HIGH",
            [ev],
            key,
            "SECURITY-level log line contains a secret-like assignment pattern; verify the logger never persists real credentials.",
        )

    return findings


def main(argv: list[str]) -> int:
    if len(argv) < 1:
        print("usage: security_log_analyzer.py <log-dump.json>", file=sys.stderr)
        return 2
    path = argv[0]
    try:
        events = load_events(path)
    except FileNotFoundError:
        print(f"error: dump not found: {path}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as err:
        print(f"error: invalid JSON in dump: {err}", file=sys.stderr)
        return 2

    findings = analyze(events)
    print(json.dumps({"contractVersion": CONTRACT_VERSION, "count": len(findings), "findings": findings}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))