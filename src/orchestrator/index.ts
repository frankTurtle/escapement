export { Phase, EventType, TRANSITIONS, TERMINAL_PHASES, isTerminal, isLegalTransition, allowedEvents } from "./phases.ts";
export type { TransitionTable } from "./phases.ts";

export type { RunEvent } from "./events.ts";
export type { Effect, EffectKind } from "./effects.ts";
export { effectKinds } from "./effects.ts";

export { reduce, checkBudget } from "./reducer.ts";
export type { Transition } from "./reducer.ts";

export {
  DEFAULT_BUDGET,
  DEFAULT_RETRY,
  DEFAULT_CONFIG,
  ZERO_USAGE,
  initialState,
  backoffDelayMs,
} from "./state.ts";
export type {
  Budget,
  RetryPolicy,
  RunConfig,
  RunState,
  Usage,
  Outcome,
  AssembledContext,
  ToolExecution,
} from "./state.ts";

export {
  LEDGER_VERSION,
  createRecorder,
  replay,
  phaseTrace,
  phasePath,
  toolSequence,
  toolCalls,
  contextReports,
  elapsedMs,
  trajectoryFingerprint,
  serializeLedger,
  parseLedger,
} from "./ledger.ts";
export type { RunLedger, LedgerEntry, ReplayResult, Divergence, Recorder, ToolCallRecord } from "./ledger.ts";

export { passthroughAssembler, trimFinalizer } from "./assembler.ts";
export type { ContextAssembler, AssemblyRequest, Finalizer } from "./assembler.ts";

export { run } from "./runtime.ts";
export type { RunOptions, RunResult, RunDeps } from "./runtime.ts";

export { toMermaid, toMarkdownTable } from "./diagram.ts";
export { renderStateMachineDoc } from "./doc.ts";
