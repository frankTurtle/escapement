import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reduce, checkBudget } from "../../src/orchestrator/reducer.ts";
import { EventType, Phase } from "../../src/orchestrator/phases.ts";
import { DEFAULT_CONFIG, initialState, type RunConfig, type RunState } from "../../src/orchestrator/state.ts";
import type { RunEvent } from "../../src/orchestrator/events.ts";
import { assistant } from "../../src/core/messages.ts";
import { Failure, InvariantViolation, correctable, fatal, transient } from "../../src/core/errors.ts";

const config: RunConfig = DEFAULT_CONFIG;
const ctx = { messages: [], tokens: 100 };
const usage = { promptTokens: 100, completionTokens: 20 };

/** Drive the machine with a list of events, draining self-emitted ones. */
function drive(events: readonly RunEvent[], cfg: RunConfig = config, start?: RunState) {
  let state = start ?? initialState("run-0001", "goal", 0);
  const queue = [...events];
  const trace: string[] = [];
  while (queue.length > 0) {
    const event = queue.shift() as RunEvent;
    const from = state.phase;
    const t = reduce(state, event, cfg);
    state = t.state;
    trace.push(`${from}->${state.phase}`);
    queue.unshift(...t.emit);
  }
  return { state, trace };
}

const started: RunEvent = { type: EventType.RunStarted, at: 0, goal: "goal" };
const assembled: RunEvent = { type: EventType.ContextAssembled, at: 1, context: ctx };

describe("happy path", () => {
  test("a direct answer walks init -> assemble -> model -> route -> finalize -> done", () => {
    const { state, trace } = drive([
      started,
      assembled,
      { type: EventType.ModelSucceeded, at: 2, message: assistant("42"), usage, stopReason: "end_turn" },
      { type: EventType.OutputFinalized, at: 3, output: "42" },
    ]);
    assert.deepEqual(trace, ["init->assemble", "assemble->model", "model->route", "route->finalize", "finalize->done"]);
    assert.equal(state.phase, Phase.Done);
    assert.deepEqual(state.outcome, { status: "completed", output: "42" });
    assert.equal(state.usage.modelCalls, 1);
    assert.equal(state.usage.totalTokens, 120);
  });

  test("a tool call routes through tools and observe, then back to assemble", () => {
    const call = { id: "c1", name: "search", args: { q: "x" } };
    const { state, trace } = drive([
      started,
      assembled,
      {
        type: EventType.ModelSucceeded,
        at: 2,
        message: assistant("looking", [call]),
        usage,
        stopReason: "tool_use",
      },
      {
        type: EventType.ToolsCompleted,
        at: 3,
        results: [{ call, ok: true, content: "found it", durationMs: 5, attempts: 1 }],
      },
    ]);
    assert.deepEqual(trace.slice(2), ["model->route", "route->tools", "tools->observe", "observe->assemble"]);
    assert.equal(state.usage.toolCalls, 1);
    assert.equal(state.transcript.at(-1)?.role, "tool");
    assert.equal(state.consecutiveFailures, 0);
  });
});

describe("routing", () => {
  test("an empty response with no tool calls is repaired, not finalised", () => {
    const { state, trace } = drive([
      started,
      assembled,
      { type: EventType.ModelSucceeded, at: 2, message: assistant("   "), usage, stopReason: "end_turn" },
    ]);
    assert.deepEqual(trace.slice(2), ["model->route", "route->observe", "observe->assemble"]);
    assert.equal(state.usage.correctiveTurns, 1);
    assert.match(state.transcript.at(-1)?.content ?? "", /neither content nor a tool call/);
  });

  test("a failing tool becomes an observation the model can act on", () => {
    const call = { id: "c1", name: "search", args: {} };
    const { state } = drive([
      started,
      assembled,
      { type: EventType.ModelSucceeded, at: 2, message: assistant("", [call]), usage, stopReason: "tool_use" },
      {
        type: EventType.ToolsCompleted,
        at: 3,
        results: [
          {
            call,
            ok: false,
            content: "no such tool",
            error: correctable("tool.unknown", "no such tool"),
            durationMs: 1,
            attempts: 1,
          },
        ],
      },
    ]);
    assert.equal(state.phase, Phase.Assemble, "the run continues — the model gets to fix it");
    const last = state.transcript.at(-1);
    assert.equal(last?.role, "tool");
    assert.equal(last?.role === "tool" ? last.isError : false, true);
    assert.equal(state.consecutiveFailures, 1);
  });

  test("a fatal tool error aborts the run rather than being fed back", () => {
    const call = { id: "c1", name: "charge", args: {} };
    const { state } = drive([
      started,
      assembled,
      { type: EventType.ModelSucceeded, at: 2, message: assistant("", [call]), usage, stopReason: "tool_use" },
      {
        type: EventType.ToolsCompleted,
        at: 3,
        results: [
          { call, ok: false, content: "bug", error: fatal("tool.bug", "handler threw"), durationMs: 1, attempts: 1 },
        ],
      },
    ]);
    assert.equal(state.phase, Phase.Failed);
    assert.equal(state.outcome?.status === "failed" ? state.outcome.error.code : null, "tool.bug");
  });
});

describe("model failure routing follows the taxonomy", () => {
  const upToModel = [started, assembled];

  test("transient backs off, retries, and counts the retry", () => {
    const { state, trace } = drive([
      ...upToModel,
      { type: EventType.ModelFailed, at: 2, error: transient("model.429", "rate limited") },
      { type: EventType.BackoffElapsed, at: 300, waitedMs: 250 },
    ]);
    assert.deepEqual(trace.slice(2), ["model->backoff", "backoff->model"]);
    assert.equal(state.attempt, 2);
    assert.equal(state.usage.retries, 1);
  });

  test("transient stops being retryable once the attempt budget is spent", () => {
    const events: RunEvent[] = [...upToModel];
    for (let i = 0; i < config.budget.maxModelAttempts; i++) {
      events.push({ type: EventType.ModelFailed, at: 2 + i, error: transient("model.429", "rate limited") });
      events.push({ type: EventType.BackoffElapsed, at: 100 + i, waitedMs: 1 });
    }
    const { state } = drive(events.slice(0, events.length - 1));
    assert.equal(state.phase, Phase.Failed);
    assert.equal(state.outcome?.status === "failed" ? state.outcome.error.code : null, "model.retries_exhausted");
  });

  test("correctable is handed back to the model, not retried", () => {
    const { state, trace } = drive([
      ...upToModel,
      { type: EventType.ModelFailed, at: 2, error: correctable("model.bad_tool_args", "unparseable") },
    ]);
    assert.deepEqual(trace.slice(2), ["model->observe", "observe->assemble"]);
    assert.equal(state.usage.retries, 0);
    assert.equal(state.usage.correctiveTurns, 1);
  });

  test("fatal aborts immediately", () => {
    const { state } = drive([...upToModel, { type: EventType.ModelFailed, at: 2, error: fatal("config.bad", "nope") }]);
    assert.equal(state.phase, Phase.Failed);
  });

  test("a budget-class failure from the provider halts rather than fails", () => {
    const { state } = drive([
      ...upToModel,
      {
        type: EventType.ModelFailed,
        at: 2,
        error: { class: Failure.Budget, code: "gateway.quota", message: "org quota spent" },
      },
    ]);
    assert.equal(state.phase, Phase.Halted);
    assert.equal(state.outcome?.status, "halted");
  });
});

describe("budgets are enforced in the reducer", () => {
  test("the step budget halts before assembling another window", () => {
    const tight: RunConfig = { ...config, budget: { ...config.budget, maxSteps: 1 } };
    const call = { id: "c1", name: "search", args: {} };
    const { state } = drive(
      [
        started,
        assembled,
        { type: EventType.ModelSucceeded, at: 2, message: assistant("", [call]), usage, stopReason: "tool_use" },
        {
          type: EventType.ToolsCompleted,
          at: 3,
          results: [{ call, ok: true, content: "ok", durationMs: 1, attempts: 1 }],
        },
      ],
      tight,
    );
    assert.equal(state.phase, Phase.Halted);
    assert.equal(state.outcome?.status === "halted" ? state.outcome.error.code : null, "budget.steps");
  });

  test("the token budget is checked prospectively, before the call is made", () => {
    const tight: RunConfig = { ...config, budget: { ...config.budget, maxTotalTokens: 50 } };
    const { state } = drive([started, { type: EventType.ContextAssembled, at: 1, context: ctx }], tight);
    assert.equal(state.phase, Phase.Halted);
    assert.equal(state.outcome?.status === "halted" ? state.outcome.error.code : null, "budget.tokens");
    assert.equal(state.usage.modelCalls, 0, "we must not spend the call we cannot afford");
  });

  test("the tool-call budget refuses a batch that would overrun it", () => {
    const tight: RunConfig = { ...config, budget: { ...config.budget, maxToolCalls: 1 } };
    const calls = [
      { id: "c1", name: "a", args: {} },
      { id: "c2", name: "b", args: {} },
    ];
    const { state } = drive(
      [
        started,
        assembled,
        { type: EventType.ModelSucceeded, at: 2, message: assistant("", calls), usage, stopReason: "tool_use" },
      ],
      tight,
    );
    assert.equal(state.phase, Phase.Halted);
    assert.equal(state.outcome?.status === "halted" ? state.outcome.error.code : null, "budget.tool_calls");
  });

  test("consecutive failures halt a flailing agent before it burns the step budget", () => {
    const tight: RunConfig = { ...config, budget: { ...config.budget, maxConsecutiveFailures: 2 } };
    const events: RunEvent[] = [started];
    for (let i = 0; i < 2; i++) {
      events.push({ type: EventType.ContextAssembled, at: 10 * i, context: ctx });
      events.push({ type: EventType.ModelFailed, at: 10 * i + 1, error: correctable("model.bad", "nope") });
    }
    const { state } = drive(events, tight);
    assert.equal(state.phase, Phase.Halted);
    assert.equal(
      state.outcome?.status === "halted" ? state.outcome.error.code : null,
      "budget.consecutive_failures",
    );
  });

  test("wall clock is measured from event timestamps, never from Date.now()", () => {
    const tight: RunConfig = { ...config, budget: { ...config.budget, maxWallClockMs: 1000 } };
    const state = { ...initialState("r", "g", 0), now: 5000 };
    const breach = checkBudget(state, tight.budget);
    assert.equal(breach?.code, "budget.wall_clock");
    assert.deepEqual(breach?.detail?.elapsedMs, 5000);
  });

  test("a fresh run is within budget", () => {
    assert.equal(checkBudget(initialState("r", "g", 0), config.budget), null);
  });
});

describe("illegal transitions crash rather than limp on", () => {
  test("an event the current phase does not accept throws", () => {
    const state = initialState("run-0001", "goal", 0);
    assert.throws(
      () => reduce(state, { type: EventType.BackoffElapsed, at: 1, waitedMs: 5 }, config),
      InvariantViolation,
    );
  });

  test("nothing is legal once the run is terminal", () => {
    const { state } = drive([
      started,
      assembled,
      { type: EventType.ModelSucceeded, at: 2, message: assistant("done"), usage, stopReason: "end_turn" },
      { type: EventType.OutputFinalized, at: 3, output: "done" },
    ]);
    assert.equal(state.phase, Phase.Done);
    assert.throws(() => reduce(state, { type: EventType.RunCancelled, at: 4 }, config), InvariantViolation);
  });
});

describe("purity", () => {
  test("the same (state, event) always produces the same transition", () => {
    const state = initialState("run-0001", "goal", 0);
    const a = reduce(state, started, config);
    const b = reduce(state, started, config);
    assert.deepEqual(a.state, b.state);
    assert.deepEqual(a.effects, b.effects);
  });

  test("the input state is never mutated", () => {
    const state = initialState("run-0001", "goal", 0);
    const snapshot = JSON.stringify(state);
    reduce(state, started, config);
    assert.equal(JSON.stringify(state), snapshot);
  });

  test("a transition never queues effects and emits events at once", () => {
    // Their relative order would be ambiguous, and the runtime asserts on it.
    const cases: readonly [RunState, RunEvent][] = [
      [initialState("r", "g", 0), started],
      [{ ...initialState("r", "g", 0), phase: Phase.Assemble }, assembled],
      [
        { ...initialState("r", "g", 0), phase: Phase.Model },
        { type: EventType.ModelSucceeded, at: 2, message: assistant("x"), usage, stopReason: "end_turn" },
      ],
    ];
    for (const [state, event] of cases) {
      const t = reduce(state, event, config);
      assert.ok(t.effects.length === 0 || t.emit.length === 0, `${event.type} returned both`);
    }
  });
});
