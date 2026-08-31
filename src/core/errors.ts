import type { JsonObject, JsonValue } from "./json.ts";

/**
 * The error taxonomy (ADR-0005).
 *
 * The axis is not "what went wrong" but **who can do something about it**.
 * That is the only question the orchestrator's routing table actually needs to
 * answer, and it makes the mapping from failure to next state total.
 */
export const Failure = {
  /** The runtime can fix it by trying again. Timeouts, 429, 5xx, socket resets. */
  Transient: "transient",
  /** The *model* can fix it by trying again with the error as an observation.
   *  Bad tool arguments, unknown tool name, a search that found nothing. */
  Correctable: "correctable",
  /** Nobody can fix it inside this run. Bad config, contract violation, a bug. */
  Fatal: "fatal",
  /** A declared limit was reached. Not an error in the moral sense; the run
   *  stops cleanly and reports what it had. */
  Budget: "budget",
  /** The caller pulled the plug. */
  Cancelled: "cancelled",
} as const;

export type FailureClass = (typeof Failure)[keyof typeof Failure];

/**
 * What the orchestrator does about a failure. Exactly one remedy per class —
 * that is the whole reason the taxonomy exists.
 */
export const Remedy = {
  Retry: "retry",
  Reprompt: "reprompt",
  Abort: "abort",
  Halt: "halt",
} as const;

export type RemedyKind = (typeof Remedy)[keyof typeof Remedy];

export const REMEDY_FOR: Readonly<Record<FailureClass, RemedyKind>> = Object.freeze({
  [Failure.Transient]: Remedy.Retry,
  [Failure.Correctable]: Remedy.Reprompt,
  [Failure.Fatal]: Remedy.Abort,
  [Failure.Budget]: Remedy.Halt,
  [Failure.Cancelled]: Remedy.Abort,
});

export type EscapementError = {
  readonly class: FailureClass;
  /** Stable, greppable, machine-routable. e.g. "tool.unknown", "model.timeout". */
  readonly code: string;
  readonly message: string;
  /** Structured detail. Must be JSON — it goes in the ledger. */
  readonly detail?: JsonObject;
  /** Where it came from, for the trace. */
  readonly source?: string;
};

export function fail(
  cls: FailureClass,
  code: string,
  message: string,
  detail?: JsonObject,
  source?: string,
): EscapementError {
  const e: { -readonly [K in keyof EscapementError]: EscapementError[K] } = { class: cls, code, message };
  if (detail !== undefined) e.detail = detail;
  if (source !== undefined) e.source = source;
  return e;
}

export const transient = (code: string, message: string, detail?: JsonObject): EscapementError =>
  fail(Failure.Transient, code, message, detail);
export const correctable = (code: string, message: string, detail?: JsonObject): EscapementError =>
  fail(Failure.Correctable, code, message, detail);
export const fatal = (code: string, message: string, detail?: JsonObject): EscapementError =>
  fail(Failure.Fatal, code, message, detail);
export const budgetExceeded = (code: string, message: string, detail?: JsonObject): EscapementError =>
  fail(Failure.Budget, code, message, detail);
export const cancelled = (message = "run cancelled"): EscapementError =>
  fail(Failure.Cancelled, "run.cancelled", message);

export const remedyFor = (error: EscapementError): RemedyKind => REMEDY_FOR[error.class];

/**
 * Programmer error. Distinct from EscapementError on purpose: an EscapementError
 * is data the state machine routes on, this is a crash. If you are tempted to
 * catch one of these, the transition table is wrong.
 */
export class InvariantViolation extends Error {
  readonly detail: JsonValue;
  constructor(message: string, detail: JsonValue = null) {
    super(message);
    this.name = "InvariantViolation";
    this.detail = detail;
  }
}

export function invariant(condition: unknown, message: string, detail: JsonValue = null): asserts condition {
  if (!condition) throw new InvariantViolation(message, detail);
}

/** Exhaustiveness check for union switches. Fails at compile time and at runtime. */
export function unreachable(value: never, context = "unreachable"): never {
  throw new InvariantViolation(`${context}: unhandled variant`, JSON.stringify(value) ?? "undefined");
}

/**
 * Carries a classified error across a boundary that can only throw.
 *
 * Some ports — the context assembler, the finalizer — are plain functions
 * because a Result-returning signature would infect every caller. When one of
 * those fails in a way the machine should route on, it throws this, and
 * `toEscapementError` unwraps it with the classification intact.
 */
export class CarriedError extends Error {
  readonly escapement: EscapementError;
  constructor(error: EscapementError) {
    super(error.message);
    this.name = "CarriedError";
    this.escapement = error;
  }
}

export const throwing = (error: EscapementError): CarriedError => new CarriedError(error);

/** Normalise anything thrown into the taxonomy, so `catch` sites stay total. */
export function toEscapementError(thrown: unknown, source?: string): EscapementError {
  if (thrown instanceof CarriedError) {
    return thrown.escapement.source === undefined && source !== undefined
      ? { ...thrown.escapement, source }
      : thrown.escapement;
  }
  if (thrown instanceof InvariantViolation) {
    return fail(Failure.Fatal, "invariant.violated", thrown.message, undefined, source);
  }
  if (thrown instanceof Error) {
    const code = thrown.name === "Error" ? "unknown.error" : `unknown.${thrown.name}`;
    return fail(Failure.Fatal, code, thrown.message, undefined, source);
  }
  return fail(Failure.Fatal, "unknown.throw", String(thrown), undefined, source);
}
