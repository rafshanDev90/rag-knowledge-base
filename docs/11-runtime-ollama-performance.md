# Phase 11 — Runtime, Ollama, and Performance

This file is about the machine, not the code. It explains why the same code can answer in 6 seconds or 38 seconds.

---

## 1. The hardware truth

| Resource | Actual | What the app saw |
|---|---|---|
| CPU | Ryzen 5 7500F, 6C/12T | fine |
| RAM | **16 GB DDR5** | **7.6 GB** in WSL2 |
| GPU | RTX 3060 **12 GB** | 12 GB via CUDA |
| Swap | 2 GB | 1.4 GB already used |
| OS | Windows + WSL2 | Ollama runs inside WSL |

WSL2 defaults to **50% of host RAM**. That is the single most important fact in this audit. Ollama was not running on 16 GB; it was running on 7.6 GB while Windows held the rest.

Fix:

```ini
# C:\Users\<you>\.wslconfig
[wsl2]
memory=12GB
swap=8GB
autoMemoryReclaim=gradual
```

Then `wsl --shutdown` and reopen. Leave 4 GB for Windows.

---

## 2. How Ollama uses memory

Ollama is a scheduler in front of `llama-server` runners. Each loaded model gets its own runner process.

Key behavior observed in this environment (Ollama 0.32.1):

| Setting | Value | Effect |
|---|---|---|
| `OLLAMA_KEEP_ALIVE` | `5m` default | A model unloads 5 minutes after last use |
| `OLLAMA_MAX_LOADED_MODELS` | `0` (auto) | Ollama decides based on VRAM |
| `OLLAMA_NUM_PARALLEL` | `1` | One request slot per model |
| `OLLAMA_CONTEXT_LENGTH` | `0` → 8192 | Default context is large |
| Prompt cache | 8192 MiB **per runner** | Huge on a 7.6 GB host |
| `--no-mmap` | enabled under pressure | Model copied into RAM instead of mapped |

Two consequences:

1. **VRAM decides what can be loaded; host RAM decides whether loading succeeds.**
2. The prompt cache and KV cache are host/GPU memory costs that are easy to forget.

The log line that explains the crash:

```
disabling mmap for llama-server load due to host memory pressure
system_free="132.4 MiB"
```

Ollama saw almost no free RAM, disabled memory-mapping, and tried to copy the model into RAM. The kernel killed it.

---

## 3. Model residency math

Approximate VRAM from the logs:

| Model | File size | VRAM |
|---|---|---|
| `gemma4:latest` (chat) | 6.6 GB | ~5.4 GiB |
| `qwen3:8b` (router) | 5.2 GB | ~5.5 GiB |
| `nomic-embed-text` | 274 MB | ~0.27 GiB |
| `deepseek-r1:8b` (summary) | 5.2 GB | ~5.2 GiB |
| `gpt-oss:20b` | 13 GB | does not fit |
| `qwen2.5-coder:7b` | 4.7 GB | ~4.9 GiB |

Usable VRAM is ~10.5–11 GiB after Windows desktop usage.

```
gemma4 + qwen3      ≈ 10.9 GiB  → borderline, KV cache pushes it over
gemma4 + nomic      ≈ 5.7 GiB   → comfortable
qwen3 + nomic       ≈ 5.8 GiB   → comfortable
gemma4 + qwen3 + nomic ≈ 11.2 GiB → does not fit
```

The current pipeline needs **three** model roles (router, chat, embed) and sometimes a fourth (summary). On a 12 GB card they cannot all be resident. Ollama therefore unloads and reloads them, and every reload is latency.

---

## 4. The crash timeline (Nov 16)

```
22:35:59  gemma4 starts loading
22:36:03  gemma4 ready                       (4 s, RAM was okay)

22:37:43  nomic starts loading               system_free 3.5 GiB
22:37:57  qwen3:8b starts loading            available_vram 11.0 GiB
          → gemma4 was evicted

22:38:07  qwen3 ready

22:39:13  gemma4 starts loading again        system_free 563 MiB
22:39:40  gemma4 ready                       (27 s under pressure)

22:41:01  nomic starts loading               system_free 132 MiB
22:41:14  OOM killer kills llama-server
          → "Load failed: llama-server process has terminated"
          → "panic: runtime error: invalid memory address"
          → ollama.service restarted
```

The client saw:

```
SocketError: other side closed
bytesWritten: 349, bytesRead: 0
```

That is exactly what a killed server looks like: request sent, no response, connection closed. It was not a `fetch` bug, a DNS bug, or an embedding bug.

---

## 5. Where the 38 seconds went

Measured warm numbers from the logs:

| Operation | Measurement |
|---|---|
| qwen3:8b generation | 37 tokens @ 47–56 tok/s ≈ 0.7–0.8 s |
| qwen3 prompt eval | ~0.2 s |
| gemma4 generation | 475 tokens @ 100.9 tok/s ≈ 4.7 s |
| gemma4 prompt eval | 1018 tokens @ 916 tok/s ≈ 1.1 s |
| gemma4 longer answer | 1187 tokens @ 97.5 tok/s ≈ 12.2 s |
| nomic cold load | ~0.7 s |
| gemma4 cold load, healthy RAM | ~4 s |
| gemma4 cold load, pressure | **~27 s** |

A plausible decomposition of 38.48 s:

```
27 s   gemma4 reload under memory pressure
 1 s   router
 1 s   embed + search + rerank
 5 s   generation
 4 s   OOM/restart/retry/overhead
≈ 38 s
```

Exact attribution requires per-stage instrumentation, which the app does not have. But the 27 s load is in the logs and dominates.

---

## 6. The recommended lean stack

The goal is **one chat model + one embedding model**, everything else removed from the hot path.

| Role | Recommended | Size | Why |
|---|---|---|---|
| Chat | `qwen2.5:7b-instruct` Q4_K_M | ~4.7 GB | Strong instruction/citation following, ~55–75 tok/s |
| Faster chat | `qwen3:4b-instruct` (thinking off) | ~2.5 GB | ~90–120 tok/s, slightly weaker |
| Embedding | `nomic-embed-text` | 274 MB | 768 dims, already indexed |
| Reranker | `BAAI/bge-reranker-v2-m3` int8 ONNX | ~300–600 MB | Strong cross-encoder, CPU/GPU |
| Router | **remove the LLM** | 0 | Rules + reuse chat with a 30-token cap |
| Summary | **reuse chat** | 0 | Background compaction |

Do not use:

- `gpt-oss:20b` — 13 GB, exceeds VRAM, spills to CPU.
- `deepseek-r1:8b` — reasoning model, slow, evicts chat.
- A second 8B model just for routing.

VRAM with the lean stack:

```
chat 4.7 + embed 0.27 + reranker 0.3–0.6 ≈ 5.5 GB
```

Leaves ~5 GB of headroom for KV cache and Windows.

---

## 7. Ollama configuration

```ini
[Service]
Environment="OLLAMA_KEEP_ALIVE=30m"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_CONTEXT_LENGTH=4096"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
```

| Setting | Why |
|---|---|
| `KEEP_ALIVE=30m` | Stops the 5-minute unload/reload cycle |
| `MAX_LOADED_MODELS=2` | Chat + embed only; hard guard against a third |
| `NUM_PARALLEL=1` | A 3060 is throughput-limited; parallel slots raise VRAM and latency |
| `CONTEXT_LENGTH=4096` | 3 chunks + short history does not need 8192 |
| `FLASH_ATTENTION=1` | Faster attention, less memory |
| `KV_CACHE_TYPE=q8_0` | Smaller KV cache |

Also:

- Quantize chat to `Q4_K_M`; avoid Q8/fp16.
- Cap output with `num_predict` (~300–350) and instruct conciseness.
- Warm chat + embed at boot with `keep_alive: "30m"`, then verify with `ollama ps`.
- Keep the reranker out of Ollama; use ONNX.

The prompt cache logged 8 GiB per runner. On a 7.6 GB host that alone is a problem. Reducing context and avoiding multiple runners is the practical mitigation; check your Ollama version for a prompt-cache limit flag if you need finer control.

---

## 8. Expected latency after the fix

| Stage | Before | After |
|---|---|---|
| Model load | 4–27 s or crash | 0 s warm |
| Router | ~1 s + eviction | 0–0.3 s |
| Embedding | cold / OOM | ~50 ms |
| Retrieval | ~0.3 s | ~0.3 s |
| Rerank | cold start | ~0.1 s |
| Generation (300 tok) | 4–12 s | ~4–5 s |
| **Total** | **30–45 s** | **~5–7 s** |

Targets:

- TTFT p50 < 1.5 s, p95 < 3 s.
- Full answer p50 < 6 s, p95 < 10 s.
- Embedding error rate < 0.1%.
- Zero OOM events.

---

## 9. Metrics to add

Without these, you cannot tell whether a change helped.

Per request:

- `requestId`, `sessionId`, `intent`
- `router_ms`, `embed_ms`, `search_ms`, `rerank_ms`, `ttft_ms`, `generation_ms`, `total_ms`
- `prompt_tokens`, `output_tokens`, `tok_per_sec` (from Ollama's `prompt_eval_count`, `eval_count`, `total_duration`)
- `vector_hits`, `keyword_hits`, `fused_hits`, `rerank_top_score`
- `empty_result` boolean
- error type and stage

Per process:

- RSS, heap, swap
- Ollama loaded models (`/api/ps`), VRAM used
- OOM/restart count
- rerank success rate
- cache hit rates

A simple structured JSON log line per request is enough to start. Export to Prometheus/Grafana later.

---

## 10. Why streaming does not make generation faster

Streaming improves **perceived** latency (the first token appears early) but the total time to the last token is the same. The 38.48 s was wall-clock time to completion; streaming could not hide a 27 s model load because no token existed yet.

This is why TTFT and total time must be measured separately.

---

## 11. Revision questions

1. Why did the app see 7.6 GB when the PC has 16 GB?
2. What is the difference between VRAM pressure and host RAM pressure?
3. Why does Ollama disable `mmap` under host memory pressure, and why does that make things worse?
4. Which models can coexist on a 12 GB card, and which cannot?
5. Why does `keep_alive` matter for latency?
6. What does the OOM log prove about the socket error?
7. Why is a reasoning model a bad choice for routing and summarization here?
8. Why is `gpt-oss:20b` unsuitable even though it is "better"?
9. Why is `num_predict` a latency control?
10. Why is TTFT a better UX metric than total time?
