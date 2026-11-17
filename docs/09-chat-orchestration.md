# Phase 9 — Chat Orchestration and SSE Streaming

File: `server/src/controllers/chatController.ts`

This is the file that ties every other phase together. Read it as a state machine, not as a linear script.

---

## 1. Entry and setup

```ts
const { query, tenantId = 'tenant_default_123', userId = 'user_123' } = req.body;
const sessionId = req.body.sessionId || crypto.randomUUID();
```

- `query` is required; empty → `400`.
- `tenantId` and `userId` are **client-supplied** with defaults. There is no authentication. This is the biggest trust gap in the system.
- If the client does not send a `sessionId`, the server generates a UUID. The CLI always sends one.

Then:

```ts
const session = await getOrCreateSession(sessionId, tenantId, userId);
```

The session is loaded **before** routing so the controller can use `session.runningSummary` later.

---

## 2. The SSE contract

The server sets:

```ts
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.setHeader('X-Session-Id', sessionId);
```

Then writes frames of the form:

```
data: {"token":"Hello"}\n\n
data: {"token":" world"}\n\n
data: [DONE]\n\n
```

Special frames:

```json
{"token":"...","type":"escalation"}
{"error":"..."}
```

There is no `event:` field, no `id:`, and no `retry:`. The event type is inside the JSON. The client relies on `[DONE]` as the terminator.

**Important:** `setHeader` does not flush the response. Node sends headers with the first `res.write`. There is no `res.flushHeaders()` call, so the client may not see an SSE response at all until retrieval and generation are ready to produce the first token. That is why a 20-second retrieval looks like a hung request.

---

## 3. Stage 1 — Intent routing

```ts
const routerResult = await classifyIntent(query);
```

Branches:

### `HIGH_RISK`

```ts
await Escalation.create({ sessionId, tenantId, reason, userQuery: query });
await saveMessage(sessionId, 'user', query);
const msg = "I understand this is a sensitive matter. I am escalating...";
await saveMessage(sessionId, 'assistant', msg);
res.write(`data: ${JSON.stringify({ token: msg, type: 'escalation' })}\n\n`);
res.write('data: [DONE]\n\n');
res.end();
return;
```

- Persist first, then respond.
- No LLM generation.
- The conversation is saved so a human can continue it.

### `CHITCHAT`

```ts
await saveMessage(sessionId, 'user', query);
const msg = "Hello! I am your technical document assistant...";
await saveMessage(sessionId, 'assistant', msg);
res.write(`data: ${JSON.stringify({ token: msg })}\n\n`);
res.write('data: [DONE]\n\n');
res.end();
return;
```

- Canned response, no retrieval, no generation.
- Both messages are saved, so chitchat becomes part of the history/summary.

---

## 4. Stage 2 — Embed the query

```ts
const queryEmbedding = (await generateEmbeddings([query]))[0];
```

- Uses the same model as ingestion (`nomic-embed-text`).
- If this throws, the catch block runs **before any bytes are flushed**, so the client gets a `500` JSON, not an SSE error. That matches the observed failure.
- The embedding is a single vector for the whole query. No query rewriting or expansion.

---

## 5. Stage 3 — Hybrid retrieval + rerank

```ts
const validResults = await hybridSearchWithReranking({
  query,
  queryEmbedding,
  tenantId,
  limit: 3,
  candidates: 10,
});
```

If empty:

```ts
res.write(`data: ${JSON.stringify({ token: "I'm sorry, I couldn't find relevant information..." })}\n\n`);
res.write('data: [DONE]\n\n');
res.end();
return;
```

This is the grounded "I don't know" path. It is the correct behavior when retrieval finds nothing, but remember: an empty result can also mean a broken index.

---

## 6. Stage 4 — Build the context

```ts
const context = validResults
  .map((r) => `[Source: ${r.sourceFile}, Chunk ${r.chunkIndex}]\n${r.text}`)
  .join('\n\n');
```

Each chunk is prefixed with a machine-readable citation label. The labels are what the model is instructed to reproduce.

Why this format:

- It gives the model an unambiguous token to copy.
- It keeps the source and chunk index adjacent to the text.
- It is easy to parse later if you want to render citations in a UI.

Limitation: the model can still cite the wrong chunk or invent a label. Citations are **not verified** against the retrieved set after generation. A robust system would parse the answer, check each cited label against `validResults`, and flag invalid ones.

---

## 7. Stage 5 — System prompt

```ts
const systemPrompt = `You are a helpful technical assistant. Answer the user's question using ONLY the provided context below.
If the answer is not in the context, say "I don't know based on the provided documents."
When you use information from the context, cite the source in brackets, like [Source: filename, Chunk X].

CONTEXT:
${context}`;
```

Three instructions:

1. **Grounding:** answer only from context.
2. **Abstention:** say "I don't know" instead of guessing.
3. **Attribution:** cite the source.

The context is embedded in the **system** message, not the user message. That gives it higher priority than user text, which helps against prompt injection ("ignore the documents and ..."). But it also means the system prompt changes on every query, so the reusable prefix is only the few lines before `CONTEXT:`.

A better layout for caching:

```
system: static instructions (never changes)
system: retrieved context
user:   question
```

That keeps a stable prefix.

---

## 8. Stage 6 — Conversation context

```ts
const messages = await getContextForLLM(session, query);
messages.unshift({ role: 'system', content: systemPrompt });
await saveMessage(sessionId, 'user', query);
```

Final order:

```
1. system: RAG instructions + retrieved context
2. system: summary of older conversation
3. user/assistant: last 10 messages
4. user: current query
```

The user message is saved **after** the context is built, so it is not duplicated in the window. This ordering is deliberate and easy to break if you refactor.

---

## 9. Stage 7 — Stream the answer

```ts
const stream = await streamChat(messages);

let fullResponse = '';
for await (const chunk of stream) {
  if (chunk.message.content) {
    fullResponse += chunk.message.content;
    res.write(`data: ${JSON.stringify({ token: chunk.message.content })}\n\n`);
  }
}

res.write('data: [DONE]\n\n');
res.end();
```

- `streamChat` returns an async iterable from `ollama.chat({ stream: true })`.
- Each chunk is one token or a small group of tokens.
- `fullResponse` is accumulated so the complete answer can be saved.
- There is no backpressure handling: `res.write` returns `false` when the socket buffer is full, and the code ignores it. For normal answer sizes this is fine; for very long answers it can buffer in memory.

---

## 10. Stage 8 — Persist and compact

```ts
await saveMessage(sessionId, 'assistant', fullResponse, validResults);
await compactHistory(session);
```

- The assistant message stores the chunks used as `sources`.
- `compactHistory` runs **after** `res.end()`. The user already has the answer; this work is invisible latency for the next turn.
- If `saveMessage` or `compactHistory` throws, the catch block runs. But `res.headersSent` is true and the response has ended. Writing an error frame at that point can produce `ERR_STREAM_WRITE_AFTER_END` or be silently ignored.

A safer order is: save the assistant message **before** `res.end()`, or run post-response work in a `finally`/background queue with its own error handling.

---

## 11. Error handling

```ts
catch (error) {
  if (res.headersSent) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  } else {
    res.status(500).json({ error: 'Failed to generate answer.' });
  }
}
```

Two modes:

- **Before first byte:** JSON 500. This is what happened with the Ollama socket error.
- **After streaming started:** an SSE `{"error": ...}` frame. Note there is **no `[DONE]`** after an error. The CLI handles this by returning early on `data.error`.

Problems:

- The error message is exposed to the client (`error.message`), which can leak internals.
- There is no error code or request ID.
- There is no `[DONE]` on the error path, so a generic SSE client waiting for `[DONE]` would hang.
- No client disconnect handling: if the user closes the CLI, generation continues and the server keeps writing to a dead socket.

---

## 12. Latency breakdown of the controller

| Stage | Warm | Notes |
|---|---|---|
| Router | ~0.9–1.0 s | 8B model, 37 output tokens |
| Query embedding | ~50 ms | nomic, one string |
| Vector + BM25 | ~0.2–0.5 s | parallel in Mongo |
| Rerank | ~0.1–0.3 s | 10 pairs, ONNX CPU |
| Context build | <5 ms | string join |
| Session load | ~5–20 ms | 10 messages |
| Time to first token | ~0.3–0.5 s after prompt eval | model already warm |
| Generation | ~3–5 s | 300 tokens at 60–100 tok/s |
| **Total** | **~5–7 s** | |

The 38.48 s case was not this table. It was a cold chat model (~27 s under memory pressure), a router/embedding model swap, and an OOM. See `11-runtime-ollama-performance.md`.

---

## 13. What to change first

1. `res.flushHeaders()` immediately after setting SSE headers.
2. Send a heartbeat comment (`: ping\n\n`) every 10–15 s while retrieving.
3. Start the router and retrieval in parallel, or replace the router with a cheap classifier.
4. Save the user message **before** retrieval so failed turns still appear in history.
5. Add `req.on('close', ...)` to abort the Ollama stream.
6. Add per-stage timing logs with a request ID.
7. Validate citations after generation.
8. Add `[DONE]` on every termination path, including errors.
9. Return a stable public error message, log the internal one.
10. Move `compactHistory` to a background queue.

---

## 14. Revision questions

1. Why are SSE headers set before routing instead of just before streaming?
2. Why does the client see nothing for several seconds even though headers were set?
3. What are the three special SSE payload shapes in this system?
4. Why is the user message saved after `getContextForLLM` rather than before?
5. What happens if the embedding call fails before any `res.write`?
6. What happens if the stream fails after the first token?
7. Why is there no `[DONE]` after an error, and why is that a problem?
8. Why is saving the assistant message after `res.end()` risky?
9. Why can the model cite the wrong chunk, and how would you verify citations?
10. Which stage would you parallelize first, and why?
