import { canonicalJson, type JsonObject, type JsonValue } from "../core/json.ts";
import { correctable, fatal, transient, type EscapementError } from "../core/errors.ts";
import { err, ok } from "../core/result.ts";
import { manualClock } from "../core/clock.ts";
import { seededRng } from "../core/rng.ts";
import { sequentialIds } from "../core/ids.ts";
import type { ModelProvider } from "../providers/provider.ts";
import type { ScriptedTurn } from "../providers/scripted.ts";
import { createRegistry, type ToolDefinition } from "../tools/registry.ts";
import type { ContextAssembler, Finalizer } from "./assembler.ts";
import type { RunEvent } from "./events.ts";
import type { RunLedger } from "./ledger.ts";
import type { AssembledContext } from "./state.ts";
import { run, type RunResult } from "./runtime.ts";

type ModelEvent = Extract<RunEvent, { type: "model.succeeded" | "model.failed" }>;
type RecordedTurn = { readonly event: ModelEvent; readonly context: AssembledContext | null; readonly seq: number };

/** Model turns in the order they happened, each with the context it was given. */
function recordedTurns(ledger: RunLedger): readonly RecordedTurn[] {
  const turns: RecordedTurn[] = [];
  let context: AssembledContext | null = null;
  for (const entry of ledger.entries) {
    const event = entry.event;
    if (event.type === "context.assembled") context = event.context;
    if (event.type === "model.succeeded" || event.type === "model.failed") {
      turns.push({ event, context, seq: entry.seq });
    }
  }
  return turns;
}

const canonical = (value: unknown): string => canonicalJson(value as JsonValue);

/**
 * A run's model turns as a script, call ids included (ADR-0018).
 *
 * Feed it to `scriptedProvider` and the run says exactly what it said before,
 * including which turns failed and how.
 */
export function scriptFromLedger(ledger: RunLedger): ScriptedTurn[] {
  return recordedTurns(ledger).map(({ event }) => {
    if (event.type === "model.failed") return { failWith: event.error };
    const calls = event.message.toolCalls ?? [];
    return {
      say: event.message.content,
      ...(calls.length > 0 ? { callTools: calls.map((c) => ({ id: c.id, name: c.name, args: c.args })) } : {}),
      usage: { promptTokens: event.usage.promptTokens, completionTokens: event.usage.completionTokens },
      stopReason: event.stopReason,
    };
  });
}

export type ReplayProviderOptions = {
  readonly name?: string;
  /**
   * Check each request against the context the ledger recorded for that call,
   * and fail with `replay.diverged` if it differs. On by default: a recorded
   * answer to a different question hides the divergence a replay exists to
   * find. Turn it off when you change the assembler on purpose.
   */
  readonly verifyRequests?: boolean;
};

export type ReplayProvider = ModelProvider & { readonly turnsServed: number };

/**
 * A model that answers with what the ledger says it answered (ADR-0018).
 *
 * Successes and failures are served in recorded order, with their recorded
 * usage and stop reason, so the reducer sees exactly the events it saw the
 * first time.
 */
export function replayProvider(ledger: RunLedger, options: ReplayProviderOptions = {}): ReplayProvider {
  const turns = recordedTurns(ledger);
  const verify = options.verifyRequests ?? true;
  let cursor = 0;

  return {
    name: options.name ?? `replay(${ledger.runId})`,
    get turnsServed() {
      return cursor;
    },
    generate: async (request) => {
      const turn = turns[cursor];
      if (turn === undefined) {
        return err(
          fatal(
            "replay.exhausted",
            `The ledger records ${turns.length} model call(s); the run asked for another.`,
            { recorded: turns.length, requested: cursor + 1 },
          ),
        );
      }
      if (verify && turn.context !== null && canonical(request.messages) !== canonical(turn.context.messages)) {
        return err(
          fatal(
            "replay.diverged",
            `Model call ${cursor + 1} was sent a different context than the recording (ledger entry ${turn.seq}).`,
            { call: cursor + 1, seq: turn.seq },
          ),
        );
      }
      cursor += 1;
      const event = turn.event;
      if (event.type === "model.failed") return err(event.error);
      return ok({ message: event.message, usage: event.usage, stopReason: event.stopReason });
    },
  };
}

type RecordedResult = {
  readonly name: string;
  readonly args: string;
  readonly ok: boolean;
  readonly content: string;
  readonly error: EscapementError | undefined;
  readonly attempts: number;
  claimed: boolean;
  served: number;
};

/**
 * Tool definitions whose handlers answer with the recorded results (ADR-0018).
 *
 * Calls are matched by name and canonical arguments, in recorded order. A call
 * the runtime retried returns `attempts - 1` transient failures before its
 * recorded result, so the retry count reproduces. Use one set per run: the
 * handlers remember what they have served.
 *
 * Pass the original `definitions` to keep their schemas, descriptions and
 * `readOnly` flags. Without them each tool gets an open schema and no
 * description, which is enough to follow the trajectory but changes what an
 * assembler renders.
 */
export function recordedTools(ledger: RunLedger, definitions?: readonly ToolDefinition[]): ToolDefinition[] {
  const records: RecordedResult[] = [];
  for (const entry of ledger.entries) {
    if (entry.event.type !== "tools.completed") continue;
    for (const r of entry.event.results) {
      records.push({
        name: r.call.name,
        args: canonical(r.call.args),
        ok: r.ok,
        content: r.content,
        error: r.error,
        attempts: Math.max(1, r.attempts),
        claimed: false,
        served: 0,
      });
    }
  }
  const inFlight = new Map<string, RecordedResult>();

  const handlerFor = (name: string): ToolDefinition["handler"] => (args: JsonObject, ctx) => {
    let slot = inFlight.get(ctx.stepId);
    if (slot === undefined) {
      const key = canonical(args);
      slot = records.find((r) => !r.claimed && r.name === name && r.args === key);
      if (slot === undefined) {
        return err(
          fatal("replay.unrecorded_tool_call", `The recording has no further call to "${name}" with these arguments.`, {
            tool: name,
            args,
          }),
        );
      }
      slot.claimed = true;
      inFlight.set(ctx.stepId, slot);
    }
    slot.served += 1;
    if (slot.served < slot.attempts) {
      return err(transient("replay.recorded_retry", `Recorded attempt ${slot.served} of ${slot.attempts} failed.`));
    }
    inFlight.delete(ctx.stepId);
    if (slot.ok) return ok(slot.content);
    return err(slot.error ?? correctable("tool.failed", slot.content));
  };

  if (definitions !== undefined) {
    return definitions.map((def) => ({ ...def, handler: handlerFor(def.name) }));
  }

  // A name the registry rejected as unknown was never a tool, and must stay unknown.
  const names: string[] = [];
  for (const r of records) {
    if (r.error?.code === "tool.unknown" || names.includes(r.name)) continue;
    names.push(r.name);
  }
  return names.map((name) => ({
    name,
    description: "",
    schema: { type: "object", properties: {} },
    handler: handlerFor(name),
    readOnly: records.some((r) => r.name === name && r.attempts > 1),
  }));
}

export type ReexecuteOptions = {
  /** The original tool definitions. Their handlers are replaced with recorded
   *  results unless `liveTools` is set. */
  readonly tools?: readonly ToolDefinition[];
  /** Run the real handlers instead of serving recorded results. */
  readonly liveTools?: boolean;
  readonly assembler?: ContextAssembler;
  readonly finalizer?: Finalizer;
  /** See `ReplayProviderOptions.verifyRequests`. */
  readonly verifyRequests?: boolean;
};

export type ReexecuteResult = RunResult & {
  /** The new ledger serialises to the same bytes as the recorded one. */
  readonly identical: boolean;
  /** `seq` of the first entry that differs; `0` if only the header differs;
   *  `null` when identical. */
  readonly firstDifference: number | null;
};

/**
 * Run a recorded run again, with the model's turns served back (ADR-0018).
 *
 * Goal, run id, seed and config come from the ledger. The clock is a manual
 * clock starting at `startedAt`, so a run recorded on a manual clock (as the
 * eval harness does) re-executes byte for byte. A run recorded on the system
 * clock re-executes with the same events but different timestamps.
 */
export async function reexecute(ledger: RunLedger, options: ReexecuteOptions = {}): Promise<ReexecuteResult> {
  const provider = replayProvider(ledger, { verifyRequests: options.verifyRequests ?? true });
  const tools = options.liveTools ? [...(options.tools ?? [])] : recordedTools(ledger, options.tools);
  const shared = {
    provider,
    tools: createRegistry(tools),
    ...(options.assembler ? { assembler: options.assembler } : {}),
    ...(options.finalizer ? { finalizer: options.finalizer } : {}),
  };

  const result: RunResult = await run({
    ...shared,
    goal: ledger.goal,
    runId: ledger.runId,
    seed: ledger.seed,
    config: ledger.config,
    deps: { clock: manualClock(ledger.startedAt), rng: seededRng(ledger.seed), ids: sequentialIds() },
  });

  const firstDifference = compareLedgers(ledger, result.ledger);
  return { ...result, identical: firstDifference === null, firstDifference };
}

function compareLedgers(recorded: RunLedger, again: RunLedger): number | null {
  const length = Math.max(recorded.entries.length, again.entries.length);
  for (let i = 0; i < length; i++) {
    const a = recorded.entries[i];
    const b = again.entries[i];
    if (a === undefined || b === undefined || canonical(a) !== canonical(b)) return i + 1;
  }
  const { entries: _a, ...headA } = recorded;
  const { entries: _b, ...headB } = again;
  return canonical(headA) === canonical(headB) ? null : 0;
}
