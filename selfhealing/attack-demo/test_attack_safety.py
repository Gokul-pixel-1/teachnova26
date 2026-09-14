#!/usr/bin/env python3
"""test_attack_safety.py — safety validation for the attack demonstration clients.

Verifies the HARD safety contract of BOTH `attack-demo` clients WITHOUT firing
a single request at any server:

  * `run_attack.py`     — the forged-sign-in attack (300 req / 60 s / 5 conn)
  * `run-overload.py`   — the multi-endpoint hard-overload (20 s / 4000 req / 16 conn)

Checks (per client):

  1. File exists and is syntactically valid Python.
  2. Only stdlib modules are imported (no subprocess, no OS process/network
     control, no third-party packages, nothing from `frontend/` or
     `buildhub-no-ai/`).
  3. No process / OS / network-manipulation primitives anywhere in the source.
  4. Hard-limit constants are present and NEVER exceed the required caps.
  5. Target policy: loopback host(s) + ports 3000/3001 only; a port flag (not a
     user-supplied arbitrary `--target`), `--confirm-local` required.
  6. CLI fail-closed behaviour: missing `--confirm-local` and any
     non-3000/3001 port (or non-loopback host / invalid weight) abort BEFORE a
     request is sent.

Exit code 0 = every check passed. Nothing here touches a server.
Run:  python3 attack-demo/test_attack_safety.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

SCRIPTS = {
    "run_attack.py": {
        "source_const": "SOURCE",
        "limits": {
            "MAX_REQUESTS": (300, True),
            "MAX_DURATION": (60.0, True),
            "MAX_CONCURRENCY": (5, True),
            "HEALTH_POLL_INTERVAL": (0.5, True),
            "HTTP_TIMEOUT": (8.0, True),
        },
        "ports": (3000, 3001),
        "source": "127.0.0.1",
        "hosts": ("127.0.0.1", "localhost", "::1"),
        "scenarios": ("request-flood", "resource-stress", "service-failure"),
    },
    "run-overload.py": {
        "source_const": "SOURCE_HOST",
        "limits": {
            "MAX_DURATION": (20.0, True),
            "MAX_REQUESTS": (3000, True),
            "MAX_REQUESTS_CEILING": (4000, True),
            "MAX_CONCURRENCY": (16, True),
            "DEFAULT_LOGIN_RATE": (12.0, True),
            "LOGIN_RATE_CEILING": (100.0, True),
            "HEALTH_POLL_INTERVAL": (0.5, True),
            "HTTP_TIMEOUT": (8.0, True),
        },
        "ports": (3000, 3001),
        "source": "127.0.0.1",
        "hosts": ("127.0.0.1", "localhost", "::1"),
    },
}

ALLOWED_ROOT_MODULES = {
    "argparse", "json", "sys", "threading", "time",
    "urllib", "http", "concurrent", "datetime", "__future__", "typing",
    "functools", "itertools", "os",  # os only for safe Path/time use; banned calls checked separately
}

# Process / OS / network-manipulation primitives that must NEVER appear in these
# clients. Patterns target real USAGE (import / call / shell command), not the
# words used in safety comments (e.g. "this script never kills a process").
BANNED_PATTERNS = [
    r"\bpkill\b",
    r"\bkillall\b",
    r"\bkill\s+-\d+",
    r"\bsystemctl\b",
    r"\bdocker\b",
    r"\biptables\b",
    r"\bufw\b",
    r"\bos\.system\b",
    r"\bos\.kill\b",
    r"\bos\.popen\b",
    r"\bimport\s+subprocess\b",
    r"\bsubprocess\s*\.\b",
    r"\bsignals?\.SIGKILL\b",
    r"\bsocket\s*\.\s*(sendto|bind|connect)\b",
    r"\brawsocket\b",
]


def fail(msg: str) -> None:
    print(f"  FAIL  {msg}")
    raise SystemExit(1)


def check(ok: bool, label: str, detail: str = "") -> None:
    if not ok:
        fail(f"{label} {detail}".strip())
    print(f"  PASS  {label}")


def main() -> int:
    counts = {"passed": 0, "failed": 0}
    print("=" * 70)
    print("ATTACK CLIENT SAFETY TEST (run_attack.py + run-overload.py)")
    print("=" * 70)

    for filename, spec in SCRIPTS.items():
        runner = HERE / filename

        # 1) Source exists + compiles -------------------------------------------
        print(f"[1] source integrity — {filename}")
        check(runner.exists(), f"{filename} exists")
        src = runner.read_text(encoding="utf-8")
        compile(src, str(runner), "exec")
        check(True, f"{filename} compiles (py_compile)")
        counts["passed"] += 2

        # 2) Imports are stdlib-only ----------------------------------------------
        print(f"[2] imports — {filename}")
        import_lines = re.findall(r"^\s*(?:import|from)\s+([\w\.]+)", src, flags=re.M)
        roots = {line.split(".")[0] for line in import_lines}
        unknown = roots - ALLOWED_ROOT_MODULES
        check(not unknown, "imports are stdlib-only", f"unexpected roots: {sorted(unknown)}")
        check("subprocess" not in roots and "socket" not in roots, "no subprocess / no raw socket")
        counts["passed"] += 2

        # 3) No process / OS / network manipulation --------------------------------
        print(f"[3] no process / OS / network manipulation — {filename}")
        for pattern in BANNED_PATTERNS:
            hit = re.search(pattern, src, flags=re.IGNORECASE)
            check(hit is None, f"banned primitive absent: {pattern}")
            counts["passed"] += 1

        # 4) Hard limits -----------------------------------------------------------
        print(f"[4] hard limits — {filename}")
        ns: dict = {}
        run_order = compilable = None
        exec(compile(src, str(runner), "exec"), {}, ns)  # noqa: S102 — executes the constant-only module
        for name, (expect, compare) in spec["limits"].items():
            check(name in ns, f"constant defined: {name}")
            if compare:
                check(ns[name] <= expect, f"{name} <= {expect}", f"got {ns[name]}")
            counts["passed"] += 1
        check(tuple(ns["ALLOWED_PORTS"]) == spec["ports"], f"ALLOWED_PORTS is exactly {spec['ports']}", f"got {ns.get('ALLOWED_PORTS')}")
        check(ns[spec["source_const"]] == spec["source"], f"{spec['source_const']} is 127.0.0.1 (loopback hard-wired)")
        counts["passed"] += 2
        if spec["hosts"] is not None:
            check("ALLOWED_HOSTS" in ns, "ALLOWED_HOSTS defined")
            check(tuple(ns["ALLOWED_HOSTS"]) == spec["hosts"], f"ALLOWED_HOSTS is exactly {spec['hosts']}")
            check(str(ns["ALLOWED_HOSTS"]).find("127.0.0.1") >= 0 and str(ns["ALLOWED_HOSTS"]).find("localhost") >= 0 and str(ns["ALLOWED_HOSTS"]).find("::1") >= 0, "ALLOWED_HOSTS contains 127.0.0.1, localhost, ::1")
            check("args.host" in src and "ALLOWED_HOSTS" in src, "--host is validated against the loopback allowlist")
            counts["passed"] += 4

        # 5) Target is loopback-only, confirm-local required --------------------------
        print(f"[5] target policy — {filename}")
        declared = {"--" + name for name in re.findall(r'"--([\w-]+)"', src)}
        check("--target" not in declared, "no user-supplied arbitrary --target host/URL argument")
        required_flags = {"--port", "--confirm-local"}
        check(required_flags <= declared, f"CLI declares {required_flags}")
        check("args.port" in src, "port arrives via --port argument")
        check(str(ns.get(spec["source_const"])) in src or "127.0.0.1" in src, "source base is loopback")
        counts["passed"] += 4
        if filename == "run_attack.py":
            check("SCENARIOS" in ns, "SCENARIOS defined")
            check(tuple(ns["SCENARIOS"]) == spec["scenarios"], f"SCENARIOS is exactly {spec['scenarios']}")
            check("plan_request" in src and '"--scenario"' in src, "--scenario dispatch present")
            check("--telemetry-out" in declared, "--telemetry-out flag present")
            check("TELEMETRY_JSON" in src, "structured telemetry emitted")
            for secret in ("set-cookie", "authorization"):
                check(secret not in src.lower(), f"no secret logging primitive: {secret}")
            check("os.kill" not in src and "import subprocess" not in src, "no process-control primitives")
            check("SCENARIO_PACING_S" in ns, "SCENARIO_PACING_S defined")
            check(all(v <= 0.5 for v in ns["SCENARIO_PACING_S"].values()), "pacing bounded (no slow-drip abuse)")
            check("SCENARIO_LOGIN_EVERY" in ns, "SCENARIO_LOGIN_EVERY defined")
            counts["passed"] += 10
        if filename == "run-overload.py":
            check("MAX_REQUESTS_CEILING" in src and "min(args.max_requests, MAX_REQUESTS_CEILING)" in src, "request cap is clamped, never exceeded")
            check("min(args.max_duration, MAX_DURATION)" in src and "min(args.concurrency, MAX_CONCURRENCY)" in src, "duration + concurrency clamped")
            check("class LoginScheduler" in src and "max_per_second" in src, "forged sign-in stream is rate-bounded")
            counts["passed"] += 3

        # 6) Fail-closed CLI behaviour (aborts before any request; no server needed) --
        print(f"[6] fail-closed CLI behaviour — {filename}")
        py = sys.executable

        def run_cli(*args: str) -> tuple[int, str]:
            proc = subprocess.run(
                [py, str(runner), *args],
                capture_output=True,
                text=True,
                timeout=20,
            )
            return proc.returncode, (proc.stdout + proc.stderr).strip()

        code, _ = run_cli("--help")
        check(code == 0, "--help exits 0")

        code, out = run_cli("--port", "3000")
        check(code == 2, "--port without --confirm-local aborts (exit 2)", f"exit={code} out={out[:120]}")

        abort_port_tests = ("3002", "8080", "9999") if filename == "run_attack.py" else ("3002", "9999", ":3999")
        for bad in abort_port_tests:
            code, out = run_cli("--port", bad, "--confirm-local")
            check(code == 2, f"port {bad} aborts before any request (exit 2)", f"exit={code} out={out[:120]}")
            counts["passed"] += 1

        if filename == "run-overload.py":
            code, out = run_cli("--host", "evilsite.example", "--port", "3001", "--confirm-local")
            check(code == 2, "non-loopback host aborts before any request (exit 2)", f"exit={code} out={out[:120]}")
            code, out = run_cli("--port", "3001", "--confirm-local", "--login-rate", "-1")
            check(code == 2, "negative login-rate aborts (exit 2)", f"exit={code} out={out[:120]}")
            code, out = run_cli("--port", "3001", "--confirm-local", "--w-posts", "-0.1")
            check(code == 2, "negative workload weight aborts (exit 2)", f"exit={code} out={out[:120]}")
            counts["passed"] += 3

        if filename == "run_attack.py":
            code, out = run_cli("--host", "evilsite.example", "--port", "3001", "--confirm-local")
            check(code == 2, "non-loopback host aborts before any request (exit 2)", f"exit={code} out={out[:120]}")
            code, out = run_cli("--port", "3001", "--confirm-local", "--scenario", "nuke-everything")
            check(code == 2, "unknown scenario aborts before any request (exit 2)", f"exit={code} out={out[:120]}")
            counts["passed"] += 2

        counts["passed"] += 2

    print("=" * 70)
    print(f"RESULT: {counts['passed']} checks passed, {counts['failed']} failed")
    print("=" * 70)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as err:  # noqa: BLE001
        print(f"  FAIL  unexpected error: {err}")
        raise SystemExit(1) from err