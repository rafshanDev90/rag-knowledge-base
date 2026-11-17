# Phase 1 — PDF Upload and Text Extraction

Files: `server/src/routes/documentRoutes.ts`, `server/src/controllers/documentController.ts`, `server/src/app.ts`

---

## 1. What this phase is responsible for

Turning an HTTP file upload into two things:

1. A single string of text for chunking.
2. A **page map** (`{ num, text }[]`) so chunks can later carry a real page number.

It does **not** decide what is relevant, and it does not store the PDF. The PDF is parsed in memory and discarded; only the extracted text continues down the pipeline.

Mental model:

```
multipart request
  → Buffer in RAM
  → pdf-parse (whole text + per-page text)
  → { text, pages[] }
  → chunking service
```

---

## 2. The routes

Mounted in `app.ts` at `/api/documents`:

| Method | Path | Handler |
|---|---|---|
| `GET` | `/api/documents?tenantId=...` | `listDocuments` |
| `POST` | `/api/documents/upload` | `uploadDocument` |
| `POST` | `/api/documents/search` | `searchDocument` |
| `POST` | `/api/documents/chat` | `chatWithDocument` |

The upload field name is **`document`**:

```ts
router.post('/upload', upload.single('document'), uploadDocument);
```

A request using `file`, `pdf`, or `upload` is rejected by Multer before the controller runs.

### Multer configuration

| Setting | Value | Why |
|---|---|---|
| `storage` | `memoryStorage()` | No temp files on disk; the buffer goes straight to the parser |
| `limits.fileSize` | `10 * 1024 * 1024` | DoS / accidental huge upload guard |
| `fileFilter` | `mimetype === 'application/pdf'` | Cheap first-pass validation |

**Why memory storage for RAG:** the parser wants a `Buffer`. Writing to disk, reading it back, and cleaning up adds I/O and failure modes for a file that will never be served again.

**Trade-off:** memory storage is per-request. Ten concurrent 10 MB uploads = ~100 MB of buffers, plus parsed text and the embedding payload. On a small host that is not free. A production system would stream large PDFs to object storage and process asynchronously.

**Important limitation:** `file.mimetype` is supplied by the client and can be spoofed. It is not a real file-type check. A robust pipeline would inspect magic bytes (`%PDF-`) or run `file`/`pdfinfo`.

---

## 3. The controller

`uploadDocument` does these steps:

1. Reject if `req.file` is missing → `400`.
2. Read `tenantId`, `chunkSize`, and `chunkOverlap` from the form body, with defaults.
3. `new PDFParse({ data: req.file.buffer })` and `await parser.getText()`.
4. If the extracted text is empty → `422` with a message about scanned PDFs (OCR is not supported).
5. Map `pdfData.pages` into `{ num, text }` for page-aware chunking.
6. Call `processAndSaveChunks(pdfData.text, originalname, { tenantId, chunkSize, chunkOverlap, pages })`.
7. Return the ingestion result plus timing and page count.

### Request options

| Field | Type | Default | Bounds |
|---|---|---|---|
| `document` | file | — | required, PDF, ≤ 10 MB |
| `tenantId` | string | `tenant_default_123` | trimmed, non-empty |
| `chunkSize` | int | `1000` | clamped to 200–4000 characters |
| `chunkOverlap` | int | `200` | clamped to `0 … chunkSize-1` |
| `chunkOverlap` guard | — | — | fallback `min(200, chunkSize - 1)` |

`clampInt` treats anything non-numeric as "not provided". This means a bad form value silently falls back instead of returning `400`. That is a deliberate robustness choice for a CLI-driven tool, but a public API should validate and reject.

### Response shape

```json
{
  "message": "File processed successfully.",
  "fileName": "ch3.pdf",
  "tenantId": "tenant_default_123",
  "totalPages": 66,
  "durationMs": 6554,
  "sourceHash": "2d7a39b5…",
  "totalChunks": 42,
  "insertedCount": 42,
  "duplicateCount": 0,
  "skipped": false,
  "writeErrors": []
}
```

| Field | Meaning |
|---|---|
| `totalPages` | `pdfData.total`: every page in the PDF |
| `durationMs` | wall-clock time for parse + chunk + embed + insert |
| `totalChunks` | expected number of chunks for this document |
| `insertedCount` | chunks actually written |
| `duplicateCount` | existing chunks found when ingestion was skipped |
| `skipped` | `true` when the document was already fully ingested |
| `writeErrors` | per-document bulk-write failures (usually empty) |

When the document is already ingested, the response is still `200`, with `insertedCount: 0` and `skipped: true`. That is why a re-upload finishes in ~200 ms instead of re-embedding everything.

### Why `tenantId` defaults to a constant

It is a placeholder for future authentication. In the current system **every user shares one tenant**. The chat endpoint uses the same default. Multi-tenancy is designed into the schema but not enforced end-to-end.

---

## 4. What `pdf-parse` actually gives you

`getText()` returns both:

- `text` — the whole document as one string.
- `pages[]` — `{ num, text }` per page.

That per-page array is what makes page citations possible. Two details matter:

- **Ordering inside a page is approximate.** Multi-column layouts and sidebars may interleave.
- **Formatting is lost.** Tables are flattened into whitespace-separated text, equations become garbled unless they are stored as text, and headers/footers repeat.
- **Scanned PDFs produce little or no text.** There is no OCR in this pipeline. The controller now detects the fully empty case and returns `422` instead of silently ingesting nothing.

Why not use only `pages[]`? Because `pdfData.text` is the canonical full extraction, and the chunker needs one continuous string to split. The controller passes both: `text` for splitting, `pages` for mapping chunks back to page numbers.

**Consequence for citations:** the system can now cite `[Source: ch3.pdf, Page 12, Chunk 4]`. Page is where the chunk *starts*; a chunk can span pages. Chunk index is still stable only for a given extraction + chunking configuration.

### Why `totalPages` and the module list's `pages` can differ

`totalPages` is the PDF's page count. The module list reports `max(page)` across stored chunks — the last page that actually contained text. Trailing blank pages therefore show a smaller number in the library view. If you need the true page count per module, it has to be stored as document-level metadata; chunks only know their own page.

---

## 5. Validation and error behavior

There are three layers now:

### Multer (before the controller)

- File too large → `MulterError` (`LIMIT_FILE_SIZE`).
- Wrong MIME type → `Error('Only PDF files are allowed!')`.

Both propagate to the centralized error middleware in `app.ts`, which converts upload errors to **`400`** instead of the default HTML error page:

```ts
app.use((err, _req, res, _next) => {
  const isUploadError =
    err?.name === 'MulterError' || err?.message === 'Only PDF files are allowed!';
  res.status(isUploadError ? 400 : 500).json({ error: err?.message || 'Internal server error.' });
});
```

### Controller

- Missing file → `400`.
- Empty extractable text → `422`:
  > No extractable text found in this PDF. It may be scanned; OCR is not supported yet.
- Parse / chunk / embed / DB failure → `500` with `error.message`.

### Downstream

The embedding service retries transient Ollama failures; the chunker replaces partial prior ingestions. Those are covered in `02-chunking.md` and `03-embeddings.md`.

There is still no job queue, no progress reporting, and no resumability. A large PDF blocks the HTTP request until the whole pipeline finishes. The CLI spinner exists precisely because the user otherwise stares at a frozen prompt for several seconds.

---

## 6. The module list endpoint

`GET /api/documents?tenantId=...` groups chunks by document:

```ts
DocumentChunk.aggregate([
  { $match: { tenantId } },
  { $group: {
      _id: { sourceHash: '$sourceHash', sourceFile: '$sourceFile' },
      chunks: { $sum: 1 },
      tokens: { $sum: '$tokenCount' },
      pages: { $max: '$page' },
      ingestedAt: { $min: '$ingestedAt' },
  }},
  { $sort: { ingestedAt: -1 } },
]);
```

Response:

```json
{
  "count": 2,
  "documents": [
    { "sourceHash": "…", "sourceFile": "ch3.pdf", "chunks": 42, "tokens": 7837, "pages": 66, "ingestedAt": "…" }
  ]
}
```

Why aggregation instead of a separate `documents` collection:

- No second source of truth to keep in sync.
- Grouping is cheap at this scale.
- The counts are always derived from the real chunks.

Why it is not enough long-term:

- Every listing scans all chunks for the tenant.
- A document with zero chunks is invisible (which is fine, but means "no upload" and "failed upload" look the same).
- Renaming or replacing a document is still not modeled.

The CLI's `/modules` command is a thin renderer over this endpoint.

---

## 7. Design decisions worth remembering

| Decision | Reason | Cost |
|---|---|---|
| In-memory upload | Simple, no temp files | RAM proportional to concurrency |
| 10 MB cap | Protects the process | Large manuals must be split |
| MIME-only validation | Cheap | Spoofable |
| Text + pages extraction | Enables page citations | Slightly more parse work |
| Clamped options instead of 400 | Friendly for a CLI | Silent bad input |
| Synchronous processing | Easy to reason about | Long request, no resumability |
| Grouped list via aggregation | One source of truth | Scan per request |
| Hardcoded tenant | No auth yet | Not truly multi-tenant |

---

## 8. What a production version would add

- Magic-byte validation and antivirus scanning.
- Async job queue (upload returns `202` + job id; a worker parses/embeds, CLI polls).
- OCR fallback for scanned PDFs.
- Section-aware extraction (headings, tables) on top of page numbers.
- Content-hash dedup *before* parsing (hash the bytes too).
- Per-tenant auth derived from a token, not the request body.
- A `documents` collection for true document-level metadata, replacement, and deletion.
- Streaming parser for very large files.

---

## 9. Revision questions

1. Why does the route accept only the field name `document`?
2. What happens to the PDF file after extraction? Where is it stored?
3. Why is `memoryStorage` reasonable here, and when does it become a problem?
4. Why can a scanned PDF silently produce an empty knowledge base? What does the controller do now?
5. What is the difference between `totalPages` and the `pages` value in the module list?
6. Why are both `text` and `pages[]` passed to the chunker instead of one of them?
7. Why does a re-upload of the same file return `200` with `skipped: true` instead of erroring?
8. Why is `file.mimetype` not a real security check?
9. Where does the centralized error middleware sit in the request path, and why does it help the CLI?
10. What would you change to support a 200 MB PDF?
11. Why is the hardcoded `tenantId` a correctness risk even though every query filters on it?
