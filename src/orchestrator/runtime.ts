import { systemClock, type Clock } from "../core/clock.ts";
import { seededRng, type Rng } from "../core/rng.ts";
import { sequentialIds, type IdFactory } from "../core/ids.ts";
import { Failure, budgetExceeded, invariant, toEscapementError } from "../core/errors.ts";
import type { Message, ToolCall } from "../core/messages.ts";
import type { ModelProvider } from "../providers/provider.ts";
import { createRegistry, type ToolRegistry } from "../tools/registry.ts";
import { EventType, isTerminal } from "./phases.ts";
import type { RunEvent } from "./events.ts";
import type { Effect } from "./effects.ts";
import { effectKinds } from "./effects.ts";
import { reduce } from "./reducer.ts";
import { createRecorder, LEDGER_VERSION, type LedgerEntry, type RunLedger } from "./ledger.ts";
import {
  DEFAULT_CONFIG,
  initialState,
  type Budget,
  type Outcome,
  type RetryPolicy,
  type RunConfig,
  type RunState,
  type ToolExecution,
} from "./state.ts";
import {
  passthroughAssembler,
  trimFinalizer,
  type AssemblyRequest,
  type ContextAssembler,
  type Finalizer,
} from "./assembler.ts";

export type RunDeps = { readonly clock: Clock; readonly rng: Rng; readonly ids: IdFactory };

export type RunOptions = {
  readonly goal: string;
  readonly provider: ModelProvider;
  readonly tools?: ToolRegistry;
  readonly assembler?: ContextAssembler;
  readonly finalizer?: Finalizer;
  readonly config?: { readonly budget?: Partial<Budget>; readonly retry?: Partial<RetryPolicy> };
  readonly deps?: Partial<RunDeps>;
  readonly seed?: string;
  readonly runId?: string;
  readonly signal?: AbortSignal;
  /** Called as each transition is recorded. For live tracing; the ledger is
   *  the durable record. */
  readonly onEntry?: (entry: LedgerEntry) => void;
};

export type RunResult = {
  readonly outcome: Outcome;
  readonly state: RunState;
  readonly ledger: RunLedger;
};

/**
 * The impure half (ADR-0006).
 *
 * Everything here is plumbing: pull an event, hand it to the reducer, execute
 * whatever effect comes back, turn the result into the next event. It makes no
 * decisions. Every branch that matters — routing, retry, budget — lives in the
 * reducer, which is why a different driver (a replayer, a distributed worker
 * pool, a debugger stepping one event at a time) produces identical behaviour.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const clock = options.deps?.clock ?? systemClock;
  const seed = options.seed ?? "escapement";
  const rng = options.deps?.rng ?? seededRng(seed);
  const ids = options.deps?.ids ?? sequentialIds();

  const config: RunConfig = {
    budget: { ...DEFAULT_CONFIG.budget, ...options.config?.budget },
    retry: { ...DEFAULT_CONFIG.retry, ...options.config?.retry },
  };

  const registry = options.tools ?? createRegistry([]);
  const assemble = options.assembler ?? passthroughAssembler;
  const finalize = options.finalizer ?? trimFinalizer;

  const runId = options.runId ?? ids.next("run");
  const startedAt = clock.now();
  const recorder = createRecorder(options.onEntry);

  let state: RunState = initialState(runId, options.goal, startedAt);
  const events: RunEvent[] = [{ type: EventType.RunStarted, at: startedAt, goal: options.goal }];
  const effects: Effect[] = [];

  const assemblyRequest = (): AssemblyRequest => ({
    runId,
    step: state.step,
    goal: state.goal,
    transcript: state.transcript,
    tools: registry.list(),
  });

  const apply = (event: RunEvent): void => {
    const from = state.phase;
    const transition = reduce(state, event, config);
    invariant(
      transition.effects.length === 0 || transition.emit.length === 0,
      "a transition may queue effects or emit events, not both — otherwise their order is ambiguous",
      { event: event.type },
    );
    state = transition.state;
    recorder.record({ at: event.at, from, to: state.phase, event, effects: effectKinds(transition.effects) });
    events.push(...transition.emit);
    effects.push(...transition.effects);
  };

  while (!isTerminal(state.phase)) {
    const queued = events.shift();
    if (queued !== undefined) {
      apply(queued);
      continue;
    }

    if (options.signal?.aborted) {
      events.push({ type: EventType.RunCancelled, at: clock.now() });
      continue;
    }

    const effect = effects.shift();
    invariant(effect !== undefined, "the run is stuck: no events queued and no effects pending", {
      phase: state.phase,
    });

    events.push(await execute(effect));

    // Wall-clock is the one limit that can be breached *during* an effect, so
    // the runtime detects it here. The reducer still decides what it means.
    const elapsed = clock.now() - startedAt;
    if (elapsed >= config.budget.maxWallClockMs && !isTerminal(state.phase)) {
      events.push({
        type: EventType.BudgetExceeded,
        at: clock.now(),
        error: budgetExceeded("budget.wall_clock", `Wall-clock budget exhausted after ${elapsed}ms.`, {
          elapsedMs: elapsed,
          limit: config.budget.maxWallClockMs,
        }),
      });
    }
  }

  async function execute(effect: Effect): Promise<RunEvent> {
    switch (effect.kind) {
      case "assemble": {
        try {
          const context = await assemble(assemblyRequest());
          return { type: EventType.ContextAssembled, at: clock.now(), context };
        } catch (thrown) {
          return { type: EventType.Fault, at: clock.now(), error: toEscapementError(thrown, "assembler") };
        }
      }

      case "call-model": {
        const stepId = ids.next("step");
        try {
          const result = await provideModel(effect.context.messages, stepId, effect.attempt);
          if (result.ok) {
            return {
              type: EventType.ModelSucceeded,
              at: clock.now(),
              message: result.value.message,
              usage: result.value.usage,
              stopReason: result.value.stopReason,
            };
          }
          return { type: EventType.ModelFailed, at: clock.now(), error: result.error };
        } catch (thrown) {
          // The port says "return a Result". A provider that throws anyway has
          // a bug, and we will not guess that trying again would help.
          return { type: EventType.Fault, at: clock.now(), error: toEscapementError(thrown, "provider") };
        }
      }

      case "execute-tools": {
        const results = await executeTools(effect.calls);
        return { type: EventType.ToolsCompleted, at: clock.now(), results };
      }

      case "wait": {
        // Jitter lives here, not in the reducer: the reducer must stay a pure
        // function of (state, event, config), and the ledger records what was
        // actually waited, so replay never needs the RNG (ADR-0004).
        const spread = effect.ms * config.retry.jitter;
        const waitedMs = Math.max(0, Math.round(effect.ms - spread + rng.next() * spread * 2));
        await clock.sleep(waitedMs);
        return { type: EventType.BackoffElapsed, at: clock.now(), waitedMs };
      }

      case "finalize": {
        try {
          const output = await finalize(effect.draft, assemblyRequest());
          return { type: EventType.OutputFinalized, at: clock.now(), output };
        } catch (thrown) {
          return { type: EventType.Fault, at: clock.now(), error: toEscapementError(thrown, "finalizer") };
        }
      }
    }
  }

  function provideModel(messages: readonly Message[], stepId: string, attempt: number) {
    return options.provider.generate(
      { messages, tools: registry.list() },
      { runId, stepId, attempt, ...(options.signal ? { signal: options.signal } : {}) },
    );
  }

  async function executeTools(calls: readonly ToolCall[]): Promise<readonly ToolExecution[]> {
    const allReadOnly = calls.every((c) => registry.get(c.name)?.readOnly === true);
    // Concurrency is a permission the tool granted, not an optimisation we
    // assume (ADR-0015). Anything not declared readOnly runs in order.
    if (allReadOnly && calls.length > 1) return Promise.all(calls.map(runOne));
    const results: ToolExecution[] = [];
    for (const call of calls) results.push(await runOne(call));
    return results;
  }

  async function runOne(call: ToolCall): Promise<ToolExecution> {
    const stepId = ids.next("tool");
    const startedCall = clock.now();
    const readOnly = registry.get(call.name)?.readOnly === true;
    const maxAttempts = readOnly ? Math.max(1, config.budget.maxToolAttempts) : 1;

    let attempts = 0;
    let last = await registry.invoke(call, { runId, stepId, clock, ...(options.signal ? { signal: options.signal } : {}) });
    attempts += 1;

    while (!last.ok && last.error.class === Failure.Transient && attempts < maxAttempts) {
      await clock.sleep(config.retry.baseDelayMs);
      last = await registry.invoke(call, { runId, stepId, clock, ...(options.signal ? { signal: options.signal } : {}) });
      attempts += 1;
    }

    const durationMs = clock.now() - startedCall;
    if (last.ok) {
      return { call, ok: true, content: renderToolValue(last.value), durationMs, attempts };
    }
    return {
      call,
      ok: false,
      content: last.error.message,
      error: last.error,
      durationMs,
      attempts,
    };
  }

  const finishedAt = clock.now();
  const outcome: Outcome = state.outcome ?? {
    status: "failed",
    error: { class: Failure.Fatal, code: "run.no_outcome", message: "run ended without recording an outcome" },
  };

  const ledger: RunLedger = {
    version: LEDGER_VERSION,
    runId,
    goal: options.goal,
    seed,
    config,
    startedAt,
    finishedAt,
    finalPhase: state.phase,
    usage: state.usage,
    outcome,
    entries: recorder.entries,
  };

  return { outcome, state, ledger };
}

function renderToolValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
