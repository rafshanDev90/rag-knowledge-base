# Phase 6 — Reranking

File: `server/src/services/hybridSearchService.ts` (the reranker half)

---

## 1. Why rerank

The embedding stage is a **bi-encoder**: it encodes the query and each chunk independently, then compares vectors. That is what makes it fast enough to search a large corpus, but it loses information: the query and the document never "see" each other.

A **cross-encoder** takes the pair `(query, document)` as a single input and runs full attention across both. It can model negation, exact phrasing, and subtle relevance. It is much more accurate — and much slower, because it must run once per candidate.

So the architecture is:

```
vector + BM25  →  ~10 candidates   (recall, cheap)
cross-encoder  →  top 3            (precision, expensive)
```

You can afford the cross-encoder only because the candidate set is small.

---

## 2. The model

```ts
const RERANKER_MODEL = 'Xenova/bge-reranker-base';
```

- `Xenova/*` is the ONNX-converted namespace used by `@huggingface/transformers` (Transformers.js).
- `bge-reranker-base` is a BERT-style cross-encoder (~278 M parameters).
- It outputs a single relevance logit per `(query, document)` pair.
- The ONNX runtime runs **in the Node process** on CPU.

Note: `.env` defines `RERANK_MODEL=onnx-community/Qwen3-Reranker-0.6B-ONNX`, but the code ignores it and hardcodes `Xenova/bge-reranker-base`. That mismatch matters for reproducibility and cold starts.

---

## 3. Lazy loading and the singleton

```ts
let rerankerPromise: Promise<RerankerBundle> | null = null;

const getReranker = async () => {
  if (!rerankerPromise) {
    rerankerPromise = Promise.all([
      AutoTokenizer.from_pretrained(RERANKER_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL),
    ]).then(([tokenizer, model]) => ({ tokenizer, model }));
  }
  return rerankerPromise;
};
```

Why a promise, not a boolean flag:

- Two concurrent requests must not load the model twice.
- The first caller starts the load; everyone else awaits the same promise.

Why this is also a trap:

- If the load **fails**, `rerankerPromise` stays in the rejected state forever. Every later request gets the same rejection instantly and falls back to RRF. There is no `catch(() => { rerankerPromise = null; })` to allow a retry.

Cold start:

- If the model is not cached locally, it is downloaded from Hugging Face at the first query.
- `bge-reranker-base` in fp32 is ~1.1 GB. On a slow link this can take minutes.
- The download and load happen **inside a user request**, so the user waits.
- Default dtype is fp32; on CPU this also means high memory and slower inference. An int8/quantized ONNX model would be far smaller and faster.

This is why the reranker should be preloaded at boot and pinned.

---

## 4. Tokenization

```ts
const queries = fusedResults.map(() => query);
const texts = fusedResults.map((chunk) => chunk.text);

const inputs = tokenizer(queries, {
  text_pair: texts,
  padding: true,
  truncation: true,
});
```

- `text_pair` produces the cross-encoder input: `[CLS] query [SEP] document [SEP]`.
- `padding: true` pads the batch to the longest sequence.
- `truncation: true` cuts to the model's max length (typically 512 tokens). A 1000-character chunk is roughly 250 tokens, so most chunks fit; very long chunks are silently truncated.
- Batching 10 pairs at once is efficient, but memory scales with `batch × sequence length`. A huge candidate set can stall or OOM the Node process.

---

## 5. Scoring

```ts
const { logits } = await model(inputs);
const scores = Array.from(logits.data as Float32Array);

const scoredResults = fusedResults
  .map((doc, idx) => ({
    doc,
    score: 1 / (1 + Math.exp(-scores[idx])),   // sigmoid
  }))
  .sort((a, b) => b.score - a.score)
  .slice(0, limit)
  .map((item) => item.doc);
```

- `logits.data` is a flat `Float32Array`. For a single-label model the shape is `[batch, 1]`, so `scores[idx]` is the logit for candidate `idx`.
- Sigmoid squashes the logit into `(0, 1)`.
- Because sigmoid is **monotonic**, it does not change the ranking. It only makes the score interpretable and comparable to a threshold.
- There is **no threshold** today. Even a score of `0.01` can be sent to the LLM if it is in the top 3.

Important caveat: if the model outputs more than one label per pair (some rerankers do binary classification), `scores[idx]` would be wrong. For `bge-reranker-base` it is single-label, so this works.

---

## 6. Why the score is not a probability in the usual sense

`sigmoid(logit)` is a number between 0 and 1, but cross-encoder logits are not calibrated probabilities. A score of `0.7` does not mean "70% chance relevant"; it means "more relevant than a score of 0.6". Thresholds must be tuned on your own data, not copied from another project.

A sensible default for a grounded RAG system:

```
keep chunks with sigmoid(score) >= 0.3–0.5
if none survive → "I don't know based on the provided documents."
```

That single threshold prevents the LLM from being fed three irrelevant chunks and inventing an answer.

---

## 7. Failure handling

```ts
try {
  ...
} catch (error) {
  console.warn('⚠️ ONNX reranking failed, falling back to RRF order:', error);
  return fusedResults.slice(0, limit);
}
```

This is good: reranking is an optimization, not a correctness requirement. If ONNX fails, retrieval still returns RRF-ranked chunks.

But it hides problems:

- A model download failure becomes "slightly worse answers", not an alert.
- The cached rejected promise means the fallback can persist until the process restarts.
- There is no metric for "rerank success rate".

---

## 8. Memory and latency

The reranker is the reason the Node process reached ~2.6 GB RSS in the audit.

- fp32 BERT-base: ~1.1 GB of weights, plus ONNX runtime arenas, tokenizer, and temporary tensors.
- It competes with Ollama for host RAM.
- On a 7.6 GB WSL VM, that is enough to trigger OOM when Ollama tries to load the embedding model.

Better options:

1. Use an int8/quantized ONNX model (`dtype: 'q8'` in Transformers.js).
2. Run the reranker in a separate worker process or sidecar.
3. Preload at boot so the memory cost is paid once, not inside a user request.
4. Use a smaller model (`bge-reranker-base` is already small-ish; `bge-reranker-v2-m3` is stronger but larger).
5. Skip reranking when the fused list is tiny (e.g., ≤2 chunks).

---

## 9. The model mismatch

| Source | Model |
|---|---|
| Code (`hybridSearchService.ts`) | `Xenova/bge-reranker-base` |
| `.env` (`RERANK_MODEL`) | `onnx-community/Qwen3-Reranker-0.6B-ONNX` |
| Local partial cache | `BAAI/bge-reranker-v2-m3` |
| Ollama model pulled | `qllama/bge-reranker-v2-m3` |

Four different reranker identities. The code wins, so the env and local caches are misleading. Pick one model, pin it, pre-download it, and delete the rest.

Also note: the Ollama `qllama/bge-reranker-v2-m3` model is a **completion** model in Ollama, not a rerank API. Scoring with it through `/api/chat` would be unreliable. Keep reranking in ONNX.

---

## 10. Revision questions

1. Why is a cross-encoder more accurate than a bi-encoder?
2. Why can't you run the cross-encoder over the whole corpus?
3. What do `text_pair`, `padding`, and `truncation` do in the tokenizer call?
4. Why does sigmoid not change the ranking?
5. Why is `sigmoid(logit)` not a calibrated probability?
6. What happens if the reranker model is not cached locally on the first query?
7. Why does a rejected singleton promise disable reranking permanently?
8. What is the risk of the reranker running in the same process as Express?
9. Why is falling back to RRF a good design, and what does it hide?
10. How would you add a relevance threshold without breaking the no-results path?
