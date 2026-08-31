# ADR-0009: Retrieval is a port, with in-process BM25 as the default

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

An agent that cannot retrieve is an agent that only knows what fits in its
prompt. But retrieval is also the part of the stack with the strongest opinions
already attached: users arrive with a vector store, an embedding model, a
chunking strategy, and a hybrid-search config they have already tuned.

Meanwhile the eval harness has a requirement that pulls the other way. If
retrieval is non-deterministic — an ANN index with approximate recall, an
embedding API with its own version drift — then every eval that involves
retrieval measures two things at once, and a score movement cannot be attributed.

## Decision

`Retriever` is a one-method port:

```ts
search(query: string, k: number): RetrievedChunk[] | Promise<RetrievedChunk[]>
```

Deliberately minimal. No filters, no namespaces, no embeddings, no index
management. Anything that ranks text can implement it: a vector store, a hybrid
search service, a SQL `LIKE`, a filesystem grep.

The default implementation is **Okapi BM25 over an in-process inverted index**,
about 60 lines. Standard parameters (`k1 = 1.2`, `b = 0.75`), Lucene's smoothed
IDF so a term appearing in every document contributes ~0 rather than a negative
score, and **ties broken on document id** so results never depend on insertion
order.

BM25 is not a compromise choice here. It is:

- **Deterministic**, which is what makes retrieval-involving evals meaningful.
- **Zero-dependency**, no embedding model and no service.
- **Genuinely competitive** on keyword-shaped queries — the kind agents actually
  issue when they call a `search` tool with terms lifted from the task.
- **Debuggable.** You can explain why a document ranked where it did.

Memory recall (`inMemoryStore`) reuses it: BM25 when a query text is given,
salience-then-recency when it is not, both fully ordered so nothing depends on
`Map` iteration order.

## Consequences

### What this buys us

- Retrieval works out of the box, offline, with no service to stand up.
- The eval suite has a deterministic retriever, so a retrieval-involving score
  movement is attributable.
- The port is small enough that adapting a real vector store is a few lines.
- No hidden embedding costs, and no embedding-model version drift underneath
  the evals.

### What this costs us

- **No semantic matching.** BM25 cannot connect "how do I stop it" to
  "termination and shutdown". For paraphrase-heavy corpora it will be clearly
  worse than embeddings, and users with that shape of data should bring their
  own retriever. We say so in the docs rather than implying BM25 is enough.
- **In-process and O(n) per query**, with the index rebuilt on construction.
  Fine for hundreds or a few thousand documents; wrong for a million.
- **No chunking.** A `Document` is whatever the caller says it is, and a badly
  chunked corpus retrieves badly. Chunking is a corpus-specific decision we
  decline to guess at.
- **English-shaped tokenisation.** Lowercase, split on non-alphanumerics, drop a
  small English stopword list. Works acceptably for many Latin-script languages,
  poorly for languages that do not delimit words with spaces.

### What we are explicitly giving up

Embeddings, reranking, and hybrid search — the things that make retrieval good
rather than adequate. All three are available through the port, none is
built in, and the ADR is deliberately explicit that the default is a floor
rather than a recommendation.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Bundle an embedding model | Megabytes of weights, an inference runtime, and non-determinism, all against the zero-dependency rule. |
| Require a `Retriever` with no default | Nothing runs out of the box, and the eval suite would need a mock retriever anyway — which is just BM25 with a worse name. |
| Depend on a vector DB client | Imports their versioning into our public API, and demands a running service to execute the test suite. |
| TF-IDF instead of BM25 | Fewer lines, no length normalisation, and measurably worse on documents of uneven size — which is every real corpus. |
| Trigram / fuzzy matching | Robust to typos, much weaker on relevance, and it is not what agents' keyword queries need. |
