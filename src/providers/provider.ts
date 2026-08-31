import type { AssistantMessage, Message } from "../core/messages.ts";
import type { EscapementError } from "../core/errors.ts";
import type { Result } from "../core/result.ts";
import type { ToolDefinition } from "../tools/registry.ts";

export type ModelUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
};

/**
 * Why the model stopped. The orchestrator routes on this, so it is a closed set
 * rather than a provider-specific string.
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export type ModelRequest = {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
};

export type ModelResponse = {
  readonly message: AssistantMessage;
  readonly usage: ModelUsage;
  readonly stopReason: StopReason;
};

export type ModelCallContext = {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly signal?: AbortSignal;
};

/**
 * The model port (ADR-0014).
 *
 * Note the return type: `Result`, not a thrown exception. A provider adapter's
 * one real job is to classify — a 429 is `transient`, a 400 about a malformed
 * tool schema is `fatal`, a response the model garbled is `correctable`. Doing
 * that at the boundary is what lets the transition table stay total.
 */
export type ModelProvider = {
  readonly name: string;
  generate(request: ModelRequest, ctx: ModelCallContext): Promise<Result<ModelResponse, EscapementError>>;
};
