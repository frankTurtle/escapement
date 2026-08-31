import type { JsonObject } from "../core/json.ts";
import { assistant, type ToolCall } from "../core/messages.ts";
import { fatal, type EscapementError } from "../core/errors.ts";
import { ok, err } from "../core/result.ts";
import type { ModelProvider, ModelRequest, ModelResponse, StopReason } from "./provider.ts";

export type ScriptedToolCall = { readonly name: string; readonly args: JsonObject };

export type ScriptedTurn =
  | {
      readonly say: string;
      readonly callTools?: readonly ScriptedToolCall[];
      readonly usage?: { readonly promptTokens?: number; readonly completionTokens?: number };
      readonly stopReason?: StopReason;
    }
  | { readonly failWith: EscapementError };

export type ScriptedProviderOptions = {
  readonly name?: string;
  /**
   * What to do when the script runs out. `"fail"` is the default and is almost
   * always what you want in a test: an agent that took more turns than the
   * fixture anticipated has changed its behaviour, and silently improvising a
   * reply would hide exactly the regression the eval exists to catch.
   */
  readonly onExhausted?: "fail" | "repeat-last";
};

export type ScriptedProvider = ModelProvider & {
  /** Every request the machine actually issued, in order. */
  readonly requests: readonly ModelRequest[];
  readonly turnsConsumed: number;
};

/**
 * A model that says exactly what you told it to say.
 *
 * This exists so the eval harness can grade *orchestration* without a network
 * call and without sampling variance. It is not a mock in the testing-seam
 * sense — it is the same `ModelProvider` interface a real adapter implements,
 * which is what makes recorded fixtures replayable (ADR-0014).
 */
export function scriptedProvider(
  turns: readonly ScriptedTurn[],
  options: ScriptedProviderOptions = {},
): ScriptedProvider {
  const onExhausted = options.onExhausted ?? "fail";
  const requests: ModelRequest[] = [];
  let cursor = 0;

  const provider = {
    name: options.name ?? "scripted",
    requests,
    get turnsConsumed() {
      return cursor;
    },
    generate: async (request: ModelRequest) => {
      requests.push(request);

      let turn = turns[cursor];
      if (turn === undefined) {
        if (onExhausted === "repeat-last" && turns.length > 0) {
          turn = turns[turns.length - 1] as ScriptedTurn;
        } else {
          return err(
            fatal(
              "scripted.exhausted",
              `Scripted provider ran out of turns after ${turns.length}. The run took more model calls than the fixture anticipated.`,
              { turnsDefined: turns.length, requested: cursor + 1 },
            ),
          );
        }
      }
      cursor += 1;

      if ("failWith" in turn) return err(turn.failWith);

      const toolCalls: ToolCall[] = (turn.callTools ?? []).map((call, i) => ({
        id: `call-${String(cursor).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`,
        name: call.name,
        args: call.args,
      }));

      const response: ModelResponse = {
        message: assistant(turn.say, toolCalls),
        usage: {
          promptTokens: turn.usage?.promptTokens ?? estimateRequestTokens(request),
          completionTokens: turn.usage?.completionTokens ?? Math.ceil(turn.say.length / 4) + toolCalls.length * 24,
        },
        stopReason: turn.stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
      };
      return ok(response);
    },
  };

  return provider;
}

/**
 * Wrap a real provider and capture its responses as a script.
 *
 * This is the bridge from "it broke in production" to "there is an eval case for
 * it": run once against the real model, keep `script`, and the trajectory
 * replays offline forever after.
 */
export function recordingProvider(inner: ModelProvider): ModelProvider & { readonly script: readonly ScriptedTurn[] } {
  const script: ScriptedTurn[] = [];
  return {
    name: `recording(${inner.name})`,
    script,
    generate: async (request, ctx) => {
      const result = await inner.generate(request, ctx);
      if (result.ok) {
        const { message, usage, stopReason } = result.value;
        script.push({
          say: message.content,
          ...(message.toolCalls && message.toolCalls.length > 0
            ? { callTools: message.toolCalls.map((c) => ({ name: c.name, args: c.args })) }
            : {}),
          usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens },
          stopReason,
        });
      } else {
        script.push({ failWith: result.error });
      }
      return result;
    },
  };
}

function estimateRequestTokens(request: ModelRequest): number {
  let chars = 0;
  for (const m of request.messages) chars += m.content.length;
  for (const t of request.tools) chars += t.name.length + t.description.length;
  return Math.ceil(chars / 4);
}
