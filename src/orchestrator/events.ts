import type { AssistantMessage, ToolCall } from "../core/messages.ts";
import type { EscapementError } from "../core/errors.ts";
import type { ModelUsage, StopReason } from "../providers/provider.ts";
import type { AssembledContext, ToolExecution } from "./state.ts";
import { EventType } from "./phases.ts";

/**
 * Everything that can happen to a run.
 *
 * Every event carries `at`, supplied by the injected clock. The reducer's only
 * notion of time is the timestamp on the event it is handling — it never asks
 * what time it is (ADR-0004), which is what makes wall-clock budget enforcement
 * survive replay unchanged.
 */
export type RunEvent =
  | { readonly type: typeof EventType.RunStarted; readonly at: number; readonly goal: string }
  | { readonly type: typeof EventType.ContextAssembled; readonly at: number; readonly context: AssembledContext }
  | {
      readonly type: typeof EventType.ModelSucceeded;
      readonly at: number;
      readonly message: AssistantMessage;
      readonly usage: ModelUsage;
      readonly stopReason: StopReason;
    }
  | { readonly type: typeof EventType.ModelFailed; readonly at: number; readonly error: EscapementError }
  | { readonly type: typeof EventType.RouteTools; readonly at: number; readonly calls: readonly ToolCall[] }
  | { readonly type: typeof EventType.RouteAnswer; readonly at: number; readonly content: string }
  | { readonly type: typeof EventType.RouteRepair; readonly at: number; readonly error: EscapementError }
  | { readonly type: typeof EventType.ToolsCompleted; readonly at: number; readonly results: readonly ToolExecution[] }
  | { readonly type: typeof EventType.ObservationsRecorded; readonly at: number; readonly count: number }
  | { readonly type: typeof EventType.BackoffElapsed; readonly at: number; readonly waitedMs: number }
  | { readonly type: typeof EventType.OutputFinalized; readonly at: number; readonly output: string }
  | { readonly type: typeof EventType.BudgetExceeded; readonly at: number; readonly error: EscapementError }
  | { readonly type: typeof EventType.Fault; readonly at: number; readonly error: EscapementError }
  | { readonly type: typeof EventType.RunCancelled; readonly at: number };
