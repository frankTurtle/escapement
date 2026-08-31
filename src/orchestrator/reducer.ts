import { toolResult, user, type Message, type ToolCall } from "../core/messages.ts";
import {
  Failure,
  budgetExceeded,
  correctable,
  fatal,
  invariant,
  unreachable,
  type EscapementError,
} from "../core/errors.ts";
import { EventType, Phase, isLegalTransition, isTerminal } from "./phases.ts";
import type { RunEvent } from "./events.ts";
import type { Effect } from "./effects.ts";
import {
  backoffDelayMs,
  type Budget,
  type Outcome,
  type RunConfig,
  type RunState,
  type Usage,
} from "./state.ts";

export type Transition = {
  readonly state: RunState;
  readonly effects: readonly Effect[];
  /** Events fed straight back into the reducer before any effect runs. Pure
   *  transitions — routing, in practice — are visible in the ledger this way
   *  instead of collapsing into the transition that caused them. */
  readonly emit: readonly RunEvent[];
};

/**
 * The whole state machine (ADR-0006).
 *
 * A pure function. No clock, no randomness, no I/O, no `Deps` argument — the
 * only inputs are the current state, one event, and static config. Feed it the
 * events out of a ledger and you get the identical state sequence back, which
 * is what `replay()` relies on and what makes trajectory diffs signal rather
 * than noise.
 */
export function reduce(state: RunState, event: RunEvent, config: RunConfig): Transition {
  invariant(!isTerminal(state.phase), "the run is over; no further events are legal", {
    phase: state.phase,
    event: event.type,
  });

  const at = event.at;
  const base: RunState = { ...state, now: at };

  switch (event.type) {
    case EventType.BudgetExceeded:
      return halt(base, event, event.error);

    case EventType.Fault:
      return abort(base, event, event.error);

    case EventType.RunCancelled:
      return abort(base, event, {
        class: Failure.Cancelled,
        code: "run.cancelled",
        message: "run cancelled by caller",
      });

    case EventType.RunStarted: {
      const started: RunState = { ...base, goal: event.goal, transcript: [user(event.goal)] };
      return toAssemble(started, event, config.budget);
    }

    case EventType.ContextAssembled: {
      // Prospective enforcement: refuse a call we cannot afford rather than
      // discovering afterwards that it put us over.
      const projected = state.usage.totalTokens + event.context.tokens;
      if (projected > config.budget.maxTotalTokens) {
        return halt(
          base,
          event,
          budgetExceeded(
            "budget.tokens",
            `Assembled context of ${event.context.tokens} tokens would take the run to ${projected}, over the ${config.budget.maxTotalTokens} token budget.`,
            { assembled: event.context.tokens, spent: state.usage.totalTokens, limit: config.budget.maxTotalTokens },
          ),
        );
      }
      const withContext: RunState = { ...base, context: event.context };
      return step(withContext, event, Phase.Model, [
        { kind: "call-model", context: event.context, attempt: state.attempt },
      ]);
    }

    case EventType.ModelSucceeded: {
      const usage: Usage = {
        ...state.usage,
        modelCalls: state.usage.modelCalls + 1,
        promptTokens: state.usage.promptTokens + event.usage.promptTokens,
        completionTokens: state.usage.completionTokens + event.usage.completionTokens,
        totalTokens: state.usage.totalTokens + event.usage.promptTokens + event.usage.completionTokens,
      };
      const next: RunState = {
        ...base,
        step: state.step + 1,
        transcript: [...state.transcript, event.message],
        usage,
        attempt: 1,
        consecutiveFailures: 0,
      };
      return step(next, event, Phase.Route, [], [routeDecision(event.message.content, event.message.toolCalls, at)]);
    }

    case EventType.ModelFailed:
      return onModelFailed(base, event, event.error, config);

    case EventType.RouteTools: {
      const projected = state.usage.toolCalls + event.calls.length;
      if (projected > config.budget.maxToolCalls) {
        return halt(
          base,
          event,
          budgetExceeded(
            "budget.tool_calls",
            `Executing ${event.calls.length} more tool call(s) would take the run to ${projected}, over the ${config.budget.maxToolCalls} call budget.`,
            { requested: event.calls.length, spent: state.usage.toolCalls, limit: config.budget.maxToolCalls },
          ),
        );
      }
      const next: RunState = { ...base, pendingCalls: event.calls };
      return step(next, event, Phase.Tools, [{ kind: "execute-tools", calls: event.calls }]);
    }

    case EventType.RouteAnswer: {
      const next: RunState = { ...base, draft: event.content };
      return step(next, event, Phase.Finalize, [{ kind: "finalize", draft: event.content }]);
    }

    case EventType.RouteRepair:
      // The model produced something unusable. That is a conversational problem,
      // not a runtime one: hand the error back and let it try again (ADR-0005).
      return toObserve(base, event, [user(repairPrompt(event.error))], { corrective: true, failed: true });

    case EventType.ToolsCompleted: {
      const showstopper = event.results.find((r) => r.error?.class === Failure.Fatal);
      if (showstopper?.error) return abort(base, event, showstopper.error);

      const messages: Message[] = event.results.map((r) => toolResult(r.call, r.content, !r.ok));
      const anyFailed = event.results.some((r) => !r.ok);
      const allFailed = event.results.length > 0 && event.results.every((r) => !r.ok);
      const withUsage: RunState = {
        ...base,
        pendingCalls: [],
        usage: {
          ...state.usage,
          toolCalls: state.usage.toolCalls + event.results.length,
          retries: state.usage.retries + event.results.reduce((sum, r) => sum + (r.attempts - 1), 0),
        },
      };
      return toObserve(withUsage, event, messages, { corrective: anyFailed, failed: allFailed });
    }

    case EventType.ObservationsRecorded:
      return toAssemble(base, event, config.budget);

    case EventType.BackoffElapsed:
      invariant(state.context !== null, "cannot retry a model call with no assembled context");
      return step(base, event, Phase.Model, [
        { kind: "call-model", context: state.context, attempt: state.attempt },
      ]);

    case EventType.OutputFinalized: {
      const outcome: Outcome = { status: "completed", output: event.output };
      return step({ ...base, draft: null, outcome }, event, Phase.Done, []);
    }

    default:
      return unreachable(event, "reduce");
  }
}

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

function routeDecision(content: string, toolCalls: readonly ToolCall[] | undefined, at: number): RunEvent {
  if (toolCalls && toolCalls.length > 0) return { type: EventType.RouteTools, at, calls: toolCalls };
  if (content.trim().length === 0) {
    // Empty, no tool calls: the model said nothing at all. Common enough with
    // aggressive stop sequences that it deserves a named path rather than
    // silently finalising an empty answer.
    return {
      type: EventType.RouteRepair,
      at,
      error: correctable("model.empty_response", "The model returned neither content nor a tool call."),
    };
  }
  return { type: EventType.RouteAnswer, at, content };
}

function onModelFailed(
  base: RunState,
  event: RunEvent,
  error: EscapementError,
  config: RunConfig,
): Transition {
  switch (error.class) {
    case Failure.Transient: {
      if (base.attempt >= config.budget.maxModelAttempts) {
        return abort(
          base,
          event,
          fatal(
            "model.retries_exhausted",
            `Model call failed ${base.attempt} time(s) with a transient error and the retry budget is spent: ${error.message}`,
            { attempts: base.attempt, lastCode: error.code },
          ),
        );
      }
      const attempt = base.attempt + 1;
      const delay = backoffDelayMs(base.attempt, config.retry);
      const next: RunState = {
        ...base,
        attempt,
        usage: { ...base.usage, retries: base.usage.retries + 1 },
      };
      return step(next, event, Phase.Backoff, [{ kind: "wait", ms: delay }]);
    }
    case Failure.Correctable:
      return toObserve(base, event, [user(repairPrompt(error))], { corrective: true, failed: true });
    case Failure.Budget:
      return halt(base, event, error);
    case Failure.Fatal:
    case Failure.Cancelled:
      return abort(base, event, error);
    default:
      return unreachable(error.class, "onModelFailed");
  }
}

const repairPrompt = (error: EscapementError): string =>
  `Your previous response could not be used: ${error.message}\nCorrect it and try again.`;

// ---------------------------------------------------------------------------
// Transition constructors. Every one of these asserts against TRANSITIONS.
// ---------------------------------------------------------------------------

function step(
  next: RunState,
  event: RunEvent,
  to: Phase,
  effects: readonly Effect[],
  emit: readonly RunEvent[] = [],
): Transition {
  invariant(
    isLegalTransition(next.phase, event.type, to),
    "illegal transition — the transition table does not permit this",
    { from: next.phase, event: event.type, to },
  );
  return { state: { ...next, phase: to }, effects, emit };
}

/** Enter `assemble`, unless a limit says the run is finished. */
function toAssemble(next: RunState, event: RunEvent, budget: Budget): Transition {
  const breach = checkBudget(next, budget);
  if (breach) return halt(next, event, breach);
  return step(next, event, Phase.Assemble, [{ kind: "assemble" }]);
}

/** Enter `observe`, appending messages, then immediately move on. */
function toObserve(
  next: RunState,
  event: RunEvent,
  messages: readonly Message[],
  flags: { corrective: boolean; failed: boolean },
): Transition {
  const observed: RunState = {
    ...next,
    transcript: [...next.transcript, ...messages],
    usage: { ...next.usage, correctiveTurns: next.usage.correctiveTurns + (flags.corrective ? 1 : 0) },
    consecutiveFailures: flags.failed ? next.consecutiveFailures + 1 : 0,
  };
  return step(observed, event, Phase.Observe, [], [
    { type: EventType.ObservationsRecorded, at: event.at, count: messages.length },
  ]);
}

function halt(next: RunState, event: RunEvent, error: EscapementError): Transition {
  const outcome: Outcome = { status: "halted", error };
  invariant(
    isLegalTransition(next.phase, event.type, Phase.Halted),
    "illegal halt — the transition table does not permit it from here",
    { from: next.phase, event: event.type },
  );
  return { state: { ...next, phase: Phase.Halted, outcome }, effects: [], emit: [] };
}

function abort(next: RunState, event: RunEvent, error: EscapementError): Transition {
  const outcome: Outcome = { status: "failed", error };
  invariant(
    isLegalTransition(next.phase, event.type, Phase.Failed),
    "illegal abort — the transition table does not permit it from here",
    { from: next.phase, event: event.type },
  );
  return { state: { ...next, phase: Phase.Failed, outcome }, effects: [], emit: [] };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Enforced here, in the reducer, and nowhere else.
 *
 * A limit the runtime enforces is a limit a different runtime — a test harness,
 * a replayer, someone's custom driver — can forget to enforce. Putting it in the
 * pure function makes "this run cannot exceed 12 model calls" a property of the
 * state machine rather than a promise about one particular loop.
 */
export function checkBudget(state: RunState, budget: Budget): EscapementError | null {
  if (state.step >= budget.maxSteps) {
    return budgetExceeded("budget.steps", `Step budget exhausted after ${state.step} model call(s).`, {
      steps: state.step,
      limit: budget.maxSteps,
    });
  }
  if (state.usage.toolCalls >= budget.maxToolCalls) {
    return budgetExceeded("budget.tool_calls", `Tool-call budget exhausted after ${state.usage.toolCalls} call(s).`, {
      toolCalls: state.usage.toolCalls,
      limit: budget.maxToolCalls,
    });
  }
  if (state.usage.totalTokens >= budget.maxTotalTokens) {
    return budgetExceeded("budget.tokens", `Token budget exhausted at ${state.usage.totalTokens} tokens.`, {
      totalTokens: state.usage.totalTokens,
      limit: budget.maxTotalTokens,
    });
  }
  const elapsed = state.now - state.startedAt;
  if (elapsed >= budget.maxWallClockMs) {
    return budgetExceeded("budget.wall_clock", `Wall-clock budget exhausted after ${elapsed}ms.`, {
      elapsedMs: elapsed,
      limit: budget.maxWallClockMs,
    });
  }
  if (state.consecutiveFailures >= budget.maxConsecutiveFailures) {
    return budgetExceeded(
      "budget.consecutive_failures",
      `${state.consecutiveFailures} consecutive failing steps; the run is not making progress.`,
      { consecutiveFailures: state.consecutiveFailures, limit: budget.maxConsecutiveFailures },
    );
  }
  return null;
}
