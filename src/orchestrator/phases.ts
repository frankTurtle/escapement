/**
 * The phases of a run, and the transition table that governs them (ADR-0006).
 *
 * This file is the specification. If you want to know what the orchestrator can
 * do, read `TRANSITIONS` — not the runtime, not the reducer. Anything not in
 * the table cannot happen, and attempting it throws rather than limping on.
 */
export const Phase = {
  /** Nothing has happened yet. */
  Init: "init",
  /** Building the context window for the next model call. */
  Assemble: "assemble",
  /** Waiting on the model. */
  Model: "model",
  /** The decision point: tool calls, an answer, or a repair. */
  Route: "route",
  /** Executing the tool calls the model asked for. */
  Tools: "tools",
  /** Folding results back into the transcript as observations. */
  Observe: "observe",
  /** Waiting out a transient failure before retrying. */
  Backoff: "backoff",
  /** Turning a draft answer into the run's output. */
  Finalize: "finalize",

  /** Terminal: produced an answer. */
  Done: "done",
  /** Terminal: gave up. Something was wrong. */
  Failed: "failed",
  /** Terminal: hit a declared limit. Nothing was wrong; the limit was the point. */
  Halted: "halted",
} as const;

export type Phase = (typeof Phase)[keyof typeof Phase];

export const TERMINAL_PHASES: readonly Phase[] = [Phase.Done, Phase.Failed, Phase.Halted];

export const isTerminal = (phase: Phase): boolean => TERMINAL_PHASES.includes(phase);

export const EventType = {
  RunStarted: "run.started",
  ContextAssembled: "context.assembled",
  ModelSucceeded: "model.succeeded",
  ModelFailed: "model.failed",
  RouteTools: "route.tools",
  RouteAnswer: "route.answer",
  RouteRepair: "route.repair",
  ToolsCompleted: "tools.completed",
  ObservationsRecorded: "observations.recorded",
  BackoffElapsed: "backoff.elapsed",
  OutputFinalized: "output.finalized",
  BudgetExceeded: "budget.exceeded",
  Fault: "fault",
  RunCancelled: "run.cancelled",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

/**
 * Three events are legal from every non-terminal phase. They are spread into
 * each row rather than special-cased in the reducer, so the table stays the
 * single source of truth and the generated diagram is honest about them.
 */
const ANY_PHASE = {
  [EventType.BudgetExceeded]: [Phase.Halted],
  [EventType.Fault]: [Phase.Failed],
  [EventType.RunCancelled]: [Phase.Failed],
} as const;

export type TransitionTable = Readonly<Record<Phase, Readonly<Partial<Record<EventType, readonly Phase[]>>>>>;

/**
 * (phase, event) -> the phases that may follow.
 *
 * A list rather than a single phase because one event legitimately has several
 * outcomes: `model.failed` goes to `backoff`, `observe`, `failed` or `halted`
 * depending on the failure class. The reducer picks; the table constrains.
 */
export const TRANSITIONS: TransitionTable = Object.freeze({
  // Note the terminal targets on ordinary events. Budget enforcement lives in
  // the reducer (ADR-0006), so the very event that would begin expensive work
  // is also the event that can end the run instead. The table says so out loud
  // rather than leaving it as a special case the reducer knows about.
  [Phase.Init]: { ...ANY_PHASE, [EventType.RunStarted]: [Phase.Assemble, Phase.Halted] },

  [Phase.Assemble]: { ...ANY_PHASE, [EventType.ContextAssembled]: [Phase.Model, Phase.Halted] },

  [Phase.Model]: {
    ...ANY_PHASE,
    [EventType.ModelSucceeded]: [Phase.Route],
    // Routed by failure class (ADR-0005): transient -> backoff, correctable ->
    // observe, budget -> halted, fatal/cancelled/retries-exhausted -> failed.
    [EventType.ModelFailed]: [Phase.Backoff, Phase.Observe, Phase.Failed, Phase.Halted],
  },

  [Phase.Route]: {
    ...ANY_PHASE,
    [EventType.RouteTools]: [Phase.Tools, Phase.Halted],
    [EventType.RouteAnswer]: [Phase.Finalize],
    [EventType.RouteRepair]: [Phase.Observe],
  },

  // A tool that failed `fatal` ends the run here: it is a bug, not something to
  // hand back to the model (ADR-0005).
  [Phase.Tools]: { ...ANY_PHASE, [EventType.ToolsCompleted]: [Phase.Observe, Phase.Failed] },

  [Phase.Observe]: { ...ANY_PHASE, [EventType.ObservationsRecorded]: [Phase.Assemble, Phase.Halted] },

  [Phase.Backoff]: { ...ANY_PHASE, [EventType.BackoffElapsed]: [Phase.Model] },

  [Phase.Finalize]: { ...ANY_PHASE, [EventType.OutputFinalized]: [Phase.Done] },

  // Terminal phases accept nothing. A run that reaches one is over.
  [Phase.Done]: {},
  [Phase.Failed]: {},
  [Phase.Halted]: {},
});

/** Is this (phase, event, phase) triple in the table? */
export function isLegalTransition(from: Phase, event: EventType, to: Phase): boolean {
  return (TRANSITIONS[from][event] ?? []).includes(to);
}

export function allowedEvents(phase: Phase): readonly EventType[] {
  return Object.keys(TRANSITIONS[phase]) as EventType[];
}
