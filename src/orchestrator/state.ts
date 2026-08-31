import type { Message, ToolCall } from "../core/messages.ts";
import type { EscapementError } from "../core/errors.ts";
import type { JsonObject } from "../core/json.ts";
import type { Phase } from "./phases.ts";

export type Usage = {
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** Turns spent letting the model fix its own mistake. A quality signal: an
   *  agent with a high corrective-turn count is being poorly prompted. */
  readonly correctiveTurns: number;
  readonly retries: number;
};

export const ZERO_USAGE: Usage = Object.freeze({
  modelCalls: 0,
  toolCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  correctiveTurns: 0,
  retries: 0,
});

/**
 * Every limit is declared, finite, and enforced in the reducer — never in the
 * runtime. A limit the runtime enforces is a limit an alternative runtime can
 * forget to enforce (ADR-0006).
 */
export type Budget = {
  /** Model calls. The one that actually bounds cost. */
  readonly maxSteps: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
  readonly maxWallClockMs: number;
  /** Consecutive steps that produced nothing but errors. Catches the flailing
   *  agent that would otherwise burn the whole step budget failing identically. */
  readonly maxConsecutiveFailures: number;
  /** Attempts at a single model call before a transient failure becomes fatal. */
  readonly maxModelAttempts: number;
  /** Attempts at a single tool call. Only ever spent on readOnly tools —
   *  retrying anything else without asking the model could double-charge a
   *  card (ADR-0015). */
  readonly maxToolAttempts: number;
};

export const DEFAULT_BUDGET: Budget = Object.freeze({
  maxSteps: 12,
  maxToolCalls: 48,
  maxTotalTokens: 200_000,
  maxWallClockMs: 120_000,
  maxConsecutiveFailures: 3,
  maxModelAttempts: 3,
  maxToolAttempts: 2,
});

export type RetryPolicy = {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Fraction of the delay that the runtime may randomise, in [0, 1). Applied
   *  outside the reducer so the reducer stays a pure function (ADR-0006). */
  readonly jitter: number;
};

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  baseDelayMs: 250,
  maxDelayMs: 20_000,
  jitter: 0.25,
});

export type RunConfig = {
  readonly budget: Budget;
  readonly retry: RetryPolicy;
};

export const DEFAULT_CONFIG: RunConfig = Object.freeze({ budget: DEFAULT_BUDGET, retry: DEFAULT_RETRY });

/** The context window handed to the model, plus what it cost. */
export type AssembledContext = {
  readonly messages: readonly Message[];
  readonly tokens: number;
  /** Per-section accounting, when the assembler provides it. Recorded in the
   *  ledger so graders can assert on what was in context, not just on output. */
  readonly report?: JsonObject;
};

export type ToolExecution = {
  readonly call: ToolCall;
  readonly ok: boolean;
  readonly content: string;
  readonly error?: EscapementError;
  readonly durationMs: number;
  /** Retries the runtime performed on its own, only legal for readOnly tools. */
  readonly attempts: number;
};

export type Outcome =
  | { readonly status: "completed"; readonly output: string }
  | { readonly status: "failed"; readonly error: EscapementError }
  | { readonly status: "halted"; readonly error: EscapementError };

export type RunState = {
  readonly phase: Phase;
  readonly runId: string;
  readonly goal: string;
  /** Completed model calls. */
  readonly step: number;
  readonly transcript: readonly Message[];
  readonly pendingCalls: readonly ToolCall[];
  readonly context: AssembledContext | null;
  /** Candidate answer, awaiting finalisation. */
  readonly draft: string | null;
  readonly usage: Usage;
  /** Attempt number for the model call in flight, 1-based. */
  readonly attempt: number;
  readonly consecutiveFailures: number;
  readonly startedAt: number;
  /** Time of the most recent event. The reducer's only notion of "now". */
  readonly now: number;
  readonly outcome: Outcome | null;
};

export function initialState(runId: string, goal: string, startedAt: number): RunState {
  return {
    phase: "init",
    runId,
    goal,
    step: 0,
    transcript: [],
    pendingCalls: [],
    context: null,
    draft: null,
    usage: ZERO_USAGE,
    attempt: 1,
    consecutiveFailures: 0,
    startedAt,
    now: startedAt,
    outcome: null,
  };
}

/** Exponential backoff without jitter. Pure, so the reducer can compute it. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, exponential);
}
