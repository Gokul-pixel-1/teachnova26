# Ollama Local-AI Setup — BuildHub Self-Healing

> The self-healing pipeline runs **entirely locally** with Ollama. Normal
> operation requires NO cloud API key. This doc records the verified setup,
> the measured performance envelope on this machine, and the operational rules.

---

## 1. Why Ollama (local-first)

`lib/server/provider.ts` resolves the active provider in priority order:

```text
1. SELF_HEALING_TEST_MODE=true + AI_PROVIDER=test  → hermetic TEST provider
2. AI_PROVIDER=groq                                → Groq (REAL, needs GROQ_API_KEY)
3. AI_PROVIDER=ollama                              → Ollama (REAL, local)
4. No explicit choice:
     GROQ_API_KEY present → Groq (REAL)
     otherwise            → Ollama (REAL, local-first)   ← default
```

A real BuildHub deployment therefore starts with a local Ollama server and no
cloud dependency. The Groq path is kept for compatibility.

## 2. Verified environment (this machine)

- **OS / CPU / RAM:** Linux, CPU-only (no GPU), **7.6 GiB RAM**.
- **Ollama:** `0.18.3`, server on `http://localhost:11434` (`ollama serve`).
- **Installed models:**
  - `qwen2.5-coder:1.5b`  (986 MB, Q4_K_M) — **primary**
  - `phi3:latest`         (2.2 GB)           — fallback

Install/verify:

```bash
ollama serve &                          # background server
ollama pull qwen2.5-coder:1.5b
ollama list
curl http://localhost:11434/api/tags    # catalog probe used by /api/ai/status
```

## 3. Environment variables (all optional)

| Variable               | Default                     | Purpose |
|------------------------|-----------------------------|---------|
| `AI_PROVIDER`          | `groq` if key present else `ollama` | provider choice |
| `AI_MODEL`             | `qwen2.5-coder:1.5b`        | Ollama model |
| `OLLAMA_BASE_URL`      | `http://localhost:11434`    | Ollama endpoint |
| `OLLAMA_TIMEOUT_MS`    | `180000`                    | hard per-call timeout |
| `OLLAMA_MAX_RETRIES`   | `2`                         | retries on 429/5xx/network |
| `OLLAMA_CONTEXT_WINDOW`| `8192`                      | `num_ctx` per call |

No secrets are involved (local inference). `GROQ_API_KEY` is never required and
never logged.

## 4. Measured performance on THIS machine

Idle-machine microbenchmark (short prompt, small JSON output, model already
loaded):

```text
qwen2.5-coder:1.5b  JSON inference    ~5.4 s
RAM during inference  2.4 → 3.7 GiB   (leaves ~3.2 GiB free)
```

Under **memory congestion** (system swap nearly full — heavy browser/IDE apps
open), the same model slows enormously:

```text
86-106 output tokens         149 s / 220 s per call   (measured 21:00, swap 1.9/2.0 GiB)
typical repair conversation  5–8 min                  (4-6 serialized calls)
entire e2e cycle             up to ~30 min
```

**Operational rule:** for a predictable local demo, run the machine with
headroom — close heavyweight apps so swap stays low. The engine serializes all
inference through a FIFO queue (`lib/server/ai/queue.ts`) so concurrent model
loads never pile up on low-RAM hosts, but the queue does not manufacture RAM.

## 5. How the Ollama provider works

`lib/server/ai/ollama-provider.ts`:

- `POST /api/chat` with `stream:false`, `format:'json'`, temperature 0.2,
  `num_predict` = the per-agent token budget, `num_ctx` = `OLLAMA_CONTEXT_WINDOW`.
- Every call runs through `withInferenceQueue` (FIFO, one inference at a time).
- Transient failures (429/5xx/network) are retried up to `OLLAMA_MAX_RETRIES`.
- A response only counts as `COMPLETE` when the content is a **valid, schema-
  conforming JSON object** (see `SECURITY_ARCHITECTURE.md`); everything else is
  an honest `FAILED` AgentRun.
- Runtime stats (`latencyMs`, `totalCalls`, `failedCalls`, `queueDepth`) are
  exposed by `GET /api/ai/status`.

## 6. Starting the REAL server for the Ollama e2e

```bash
cd frontend
env FAULT_INJECTION_ENABLED=true AUTH_GUARD_ENABLED=false \
    AI_PROVIDER=ollama AI_MODEL=qwen2.5-coder:1.5b \
    npx next dev -p 3000
```

Then:

```bash
python3 -u scripts/e2e_ollama_real_self_healing.py          # smoke (LOW-01)
python3 -u scripts/e2e_ollama_real_self_healing.py --with-approval
```

See the script header for full requirements. The expensive checks are real:
the `send` script polls the server-side repair to completion (a single REAL
conversation can take several minutes on a congested CPU-only machine).

## 7. Known limitations (honest)

- A 1.5B coder model has real quality limits: diagnoses can be off-target and
  strict-schema JSON can be rejected. The pipeline does NOT fake this — it
  records `AI_REPAIR_FAILED`/`FAILED` runs and keeps the fault active for a
  retry. Use `phi3:latest`/a larger model when accuracy beats speed.
- No GPU: inference is CPU-bound; RAM pressure directly controls throughput.
- `ollama`'s model unloads after idle; the first call reloads it (~extra
  seconds).