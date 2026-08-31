/**
 * Randomness is an injected port (ADR-0004). Seeded, so a run's jitter, its
 * sampling, and any tie-break in context packing are reproducible.
 */
export type Rng = {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max]. */
  int(min: number, max: number): number;
  /** Deterministic in-place-free shuffle. */
  shuffle<T>(items: readonly T[]): T[];
};

/**
 * mulberry32. 32 bits of state, passes the smoke tests we care about, and is
 * eight lines — which matters when the alternative is a dependency (ADR-0003).
 */
export function seededRng(seed: number | string): Rng {
  let state = typeof seed === "number" ? seed >>> 0 : hashString(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i] as T;
        const b = out[j] as T;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
  };
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
