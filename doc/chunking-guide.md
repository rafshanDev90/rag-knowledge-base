# Understanding the Document Chunking Pipeline

This guide explains the chunking work completed so far in the RAG project. It follows the real request path through the code and builds from the basic concepts to implementation details and design considerations.

## What this module does

Chunking turns a long document into smaller, ordered pieces that can later be searched and supplied as context to an AI model. The current pipeline:

1. Accepts a PDF upload.
2. Extracts its text.
3. Normalizes and hashes the text.
4. Splits it into overlapping chunks.
5. Adds identifiers, token counts, and metadata.
6. Saves the chunks to MongoDB.

This is the **ingestion** part of RAG. The current code does not yet create embeddings, search chunks, or generate answers.

## Level 1 — Basic

### Step 1: A PDF enters through the API

The route is `POST /api/documents/upload`. It expects a multipart form upload with the file field named `document`.

The route uses Multer memory storage, accepts files with the PDF MIME type, and limits the upload to 10 MB. The controller then:

- Returns `400` if no file was provided.
- Uses `pdf-parse` to extract the PDF text.
- Supplies the extracted text and original filename to the chunking service.
- Returns the ingestion result as JSON if processing succeeds.

Relevant files:

- `server/src/routes/documentRoutes.ts`
- `server/src/controllers/documentController.ts`

### Step 2: The service checks its inputs

`processAndSaveChunks` requires document text, a filename, and a `tenantId`. It rejects:

- Empty or whitespace-only text.
- A `chunkOverlap` that is greater than or equal to `chunkSize`.
- A missing tenant ID.

The upload controller currently supplies a placeholder tenant ID, `tenant_default_123`, and explicitly configures a chunk size of `1000` and overlap of `200`.

### Step 3: Text is split

The service uses LangChain's `RecursiveCharacterTextSplitter`. With the current upload settings, it aims for chunks of 1,000 characters, with up to 200 characters repeated between neighboring chunks.

Overlap helps preserve context when a useful passage crosses a chunk boundary. For example, the last part of one chunk may appear again at the start of the next.

### Step 4: Chunks are saved

Each chunk is stored as a `DocumentChunk` document in the MongoDB `document_chunks` collection. The stored text and its metadata can later be used by retrieval features.

Relevant files:

- `server/src/services/chunkingService.ts`
- `server/src/models/DocumentChunk.ts`

## Level 2 — Intermediate

### Step 1: Options and defaults

The service accepts `ChunkingOptions`:

| Option | Default | Purpose |
| --- | --- | --- |
| `chunkSize` | `1000` | Target chunk length for the splitter |
| `chunkOverlap` | `200` | Amount of overlap between chunks |
| `tokenModel` | `gpt-4` | Tokenizer model used for token counting |
| `tenantId` | Required | Associates chunks with a tenant |
| `blockType` | `prose` | Labels the kind of content |
| `page` | None | Optional page metadata |
| `section` | None | Optional section metadata |

The upload controller passes `chunkSize` and `chunkOverlap`, so those values override the service defaults. It does not currently pass `tokenModel`, `blockType`, `page`, or `section`; their defaults or absent values apply.

### Step 2: Normalize the whole document

`normalizeText` replaces every run of whitespace with one space and trims whitespace from the beginning and end. The service hashes and splits this normalized version.

This makes the source hash less sensitive to differences such as repeated spaces and line breaks. It also means the splitter does not receive the original PDF line breaks: the configured `\n\n` and `\n` separators generally cannot match after normalization. In practice, splitting falls back to the remaining separators, such as sentence boundaries, spaces, and finally individual characters.

### Step 3: Identify the source and check for prior ingestion

The service computes a SHA-256 `sourceHash` from the normalized full document. It checks MongoDB for an existing chunk with the same `sourceHash` and `tenantId`.

- If one exists, it counts the matching chunks and returns without splitting or inserting.
- Otherwise, it continues with splitting and persistence.

This is an idempotency check: uploading unchanged normalized text again for the same tenant is intended to avoid repeating the work.

### Step 4: Build each chunk record

For every piece of splitter output, the service creates fields including:

| Field | Meaning |
| --- | --- |
| `chunkId` | Deterministic ID built from `sourceHash` and the zero-based chunk index |
| `sourceFile` | Original uploaded filename |
| `sourceHash` | Hash identifying the normalized source text |
| `contentHash` | SHA-256 hash of this chunk's text |
| `chunkIndex` | Position of this chunk within the source document |
| `totalChunks` | Number of chunks produced for this source |
| `text` | The chunk text |
| `tokenCount` | Token count calculated with `tiktoken` |
| `blockType` | Content classification, defaulting to `prose` |
| `tenantId` | Tenant associated with the ingestion |
| `ingestedAt` | Time the chunk record was created |

`page` and `section` are also available for callers that supply them.

`chunkSize` is a **character-based splitter setting**, not a token limit. `tokenCount` is calculated afterward and recorded separately; it does not control how the text is split.

### Step 5: Persist and report the result

The service sends the chunk records to MongoDB with `insertMany` and `ordered: false`. This requests non-ordered insertion so a write problem with one record does not necessarily prevent attempts for other records.

On the normal success path, the result reports the source hash, total chunks, inserted count, duplicate count, and write errors. If the source already exists, it reports zero newly inserted chunks and the number found as duplicates.

## Level 3 — Advanced

### The implementation in sequence

In `processAndSaveChunks`, the full operation is:

1. Destructure options and apply defaults.
2. Validate text, overlap, and tenant ID before database work.
3. Normalize text and compute the source-level SHA-256 hash.
4. Query MongoDB for an existing `{ sourceHash, tenantId }`.
5. If found, count those chunks and return an idempotent result.
6. Configure a recursive character splitter and create LangChain documents.
7. Reject an empty splitter result.
8. For each output, compute its content hash and token count, and assign its index and metadata.
9. Insert the batch into MongoDB.
10. Return ingestion counts and identifiers to the controller.

The model adds schema validation and indexes. In addition to the unique `chunkId` index, it defines indexes for source ordering, tenant/source lookup, and content-hash lookup.

### Two hashes, two purposes

- **`sourceHash`** identifies the normalized document as a whole. It powers the service's existing-source check.
- **`contentHash`** identifies an individual chunk's text. It can support later content lookup or comparison.

The source hash is independent of the uploaded filename. Two files with identical normalized text therefore have the same source hash.

### Error behavior and the safe wrapper

The module also exports `processAndSaveChunksSafe`, which catches duplicate-key or bulk-write-shaped errors and converts some of them to an `IngestionResult`. Other errors are rethrown.

The current upload controller imports and calls `processAndSaveChunks`, **not** `processAndSaveChunksSafe`. Therefore, an insertion error from that call reaches the controller's catch handler and is returned as an HTTP 500 response. Do not assume the safe wrapper's partial-write result behavior is active in the upload endpoint.

### Details to keep in mind

1. **Whitespace normalization affects structure.** Collapsing all whitespace before splitting removes paragraph and line boundaries, even though newline separators are configured. If preserving document structure becomes important, normalization and splitting should be designed together.
2. **Character size is not a model context limit.** A 1,000-character chunk may have different token counts depending on its content. The recorded `tokenCount` is useful for observing this, but it does not enforce a token ceiling.
3. **The existing-source check is not atomic.** Two simultaneous uploads of the same source can both pass the `exists` check before either inserts. The unique `chunkId` index may then reject conflicting records. A database-level strategy is needed if concurrent duplicate ingestion must be handled reliably.
4. **Chunk IDs are globally unique by source hash and index.** `tenantId` is not part of `buildChunkId`, while the MongoDB unique index applies to `chunkId` globally. Identical source text ingested for different tenants can therefore produce colliding chunk IDs. Consider tenant scope when deciding the intended uniqueness rule.
5. **Partial-write reporting needs verification.** The safe wrapper assumes certain fields on a bulk error, and the normal service path does not convert an insertion exception into a partial-success result. Test the behavior against the installed Mongoose/MongoDB versions before relying on counts in partial-failure cases.
6. **PDF extraction may not preserve layout.** The chunking service receives plain extracted text. Tables, page boundaries, and section headings are not reliably represented as structured metadata by this flow; `page` and `section` are optional inputs but are not populated by the upload controller today.
7. **Chunking is not retrieval yet.** The model currently has no embedding field enabled, and this service does not create embeddings or query for relevant chunks. Those are later RAG stages.

### A useful mental model

Think of ingestion as creating two linked identities:

```text
normalized document
  └─ sourceHash
      ├─ chunk 0 → chunkId + contentHash + text + metadata
      ├─ chunk 1 → chunkId + contentHash + text + metadata
      └─ chunk N → chunkId + contentHash + text + metadata
```

The `sourceHash` groups chunks from one normalized document; `chunkIndex` preserves their order; and each `contentHash` identifies one chunk's text. Future retrieval can build on these records by embedding chunk text, searching for relevant chunks, and passing selected context to a language model.
