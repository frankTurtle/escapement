import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../src/orchestrator/runtime.ts";
import { Phase } from "../../src/orchestrator/phases.ts";
import {
  replay,
  phasePath,
  toolSequence,
  toolCalls,
  serializeLedger,
  trajectoryFingerprint,
  parseLedger,
} from "../../src/orchestrator/ledger.ts";
import { scriptedProvider, type ScriptedTurn } from "../../src/providers/scripted.ts";
import { createRegistry, tool } from "../../src/tools/registry.ts";
import type { ObjectSchema } from "../../src/tools/schema.ts";
import { manualClock } from "../../src/core/clock.ts";
import { seededRng } from "../../src/core/rng.ts";
import { sequentialIds } from "../../src/core/ids.ts";
import { transient, fatal, Failure } from "../../src/core/errors.ts";
import { err, ok } from "../../src/core/result.ts";

const querySchema: ObjectSchema = {
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
};

const deps = () => ({ clock: manualClock(0), rng: seededRng("test"), ids: sequentialIds() });

const search = tool("search", "Search the index.", querySchema, (args) => `results for ${String(args["q"])}`, {
  readOnly: true,
});

const go = (turns: readonly ScriptedTurn[], extra: Partial<Parameters<typeof run>[0]> = {}) =>
  run({
    goal: "find the answer",
    provider: scriptedProvider(turns),
    tools: createRegistry([search]),
    deps: deps(),
    runId: "run-0001",
    ...extra,
  });

describe("end to end", () => {
  test("a direct answer completes", async () => {
    const { outcome, ledger } = await go([{ say: "the answer is 42" }]);
    assert.deepEqual(outcome, { status: "completed", output: "the answer is 42" });
    assert.deepEqual(phasePath(ledger), [Phase.Assemble, Phase.Model, Phase.Route, Phase.Finalize, Phase.Done]);
    assert.equal(ledger.usage.modelCalls, 1);
  });

  test("a tool call is executed and observed, then the model answers", async () => {
    const { outcome, ledger, state } = await go([
      { say: "let me look", callTools: [{ name: "search", args: { q: "ledgers" } }] },
      { say: "found: ledgers are append-only" },
    ]);
    assert.equal(outcome.status, "completed");
    assert.deepEqual(toolSequence(ledger), ["search"]);
    assert.deepEqual(toolCalls(ledger)[0]?.content, "results for ledgers");
    assert.equal(ledger.usage.toolCalls, 1);
    assert.equal(ledger.usage.modelCalls, 2);
    assert.equal(state.transcript.filter((m) => m.role === "tool").length, 1);
  });

  test("an unknown tool costs one corrective turn, not the run", async () => {
    const { outcome, ledger } = await go([
      { say: "hmm", callTools: [{ name: "serch", args: { q: "x" } }] },
      { say: "let me try that again", callTools: [{ name: "search", args: { q: "x" } }] },
      { say: "done" },
    ]);
    assert.equal(outcome.status, "completed");
    assert.equal(ledger.usage.correctiveTurns, 1);
    assert.deepEqual(
      toolCalls(ledger).map((c) => [c.name, c.ok, c.errorCode]),
      [
        ["serch", false, "tool.unknown"],
        ["search", true, null],
      ],
    );
  });

  test("bad tool arguments are handed back to the model", async () => {
    const { outcome, ledger } = await go([
      { say: "", callTools: [{ name: "search", args: { query: "wrong key" } }] },
      { say: "recovered" },
    ]);
    assert.equal(outcome.status, "completed");
    assert.equal(toolCalls(ledger)[0]?.errorCode, "tool.invalid_arguments");
  });
});

describe("failure handling", () => {
  test("a transient model failure is retried after backoff, invisibly", async () => {
    const { outcome, ledger } = await go([
      { failWith: transient("model.429", "rate limited") },
      { say: "second time lucky" },
    ]);
    assert.equal(outcome.status, "completed");
    assert.equal(ledger.usage.retries, 1);
    assert.ok(phasePath(ledger).includes(Phase.Backoff));
    assert.ok(ledger.finishedAt > 0, "virtual time advanced across the backoff");
  });

  test("backoff is exponential and jittered within the declared band", async () => {
    const waits: number[] = [];
    await run({
      goal: "g",
      provider: scriptedProvider([
        { failWith: transient("model.429", "a") },
        { failWith: transient("model.429", "b") },
        { say: "ok" },
      ]),
      deps: deps(),
      config: { retry: { baseDelayMs: 100, maxDelayMs: 10_000, jitter: 0.25 } },
      onEntry: (entry) => {
        if (entry.event.type === "backoff.elapsed") waits.push(entry.event.waitedMs);
      },
    });
    assert.equal(waits.length, 2);
    assert.ok((waits[0] ?? 0) >= 75 && (waits[0] ?? 0) <= 125, `first wait ${waits[0]} outside 100ms ±25%`);
    assert.ok((waits[1] ?? 0) >= 150 && (waits[1] ?? 0) <= 250, `second wait ${waits[1]} outside 200ms ±25%`);
  });

  test("retries run out and the run fails, rather than looping forever", async () => {
    const { outcome } = await go(
      [
        { failWith: transient("model.429", "x") },
        { failWith: transient("model.429", "x") },
        { failWith: transient("model.429", "x") },
        { failWith: transient("model.429", "x") },
      ],
      { config: { budget: { maxModelAttempts: 2 } } },
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.error.code : "", "model.retries_exhausted");
  });

  test("a provider that throws instead of returning Result is a fault, not a retry", async () => {
    const { outcome } = await run({
      goal: "g",
      provider: {
        name: "broken",
        generate: () => {
          throw new TypeError("undefined is not a function");
        },
      },
      deps: deps(),
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.error.source : "", "provider");
  });

  test("a tool handler that throws ends the run — it is a bug, not an observation", async () => {
    const boom = tool("boom", "explodes", { type: "object", properties: {} }, () => {
      throw new Error("kaboom");
    });
    const { outcome } = await run({
      goal: "g",
      provider: scriptedProvider([{ say: "", callTools: [{ name: "boom", args: {} }] }]),
      tools: createRegistry([boom]),
      deps: deps(),
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.error.class : "", Failure.Fatal);
  });
});

describe("budgets stop runaway runs", () => {
  test("the step budget halts a loop that never answers", async () => {
    const { outcome, ledger } = await go(
      [{ say: "looking", callTools: [{ name: "search", args: { q: "x" } }] }],
      {
        provider: scriptedProvider([{ say: "looking", callTools: [{ name: "search", args: { q: "x" } }] }], {
          onExhausted: "repeat-last",
        }),
        config: { budget: { maxSteps: 4 } },
      },
    );
    assert.equal(outcome.status, "halted");
    assert.equal(outcome.status === "halted" ? outcome.error.code : "", "budget.steps");
    assert.equal(ledger.usage.modelCalls, 4, "exactly the declared number of calls, no more");
  });

  test("wall clock halts a run whose tools are slow", async () => {
    const slow = tool(
      "slow",
      "takes forever",
      { type: "object", properties: {} },
      async (_args, ctx) => {
        await ctx.clock.sleep(60_000);
        return "eventually";
      },
      { readOnly: true },
    );
    const { outcome } = await run({
      goal: "g",
      provider: scriptedProvider([{ say: "", callTools: [{ name: "slow", args: {} }] }], {
        onExhausted: "repeat-last",
      }),
      tools: createRegistry([slow]),
      deps: deps(),
      config: { budget: { maxWallClockMs: 30_000 } },
    });
    assert.equal(outcome.status, "halted");
    assert.equal(outcome.status === "halted" ? outcome.error.code : "", "budget.wall_clock");
  });
});

describe("readOnly governs concurrency and runtime retry", () => {
  test("a transient failure from a readOnly tool is retried without a model turn", async () => {
    let calls = 0;
    const flaky = {
      name: "flaky",
      description: "fails once",
      schema: { type: "object", properties: {} } as ObjectSchema,
      readOnly: true,
      handler: async () => (++calls === 1 ? err(transient("net.reset", "connection reset")) : ok("finally")),
    };
    const { ledger, outcome } = await run({
      goal: "g",
      provider: scriptedProvider([{ say: "", callTools: [{ name: "flaky", args: {} }] }, { say: "done" }]),
      tools: createRegistry([flaky]),
      deps: deps(),
    });
    assert.equal(outcome.status, "completed");
    assert.equal(calls, 2);
    assert.equal(toolCalls(ledger)[0]?.ok, true);
    assert.equal(ledger.usage.modelCalls, 2, "the retry did not cost a model turn");
  });

  test("a write tool is never retried by the runtime", async () => {
    let calls = 0;
    const writer = {
      name: "charge_card",
      description: "takes money",
      schema: { type: "object", properties: {} } as ObjectSchema,
      handler: async () => {
        calls += 1;
        return err(transient("net.reset", "connection reset"));
      },
    };
    await run({
      goal: "g",
      provider: scriptedProvider([{ say: "", callTools: [{ name: "charge_card", args: {} }] }, { say: "gave up" }]),
      tools: createRegistry([writer]),
      deps: deps(),
    });
    assert.equal(calls, 1, "retrying an undeclared tool could double-charge the card");
  });

  test("readOnly calls in one turn run concurrently", async () => {
    const order: string[] = [];
    const mk = (name: string, delay: number) =>
      tool(
        name,
        "d",
        { type: "object", properties: {} },
        async (_a, ctx) => {
          await ctx.clock.sleep(delay);
          order.push(name);
          return name;
        },
        { readOnly: true },
      );
    const { ledger } = await run({
      goal: "g",
      provider: scriptedProvider([
        { say: "", callTools: [{ name: "slow_one", args: {} }, { name: "fast_one", args: {} }] },
        { say: "done" },
      ]),
      tools: createRegistry([mk("slow_one", 100), mk("fast_one", 1)]),
      deps: deps(),
    });
    assert.deepEqual(toolSequence(ledger), ["slow_one", "fast_one"], "results keep the model's order");
    assert.deepEqual(order, ["slow_one", "fast_one"], "both ran; the manual clock makes the race deterministic");
  });
});

describe("the ledger is the artifact", () => {
  test("it replays through the reducer to the identical phase sequence", async () => {
    const { ledger } = await go([
      { say: "looking", callTools: [{ name: "search", args: { q: "a" } }] },
      { failWith: transient("model.429", "slow down") },
      { say: "the answer" },
    ]);
    const result = replay(ledger);
    assert.equal(result.ok, true);
    assert.equal(result.divergence, null);
    assert.equal(result.entriesReplayed, ledger.entries.length);
    assert.equal(result.state.phase, ledger.finalPhase);
  });

  test("replay reports exactly where a tampered ledger diverges", async () => {
    const { ledger } = await go([{ say: "answer" }]);
    const entries = ledger.entries.map((e, i) => (i === 2 ? { ...e, to: Phase.Tools } : e));
    const result = replay({ ...ledger, entries });
    assert.equal(result.ok, false);
    assert.equal(result.divergence?.seq, 3);
    assert.equal(result.divergence?.recorded, Phase.Tools);
    assert.equal(result.divergence?.replayed, Phase.Route);
  });

  test("it survives a JSON round trip unchanged", async () => {
    const { ledger } = await go([
      { say: "looking", callTools: [{ name: "search", args: { q: "a" } }] },
      { say: "done" },
    ]);
    const restored = parseLedger(serializeLedger(ledger));
    assert.equal(serializeLedger(restored), serializeLedger(ledger));
    assert.equal(replay(restored).ok, true);
  });

  test("two runs of the same fixture produce byte-identical ledgers", async () => {
    const script: readonly ScriptedTurn[] = [
      { failWith: transient("model.429", "x") },
      { say: "looking", callTools: [{ name: "search", args: { q: "a" } }] },
      { say: "done" },
    ];
    const a = await go(script);
    const b = await go(script);
    assert.equal(serializeLedger(a.ledger), serializeLedger(b.ledger));
    assert.equal(trajectoryFingerprint(a.ledger), trajectoryFingerprint(b.ledger));
  });

  test("a different path produces a different fingerprint", async () => {
    const a = await go([{ say: "direct" }]);
    const b = await go([
      { say: "", callTools: [{ name: "search", args: { q: "a" } }] },
      { say: "indirect" },
    ]);
    assert.notEqual(trajectoryFingerprint(a.ledger), trajectoryFingerprint(b.ledger));
  });

  test("every entry records the transition it caused", async () => {
    const { ledger } = await go([{ say: "answer" }]);
    ledger.entries.forEach((entry, i) => {
      assert.equal(entry.seq, i + 1);
      if (i > 0) assert.equal(entry.from, ledger.entries[i - 1]?.to, "entries form an unbroken chain");
    });
  });
});

describe("cancellation", () => {
  test("an aborted signal ends the run as failed", async () => {
    const controller = new AbortController();
    controller.abort();
    const { outcome } = await run({
      goal: "g",
      provider: scriptedProvider([{ say: "never reached" }]),
      deps: deps(),
      signal: controller.signal,
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.error.code : "", "run.cancelled");
  });
});

describe("fatal classification is respected end to end", () => {
  test("a fatal provider error aborts without retrying", async () => {
    const { outcome, ledger } = await go([{ failWith: fatal("auth.invalid_key", "bad api key") }]);
    assert.equal(outcome.status, "failed");
    assert.equal(ledger.usage.retries, 0);
    assert.ok(!phasePath(ledger).includes(Phase.Backoff));
  });
});
