import { invariant } from "./errors.ts";

/**
 * Identity is an injected port (ADR-0004).
 *
 * `crypto.randomUUID()` inside a run means the ledger differs on every
 * execution, so no two trajectories are ever byte-comparable and the eval
 * harness cannot diff them. Ids here are a deterministic function of
 * (prefix, ordinal), which makes them boring, readable, and stable.
 */
export type IdFactory = {
  /** `${prefix}-${n}` where n counts per prefix from 1. */
  next(prefix: string): string;
  /** Current ordinal for a prefix, for assertions and reporting. */
  count(prefix: string): number;
};

export function sequentialIds(): IdFactory {
  const counters = new Map<string, number>();
  return {
    next: (prefix) => {
      invariant(prefix.length > 0, "id prefix must be non-empty");
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${String(n).padStart(4, "0")}`;
    },
    count: (prefix) => counters.get(prefix) ?? 0,
  };
}
