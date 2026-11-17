# Phase 12 — Study Guide: Glossary, Trace, Questions, Exercises

This file is for revision. Read it after the phase files.

---

## 1. Glossary

| Term | Meaning in this project |
|---|---|
| **RAG** | Retrieval-Augmented Generation: retrieve relevant text, then let an LLM answer from it. |
| **Grounding** | Constraining the model to the retrieved context instead of its own knowledge. |
| **Chunk** | A small piece of a document (here ~1000 characters) stored and retrieved as a unit. |
| **Overlap** | Text repeated between adjacent chunks so facts crossing a boundary survive. |
| **Embedding** | A fixed-length vector representing text meaning. Here 768 floats from `nomic-embed-text`. |
| **Dimension** | Length of the embedding vector. Must match the Atlas index. |
| **Cosine similarity** | Angle-based similarity between vectors; `1` = same direction. |
| **Bi-encoder** | Embeds query and document separately; fast, used for recall. |
| **Cross-encoder** | Scores `(query, document)` together; slow, used for precision. |
| **Reranker** | The cross-encoder stage that reorders the top candidates. |
| **BM25** | A lexical ranking function based on term frequency and inverse document frequency. |
| **RRF** | Reciprocal Rank Fusion: combine ranked lists using `1/(k + rank)`. |
| **Atlas Vector Search** | MongoDB's `$vectorSearch` stage and its vector index. |
| **Atlas Search** | MongoDB's Lucene-based `$search` stage, used here for BM25. |
| **Tenant** | An isolation boundary (customer/organization). Here `tenant_default_123`. |
| **Session** | A conversation identified by `sessionId`, with history and a summary. |
| **Sliding window** | Keeping only the last N messages verbatim. |
| **Running summary** | A compressed representation of older conversation turns. |
| **Compaction** | Summarizing and deleting old messages to fit the context budget. |
| **Token** | A subword unit the model reads/writes. ~4 characters of English. |
| **Context window** | Maximum tokens a model can attend to in one call. |
| **KV cache** | Memory holding attention keys/values for the current context. |
| **Quantization** | Compressing weights (e.g., `Q4_K_M` ≈ 4 bits per weight) to save memory. |
| **Cold start** | First request after a model is unloaded; includes loading weights. |
| **`keep_alive`** | How long Ollama keeps a model loaded after a request. |
| **TTFT** | Time To First Token: the latency the user actually perceives. |
| **SSE** | Server-Sent Events: a one-way streaming HTTP response. |
| **Hallucination** | A fluent answer not supported by the context. |
| **Citation** | A label like `[Source: file.pdf, Chunk 12]` pointing to evidence. |
| **Idempotency** | Repeating an operation has no additional effect. |
| **`sourceHash`** | SHA-256 of the normalized full document. |
| **`contentHash`** | SHA-256 of one chunk. |
| **Prompt injection** | User text trying to override system instructions. |

---

## 2. End-to-end trace: "Explain the AX register"

This is the example from the original bug report. Follow one request through every file.

### Step 0 — Client

`cli.ts` sends:

```json
{ "query": "Explain the AX register", "sessionId": "<uuid>" }
```

Timer starts. Spinner shows "Thinking…".

### Step 1 — Server setup

`chatController.chatWithDocument`:

- validates `query`,
- uses the provided `sessionId` (or generates one),
- loads/creates `ChatSession`.

### Step 2 — Router

`classifyIntent` calls `qwen3:8b` with a JSON schema.

Warm: ~0.9–1.0 s, ~37 output tokens.

Result:

```json
{ "intent": "DOCUMENT_QA", "reason": "Technical question about hardware." }
```

If the model was unloaded, this step may include a cold load and may evict the chat model.

### Step 3 — Query embedding

`generateEmbeddings(["Explain the AX register"])` → one 768-float vector.

Warm: ~50 ms. Cold: ~0.7 s. Under host memory pressure: possible OOM (the original crash).

### Step 4 — Hybrid retrieval

Two Atlas queries run in parallel:

- `$vectorSearch` on `vector_index`, `numCandidates: 100`, `limit: 10`, filter `tenantId`.
- `$search` on `text_index` for the words, `limit: 10` (**no tenant filter**).

Each returns up to 10 chunks. The question mentions "AX", which is a strong BM25 signal, so the keyword path likely surfaces the right chunk even if the vector is mediocre.

### Step 5 — RRF fusion

Merge the two lists with:

```
0.6 × 1/(60 + vectorRank) + 0.4 × 1/(60 + keywordRank)
```

A chunk ranked high in both wins. Result: top 10 chunks.

### Step 6 — Rerank

The ONNX cross-encoder scores all 10 pairs `(question, chunk)`, applies sigmoid, sorts, keeps 3.

Warm: ~0.1–0.3 s. First ever call: model download + load (potentially minutes, or a crash if RAM is tight).

The three survivors are likely from `Lab_01&02.pdf`, around the chunk that lists 8-bit and 16-bit registers.

### Step 7 — Context assembly

```ts
const context = results.map(r =>
  `[Source: ${r.sourceFile}, Chunk ${r.chunkIndex}]\n${r.text}`
).join('\n\n');
```

The system prompt says: answer only from this context, say "I don't know" if absent, cite sources.

### Step 8 — Conversation context

`getContextForLLM` adds:

- the running summary (if any),
- the last 10 messages,
- the current question.

The RAG system prompt is `unshift`ed to the front.

### Step 9 — Generation

`gemma4:latest` streams the answer.

Warm: ~100 tokens/s. A 300-token answer ≈ 3 s; the observed 475-token answer ≈ 4.7 s.

The model reproduces the citation labels it was given. It may cite the same chunk multiple times if all facts came from that chunk — which is plausible for a short register table — or it may cite the wrong label, which the system does not verify.

### Step 10 — Stream to client

Each token becomes:

```
data: {"token":"..."}\n\n
```

The CLI switches from "Thinking…" to streaming on the first token, then prints the elapsed time after `[DONE]`.

### Step 11 — Persistence

- `saveMessage(user)` — note: saved **after** retrieval, so a failed retrieval loses the user turn.
- `saveMessage(assistant, sources)` — after `res.end()`.
- `compactHistory` — scans the whole session, maybe summarizes with `deepseek-r1:8b`.

### Warm vs observed

| Run | Time | Why |
|---|---|---|
| Warm, lean stack | ~5–7 s | no loads, 300-token cap |
| Warm, current stack | ~6–10 s | + router, + longer answers |
| Original | **38.48 s** | cold 27 s load + thrash + generation |

---

## 3. Thirty revision questions (with short answers)

1. **What are the two pipelines in a RAG system?**
   Ingestion (offline: parse, chunk, embed, store) and query (online: route, embed, retrieve, rerank, generate).

2. **Why not embed the whole document?**
   A single vector averages everything and matches nothing precisely; retrieval needs granular units.

3. **What does `chunkOverlap` protect against?**
   Facts split across a boundary being lost from both chunks.

4. **Is `chunkSize: 1000` tokens?**
   No, characters. The token count is measured separately.

5. **Why is `normalizeText` risky?**
   It collapses newlines, so the splitter's paragraph/line separators never match.

6. **What is `sourceHash` for?**
   Document identity and idempotent ingestion.

7. **What is `contentHash` for?**
   Chunk-level identity (currently stored, not used for retrieval).

8. **Why can two tenants collide on `chunkId`?**
   `chunkId = sourceHash_index` and the unique index is global, not tenant-scoped.

9. **Why is the idempotency check unsafe?**
   It returns true if any chunk exists, so a partial insert is treated as complete.

10. **Why must query and document embeddings use the same model?**
    Different models produce different vector spaces; similarity becomes meaningless.

11. **What does changing the embedding model require?**
    Re-embedding all chunks and recreating the vector index with the new dimension.

12. **Why is cosine similarity used?**
    It compares direction, not magnitude, which suits text embeddings.

13. **What is the difference between a bi-encoder and a cross-encoder?**
    Bi-encoder embeds separately (fast recall); cross-encoder scores the pair together (slow precision).

14. **Why rerank only 10 candidates?**
    Cross-encoder cost is per pair; 10 is affordable, the whole corpus is not.

15. **What does RRF use instead of raw scores?**
    Ranks: `weight × 1/(k + rank)`.

16. **Why can't you add cosine and BM25 scores?**
    They have different, incomparable scales.

17. **Which retrieval path ignores `tenantId`?**
    The BM25 `$search` path (and the `/search` endpoint).

18. **What does `numCandidates: 100, limit: 10` mean?**
    Consider 100 approximate neighbours, return the best 10.

19. **Why is `format: 'json'` used for routing?**
    It constrains decoding to valid JSON, making parsing reliable.

20. **Why is an 8B model overkill for routing?**
    It is a three-class decision; rules or a tiny model can do it in milliseconds.

21. **What is the router's fallback?**
    `DOCUMENT_QA`, so a router failure does not break answering.

22. **What is the difference between the sliding window and the summary?**
    Verbatim recent turns vs compressed older turns.

23. **Why is `compactHistory` O(n) per turn?**
    It loads and tokenizes every message in the session on every answer.

24. **Why is `limit(20)` in compaction dangerous?**
    If the session has fewer than 20 messages, it can summarize and delete the most recent ones too.

25. **Why does the summary grow unbounded?**
    It appends each new summary to the old one instead of rewriting to a target length.

26. **Why can the model hallucinate a citation?**
    Citations are generated text; they are not verified against the retrieved set.

27. **What does `select: false` do for `embedding`?**
    Hides it from normal queries; aggregation still uses it.

28. **Why did the embedding call fail with `UND_ERR_SOCKET`?**
    Ollama was OOM-killed while loading the embedding model; the socket closed with no response.

29. **Why did the app see 7.6 GB instead of 16 GB?**
    WSL2 defaults to 50% of host RAM.

30. **Why does streaming not reduce total latency?**
    It only makes the first token appear earlier; the last token still takes the same time.

---

## 4. Exercises

### Exercise 1 — RRF by hand

Given vector ranking `[A, B, C]` and keyword ranking `[C, D, A]`, compute the fused order with `k = 60`, weights `0.6/0.4`. (Answer: A, C, B, D — see `05-hybrid-retrieval.md`.)

### Exercise 2 — Chunk size experiment

Ingest the same PDF with `chunkSize` 500, 1000, and 2000. Record:

- number of chunks,
- average `tokenCount`,
- retrieval quality on 5 fixed questions,
- ingestion time.

Which size gives the best answers per token?

### Exercise 3 — Add a relevance threshold

After reranking, drop chunks with sigmoid score `< 0.3`. If none survive, return the "I don't know" message. Measure how often the system abstains and whether wrong answers decrease.

### Exercise 4 — Measure TTFT

Instrument the controller with timestamps at:

```
start, after router, after embed, after search, after rerank, first token, last token
```

Log them as one JSON line. Run 20 questions warm and compute p50/p95.

### Exercise 5 — Reproduce the OOM

Read the journal:

```bash
journalctl -u ollama --since "-2 days" | grep -E "OOM|oom-kill|panic|system_free"
```

Identify which model load preceded each kill. Compare with `ollama ps` at the time.

### Exercise 6 — Fix tenant isolation

Add a `tenantId` filter to the keyword pipeline and to `/search`. Write a test that inserts chunks for two tenants and asserts no cross-tenant results.

### Exercise 7 — Add Nomic prefixes

Prepend `search_document: ` at ingestion and `search_query: ` at query. Re-ingest and compare retrieval on 10 questions. Explain why the document side requires re-ingestion.

### Exercise 8 — Replace the router

Implement a rules-based classifier for greetings/refunds/legal terms. Fall back to the LLM only when unsure. Measure latency and accuracy on 20 labeled messages.

### Exercise 9 — Make compaction safe

Change `compactHistory` to:

- summarize only messages older than the window,
- rewrite the summary to ≤400 tokens,
- run in the background,
- use the chat model.

Verify that the last 10 messages are never deleted.

### Exercise 10 — Build a retrieval eval set

For 20 questions, record the correct `chunkId`. Compute recall@10, recall@3, and MRR before and after each retrieval change. This is the only reliable way to tune `numCandidates`, weights, and chunk size.

---

## 5. Common misconceptions

| Misconception | Reality |
|---|---|
| "A bigger LLM will fix bad answers." | Retrieval quality usually dominates. A 70B model given the wrong chunk still answers wrong. |
| "Chunk size is measured in tokens." | Here it is characters; token count is measured separately. |
| "I can swap the embedding model freely." | You must re-embed and recreate the index. |
| "Streaming makes the model faster." | It improves perceived latency, not total time. |
| "The 38 s was the LLM generating." | Most of it was a cold model load under memory pressure. |
| "Ollama only uses VRAM." | Host RAM matters; the OOM was a host-RAM kill. |
| "SSE headers mean the client is connected." | Headers are not flushed until the first write. |
| "Citations are guaranteed." | The model can cite the wrong chunk or invent a label. |
| "More candidates always improve quality." | They add latency and noise; reranking and thresholds matter more. |
| "`keep_alive` only affects disk." | It controls whether the model stays in RAM/VRAM between requests. |
| "A reasoning model is always better." | It is slower and often unnecessary for routing and summarization. |

---

## 6. Suggested further study

- **Embeddings:** cosine vs dot product, normalization, Matryoshka embeddings, task prefixes.
- **Retrieval:** BM25 math, hybrid fusion (RRF vs weighted score normalization), query expansion, HyDE.
- **Reranking:** cross-encoder architectures, listwise rerankers, calibration, thresholds.
- **Evaluation:** recall@k, MRR, nDCG, groundedness/faithfulness, answer relevance.
- **Serving:** KV cache, paged attention, continuous batching, quantization, speculative decoding.
- **Operations:** OpenTelemetry tracing, Prometheus metrics, SLOs, load testing, graceful degradation.
- **Safety:** prompt injection, citation verification, PII redaction, tenant isolation, rate limiting.

---

## 7. One-paragraph summary to memorize

> A PDF is parsed into text, normalized, split into ~1000-character overlapping chunks, hashed for idempotency, embedded with `nomic-embed-text` into 768-dimensional vectors, and stored in MongoDB Atlas. At query time the question is classified, embedded with the same model, matched by both Atlas Vector Search and BM25, fused with Reciprocal Rank Fusion, reranked by an ONNX cross-encoder to the top three chunks, and injected into a grounded system prompt. The model streams an answer with citations over SSE, the turn is saved, and old history is compacted into a running summary. The main failure modes are model thrashing on a 12 GB GPU, host RAM exhaustion inside WSL2, missing tenant filters, and unbounded session growth.
