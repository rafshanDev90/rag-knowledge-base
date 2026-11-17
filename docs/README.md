# RAG Knowledge Base — Study Notes

> Personal revision guide for the `rag-knowledge-base` project.
> Written against the actual code as of **2026-11-17**. The code is the source of truth; these notes explain the *logic*, the trade-offs, and the sharp edges.

---

## 1. What this system does

It is a **document-grounded question answering system**:

1. You upload a PDF.
2. The text is extracted, split into chunks, and converted into vectors.
3. Chunks + vectors are stored in MongoDB Atlas.
4. A question is classified, embedded, matched against both vector and keyword indexes, and reranked.
5. The best chunks are injected into a prompt and a local Ollama model answers **with citations**, streamed back over SSE.

The goal is not "chat with an LLM". The goal is **"answer only from the provided documents, and prove where the answer came from."**

---

## 2. The two pipelines

RAG has two completely separate lifecycles. Keep them separate in your head.

### Ingestion (offline, happens on upload)

```
PDF bytes
  → pdf-parse (whole text + per-page text)
  → page-aware normalize (collapse whitespace, keep page ranges)
  → SHA-256 sourceHash
  → RecursiveCharacterTextSplitter (1000 chars / 200 overlap)
  → count existing chunks (skip if complete)
  → per-chunk metadata + page + contentHash + tokenCount
  → Ollama /api/embed in batches of 32 (nomic-embed-text, 768 dims, keep_alive)
  → replace partial ingestion if needed
  → insertMany into Atlas
```

### Query (online, happens per question)

```
question
  → intent router (LLM, 3 classes)
  → embed question (same model as ingestion!)
  → Atlas $vectorSearch  ┐
  → Atlas $search (BM25) ┘→ RRF fusion → ONNX cross-encoder rerank → top 3
  → system prompt + context + session history
  → Ollama chat (streaming)
  → SSE tokens → CLI
  → save messages → maybe compact history
```

The only contract between the two pipelines is: **the embedding model and its dimension must never change without re-embedding everything.**

---

## 3. End-to-end request lifecycle

Entry point: `POST /api/documents/chat` (`server/src/routes/documentRoutes.ts` → `chatController.ts`).

| # | Stage | Code | What can go wrong |
|---|---|---|---|
| 1 | Validate `query`, resolve `sessionId` | `chatController.ts` | 400 if query missing |
| 2 | Get/create `ChatSession` | `sessionService.ts` | Mongo down |
| 3 | Classify intent | `routerService.ts` → `llmService.generateJSON` | model slow / invalid JSON → falls back to `DOCUMENT_QA` |
| 4 | Branch: `HIGH_RISK` / `CHITCHAT` | `chatController.ts` | writes SSE and ends early |
| 5 | Embed query | `embeddingService.ts` | Ollama cold load / OOM / socket close |
| 6 | Hybrid search | `hybridSearchService.ts` | missing Atlas indexes, wrong dimensions |
| 7 | Rerank top 10 → top 3 | `hybridSearchService.ts` | ONNX cold start, OOM, fallback to RRF |
| 8 | Build context + system prompt | `chatController.ts` | too many tokens, stale citations |
| 9 | Load session context | `sessionService.getContextForLLM` | summary/history ordering |
| 10 | Stream answer | `llmService.streamChat` | model reload, client disconnect |
| 11 | Persist messages | `saveMessage` | DB write after response |
| 12 | Compact history | `compactHistory` | O(n) scan, model eviction |

The measured warm latency on this machine is roughly:

```
router ~1s + embed ~0.05s + search ~0.3s + rerank ~0.1s
+ TTFT ~0.3s + generation (300 tok @ 60–100 tok/s) ~3–5s
≈ 5–7s total
```

The 38 s you saw was dominated by **cold model loads and model thrashing**, not by the code path itself. See `11-runtime-ollama-performance.md`.

---

## 4. File map

| File | Responsibility |
|---|---|
| `server/src/server.ts` | Connect DB, start Express |
| `server/src/app.ts` | Middleware, `/health`, mount routes |
| `server/src/config/env.ts` | `dotenv` + `{ port, mongoUri, openAiApiKey }` |
| `server/src/config/db.ts` | Mongoose connection, `strictQuery` |
| `server/src/routes/documentRoutes.ts` | Multer config + 4 routes |
| `server/src/controllers/documentController.ts` | Upload → extract (pages) → chunk; list modules |
| `server/src/controllers/searchController.ts` | Debug vector search (no tenant filter) |
| `server/src/controllers/chatController.ts` | Full RAG request orchestration |
| `server/src/services/chunkingService.ts` | Normalize, hash, split, embed, insert |
| `server/src/services/embeddingService.ts` | Ollama `/api/embed` wrapper |
| `server/src/services/hybridSearchService.ts` | Vector + BM25 + RRF + ONNX rerank |
| `server/src/services/routerService.ts` | Intent classification |
| `server/src/services/llmService.ts` | Model names, chat/JSON/text helpers |
| `server/src/services/sessionService.ts` | Session, history window, compaction |
| `server/src/models/DocumentChunk.ts` | Chunk schema + indexes + hashing |
| `server/src/models/ChatSession.ts` | Session + running summary |
| `server/src/models/ChatMessage.ts` | Individual messages + sources |
| `server/src/models/Escalation.ts` | Human handoff records |
| `server/src/cli.ts` | Interactive terminal client |

---

## 5. Data model at a glance

```
DocumentChunk
  chunkId       unique, `${sourceHash}_${chunkIndex}`
  sourceHash    SHA-256 of normalized full document
  contentHash   SHA-256 of this chunk
  chunkIndex    0..N-1, preserves order
  text          the actual chunk
  tokenCount    cl100k_base token count (approximate)
  embedding     768-float array, select:false
  tenantId      multi-tenancy key
  sourceFile, blockType, page (populated), section?, ingestedAt

ChatSession
  sessionId (UUID), tenantId, userId
  runningSummary, summaryTokenCount
  timestamps

ChatMessage
  sessionId, role (user|assistant|system), content
  sources[]     the chunks used for the answer
  createdAt

Escalation
  sessionId, tenantId, reason, userQuery, status
```

---

## 6. Current model stack (as configured)

| Role | Model | Size | Notes |
|---|---|---|---|
| Chat | `gemma4:latest` | ~6.6 GB | streaming, `keep_alive: 30m` |
| Router | `qwen3:8b` | ~5.2 GB | non-streaming, JSON mode |
| Summary | `deepseek-r1:8b` | ~5.2 GB | reasoning model, compaction only |
| Embedding | `nomic-embed-text` | 274 MB | 768 dims |
| Reranker | `Xenova/bge-reranker-base` (hardcoded) | ~1.1 GB | ONNX, in-process |

> These choices are the main reason the system is slow on a 12 GB GPU. The recommended lean stack is in `11-runtime-ollama-performance.md`.

---

## 7. Reading order

Read these in order the first time; they follow the data.

1. [`01-pdf-upload.md`](01-pdf-upload.md) — how bytes become text
2. [`02-chunking.md`](02-chunking.md) — why chunk, how, and what breaks
3. [`03-embeddings.md`](03-embeddings.md) — vectors, dimensions, Ollama
4. [`04-storage-and-indexes.md`](04-storage-and-indexes.md) — schemas + Atlas indexes
5. [`05-hybrid-retrieval.md`](05-hybrid-retrieval.md) — vector + BM25 + RRF
6. [`06-reranking.md`](06-reranking.md) — cross-encoders and ONNX
7. [`07-intent-routing.md`](07-intent-routing.md) — cheap decisions before expensive work
8. [`08-session-memory.md`](08-session-memory.md) — sliding window + summary
9. [`09-chat-orchestration.md`](09-chat-orchestration.md) — the full controller
10. [`10-cli-client.md`](10-cli-client.md) — SSE from the client side
11. [`11-runtime-ollama-performance.md`](11-runtime-ollama-performance.md) — hardware, OOM, latency
12. [`12-study-guide.md`](12-study-guide.md) — glossary, trace, questions, exercises

---

## 8. Known sharp edges (summary)

Each is explained in its own file.

- Normalization removes newlines, so the splitter's `\n\n` / `\n` separators never fire.
- `chunkSize` is **characters**, not tokens; `tokenCount` uses an OpenAI tokenizer, not the model's.
- `chunkId` is globally unique but does **not** include `tenantId` → identical documents across tenants collide.
- Idempotency now compares counts, but it is still non-atomic: concurrent uploads of the same file can race.
- Ingestion re-embeds the whole document when chunk parameters change or a partial ingest is repaired.
- Documents ingested before page mapping produce a different `sourceHash` and appear as duplicates until cleaned up.
- Embedding batches run sequentially; large documents are still slow.
- The BM25 path has **no tenant filter**; `/search` has no tenant filter at all.
- The reranker model is hardcoded and does not match `RERANK_MODEL` in `.env`; a rejected load is cached forever.
- The router is a blocking 8B LLM call before retrieval.
- `compactHistory` scans the whole session every turn and can summarize recent messages.
- No request timeouts, abort support, or per-stage metrics anywhere (embeddings do retry).
- Ollama runs inside a WSL2 VM capped at 7.6 GB, causing OOM during embedding loads.
- `js-tiktoken` is imported but not declared in `package.json`.
- `npm run build` fails on dependency type errors (`skipLibCheck` not set); the app runs via `tsx`.

---

## 9. How to run (current state)

```bash
cd server
npm run dev     # tsx src/server.ts, port 5000
npm run cli     # interactive terminal client
```

Typical study loop:

```
npm run cli
❯ /upload ../doc/ch3.pdf     # ingest a class module
❯ /modules                   # confirm it is in the library
❯ Explain the AX register    # ask a grounded question
❯ /new                       # start a clean conversation
```

CLI commands: `/upload [path]`, `/modules` (`/docs`), `/new`, `/clear`, `/help`, `exit`.

Optional CLI environment overrides: `API_BASE`, `TENANT_ID`.

Prerequisites:

- Ollama on `127.0.0.1:11434` with `nomic-embed-text`, the chat/router/summary models, and the reranker files.
- MongoDB Atlas cluster with:
  - a vector index named `vector_index` on `embedding` (768 dims, cosine, `tenantId` as filter),
  - a Search index named `text_index` on `text`.
- `.env` with `MONGO_URI`, `CHAT_MODEL`, `ROUTER_MODEL`, `SUMMARY_MODEL`, `RERANK_MODEL`.
- Optional: `OLLAMA_HOST`, `EMBED_MODEL`, `OLLAMA_KEEP_ALIVE`, `EMBED_BATCH_SIZE`.

Those Atlas indexes are **not** created by the code. If they are missing or have the wrong dimension, retrieval silently fails or errors.

---

## 10. Note on older docs

`doc/chunking-guide.md` describes an earlier version of the project (it mentions `processAndSaveChunksSafe` and a `tokenModel` option that no longer exist, and says embeddings are not implemented yet). Treat the `docs/` set as current.
