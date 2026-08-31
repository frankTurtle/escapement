import type { JsonObject } from "../core/json.ts";
import { bm25Retriever, type Document } from "./retrieval.ts";

export const MemoryKind = {
  /** A durable statement about the world or the user. "Prefers metric units." */
  Fact: "fact",
  /** Something that happened. "Ran the migration on 2026-08-14; it failed." */
  Episode: "episode",
  /** A standing instruction. "Never email customers without approval." */
  Instruction: "instruction",
} as const;

export type MemoryKind = (typeof MemoryKind)[keyof typeof MemoryKind];

export type MemoryRecord = {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly createdAt: number;
  /**
   * How much this deserves scarce context, 0..1. Not a relevance score —
   * relevance is computed per query. This is standing importance, and it is the
   * tiebreak when two records are equally relevant.
   */
  readonly salience?: number;
  readonly tags?: readonly string[];
  readonly metadata?: JsonObject;
};

export type RecallQuery = {
  readonly text?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly tags?: readonly string[];
  readonly limit: number;
};

export type MemoryStore = {
  readonly name: string;
  remember(record: MemoryRecord): void;
  recall(query: RecallQuery): readonly MemoryRecord[];
  all(): readonly MemoryRecord[];
};

/**
 * The in-process default.
 *
 * Recall is BM25 when a query text is given, and recency-plus-salience when it
 * is not. Rebuilding the index on every recall is O(n) in the store size, which
 * is fine for the hundreds-of-records case this is for and wrong for the
 * millions case — at which point you want a real store behind the same port.
 *
 * Note what is *not* here: no automatic writing. Escapement never decides on its
 * own that something is worth remembering. What goes in memory is an
 * application decision, and a framework that guesses will eventually persist
 * something it should not have.
 */
export function inMemoryStore(initial: readonly MemoryRecord[] = [], name = "in-memory"): MemoryStore {
  const records = new Map<string, MemoryRecord>();
  for (const record of initial) records.set(record.id, record);

  const matchesFilters = (record: MemoryRecord, query: RecallQuery): boolean => {
    if (query.kinds && !query.kinds.includes(record.kind)) return false;
    if (query.tags && query.tags.length > 0) {
      const tags = record.tags ?? [];
      if (!query.tags.some((t) => tags.includes(t))) return false;
    }
    return true;
  };

  return {
    name,
    remember: (record) => void records.set(record.id, record),
    all: () => [...records.values()],
    recall: (query) => {
      const candidates = [...records.values()].filter((r) => matchesFilters(r, query));
      if (candidates.length === 0) return [];

      if (query.text === undefined || query.text.trim().length === 0) {
        // No query: most salient first, then most recent, then id. Fully ordered
        // so the result never depends on Map insertion order.
        return [...candidates]
          .sort(
            (a, b) =>
              (b.salience ?? 0) - (a.salience ?? 0) ||
              b.createdAt - a.createdAt ||
              (a.id < b.id ? -1 : 1),
          )
          .slice(0, query.limit);
      }

      const documents: Document[] = candidates.map((r) => ({ id: r.id, text: r.text }));
      const hits = bm25Retriever(documents).search(query.text, query.limit);
      const byId = new Map(candidates.map((r) => [r.id, r]));
      const results = hits as readonly { id: string }[];
      return results.flatMap((hit) => {
        const record = byId.get(hit.id);
        return record ? [record] : [];
      });
    },
  };
}

export function memoryRecord(
  id: string,
  kind: MemoryKind,
  text: string,
  extras: { createdAt?: number; salience?: number; tags?: readonly string[] } = {},
): MemoryRecord {
  return {
    id,
    kind,
    text,
    createdAt: extras.createdAt ?? 0,
    ...(extras.salience === undefined ? {} : { salience: extras.salience }),
    ...(extras.tags === undefined ? {} : { tags: extras.tags }),
  };
}
