import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scriptedProvider, recordingProvider } from "../../src/providers/scripted.ts";
import type { ModelRequest } from "../../src/providers/provider.ts";
import { user } from "../../src/core/messages.ts";
import { Failure, transient } from "../../src/core/errors.ts";

const request: ModelRequest = { messages: [user("what is the capital of France?")], tools: [] };
const ctx = { runId: "run-0001", stepId: "step-0001", attempt: 1 };

describe("scripted provider", () => {
  test("says what it was told, in order", async () => {
    const provider = scriptedProvider([{ say: "first" }, { say: "second" }]);
    const a = await provider.generate(request, ctx);
    const b = await provider.generate(request, ctx);
    assert.ok(a.ok && b.ok);
    assert.equal(a.value.message.content, "first");
    assert.equal(b.value.message.content, "second");
  });

  test("infers stopReason from whether it asked for tools", async () => {
    const provider = scriptedProvider([
      { say: "let me look", callTools: [{ name: "search", args: { query: "x" } }] },
      { say: "done" },
    ]);
    const a = await provider.generate(request, ctx);
    const b = await provider.generate(request, ctx);
    assert.ok(a.ok && b.ok);
    assert.equal(a.value.stopReason, "tool_use");
    assert.equal(b.value.stopReason, "end_turn");
  });

  test("tool call ids are deterministic across runs", async () => {
    const script = [{ say: "s", callTools: [{ name: "a", args: {} }, { name: "b", args: {} }] }];
    const first = await scriptedProvider(script).generate(request, ctx);
    const second = await scriptedProvider(script).generate(request, ctx);
    assert.ok(first.ok && second.ok);
    assert.deepEqual(
      first.value.message.toolCalls?.map((c) => c.id),
      second.value.message.toolCalls?.map((c) => c.id),
    );
    assert.deepEqual(first.value.message.toolCalls?.map((c) => c.id), ["call-01-01", "call-01-02"]);
  });

  test("can be scripted to fail, with a real classified error", async () => {
    const provider = scriptedProvider([{ failWith: transient("model.rate_limited", "429") }, { say: "recovered" }]);
    const a = await provider.generate(request, ctx);
    assert.ok(!a.ok);
    assert.equal(a.error.class, Failure.Transient);
    const b = await provider.generate(request, ctx);
    assert.ok(b.ok);
    assert.equal(b.value.message.content, "recovered");
  });

  test("running out of script is a loud failure, not an improvised reply", async () => {
    const provider = scriptedProvider([{ say: "only one" }]);
    await provider.generate(request, ctx);
    const overrun = await provider.generate(request, ctx);
    assert.ok(!overrun.ok);
    assert.equal(overrun.error.code, "scripted.exhausted");
    assert.equal(overrun.error.class, Failure.Fatal, "the agent took more turns than the fixture expected — that is the regression");
  });

  test("repeat-last is available when the turn count is not what is under test", async () => {
    const provider = scriptedProvider([{ say: "again" }], { onExhausted: "repeat-last" });
    await provider.generate(request, ctx);
    const second = await provider.generate(request, ctx);
    assert.ok(second.ok);
    assert.equal(second.value.message.content, "again");
  });

  test("records every request the machine issued", async () => {
    const provider = scriptedProvider([{ say: "a" }, { say: "b" }]);
    await provider.generate(request, ctx);
    await provider.generate({ messages: [user("second question")], tools: [] }, ctx);
    assert.equal(provider.requests.length, 2);
    assert.equal(provider.turnsConsumed, 2);
    assert.equal(provider.requests[1]?.messages[0]?.content, "second question");
  });
});

describe("recording provider", () => {
  test("captures a live run as a replayable script", async () => {
    const live = scriptedProvider([
      { say: "looking", callTools: [{ name: "search", args: { query: "ledger" } }] },
      { failWith: transient("model.timeout", "took too long") },
    ]);
    const recorder = recordingProvider(live);
    await recorder.generate(request, ctx);
    await recorder.generate(request, ctx);

    assert.equal(recorder.script.length, 2);
    const replay = scriptedProvider(recorder.script);
    const first = await replay.generate(request, ctx);
    assert.ok(first.ok);
    assert.deepEqual(first.value.message.toolCalls?.[0]?.args, { query: "ledger" });
    const second = await replay.generate(request, ctx);
    assert.ok(!second.ok);
    assert.equal(second.error.code, "model.timeout");
  });
});
