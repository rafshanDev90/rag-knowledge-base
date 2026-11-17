# Phase 1 — PDF Upload and Text Extraction

Files: `server/src/routes/documentRoutes.ts`, `server/src/controllers/documentController.ts`

---

## 1. What this phase is responsible for

Turning an HTTP file upload into a single string of text plus a filename. Nothing more.

It does **not** decide what is relevant, and it does not store the PDF. The PDF is parsed in memory and discarded; only the extracted text continues down the pipeline.

Mental model:

```
multipart request → Buffer in RAM → pdf-parse → string → chunking service
```

---

## 2. The route

```ts
router.post('/upload', upload.single('document'), uploadDocument);
```

Mounted in `app.ts` at:

```
POST /api/documents/upload
```

The field name is **`document`**. A request using `file`, `pdf`, or `upload` will be rejected by Multer before the controller runs.

### Multer configuration

| Setting | Value | Why |
|---|---|---|
| `storage` | `memoryStorage()` | No temp files on disk; buffer goes straight to the parser |
| `limits.fileSize` | `10 * 1024 * 1024` | DoS / accidental huge upload guard |
| `fileFilter` | `mimetype === 'application/pdf'` | Cheap first-pass validation |

**Why memory storage for RAG:** the downstream parser wants a `Buffer`. Writing to disk, reading it back, and cleaning up adds I/O and failure modes for a file that will never be served again. For a 10 MB cap this is reasonable.

**Trade-off:** memory storage is per-request. Ten concurrent 10 MB uploads = ~100 MB of Buffers, plus the parsed text and the embedding payload. On a small host this is not free. A production system would stream large PDFs to object storage and process asynchronously.

**Important limitation:** `file.mimetype` is supplied by the client and can be spoofed. It is not a real file-type check. A robust pipeline would inspect magic bytes (`%PDF-`) or run `file`/`pdfinfo`.

---

## 3. The controller

`uploadDocument` does five things:

1. Reject if `req.file` is missing → `400`.
2. `new PDFParse({ data: req.file.buffer })` and `await parser.getText()`.
3. Hardcode `tenantId = "tenant_default_123"`.
4. Call `processAndSaveChunks(pdfData.text, originalname, { tenantId, chunkSize: 1000, chunkOverlap: 200 })`.
5. Return the ingestion result as JSON.

Example response shape:

```json
{
  "message": "File processed successfully",
  "fileName": "Lab_01&02.pdf",
  "sourceHash": "…",
  "totalChunks": 42,
  "insertedCount": 42,
  "duplicateCount": 0,
  "writeErrors": []
}
```

### Why `tenantId` is hardcoded

It is a placeholder for future authentication. In the current system, **every user shares one tenant**. The chat endpoint also defaults to `tenant_default_123`. This means multi-tenant isolation is designed into the schema but not actually enforced end-to-end.

---

## 4. What `pdf-parse` actually gives you

`getText()` returns extracted text, not structure. In practice:

- Reading order is approximate.
- Tables are flattened into whitespace-separated text.
- Page boundaries are usually lost or only weakly represented.
- Headers/footers may repeat on every page.
- Scanned PDFs (images only) produce little or no text — there is **no OCR** in this pipeline.
- Equations become garbled unless the PDF stores them as text.

This is why the chunk metadata has `page?` and `section?` fields that are never populated: the extraction step does not provide them, and the controller does not pass them.

**Consequence for citations:** the system can cite `[Source: file.pdf, Chunk 12]`, but "Chunk 12" means *the 13th splitter output*, not page 12. It is stable for a given ingestion, but it is not human-friendly and it changes if chunking parameters change.

---

## 5. Error behavior

The whole controller body is wrapped in `try/catch`:

- Multer errors (file too large, wrong type) are **not** handled by this controller. They surface through Express's default error handling unless you add error middleware.
- Parse/chunk/DB errors are caught and returned as `500` with `error.message` (or a generic message).
- The error message may leak internal details (Mongo errors, stack-adjacent text). In production, log the full error and return a stable public message.

There is no retry, no job queue, and no progress reporting. A large PDF blocks the HTTP request until the entire embedding + insert finishes. If Ollama is slow or crashes, the upload request hangs or fails.

---

## 6. Design decisions worth remembering

| Decision | Reason | Cost |
|---|---|---|
| In-memory upload | Simple, no temp files | RAM proportional to concurrency |
| 10 MB cap | Protects the process | Large manuals must be split |
| MIME-only validation | Cheap | Spoofable |
| Synchronous processing | Easy to reason about | Long request, no resumability |
| Extract text only | Minimal viable RAG | Loss of layout, tables, pages |
| Hardcoded tenant | No auth yet | Not truly multi-tenant |

---

## 7. What a production version would add

- Magic-byte validation and antivirus scanning.
- Async job queue (upload returns `202` + job id; worker parses/embeds).
- OCR fallback for scanned PDFs.
- Page-aware extraction (store `page`, `section`, bounding boxes).
- Content-hash dedup *before* parsing (hash the bytes, not just the text).
- Per-tenant auth derived from a token, not the request body.
- Streaming parser for very large files.

---

## 8. Revision questions

1. Why does the route accept only the field name `document`?
2. What happens to the PDF file after extraction? Where is it stored?
3. Why is `memoryStorage` a reasonable choice here, and when would it become a problem?
4. Why can a scanned PDF silently produce an empty or useless knowledge base?
5. What does "Chunk 12" in a citation actually refer to?
6. Why is the hardcoded `tenantId` a correctness risk even though every query filters on it?
7. Where would you add an async queue, and what would the API contract become?
