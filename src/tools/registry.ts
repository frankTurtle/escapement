import type { JsonObject, JsonValue } from "../core/json.ts";
import type { Clock } from "../core/clock.ts";
import type { ToolCall } from "../core/messages.ts";
import { correctable, toEscapementError, invariant, type EscapementError } from "../core/errors.ts";
import { ok, err, type Result } from "../core/result.ts";
import { renderSchema, validateArgs, type ObjectSchema } from "./schema.ts";

export type ToolContext = {
  readonly runId: string;
  readonly stepId: string;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
};

export type ToolOutcome = Result<JsonValue, EscapementError>;
export type ToolHandler = (args: JsonObject, ctx: ToolContext) => ToolOutcome | Promise<ToolOutcome>;

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly schema: ObjectSchema;
  readonly handler: ToolHandler;
  /**
   * No observable side effects.
   *
   * This is not documentation — the orchestrator reads it. Read-only calls in a
   * single assistant turn may be executed concurrently, and a read-only call
   * that fails transiently may be retried without asking the model. Neither is
   * safe for a tool that charges a credit card, so the default is `false`.
   */
  readonly readOnly?: boolean;
};

export type ToolRegistry = {
  get(name: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
  has(name: string): boolean;
  /** Prompt-shaped rendering of the whole toolset. Costs tokens; budgeted for. */
  render(): string;
  /** Resolve, validate, and run a model-issued call. Never throws. */
  invoke(call: ToolCall, ctx: ToolContext): Promise<Result<JsonValue, EscapementError>>;
};

export function createRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    invariant(/^[a-z][a-z0-9_]*$/.test(tool.name), "tool names must be lower_snake_case", tool.name);
    invariant(!byName.has(tool.name), "duplicate tool name", tool.name);
    byName.set(tool.name, tool);
  }

  const render = (): string =>
    [...byName.values()]
      .map((t) => `- ${t.name}${renderSchema(t.schema)}\n  ${t.description}`)
      .join("\n");

  return {
    get: (name) => byName.get(name),
    has: (name) => byName.has(name),
    list: () => [...byName.values()],
    render,
    invoke: async (call, ctx) => {
      const tool = byName.get(call.name);
      if (!tool) {
        // Correctable, not fatal: the model picked a name that does not exist,
        // and the fix is to tell it which names do (ADR-0005). Listing them is
        // the difference between one corrective turn and a loop.
        return err(
          correctable("tool.unknown", `No tool named "${call.name}". Available tools: ${[...byName.keys()].join(", ")}.`, {
            requested: call.name,
            available: [...byName.keys()],
          }),
        );
      }

      const validated = validateArgs(tool.name, tool.schema, call.args);
      if (!validated.ok) return validated;

      try {
        return await tool.handler(validated.value, ctx);
      } catch (thrown) {
        // A handler that throws is a handler with a bug. We classify it as fatal
        // rather than guessing, because a thrown exception carries no evidence
        // that trying again would help.
        return err(toEscapementError(thrown, `tool:${tool.name}`));
      }
    },
  };
}

/** Convenience for the common case: a handler that cannot fail. */
export function tool(
  name: string,
  description: string,
  schema: ObjectSchema,
  handler: (args: JsonObject, ctx: ToolContext) => JsonValue | Promise<JsonValue>,
  options: { readonly readOnly?: boolean } = {},
): ToolDefinition {
  const def: ToolDefinition = {
    name,
    description,
    schema,
    handler: async (args, ctx) => ok(await handler(args, ctx)),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  };
  return def;
}
