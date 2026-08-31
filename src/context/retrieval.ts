import type { JsonObject } from "../core/json.ts";

export type Document = {
  readonly id: string;
  readonly text: string;
  readonly metadata?: JsonObject;
};

export type RetrievedChunk = {
  readonly id: string;
  readonly text: string;
  readonly score: number;
  readonly metadata?: JsonObject;
};

/**
 * The retrieval port (ADR-0009). Anything that can turn a query into ranked
 * text: a vector store, a hybrid search service, a SQL query, a filesystem grep.
 */
export type Retriever = {
  readonly name: string;
  search(query: string, k: number): readonly RetrievedChunk[] | Promise<readonly RetrievedChunk[]>;
};

/**
 * A retriever that answers without awaiting. Every in-process implementation is
 * one, and saying so keeps callers from having to `await` a value that was
 * never a promise.
 */
export type SyncRetriever = {
  readonly name: string;
  search(query: string, k: number): readonly RetrievedChunk[];
};

export type Bm25Options = {
  /** Term-frequency saturation. Higher rewards repeated terms more. */
  readonly k1?: number;
  /** Length normalisation, 0..1. Higher penalises long documents more. */
  readonly b?: number;
  readonly stopwords?: ReadonlySet<string>;
};

export const DEFAULT_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "was", "what", "when", "where", "which", "who",
  "will", "with",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and single characters. */
export function tokenize(text: string, stopwords: ReadonlySet<string> = DEFAULT_STOPWORDS): readonly string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !stopwords.has(t));
}

/**
 * Okapi BM25 over an in-process inverted index.
 *
 * Not a vector store, and not pretending to be one. It is here so that
 * `escapement` retrieves *something* out of the box, so the eval suite has a
 * deterministic retriever, and so the `Retriever` port has a reference
 * implementation. Ties break on document id, so results are stable.
 */
export function bm25Retriever(documents: readonly Document[], options: Bm25Options = {}): SyncRetriever {
  const k1 = options.k1 ?? 1.2;
  const b = options.b ?? 0.75;
  const stopwords = options.stopwords ?? DEFAULT_STOPWORDS;

  const docs = documents.map((doc) => {
    const terms = tokenize(doc.text, stopwords);
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    return { doc, length: terms.length, frequencies };
  });

  const documentFrequency = new Map<string, number>();
  for (const entry of docs) {
    for (const term of entry.frequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const total = docs.length;
  const averageLength = total === 0 ? 0 : docs.reduce((sum, d) => sum + d.length, 0) / total;

  return {
    name: "bm25",
    search: (query, k) => {
      const terms = tokenize(query, stopwords);
      if (terms.length === 0 || total === 0) return [];

      const scored = docs.map((entry) => {
        let score = 0;
        for (const term of terms) {
          const tf = entry.frequencies.get(term);
          if (tf === undefined) continue;
          const df = documentFrequency.get(term) ?? 0;
          // Lucene's smoothed IDF: always positive, so a term present in every
          // document contributes ~0 rather than a negative score.
          const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
          const norm = averageLength === 0 ? 1 : 1 - b + (b * entry.length) / averageLength;
          score += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
        }
        return { entry, score };
      });

      return scored
        .filter((s) => s.score > 0)
        .sort((x, y) => (y.score - x.score) || (x.entry.doc.id < y.entry.doc.id ? -1 : 1))
        .slice(0, k)
        .map(({ entry, score }) => ({
          id: entry.doc.id,
          text: entry.doc.text,
          score,
          ...(entry.doc.metadata ? { metadata: entry.doc.metadata } : {}),
        }));
    },
  };
}
