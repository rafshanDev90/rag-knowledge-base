# Phase 10 — The CLI Client

File: `server/src/cli.ts`

---

## 1. Why a CLI

The project has no web frontend. The CLI is the reference client and the fastest way to observe the server. It is also a teaching tool: it shows the full RAG loop from the consumer side:

1. Upload a PDF module.
2. Confirm it is in the library.
3. Ask questions about it.
4. Parse the SSE stream and render tokens.

Everything runs against the same HTTP API a browser would use, so the CLI doubles as living API documentation.

---

## 2. Configuration

```ts
const API_BASE = process.env.API_BASE || 'http://localhost:5000/api/documents';
const TENANT_ID = process.env.TENANT_ID || 'tenant_default_123';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SESSION_ID = crypto.randomUUID();
```

| Constant | Why |
|---|---|
| `API_BASE` | One base for `/upload`, `GET /`, and `/chat`; overridable for remote servers |
| `TENANT_ID` | Sent explicitly so the CLI does not silently depend on the server default |
| `MAX_UPLOAD_BYTES` | Mirrors the Multer limit; fail before uploading a huge file |
| `SESSION_ID` | One conversation identity per CLI process |

The server's default tenant is the same value, but sending it makes the contract visible and lets you point the CLI at another tenant later.

---

## 3. Session lifecycle

```ts
let activeSession = SESSION_ID;
```

- One UUID per CLI process.
- `/new` generates a fresh UUID → new conversation, empty history.
- `/clear` only clears the terminal; it does **not** reset the server-side session. After `/clear`, the model still remembers previous turns. Use `/new` for a truly fresh context.
- `exit` / `/exit` closes the readline interface.

The session ID is sent in the chat request body:

```json
{ "query": "...", "sessionId": "...", "tenantId": "tenant_default_123" }
```

`userId` is omitted, so the server uses its default.

---

## 4. Commands

| Command | Behavior |
|---|---|
| `/upload <path>` | Validate the local file, POST it, print an ingestion summary |
| `/upload` | Prompt for a path, then same as above |
| `/modules` | List ingested modules for the tenant |
| `/docs` | Alias for `/modules` |
| `/new` | Start a fresh session |
| `/clear` | Clear the terminal (banner redraw) |
| `/help` or `/?` | Show the command box |
| `exit` / `/exit` | Quit |
| anything else | Sent to the RAG assistant as a question |
| unknown `/command` | Prints a hint instead of sending it to the model |

The dispatch loop is intentionally simple: exact string checks first, then a regex for `/upload`, then a fallback. This order matters — `upload` must match before the generic "unknown slash command" check.

```ts
const uploadMatch = answer.match(/^\/upload(?:\s+([\s\S]+))?$/i);
```

`[\s\S]+` rather than `.+` allows paths that contain unusual characters across a single quoted argument; the surrounding quotes are stripped before use.

---

## 5. `/upload` — how the CLI uploads a module

### Step 1 — Validate locally

```ts
const filePath = path.resolve(stripQuotes(rawPath));
const fileStats = await stat(filePath);

if (!fileStats.isFile())            // not a file
if (extname !== '.pdf')             // wrong extension
if (fileStats.size > MAX_UPLOAD_BYTES) // too large
if (fileStats.size === 0)           // empty
```

Why validate twice (client and server):

- The server must enforce its own limits; the client cannot be trusted.
- The client check gives a fast, specific error before a long upload.
- The extension check is convenience, not security. The server checks the MIME type, which is also spoofable.

`path.resolve` means relative paths are resolved from the **server** directory when you run `npm run cli`. If you are in `server/`, use `../doc/ch3.pdf`. A leading `~` or `~/` is expanded to your home directory, and surrounding quotes are stripped, so a path copied from a file manager usually works as-is.

### Step 2 — Read and wrap the file

```ts
const buffer = await readFile(filePath);

const form = new FormData();
form.append(
  'document',
  new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }),
  fileName
);
form.append('tenantId', TENANT_ID);
```

Details that matter:

- **Field name is `document`.** It must match `upload.single('document')`.
- **Do not set `Content-Type`.** `fetch` generates the multipart boundary when the body is `FormData`. Setting it manually breaks parsing.
- **Filename belongs in the third argument.** Without it, the server sees a generic blob name.
- **`new Uint8Array(buffer)`** creates a plain byte view. It avoids TypeScript/runtime `Buffer`-vs-`BlobPart` mismatches at the cost of one copy. For 10 MB this is negligible.
- **PDF MIME type is explicit.** The server's filter rejects anything else.

### Step 3 — POST with a spinner

```ts
payload = await withSpinner(`Uploading ${fileName} (${formatBytes(size)})`, async () => {
  const response = await fetch(`${API_BASE}/upload`, { method: 'POST', body: form });
  const body = await readJsonBody<UploadResponse>(response);
  if (!response.ok) throw new Error(body.error || `Server responded with ${response.status}`);
  return body;
});
```

The spinner is a one-line rotating star plus elapsed seconds. It reuses the same frames as the chat indicator so the CLI feels consistent.

Why read the body before checking status:

- The server returns useful JSON on `400`/`422`/`500` (e.g., "Only PDF files are allowed", "scanned PDF").
- Throwing on status alone would hide that message.
- `readJsonBody` tolerates an empty or non-JSON body instead of crashing.

### Step 4 — Render the result

Success:

```
✔ ch3.pdf ingested
  Pages     66
  Chunks    42 inserted · 0 duplicates
  Duration  6.55s

  Ready to study. Ask a question, or use /modules to check the library.
```

Already ingested:

```
↺ ch3.pdf is already ingested (42 chunks, no duplicates created)
  Ask a question about it, or use /modules to see what is available.
```

The distinction matters. A re-upload finishes in ~200 ms because the server skips embedding entirely (`skipped: true`). Without this message the user might think nothing happened.

Partial write failures are appended to the chunk line (`· N failed`) rather than hidden.

---

## 6. `/modules` — the library view

```ts
const response = await fetch(`${API_BASE}?tenantId=${encodeURIComponent(TENANT_ID)}`);
```

The server groups chunks by `(sourceHash, sourceFile)` and returns:

```json
{ "count": 2, "documents": [ { "sourceFile": "ch3.pdf", "chunks": 42, "tokens": 7837, "pages": 66, "ingestedAt": "…" } ] }
```

The CLI renders a fixed-width table:

```
2 modules in the library

#  Module         Chunks  Pages  Tokens  Ingested
1  ch3.pdf            42     66   7,837  17/11/2026, 20:27
2  Lab_01&02.pdf      14     32   3,262  17/11/2026, 20:29

Tenant: tenant_default_123
```

Implementation points:

- Column widths are computed from the header and the actual rows, so the table stays aligned.
- Long filenames are trimmed from the left (`…tail`), which keeps the distinctive part of the name visible.
- Numbers use `toLocaleString`; dates use `en-GB` short date + time.
- `pages` is the **highest page with text**, not the PDF's page count. A trailing blank page explains the difference.
- An empty library prints a hint instead of an empty table.

Why a table and not JSON: this is a human-facing command. JSON would be better for scripting, but the CLI is for studying.

---

## 7. The chat request

```ts
const response = await fetch(`${API_BASE}/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query, sessionId: currentSessionId, tenantId: TENANT_ID }),
});
```

- `fetch` has no timeout. If the server hangs, the CLI hangs.
- There is no `AbortController`, so Ctrl+C during a request kills the process abruptly rather than cancelling cleanly.
- A non-2xx response or missing body throws, and the CLI shows the "Could not reach the RAG server" box.

---

## 8. Parsing SSE by hand

```ts
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const events = buffer.split('\n\n');
  buffer = events.pop() || '';

  for (const event of events) {
    if (!event.startsWith('data: ')) continue;

    const dataStr = event.replace(/^data:\s*/, '').trim();
    if (dataStr === '[DONE]') continue;

    const data = JSON.parse(dataStr);
    ...
  }
}
```

Why this exact shape:

- **`{ stream: true }`** tells `TextDecoder` not to assume the chunk ends on a character boundary. Without it, a multi-byte UTF-8 character split across network chunks would corrupt.
- **Accumulate, split on `\n\n`.** TCP does not preserve message boundaries. One read may contain half a frame or three frames. The buffer holds the incomplete tail; `events.pop()` removes it.
- **`startsWith('data: ')`** is stricter than the SSE spec, which allows `data:` without a space. The server always emits the space.
- **`replace(/^data:\s*/, '')`** strips the prefix; `.trim()` removes the trailing newline.
- **`JSON.parse` in `try/catch`** ignores partial or malformed frames instead of crashing.

This is the standard hand-rolled SSE parser. A browser would use `EventSource`, but it only supports GET and this API is POST.

---

## 9. Rendering the answer

### Thinking indicator

`ClaudeIndicator` runs a `setInterval` every 90 ms, redrawing a rotating frame on the same terminal line with `\r\x1b[2K` (carriage return + clear line). It shows elapsed seconds.

When the first token arrives:

- `switchToStreaming()` stops the thinking timer.
- Prints the "Assistant" header.
- Starts a second timer that pulses an icon at a fixed screen position using ANSI save/restore cursor (`\x1b7` / `\x1b8`).
- Subsequent tokens are written normally, below the icon.

When the stream ends, `stop(true)` replaces the pulsing icon with a solid dot.

This is cosmetic, but it teaches an important lesson: **time to first token is the perceived latency**. A 6-second answer that starts streaming after 5 seconds feels much slower than one that starts after 1 second.

### Special payloads

```ts
if (data.token) {
  process.stdout.write(data.type === 'escalation' ? chalk.yellow(data.token) : chalk.white(data.token));
} else if (data.error) {
  indicator.stop(false);
  console.log(chalk.red(`\n✖ ${data.error}`));
  return;
}
```

- Escalation messages are yellow.
- Errors stop the spinner, print the message, and return without waiting for `[DONE]`.

### Timing

The timer starts **before** `fetch` and ends after the stream closes. So "38.48s" includes TCP connect, routing, classification, embedding, retrieval, reranking, prompt evaluation, generation, and the final flush. It is an end-to-end wall-clock number, not model time. That makes it a useful symptom but a bad diagnostic.

---

## 10. Readline edge cases

The loop uses `readline/promises`:

```ts
const askLine = async (prompt: string): Promise<string | null> => {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_USE_AFTER_CLOSE') return null;
    throw error;
  }
};
```

With a TTY, `question()` only rejects if the interface is already closed. With **piped input** (scripts, tests), stdin hits EOF and readline closes immediately, so a later `question()` throws `ERR_USE_AFTER_CLOSE`. Returning `null` turns that into a clean loop exit instead of a stack trace. This is why `printf '/modules\n' | npm run cli` works.

`SIGINT` restores the cursor (`\x1b[?25h`) before exiting, otherwise the terminal is left with an invisible cursor after an interrupted spinner.

---

## 11. Error UX

If `fetch` throws (server down, network error), the CLI prints a boxed message:

```
Could not reach the RAG server
Ensure your backend is running at http://localhost:5000/api/documents
```

For uploads, the server's error text is displayed directly, which is why the server returns specific messages for oversized files, wrong types, and scanned PDFs.

The chat path still discards the server's JSON error body on a non-2xx response. A better client would read it.

---

## 12. Limitations

| Limitation | Consequence |
|---|---|
| No request timeout | A hung server hangs the CLI forever |
| No abort | Ctrl+C kills the process, not the request |
| No retry | A transient network error ends the turn |
| No reconnect/resume | A dropped stream loses the partial answer |
| `/clear` does not reset the session | Old context still influences answers |
| Strict `data: ` prefix | Would break on a spec-compliant server without the space |
| No citation rendering | Citations appear inline in the answer text |
| No token/timing stats | Only total wall-clock time |
| Upload is synchronous | A large PDF keeps the CLI busy for the whole ingest |

---

## 13. What a better client would add

1. `AbortController` + timeout; cancel on Ctrl+C.
2. Read and display the server's JSON error body on chat failures.
3. Parse citation labels into a footer list.
4. Show time-to-first-token separately from total time.
5. Handle SSE comments/heartbeats (`: ping`) explicitly.
6. `/clear` that actually starts a new session (or rename it `/screen`).
7. `/delete <module>` once the server supports document deletion.
8. A `--json` mode for the upload/list commands, for scripting.

---

## 14. Revision questions

1. Why does the CLI send `tenantId` explicitly if the server has a default?
2. Why must the upload field be named `document`?
3. Why should you never set `Content-Type` manually for a `FormData` request?
4. What is the third argument to `form.append`, and what happens without it?
5. Why does the CLI validate file size and extension before uploading?
6. Why does a re-upload finish in ~200 ms, and what response field proves it?
7. What is the difference between `/clear` and `/new`?
8. Why must `TextDecoder` use `{ stream: true }`?
9. Why split on `\n\n` and keep the last partial element in a buffer?
10. Why not use `EventSource` for this API?
11. What does the 38.48 s timer actually measure?
12. Why is `ERR_USE_AFTER_CLOSE` relevant only for piped input?
13. Why does `pages` in `/modules` sometimes differ from the upload response's `totalPages`?
14. How would you make an upload resumable?
