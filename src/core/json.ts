/**
 * The value type that crosses every boundary in Escapement: tool arguments,
 * tool results, ledger entries, eval fixtures.
 *
 * It is deliberately JSON and nothing else. Everything that gets recorded to a
 * ledger must survive `JSON.parse(JSON.stringify(x))` unchanged, or replay
 * (ADR-0007) is not replay — it is a re-run that happens to look similar.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/** True if `value` round-trips through JSON without loss. */
export function isJsonValue(value: unknown): value is JsonValue {
  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (value === null) return true;
      if (Array.isArray(value)) return value.every(isJsonValue);
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      return Object.values(value as Record<string, unknown>).every(isJsonValue);
    }
    default:
      return false;
  }
}

/**
 * Serialise with object keys sorted at every depth.
 *
 * Two runs that produce the same data must produce the same bytes, or every
 * hash-based comparison in the eval harness becomes a coin flip on V8's
 * insertion order. Used for ledger digests and eval fingerprints.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as JsonObject).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * FNV-1a over the canonical form. Not cryptographic — this exists to answer
 * "is this the same trajectory as last time", cheaply and without a dependency.
 */
export function digest(value: JsonValue): string {
  const text = canonicalJson(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
