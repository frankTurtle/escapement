/**
 * A Result type, because the orchestrator's transition table has to be total.
 *
 * Anything that can fail in a way the state machine must *route on* returns a
 * Result rather than throwing. Thrown exceptions are reserved for programmer
 * error — an illegal transition, a malformed machine definition — where there
 * is no sensible next state and crashing loudly is the correct behaviour.
 */
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Unwrap or throw. Only for call sites that have already proven the branch. */
export function expect<T, E>(r: Result<T, E>, message: string): T {
  if (r.ok) return r.value;
  throw new Error(`${message}: ${JSON.stringify(r.error)}`);
}

export function mapOk<T, U, E>(r: Result<T, E>, f: (value: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}
