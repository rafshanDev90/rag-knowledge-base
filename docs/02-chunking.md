# Phase 2 — Chunking

Files: `server/src/services/chunkingService.ts`, `server/src/models/DocumentChunk.ts`

---

## 1. Why chunk at all

You cannot embed or retrieve a whole manual as one unit. Chunking is the compromise between four forces:

| Force | Effect |
|---|---|
| **Embedding quality** | A vector for a 40-page document is an average of everything → matches nothing specifically. Smaller units have sharper meaning. |
| **Context window** | The LLM can only receive a few chunks. Retrieval must select them. |
| **Retrieval granularity** | Smaller chunks retrieve precise facts but lose surrounding context. |
| **Cost / latency** | More chunks = more embeddings at ingest, more candidates at query. |

A good chunk is **self-contained enough to answer a question** and **small enough to be specific**. That is the whole design tension.

---

## 2. The pipeline in code

`processAndSaveChunks(rawText, fileName, options)`:

1. Validate: non-empty text, `overlap < chunkSize`, `tenantId` present.
2. `normalizeText(rawText)`.
3. `sourceHash = SHA-256(normalized)`.
4. Idempotency check: `DocumentChunk.exists({ sourceHash, tenantId })`.
5. Build a `RecursiveCharacterTextSplitter`.
6. `splitter.createDocuments([normalized])`.
7. For each chunk: `contentHash`, `tokenCount`, index, metadata.
8. Embed **all** chunk texts in one Ollama call.
9. `insertMany(chunkDocs, { ordered: false })`.

---

## 3. Normalization — the most consequential line

```ts
raw.replace(/\s+/g, ' ').trim()
```

Every run of whitespace (spaces, tabs, newlines, multiple blank lines) becomes **one space**.

Why do it:

- Makes the `sourceHash` stable across cosmetic differences (PDF extraction often produces inconsistent spacing).
- Makes dedup work: the same document extracted twice hashes the same.

What it breaks:

- **Paragraph structure is destroyed.** The splitter is configured with separators `['\n\n', '\n', '. ', ' ', '']`, but after normalization there are no `\n` characters left. The first two separators can never match. In practice splitting falls back to `. ` (sentence), then space, then individual characters.
- Tables, code blocks, and lists lose their line structure.
- Section headings are no longer distinguishable from body text.

This is a real design coupling: **normalization and splitting must be designed together.** If you want structure-aware chunks, normalize less aggressively (e.g., collapse spaces/tabs but preserve `\n\n`).

---

## 4. Hashing — two identities

### `sourceHash`

SHA-256 of the **normalized full document**. Purpose: identify the document.

- Independent of filename.
- Two files with identical normalized text share a hash.
- Used for the idempotency check.

### `contentHash`

SHA-256 of **one chunk's text**. Purpose: identify the chunk content.

- Available for change detection or dedup at chunk level.
- Currently only stored; not used by retrieval.

### `chunkId`

```ts
`${sourceHash}_${chunkIndex}`
```

Deterministic and reproducible: re-chunking the same normalized text with the same parameters produces the same IDs.

**Bug to remember:** `chunkId` is **globally unique** in MongoDB, but `sourceHash` is not tenant-scoped. If tenant A and tenant B upload the same document, both compute the same `chunkId` values. Tenant B's insert hits duplicate-key errors. The unique index should be compound (`{ tenantId, chunkId }`) or the ID should include `tenantId`.

---

## 5. The splitter

```ts
new RecursiveCharacterTextSplitter({
  chunkSize,
  chunkOverlap,
  separators: ['\n\n', '\n', '. ', ' ', ''],
})
```

### What "recursive character" means

The splitter tries the first separator. If a piece is still larger than `chunkSize`, it recurses with the next separator. It then merges small pieces back together up to `chunkSize`, and finally applies overlap.

Order of preference: paragraph → line → sentence → word → character. Because normalization removed newlines, the effective order here is sentence → word → character.

### `chunkSize` is characters, not tokens

`1000` means ~1000 **characters** (roughly 200–300 English tokens), not 1000 tokens. The stored `tokenCount` is computed afterward with `js-tiktoken` (`cl100k_base`), which is OpenAI's tokenizer — **not** nomic's or gemma's. So `tokenCount` is an approximation, useful for budgeting but not exact.

If you need token-based chunks, pass a token-counting `lengthFunction` to the splitter.

### Overlap

`chunkOverlap = 200` repeats the tail of one chunk at the head of the next.

Why: a fact that straddles a boundary would otherwise be cut in half and retrieved poorly.

Cost: duplicated text → duplicated embedding cost, more storage, and possible duplicate retrieval hits. Typical overlap is 10–20% of chunk size; 200/1000 = 20%.

### Worked example

Normalized text of 2500 characters, split on `. `, target 1000, overlap 200:

```
chunk 0: chars 0–1000
chunk 1: starts ~800 (200 overlap), ends ~1800
chunk 2: starts ~1600, ends ~2500
```

Exact boundaries depend on where the sentence separators fall, because the splitter prefers not to cut mid-sentence.

---

## 6. Per-chunk metadata

| Field | Source | Why it exists |
|---|---|---|
| `chunkId` | `sourceHash_index` | Deterministic identity |
| `sourceFile` | upload filename | Citation |
| `sourceHash` | normalized doc hash | Group chunks by document |
| `contentHash` | chunk hash | Content identity |
| `chunkIndex` | loop index | Ordering / citation |
| `totalChunks` | document length | Validation, "chunk 3 of 42" |
| `text` | splitter output | The retrievable content |
| `tokenCount` | `cl100k_base` | Budgeting |
| `blockType` | default `prose` | Future structure-aware retrieval |
| `page`, `section` | optional | Future page-aware citation |
| `tenantId` | caller | Isolation |
| `ingestedAt` | now | Freshness / debugging |

---

## 7. Embedding inside the chunking service

After splitting, the code calls:

```ts
const embeddings = await generateEmbeddings(textChunks);
```

All chunks go in **one** `/api/embed` request. This couples two concerns:

- A large PDF creates a very large request → long latency, high memory, higher chance of Ollama crashing or closing the socket.
- If one chunk fails, the whole ingestion fails; there is no partial progress.
- `embeddings[index]` assumes the response order and length exactly match the input. That is not validated.

A robust version batches (e.g., 32–64 chunks), limits concurrency, retries transient failures, and only inserts after all embeddings for a batch succeed.

---

## 8. Persistence and error handling

```ts
const result = await DocumentChunk.insertMany(chunkDocs, { ordered: false });
```

`ordered: false` means MongoDB attempts every document and reports individual failures instead of stopping at the first duplicate.

The `catch` block recognizes duplicate-key / bulk-write errors and returns a partial result:

```ts
{ insertedCount: error.result?.insertedCount ?? 0,
  duplicateCount: error.writeErrors?.length ?? 0,
  writeErrors: ... }
```

This is a best-effort report, not a transaction. Some chunks may be stored while others are not.

### The idempotency trap

```ts
const existing = await DocumentChunk.exists({ sourceHash, tenantId });
if (existing) {
  const count = await DocumentChunk.countDocuments(...);
  return { insertedCount: 0, duplicateCount: count, ... };
}
```

`exists` returns true if **even one** chunk exists. If a previous ingestion crashed after inserting 5 of 42 chunks, re-uploading the same file will be treated as "already done" and the missing 37 chunks will never be inserted. The check should count against `totalChunks`, or ingestion should be transactional/resumable.

---

## 9. Failure modes summary

| Failure | Effect |
|---|---|
| Whitespace normalization | Newline separators never fire; structure lost |
| Character-based size | Token counts vary widely per chunk |
| Globally unique `chunkId` | Cross-tenant collisions |
| Non-atomic `exists` check | Concurrent uploads race |
| Partial insert | Re-upload skipped by idempotency |
| One huge embed call | Slow / crash-prone ingestion |
| `embeddings[index]` unchecked | Silent misalignment if API returns fewer vectors |
| No transaction | Partial documents in the knowledge base |

---

## 10. Revision questions

1. Why does chunk size need to balance retrieval precision and context?
2. What exactly does `normalizeText` change, and which splitter separators become dead?
3. Is `chunkSize: 1000` tokens or characters? How would you prove it?
4. Why is `tokenCount` approximate for nomic/gemma?
5. What is the difference between `sourceHash`, `contentHash`, and `chunkId`?
6. Why can two tenants uploading the same PDF collide?
7. Walk through what happens if the process crashes after 5 of 42 inserts.
8. Why is overlap useful, and what does it cost?
9. How would you make ingestion resumable and idempotent?
10. What would change if you wanted page-level citations?
