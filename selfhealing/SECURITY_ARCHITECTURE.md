# Security Architecture — BuildHub Self-Healing

> Two security concerns compose here: (1) defending the *application* against
> attack-like log signatures, and (2) defending the *AI agents* against
> prompt-injection via incident data. Both are documented from the shipped
> code, not from intent.

---

## 1. Files

| Area | File |
|------|------|
| Strict output contracts (all agents) | `frontend/lib/ai/schemas.ts` |
| Prompt-injection boundary + system guards | `frontend/lib/ai/prompts.ts` |
| Repair conversation (uses both) | `frontend/lib/server/repair/conversation.ts` |
| Security log analyzer (Python) | `frontend/scripts/security_log_analyzer.py` |
| Analyzer phase gates | `frontend/lib/server/repair/conversation.ts` (`provider.mode === 'REAL'`) |

---

## 2. Part A — Strict AI output contracts (defense against malformed/hostile LLM output)

Every agent must answer with STRICT JSON matching an explicit zod schema.
A response that violates the schema becomes a **FAILED AgentRun** — it is never
partially trusted.

- `AnalyzerSchema` — classification, rootCause, evidence, suspectedFiles, confidence (0-1)
- `CoderSchema`   — diagnosis, rootCause, file, line, function, affectedBehavior,
  currentCode, proposedCode, validationPlan, confidence (0-100)
- `CriticSchema`  — verdict ∈ {ACCEPT, REVISE, REJECT}, reasoning, problem arrays
- `JudgeSchema`   — decision ∈ {APPROVE, REJECT}, reasoning, confidence, risk, validationItems

Enforcement:

- `extractJsonObject` — bare / fenced / embedded JSON all parse; garbage → null.
- `validateWith` — `schema.safeParse`, never throws; unknown keys stripped,
  missing fields / wrong types / out-of-range enums reject the **whole** response.
- `parseAndValidate` — extraction + validation in one step.
- Covered by `scripts/test-ai-safety.mts` (24 checks, no network).

## 3. Part B — Prompt-injection boundary (defense against malice in incident data)

Incident data (logs, stack traces, source text, request content) is **data**, and
can contain text that looks like instructions ("ignore previous instructions",
"return approved", shell commands). The boundary:

1. Every untrusted payload is wrapped in explicit markers:
   `--- UNTRUSTED INCIDENT DATA (DATA ONLY …) ---` … `--- END UNTRUSTED INCIDENT DATA ---`
   (`assembleUserPayload`).
2. The operative instruction lives OUTSIDE those markers in a `## Task` section.
3. Every system prompt (CODER/CRITIC/JUDGE/ANALYZER) embeds `INJECTION_GUARD`,
   which tells the model that anything inside the UNTRUSTED block is DATA ONLY
   and its output is governed by the SYSTEM prompt + the Task section.
4. Builders only place evidence inside the untrusted section; instructions are
   assembled separately.
5. The Ollama provider never inspects prompt content (defense-in-depth lives in
   the prompt builders + strict schemas).

The boundary is asserted by `scripts/test-ai-safety.mts` (marker ordering,
attacker text confined inside the UNTRUSTED block, Task section after
UNTRUSTED_CLOSE, guard present in every system prompt).

## 4. Part C — Security log analysis (attack signature rules)

`scripts/security_log_analyzer.py` turns `SECURITY`/`ERROR`/`WARN`/`INFO` log
events into fingerprint-deduped `SecurityFinding` rows. Rules (highest
severity first; the analyzer never invents requests — it works only from logged
fields, `route`/`method`/`status`/`message`/`level`):

| Rule | Severity | Signal |
|------|----------|--------|
| `auth-failure-burst`             | HIGH   | ≥3 auth failures on one endpoint/5 min |
| `repeated-401`                   | HIGH   | ≥4 auth failures endpoint |
| `repeated-403`                   | HIGH   | ≥4 access-denied endpoint |
| `server-error-spike`             | HIGH   | ≥4 x 5xx / 5 min |
| `repeated-unauthorized-mutations`| HIGH   | ≥4 403 on write routes |
| `sensitive-endpoint-access`      | HIGH   | requests to `.env`, `/.git`, admin/config paths |
| `application-crash-loop`         | HIGH   | ≥3 x 5xx same route / 10 min |
| `secret-string-in-security-log`  | HIGH   | secret-like strings (`password=`, `api_key=`, token patterns) in a `SECURITY`-level event |
| `not-found-burst`                | MEDIUM | 8+ 404s / 2 min |
| `invalid-request-burst`          | MEDIUM | 10+ 400s / 2 min |
| `endpoint-abuse-pattern`         | MEDIUM | ≥15 mixed 401/403 |
| `path-traversal-input`           | MEDIUM | `..` segment / path traversal in route |
| `sql-injection-like-input`       | MEDIUM | SQL keywords + query-artifact pattern in logged text |
| `xss-like-input`                 | MEDIUM | `<script`, event handlers in logged text |
| `command-injection-like-input`   | MEDIUM | `;`/`|` + shell commands in logged text |

Payload rules are **best-effort heuristics** because `LogEvent` deliberately
stores no request bodies (privacy). Each finding uses the shared
`payload_rule()`/bucket helpers. Covered by
`scripts/test_security_log_analyzer.py` (20 tests, parity with the shipped
rules).

## 5. Authorization

- Repair entrypoints (`/api/security/run`, approvals, apply-patch) are guarded
  by `requireSecurityOperator()` — operator-only, enforced server-side.
- Authorization is never inferred from hidden UI.

## 6. Anti-secrets rules

- No secrets are logged: `password`, tokens, API keys are excluded from logs.
- `secret-string-in-security-log` treats the *presence* of a secret-like string
  in a SECURITY event as a HIGH finding (the spaces where secrets should never
  appear).