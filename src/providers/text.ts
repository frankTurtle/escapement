import type { JsonObject, JsonValue } from "../core/json.ts";
import { assistant, type Message, type ToolCall } from "../core/messages.ts";
import { correctable, type EscapementError } from "../core/errors.ts";
import { err, ok, type Result } from "../core/result.ts";
import { renderSchema } from "../tools/schema.ts";
import type { ModelCallContext, ModelProvider, ModelRequest, ModelUsage, StopReason } from "./provider.ts";

/**
 * The instruction a text-only model is given (ADR-0022). Exported so a client
 * that builds its own prompt can still ask for the same format.
 */
export const TEXT_TURN_PROTOCOL =
  'Reply with one JSON object and nothing else: {"say": string, "tool_calls": [{"name": string, "args": object}]}. ' +
  'To use tools, list the calls in "tool_calls". When you are done, leave "tool_calls" empty; "say" is then your final answer.';

export type TextPrompt = { readonly system: string; readonly prompt: string };

export type TextCompletion = {
  readonly text: string;
  /** Reported by the client when it knows. Estimated at chars/4 otherwise. */
  readonly usage?: ModelUsage;
  /** Only needed to report `max_tokens`; inferred from the parsed turn otherwise. */
  readonly stopReason?: StopReason;
};

/**
 * A client that takes text and returns text. Like `ModelProvider`, it returns a
 * classified `Result` rather than throwing: a 429 is `transient`, a 400 is
 * `fatal` (ADR-0014).
 */
export type TextModel = {
  readonly name: string;
  complete(
    input: TextPrompt & { readonly maxOutputTokens?: number; readonly temperature?: number },
    ctx: ModelCallContext,
  ): Promise<Result<TextCompletion, EscapementError>>;
};

export type TextTurn = { readonly say: string; readonly toolCalls: readonly ToolCall[] };

/** A turn in the protocol's own JSON, as earlier assistant turns are shown. */
const asProtocol = (content: string, calls: readonly ToolCall[]): string =>
  JSON.stringify({ say: content, tool_calls: calls.map((c) => ({ name: c.name, args: c.args })) });

function renderMessage(message: Message): string {
  switch (message.role) {
    case "system":
    case "user":
      return `[${message.role}]\n${message.content}`;
    case "assistant":
      return `[assistant]\n${asProtocol(message.content, message.toolCalls ?? [])}`;
    case "tool":
      return `[tool result: ${message.name}${message.isError ? " (error)" : ""}]\n${message.content}`;
  }
}

/**
 * Flatten a request into a system prompt and a user prompt (ADR-0022).
 *
 * `system` is the request's system messages, then the tools, then the
 * protocol. `prompt` is the rest of the transcript, one labelled block per
 * message.
 */
export function renderTextPrompt(request: ModelRequest): TextPrompt {
  const systemText = request.messages.filter((m) => m.role === "system").map((m) => m.content);
  const tools =
    request.tools.length > 0
      ? [`Tools:\n${request.tools.map((t) => `- ${t.name}${renderSchema(t.schema)}\n  ${t.description}`).join("\n")}`]
      : [];
  return {
    system: [...systemText, ...tools, TEXT_TURN_PROTOCOL].join("\n\n"),
    prompt: request.messages
      .filter((m) => m.role !== "system")
      .map(renderMessage)
      .join("\n\n"),
  };
}

const invalid = (problem: string): EscapementError =>
  correctable("model.invalid_turn", `Your reply did not follow the format: ${problem}. ${TEXT_TURN_PROTOCOL}`);

/** The JSON object in a reply: bare, fenced, or with prose around it. */
function extractObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : null;
}

const isObject = (v: unknown): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Parse one reply into a turn (ADR-0022).
 *
 * Anything unusable is `correctable`, with every shape problem listed and the
 * protocol restated, so the model gets one turn to fix it rather than the run
 * ending. Call ids are `${stepId}-call-${n}`, deterministic because the step id
 * is.
 */
export function parseTextTurn(text: string, stepId: string): Result<TextTurn, EscapementError> {
  const body = extractObject(text);
  if (body === null) return err(invalid("no JSON object found"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return err(invalid("the JSON object did not parse"));
  }
  if (!isObject(parsed)) return err(invalid("the reply must be a JSON object"));

  const problems: string[] = [];
  const say = parsed["say"];
  if (typeof say !== "string") problems.push("say must be a string");

  const rawCalls: JsonValue = parsed["tool_calls"] ?? [];
  const calls: ToolCall[] = [];
  if (!Array.isArray(rawCalls)) {
    problems.push("tool_calls must be an array");
  } else {
    rawCalls.forEach((raw: JsonValue, i: number) => {
      if (!isObject(raw)) return void problems.push(`tool_calls[${i}] must be an object`);
      const name = raw["name"];
      const args = raw["args"] ?? {};
      if (typeof name !== "string" || name.length === 0) problems.push(`tool_calls[${i}].name must be a string`);
      if (!isObject(args)) problems.push(`tool_calls[${i}].args must be an object`);
      if (typeof name === "string" && isObject(args)) calls.push({ id: `${stepId}-call-${i + 1}`, name, args });
    });
  }

  if (problems.length > 0 || typeof say !== "string") return err(invalid(problems.join("; ")));
  return ok({ say, toolCalls: calls });
}

/**
 * A `ModelProvider` over a client that only speaks text (ADR-0022).
 *
 * Renders the request with `renderTextPrompt`, calls the client, and parses
 * the reply with `parseTextTurn`. A reply that breaks the format becomes a
 * repair turn, not a failed run.
 */
export function textProvider(model: TextModel, options: { readonly name?: string } = {}): ModelProvider {
  return {
    name: options.name ?? `text(${model.name})`,
    generate: async (request, ctx) => {
      const prompt = renderTextPrompt(request);
      const completion = await model.complete(
        {
          ...prompt,
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        },
        ctx,
      );
      if (!completion.ok) return completion;

      const { text } = completion.value;
      const turn = parseTextTurn(text, ctx.stepId);
      if (!turn.ok) return turn;

      const usage: ModelUsage = completion.value.usage ?? {
        promptTokens: Math.ceil((prompt.system.length + prompt.prompt.length) / 4),
        completionTokens: Math.ceil(text.length / 4),
      };
      const stopReason: StopReason =
        completion.value.stopReason ?? (turn.value.toolCalls.length > 0 ? "tool_use" : "end_turn");
      return ok({ message: assistant(turn.value.say, turn.value.toolCalls), usage, stopReason });
    },
  };
}
