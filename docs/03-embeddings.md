# Phase 3 — Embeddings

Files: `server/src/services/embeddingService.ts`, plus the calls in `chunkingService.ts` and `chatController.ts`

---

## 1. What an embedding is

An embedding model maps text to a fixed-length vector of floats:

```
"Explain the AX register"  →  [0.028, -0.191, 0.063, …, 0.014]   (768 numbers)
```

The geometry encodes meaning: texts used in similar contexts end up close together. "Register" and "accumulator" should be nearer than "register" and "banana".

Retrieval compares vectors with **cosine similarity**:

```
cos(a, b) = (a · b) / (|a| · |b|)
```

- `1.0` = same direction (very similar)
- `0.0` = unrelated
- `-1.0` = opposite

MongoDB Atlas `$vectorSearch` does this for you; the app never computes cosine directly.

### Bi-encoder vs cross-encoder

This project uses **both**, at different stages:

| | Bi-encoder (embedding) | Cross-encoder (reranker) |
|---|---|---|
| Input | one text at a time | query + document **together** |
| Output | a vector | a relevance score |
| Speed | fast, precomputable | slow, must run per pair |
| Use | recall: fetch candidates | precision: reorder candidates |

Embeddings let you search millions of chunks quickly. A cross-encoder is more accurate but cannot precompute, so it only sees the top ~10 candidates. This is the classic **retrieve-then-rerank** pattern.

---

## 2. The embedding service

```ts
const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
});

const response = await ollama.embed({
  model: process.env.EMBED_MODEL || 'nomic-embed-text',
  input: texts,                       // string[]
  keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
});
```

Key properties:

- **Configurable host and model.** `OLLAMA_HOST` and `EMBED_MODEL` come from the environment, so the service is no longer tied to `127.0.0.1` or one model name.
- **Batch API.** `input` can be one string or many. Ingestion passes batches; query passes `[query]`.
- **Same model for both sides.** Query and document vectors must live in the same vector space. Changing the model invalidates the entire index.
- **`keep_alive`.** The embed call now pins the model for 30 minutes instead of letting the server unload it after the default 5. This removes the most common cold-load latency and reduces the load/unload churn that triggered OOM kills.
- **Retries with backoff.** Up to 3 attempts. Socket-level failures are retried; "model not found" and validation errors are not.
- **Count validation.** `response.embeddings.length` must equal `texts.length`, otherwise the call throws.
- **Error cause preserved.** The thrown error includes the original failure text instead of a generic message.

### Retry classification

```ts
const retryableCodes = ['UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'];
```

Plus a message check for `fetch failed`, `socket`, `terminated`, `loading model`, and `connection`.

This is deliberately narrow. Retrying a 404 or a malformed request just wastes time. Retrying a closed socket is exactly what you want after Ollama restarts a runner.

What retries do **not** do: create memory. If the host is out of RAM, three retries will all fail. See `11-runtime-ollama-performance.md`.

---

## 3. `nomic-embed-text` specifics

| Property | Value |
|---|---|
| Parameters | ~137 M |
| Disk size | ~274 MB |
| Dimensions | **768** |
| Max context | 2048 tokens |
| License | Apache 2.0 |

768 dimensions is the contract with the Atlas vector index. If you switch to `bge-m3` (1024) or `mxbai-embed-large` (1024), you must:

1. Re-embed every chunk.
2. Recreate the vector index with the new `numDimensions`.
3. Re-embed every query at runtime.

There is no migration path that mixes dimensions. Treat the embedding model as a schema.

### Task prefixes (currently missing)

Nomic was trained with task prefixes:

```
documents: "search_document: <chunk text>"
queries:   "search_query: <question>"
```

The current code sends raw text for both. Adding the prefixes is nearly free at query time and improves retrieval quality, especially for short questions. It is a one-line change on each side, but it **requires re-embedding the corpus** if you change the document side, because the stored vectors were produced without the prefix.

Practical compromise for an existing index: add prefixes at query time only and measure. For best results, re-ingest with both prefixes.

---

## 4. Where embeddings are generated

### Ingestion

`chunkingService.processAndSaveChunks` calls `embedInBatches`, which splits chunk text into batches of `EMBED_BATCH_SIZE` (default 32) and awaits them one at a time:

- A 42-chunk document becomes two requests (`1–32`, `33–42`).
- The model is pinned with `keep_alive`, so the second batch does not reload it.
- The final count check catches a batch that returned the wrong number of vectors.
- Embedding still happens **before** `insertMany`, so a crash discards all work. There is no resume.
- Batches are sequential, not concurrent. Concurrency would help throughput but increases peak memory on this machine, so sequential is the safer default here.

### Query

`chatController.chatWithDocument`:

```ts
const queryEmbedding = (await generateEmbeddings([query]))[0];
```

One short string. Warm latency is tens of milliseconds; cold load is ~0.7 s; under memory pressure it can trigger an OOM (see `11-runtime-ollama-performance.md`).

The same call exists in `searchController.searchDocument` for the debug endpoint.

---

## 5. Why the socket error happened here

The error:

```
Ollama Embedding Error: [TypeError: fetch failed]
  cause: SocketError: other side closed
  bytesWritten: 349, bytesRead: 0
```

means: the HTTP request was sent, Ollama closed the connection without sending a response. It is **not** an embedding-logic bug.

The Ollama journal shows what actually happened at that moment:

```
disabling mmap ... due to host memory pressure
system_free="132.4 MiB"
starting llama-server ... --embedding
OOM killer → llama-server terminated → panic: nil pointer → service restart
```

The embed model load pushed the host over its memory limit, the kernel killed the runner, and the in-flight request died. Fixing this is an infrastructure problem (memory, model residency), not a `try/catch` problem. Retries help mask transient reloads, but they do not create memory.

---

## 6. Dimension and storage details

`DocumentChunk.embedding`:

```ts
embedding: { type: [Number], required: false, select: false }
```

- Stored as a plain array of numbers.
- `select: false` means normal `find()` queries do **not** return it (saves bandwidth).
- Aggregation pipelines (`$vectorSearch`) still use it internally; the `$project` stage explicitly excludes it from the result.
- There is no application-level validation that the vector length is 768.

Atlas expects the index to declare:

```json
{
  "fields": [
    { "type": "vector", "path": "embedding", "numDimensions": 768, "similarity": "cosine" },
    { "type": "filter", "path": "tenantId" }
  ]
}
```

If the index says 768 and you insert 1024, inserts may succeed but search fails or returns nothing.

---

## 7. Failure modes

| Failure | Symptom |
|---|---|
| Ollama down | `fetch failed` / `ECONNREFUSED` (retried, then surfaced) |
| Model not pulled | Ollama 404 "model not found" (not retried) |
| Model unloaded + host pressure | Socket closed mid-load (the crash above) |
| Large ingestion | More batches, so more wall-clock time, but smaller requests |
| Wrong dimension | Vector index error or empty results |
| Different model for query vs docs | Results look random; similarity is meaningless |
| Missing task prefixes | Weaker recall, especially on short queries |
| Bad `EMBED_BATCH_SIZE` | Too large → memory spikes; too small → request overhead |

---

## 8. What is handled vs what remains

Handled in the current code:

- `keep_alive` on embed calls.
- Batching at ingestion.
- Retry with exponential backoff + jitter for transient failures.
- `embeddings.length` validation.
- Original error cause preserved.
- Configurable Ollama host and embedding model.

Still missing:

1. A per-request **timeout** and `AbortController`.
2. Per-vector dimension validation (768 for nomic).
3. Nomic task prefixes (`search_query:` / `search_document:`), which require re-ingestion on the document side.
4. Bounded concurrency instead of sequential batches.
5. Streaming/resumable ingestion, so a crash does not lose completed batches.
6. Embedding cache keyed by `contentHash`, so unchanged chunks are never re-embedded.

---

## 9. Revision questions

1. Why must the query and document embeddings come from the same model?
2. What does cosine similarity measure, and why is it preferred over Euclidean distance for text?
3. What is the difference between a bi-encoder and a cross-encoder, and why use both?
4. What exactly happens if you change the embedding model without re-indexing?
5. Why is the embedding call the most likely place to see an Ollama socket error?
6. Why does batching all chunks into one request increase risk, and what does batching in groups of 32 change?
7. What do the `search_query:` and `search_document:` prefixes do?
8. Where is `select: false` set, and why does it not break vector search?
9. How would you detect that stored vectors and query vectors are misaligned?
10. What is the cheapest way to reduce embedding cost at ingestion?
11. Why does `keep_alive` reduce both latency and OOM risk?
12. Why should a "model not found" error not be retried?
