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
2. Build the normalized source: `normalizeText(rawText)`, or a page-by-page join when `options.pages` is provided. The join also records character ranges per page.
3. `sourceHash = SHA-256(normalized)`.
4. Build a `RecursiveCharacterTextSplitter`.
5. `splitter.createDocuments([normalized])`.
6. Count existing chunks: `DocumentChunk.countDocuments({ sourceHash, tenantId })`. If it equals `totalChunks`, return `{ skipped: true }` without embedding.
7. For each chunk: locate its starting page, then compute `contentHash`, `tokenCount`, index, metadata.
8. Embed chunk texts in **batches** of `EMBED_BATCH_SIZE` (default 32), with retries.
9. If a partial previous ingestion exists, `deleteMany({ sourceHash, tenantId })`.
10. `insertMany(chunkDocs, { ordered: false })`.

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

### Page-aware normalization

When the controller passes `pages[]`, the chunker does not normalize `rawText` directly. It normalizes each page, joins them with a single space, and stores character ranges:

```
page 1 text [0, 1432)
page 2 text [1433, 2901)
page 3 text [2902, 4510)
...
```

After splitting, each chunk is located back into this string with `indexOf`, starting from the previous chunk's position. The page whose range contains the chunk's start becomes `chunk.page`.

Two details:

- Searching from the previous position keeps the mapping monotonic even when text repeats.
- The splitter may trim whitespace at chunk edges, so the locator falls back to a 40-character prefix probe.

This is O(n) over the document and adds no model cost. It is the cheapest useful metadata you can attach to a chunk.

**Consequence:** `sourceHash` now hashes the *page-joined* normalized text. A document ingested before this change has a different hash than the same document ingested now. That is why re-uploading an old module created a second copy instead of replacing the first during testing. Fresh environments do not have this problem; existing ones need a one-time cleanup.

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
| `page`, `section` | page map / caller | `page` is now populated; `section` is still unused |
| `tenantId` | caller | Isolation |
| `ingestedAt` | now | Freshness / debugging |

---

## 7. Embedding inside the chunking service

After splitting, the code calls `embedInBatches(textChunks)`:

```ts
for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
  const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
  const batchEmbeddings = await generateEmbeddings(batch);
  embeddings.push(...batchEmbeddings);
}
```

`EMBED_BATCH_SIZE` defaults to **32** and is overridable with the `EMBED_BATCH_SIZE` env var.

Why batch:

- A 42-chunk document is four requests instead of one large one. Each request is shorter and less likely to hit a timeout.
- Progress is logged per batch, which makes a slow ingest diagnosable.
- If a batch fails permanently, you fail fast instead of waiting on one giant call.

Why batching alone is not enough:

- Batches run **sequentially**. There is no bounded-concurrency pool, so a 500-chunk document is still slow.
- Embeddings happen **before** any insert. A crash discards all embedding work, including completed batches.
- The final `embeddings.length !== texts.length` check catches a missing batch, but not per-vector dimension changes.

The retry, `keep_alive`, and error-cause handling live in `embeddingService.ts`; see `03-embeddings.md`.

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

### Idempotency and partial re-ingestion

The check now runs **after splitting**, because the splitter output is what tells you how many chunks to expect:

```ts
const existingCount = await DocumentChunk.countDocuments({ sourceHash, tenantId });
if (existingCount === totalChunks) {
  return { insertedCount: 0, duplicateCount: existingCount, skipped: true, ... };
}
```

This fixes the old `exists()` trap. `exists` returned true if **even one** chunk existed, so a crash after 5 of 42 inserts made the document permanently incomplete.

For a partial ingest (`0 < existingCount < totalChunks`), the flow is:

1. Recompute all chunks and embeddings.
2. `deleteMany({ sourceHash, tenantId })` **after** embeddings succeed.
3. Insert the complete set.

That makes recovery possible: re-upload the same file and the missing chunks are restored.

The ordering matters. Deleting first would destroy the only copy if embedding then failed. Deleting after embedding means the worst case is "old partial data still there", which a later retry can fix.

### What is still unsafe

- **Not atomic.** Two concurrent uploads of the same file can both see `existingCount === 0`, both embed, both delete, and both insert. `ordered: false` reports duplicates, but the outcome is not deterministic.
- **Count equality is a heuristic.** Different chunking parameters produce different `totalChunks`, so the same document uploaded with `chunkSize: 500` is treated as a new version even though it is the same content.
- **Changing chunk parameters triggers a full re-embed.** `sourceHash` is unchanged (it hashes the text, not the chunking config), but `totalChunks` differs, so the code deletes and re-inserts every chunk.
- **A page-aware re-extraction changes the hash.** Documents ingested before page mapping was added do not match their new counterpart, producing a duplicate in the library. `GET /api/documents` makes this visible; deleting the stale `sourceHash` is a manual cleanup.

A fully robust version would use a `contentHash` on the document plus a version field, and wrap the delete+insert in a transaction or a per-`sourceHash` lock.

---

## 9. Failure modes summary

| Failure | Effect |
|---|---|
| Whitespace normalization | Newline separators never fire; structure lost |
| Character-based size | Token counts vary widely per chunk |
| Globally unique `chunkId` | Cross-tenant collisions |
| Count-based idempotency | Concurrent uploads still race; not atomic |
| Sequential embedding batches | Large documents remain slow |
| `embeddings.length` check | Catches missing batches, not dimension drift |
| Delete-then-insert | Not transactional; a crash mid-insert leaves a partial set (recoverable by re-upload) |
| Page-join hash change | Pre-existing documents appear as duplicates until cleaned up |

---

## 10. Revision questions

1. Why does chunk size need to balance retrieval precision and context?
2. What exactly does `normalizeText` change, and which splitter separators become dead?
3. Is `chunkSize: 1000` tokens or characters? How would you prove it?
4. Why is `tokenCount` approximate for nomic/gemma?
5. What is the difference between `sourceHash`, `contentHash`, and `chunkId`?
6. Why can two tenants uploading the same PDF collide?
7. Walk through what happens if the process crashes after 5 of 42 inserts, before and after the count-based check.
8. Why is overlap useful, and what does it cost?
9. How would you make ingestion resumable and atomic?
10. What would change if you wanted page-level citations? (Implemented: explain the page-range mapping.)
11. Why does the page-aware join change `sourceHash` for existing documents?
12. Why is `deleteMany` placed after embedding rather than before?
