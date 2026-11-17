# Phase 10 — The CLI Client

File: `server/src/cli.ts`

---

## 1. Why a CLI

The project has no web frontend. The CLI is the reference client and the fastest way to observe the server's streaming behavior. It is also a useful teaching tool: it shows exactly what the SSE contract looks like from the consumer side.

It does three jobs:

1. Maintain a session ID across turns.
2. Send `POST /api/documents/chat`.
3. Parse the SSE stream and render tokens with a "thinking" indicator.

---

## 2. Session lifecycle

```ts
const SESSION_ID = crypto.randomUUID();
let activeSession = SESSION_ID;
```

- One UUID per CLI process.
- `/new` generates a fresh UUID → new conversation, empty history.
- `/clear` only clears the **terminal**; it does **not** reset the server-side session. This is a common source of confusion: after `/clear`, the model still remembers the previous turns.
- `exit` / `/exit` closes the readline interface.

The session ID is sent in the request body:

```json
{ "query": "...", "sessionId": "..." }
```

`tenantId` and `userId` are omitted, so the server uses its defaults.

---

## 3. The request

```ts
const response = await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query, sessionId: currentSessionId }),
});
```

- `fetch` has no timeout. If the server hangs, the CLI hangs.
- There is no `AbortController`, so Ctrl+C during a request kills the process abruptly rather than cancelling the HTTP request cleanly.
- A non-2xx response or a missing body throws, and the CLI shows the "Could not reach the RAG server" box.

---

## 4. Parsing SSE by hand

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
- **Accumulate into a buffer, split on `\n\n`.** TCP does not preserve message boundaries. One read may contain half a frame or three frames. The buffer holds the incomplete tail; `events.pop()` removes it.
- **`startsWith('data: ')`** is stricter than the SSE spec, which allows `data:` without a space. The server always emits the space, so it works.
- **`replace(/^data:\s*/, '')`** strips the prefix; `.trim()` removes the trailing newline.
- **`JSON.parse` in a `try/catch`** ignores partial or malformed frames instead of crashing.

This is the standard hand-rolled SSE parser. In a real browser you would use `EventSource`, but `EventSource` only supports GET, and this API is POST.

---

## 5. Rendering

### Thinking indicator

`ClaudeIndicator` runs a `setInterval` every 90 ms, redrawing a rotating frame on the same terminal line with `\r\x1b[2K` (carriage return + clear line). It shows elapsed seconds.

When the first token arrives:

```ts
indicator.switchToStreaming();
```

- Stops the thinking timer.
- Prints the "Assistant" header.
- Starts a second timer that pulses an icon at a fixed screen position using ANSI save/restore cursor (`\x1b7` / `\x1b8`).
- Subsequent tokens are written normally, below the icon.

When the stream ends, `indicator.stop(true)` replaces the pulsing icon with a solid dot.

This is purely cosmetic, but it teaches an important lesson: **time to first token is the perceived latency**. A 6-second answer that starts streaming after 5 seconds feels much slower than one that starts after 1 second — even if the total is the same.

### Special payloads

```ts
if (data.token) {
  if (data.type === 'escalation') {
    process.stdout.write(chalk.yellow(data.token));
  } else {
    process.stdout.write(chalk.white(data.token));
  }
} else if (data.error) {
  indicator.stop(false);
  console.log(chalk.red(`\n✖ ${data.error}`));
  return;
}
```

- Escalation messages are yellow.
- Errors stop the spinner, print the message, and return without waiting for `[DONE]`.

### Timing

```ts
const startTime = performance.now();
...
const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
console.log(`\n\n${chalk.dim(`─ Completed in ${elapsed}s ─`)}\n`);
```

The timer starts **before** `fetch` and ends after the stream closes. So "38.48s" includes:

- TCP connect,
- server routing,
- intent classification,
- embedding,
- retrieval,
- reranking,
- prompt evaluation,
- generation,
- and the final network flush.

It is an end-to-end wall-clock number, not model generation time. That is why it is a useful symptom but a bad diagnostic. Per-stage server timings are needed to attribute the delay.

---

## 6. Error UX

If `fetch` throws (server down, network error), the CLI prints a boxed message:

```
Could not reach the RAG server
Ensure your backend is running at http://localhost:5000/api/documents/chat
```

If the server returns a non-2xx status, the same box appears, because the code throws `Server responded with ${status}` and the catch is generic. The actual server error body is discarded. A better client would read the JSON error body and display it.

---

## 7. Limitations

| Limitation | Consequence |
|---|---|
| No request timeout | A hung server hangs the CLI forever |
| No abort | Ctrl+C kills the process, not the request |
| No retry | A transient network error ends the turn |
| No reconnect/resume | A dropped stream loses the partial answer |
| `/clear` does not reset the session | Old context still influences answers |
| Strict `data: ` prefix | Would break on a spec-compliant server without the space |
| No rendering of citations | The model cites sources, but the CLI prints them inline as text |
| No token/timing stats | Only total wall-clock time |

---

## 8. What a better client would add

1. `AbortController` + a timeout; cancel on Ctrl+C.
2. Read and display the server's JSON error body.
3. Parse citations into a footer list.
4. Show time-to-first-token separately from total time.
5. Handle SSE comments/heartbeats (`: ping`) explicitly.
6. Support `Last-Event-ID` if the server adds resumability.
7. Add `/clear` that actually starts a new session (or rename it `/screen`).

---

## 9. Revision questions

1. Why does the CLI need a session ID, and where is it generated?
2. What is the difference between `/clear` and `/new`?
3. Why must `TextDecoder` use `{ stream: true }`?
4. Why split on `\n\n` and keep the last partial element in a buffer?
5. Why not use `EventSource` for this API?
6. Why is `data: ` checked with a trailing space?
7. What does the 38.48 s timer actually measure?
8. Why is time-to-first-token more important than total time for perceived speed?
9. What happens if the server errors mid-stream?
10. How would you make the CLI cancel an in-flight request?
