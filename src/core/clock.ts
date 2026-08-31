/**
 * Time is an injected port (ADR-0004).
 *
 * Wall-clock time is the second most common source of non-determinism in an
 * agent, after the model itself. A run that consults `Date.now()` directly can
 * never be replayed, and any test that asserts on a duration is a future flake.
 */
export type Clock = {
  /** Milliseconds since epoch. */
  now(): number;
  /** Resolves after roughly `ms`. Virtual clocks resolve immediately. */
  sleep(ms: number): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export type ManualClock = Clock & {
  /** Move time forward without waiting for it. */
  advance(ms: number): void;
};

/**
 * A clock that only moves when you tell it to — except that `sleep` advances it
 * and resolves immediately. Backoff schedules are therefore testable and
 * instant: a run with 30s of backoff in it takes microseconds and still records
 * the correct elapsed time in its ledger.
 */
export function manualClock(startMs = 0): ManualClock {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(0, ms);
    },
    advance: (ms) => {
      t += ms;
    },
  };
}
