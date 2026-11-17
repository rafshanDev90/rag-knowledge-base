# Phase 5 — Hybrid Retrieval (Vector + BM25 + RRF)

File: `server/src/services/hybridSearchService.ts`

---

## 1. Why hybrid search

Vector search and keyword search fail in different ways. Combining them is more robust than either alone.

| Query | Vector search | BM25 keyword |
|---|---|---|
| "How does the AX register work?" | strong: understands meaning | weak: may match "work" everywhere |
| "AX" / "BH" / error code `0x1F` | weak: short strings have noisy vectors | strong: exact term match |
| Paraphrase ("accumulator") | strong | fails if the document says "AX" |
| Rare identifier (`Lab_01&02`) | weak | strong |

Vector search answers **"what does this mean?"**. BM25 answers **"where does this exact word appear?"**. Real questions mix both.

---

## 2. The two paths

### Path 1 — Atlas Vector Search

```ts
{
  $vectorSearch: {
    index: 'vector_index',
    path: 'embedding',
    queryVector: queryEmbedding,
    numCandidates: 100,
    limit: candidates,        // 10
    filter: { tenantId },
  },
},
{ $project: { _id: 1, text: 1, sourceFile: 1, chunkIndex: 1, page: 1 } }
```

- `numCandidates: 100` — Atlas examines 100 approximate nearest neighbours, then keeps the top `limit`.
- Raising `numCandidates` improves recall but costs CPU/latency.
- `limit: 10` matches the `candidates` option.
- The `filter` is applied **during** the search (not after), which is why `tenantId` must be declared as a filter field in the index.
- `$vectorSearch` must be the **first** stage of the pipeline. This is an Atlas requirement.

### Path 2 — Atlas Search (BM25)

```ts
{
  $search: {
    index: 'text_index',
    text: { query, path: 'text' },
  },
},
{ $limit: candidates },
{ $project: { _id: 1, text: 1, sourceFile: 1, chunkIndex: 1, page: 1 } }
```

- `$search` must also appear first.
- `text` is the analyzed field; default analyzer lowercases and tokenizes.
- The result order is BM25 relevance, already descending.
- **No `tenantId` filter.** This is a bug: the keyword half can return another tenant's chunks. A compound filter (`must` / `filter`) should be added.

### Parallel execution

```ts
const [vectorResults, keywordResults] = await Promise.all([...]);
```

Both queries run concurrently. This is the one genuinely parallel part of the request pipeline. Latency is `max(vector, keyword)`, not the sum.

---

## 3. Reciprocal Rank Fusion (RRF)

The two result sets have **incomparable scores**:

- Vector scores are cosine-like similarities (model-dependent).
- BM25 scores are unbounded term-frequency statistics.

You cannot add them. RRF solves this by throwing away the raw scores and using only **ranks**.

### Formula

```
score(d) = Σ_paths  weight_path × 1 / (k + rank_path(d))
```

with:

- `k = 60` (the standard RRF constant),
- `vectorWeight = 0.6`,
- `keywordWeight = 0.4`,
- `rank` is 1-based.

### Worked example

Suppose:

- Vector: A, B, C
- BM25: C, D, A

| Doc | Vector contribution | BM25 contribution | Total |
|---|---|---|---|
| A | 0.6 × 1/61 = 0.009836 | 0.4 × 1/63 = 0.006349 | **0.016185** |
| B | 0.6 × 1/62 = 0.009677 | — | 0.009677 |
| C | 0.6 × 1/63 = 0.009524 | 0.4 × 1/61 = 0.006557 | **0.016081** |
| D | — | 0.4 × 1/62 = 0.006452 | 0.006452 |

Final order: **A, C, B, D**.

Notice:

- A document that appears in **both** lists is almost always promoted.
- The weights tilt the result toward the vector path (0.6 vs 0.4), but a strong keyword rank can still win.
- Because the score depends only on rank, a path with wildly different raw scores cannot dominate.

### Implementation details

```ts
const rrfScores = new Map<string, { doc, score }>();
```

- Deduplication key is `String(doc._id)`.
- If a doc appears in both lists, the scores are summed and the **first** `doc` object is kept. The projected fields are identical in both paths, so this is safe.
- After fusion, results are sorted descending and sliced to `candidates` (10).

### Why the weights are debatable

Standard RRF has no weights. Applying `0.6`/`0.4` is a heuristic that assumes vector search is more trustworthy. It is reasonable for natural-language questions, but it is not principled. If you have evaluation data, tune it; otherwise keep it simple and document the assumption.

---

## 4. The full retrieval function

`hybridSearchWithReranking({ query, queryEmbedding, tenantId, limit = 3, candidates = 10 })`:

1. Build both pipelines.
2. `Promise.all` → vector + keyword results.
3. RRF-fuse into a map.
4. If empty → return `[]`.
5. Rerank the fused candidates (next file).
6. Return the top `limit` (3).

So the budget is:

```
100 vector candidates → 10 kept
100 keyword candidates → 10 kept
20 ranked lists → fused to 10
10 → cross-encoder → 3
```

This funnel is deliberate: cheap recall first, expensive precision last.

---

## 5. Empty results

If the fused list is empty, the controller responds:

> "I'm sorry, I couldn't find relevant information in the provided documents to answer that."

This is the correct behavior for a grounded system. It is better than letting the LLM answer from its own knowledge.

But note: **empty results can also mean a broken index**, not "no answer". A missing `text_index`, a dimension mismatch, or a tenant mismatch all look the same to the user. Add health checks and log the raw counts.

---

## 6. Failure modes

| Failure | Effect |
|---|---|
| `vector_index` missing | `$vectorSearch` throws → 500 |
| `text_index` missing | `$search` throws → 500 |
| Embedding dimension mismatch | Search error or empty results |
| Missing tenant filter on BM25 | Cross-tenant leakage |
| Empty query | Meaningless vector; guard exists only for `!query` |
| Very short query ("AX") | Weak vector, strong BM25 — hybrid helps |
| `numCandidates` too low | Relevant chunk never enters the funnel |
| No score threshold | Irrelevant chunks still reach the LLM |

---

## 7. What to improve

1. Add `tenantId` filtering to the keyword pipeline.
2. Add `sourceFile` / `blockType` filters if needed.
3. Log vector count, keyword count, fused count, and rerank scores.
4. Add a minimum vector/BM25 score threshold before fusion.
5. Make `numCandidates`, `candidates`, `limit`, weights, and `k` configurable.
6. Consider a per-path limit that differs from the final limit (e.g., 50 vector, 50 keyword).
7. Add a retrieval evaluation set: for each question, the correct chunk ID. Measure recall@10 before tuning.

---

## 8. Revision questions

1. Give one query where BM25 beats vector search, and one where vector search beats BM25.
2. Why can't you simply add cosine and BM25 scores?
3. Derive the RRF score for a document ranked 2nd in both lists with `k = 60`, weights `0.6/0.4`.
4. Why is `$vectorSearch` required to be the first stage?
5. What does `numCandidates: 100, limit: 10` mean in terms of recall vs latency?
6. What is the security impact of the missing tenant filter on the keyword path?
7. Why is an empty result ambiguous, and how would you disambiguate it?
8. What does the 100 → 10 → 10 → 3 funnel optimize for?
9. Would you weight vector search higher for this project? Why?
10. How would you measure whether hybrid retrieval is actually better than vector-only?
