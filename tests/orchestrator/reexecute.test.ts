import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../src/orchestrator/runtime.ts";
import { replayProvider, recordedTools, reexecute, scriptFromLedger } from "../../src/orchestrator/reexecute.ts";
import { serializeLedger, toolSequence, trajectoryFingerprint, type RunLedger } from "../../src/orchestrator/ledger.ts";
import { scriptedProvider, type ScriptedTurn } from "../../src/providers/scripted.ts";
import { createRegistry, tool, type ToolDefinition } from "../../src/tools/registry.ts";
import type { ObjectSchema } from "../../src/tools/schema.ts";
import { manualClock } from "../../src/core/clock.ts";
import { seededRng } from "../../src/core/rng.ts";
import { sequentialIds } from "../../src/core/ids.ts";
import { Failure, transient } from "../../src/core/errors.ts";
import { err, ok } from "../../src/core/result.ts";
import { user } from "../../src/core/messages.ts";
import type { ContextAssembler } from "../../src/orchestrator/assembler.ts";

const q: ObjectSchema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };

/** Tools that count their invocations, so a test can prove re-execution never ran them. */
function countingTools() {
  const calls = { search: 0, write: 0 };
  const search = tool(
    "search",
    "Search.",
    q,
    (args) => {
      calls.search += 1;
      return { hits: [`hit for ${String(args["q"])}`] };
    },
    { readOnly: true },
  );
  const write = tool("write", "Write.", q, (args) => {
    calls.write += 1;
    return `wrote ${String(args["q"])}`;
  });
  return { calls, defs: [search, write] as const };
}

/** A read-only tool that fails transiently on its first attempt, every time it is called. */
function flakyTool(): ToolDefinition {
  const seen = new Map<string, number>();
  return {
    name: "flaky",
    description: "Fails once per call.",
    schema: q,
    readOnly: true,
    handler: (args, ctx) => {
      const n = (seen.get(ctx.stepId) ?? 0) + 1;
      seen.set(ctx.stepId, n);
      return n === 1 ? err(transient("net.blip", "blip")) : ok(`ok ${String(args["q"])}`);
    },
  };
}

// Ids a "real" provider might have chosen. The scripted provider keeps them.
const LIVE: readonly ScriptedTurn[] = [
  {
    say: "looking",
    callTools: [
      { id: "toolu_A", name: "search", args: { q: "ledger" } },
      { id: "toolu_B", name: "search", args: { q: "replay" } },
    ],
  },
  { failWith: transient("model.rate_limited", "429") },
  { say: "writing", callTools: [{ id: "toolu_C", name: "write", args: { q: "notes" } }] },
  { say: "  done  " },
];

async function record(turns: readonly ScriptedTurn[], tools: readonly ToolDefinition[], startedAt = 5_000) {
  return run({
    goal: "summarise the ledger",
    provider: scriptedProvider(turns),
    tools: createRegistry(tools),
    deps: { clock: manualClock(startedAt), rng: seededRng("rec"), ids: sequentialIds() },
    seed: "rec",
    runId: "run-rec",
  });
}

describe("scriptFromLedger", () => {
  test("returns every model turn, failures and call ids included", async () => {
    const { defs } = countingTools();
    const { ledger } = await record(LIVE, defs);
    const script = scriptFromLedger(ledger);
    assert.equal(script.length, 4);
    assert.deepEqual(
      script.flatMap((t) => ("callTools" in t ? (t.callTools ?? []).map((c) => c.id) : [])),
      ["toolu_A", "toolu_B", "toolu_C"],
    );
    assert.ok("failWith" in (script[1] as ScriptedTurn));
  });
});

describe("reexecute", () => {
  test("a manual-clock run re-executes byte for byte, without running a single tool", async () => {
    const original = countingTools();
    const { ledger } = await record(LIVE, original.defs);
    assert.equal(ledger.outcome?.status, "completed");

    const again = countingTools();
    const result = await reexecute(ledger, { tools: again.defs });
    assert.equal(result.identical, true, `diverged at ${result.firstDifference}`);
    assert.equal(result.firstDifference, null);
    assert.equal(serializeLedger(result.ledger), serializeLedger(ledger));
    assert.deepEqual(again.calls, { search: 0, write: 0 }, "recorded tools answer; the real handlers never run");
  });

  test("runtime retries of a read-only tool are reproduced, concurrently", async () => {
    const turns: ScriptedTurn[] = [
      { say: "", callTools: [{ name: "flaky", args: { q: "a" } }, { name: "flaky", args: { q: "b" } }] },
      { say: "both fine" },
    ];
    const { ledger } = await record(turns, [flakyTool()]);
    assert.equal(ledger.usage.retries, 2);
    const result = await reexecute(ledger, { tools: [flakyTool()] });
    assert.equal(result.identical, true, `diverged at ${result.firstDifference}`);
  });

  test("without definitions, tools are synthesised and the trajectory still matches", async () => {
    const { defs } = countingTools();
    const { ledger } = await record(LIVE, defs);
    // Synthesised tools carry no description, so the assembler renders a
    // different preamble: the requests differ by construction.
    const result = await reexecute(ledger, { verifyRequests: false });
    assert.equal(result.outcome.status, "completed");
    assert.deepEqual(toolSequence(result.ledger), toolSequence(ledger));
    assert.equal(trajectoryFingerprint(result.ledger), trajectoryFingerprint(ledger));
  });

  test("live tools that behave differently are caught, with the entry where the runs split", async () => {
    const { defs } = countingTools();
    const { ledger } = await record(LIVE, defs);
    const drifted = tool("search", "Search.", q, () => "different answer", { readOnly: true });
    const write = tool("write", "Write.", q, (args) => `wrote ${String(args["q"])}`);
    const result = await reexecute(ledger, { tools: [drifted, write], liveTools: true });
    assert.equal(result.identical, false);
    const split = ledger.entries.find((e) => e.event.type === "tools.completed");
    assert.equal(result.firstDifference, split?.seq);
  });
});

describe("replayProvider", () => {
  test("a different request is a fatal divergence, not a recorded answer to the wrong question", async () => {
    const { defs } = countingTools();
    const { ledger } = await record(LIVE, defs);
    const other: ContextAssembler = (req) => ({ messages: [user("something else"), ...req.transcript], tokens: 10 });
    const result = await reexecute(ledger, { tools: defs, assembler: other });
    assert.equal(result.outcome.status, "failed");
    assert.ok(result.outcome.status === "failed" && result.outcome.error.code === "replay.diverged");
  });

  test("request checking can be turned off when the assembler is swapped on purpose", async () => {
    const { defs } = countingTools();
    const { ledger } = await record(LIVE, defs);
    const other: ContextAssembler = (req) => ({ messages: [user("something else"), ...req.transcript], tokens: 10 });
    const result = await reexecute(ledger, { tools: defs, assembler: other, verifyRequests: false });
    assert.equal(result.outcome.status, "completed");
    assert.deepEqual(toolSequence(result.ledger), toolSequence(ledger));
  });

  test("running past the recording is a loud failure", async () => {
    const { defs } = countingTools();
    const { ledger } = await record([{ say: "one and done" }], defs);
    const provider = replayProvider(ledger, { verifyRequests: false });
    const req = { messages: [user("x")], tools: [] };
    const ctx = { runId: "r", stepId: "s", attempt: 1 };
    assert.ok((await provider.generate(req, ctx)).ok);
    const overrun = await provider.generate(req, ctx);
    assert.ok(!overrun.ok);
    assert.equal(overrun.error.code, "replay.exhausted");
    assert.equal(overrun.error.class, Failure.Fatal);
  });
});

describe("recordedTools", () => {
  test("a call the recording does not contain is fatal", async () => {
    const { defs } = countingTools();
    const { ledger }: { ledger: RunLedger } = await record(LIVE, defs);
    const registry = createRegistry(recordedTools(ledger, defs));
    const ctx = { runId: "r", stepId: "tool-x", clock: manualClock(0) };
    const known = await registry.invoke({ id: "1", name: "write", args: { q: "notes" } }, ctx);
    assert.ok(known.ok);
    assert.equal(known.value, "wrote notes");
    const unknown = await registry.invoke({ id: "2", name: "write", args: { q: "something new" } }, { ...ctx, stepId: "tool-y" });
    assert.ok(!unknown.ok);
    assert.equal(unknown.error.code, "replay.unrecorded_tool_call");
    assert.equal(unknown.error.class, Failure.Fatal);
  });

  test("a tool the model invented stays unknown when definitions are synthesised", async () => {
    const { defs } = countingTools();
    const { ledger } = await record(
      [{ say: "", callTools: [{ name: "serch", args: { q: "x" } }] }, { say: "gave up" }],
      defs,
    );
    assert.deepEqual(recordedTools(ledger).map((t) => t.name), []);
  });
});
