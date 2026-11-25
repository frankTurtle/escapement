import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TEXT_TURN_PROTOCOL,
  parseTextTurn,
  renderTextPrompt,
  textProvider,
  type TextModel,
  type TextPrompt,
} from "../../src/providers/text.ts";
import { assistant, system, toolResult, user } from "../../src/core/messages.ts";
import { Failure, transient } from "../../src/core/errors.ts";
import { err, ok } from "../../src/core/result.ts";
import { run } from "../../src/orchestrator/runtime.ts";
import { toolSequence } from "../../src/orchestrator/ledger.ts";
import { reexecute } from "../../src/orchestrator/reexecute.ts";
import { createRegistry, tool } from "../../src/tools/registry.ts";
import { manualClock } from "../../src/core/clock.ts";

const search = tool(
  "search",
  "Search the docs.",
  { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  (args) => `hits for ${args.q}`,
  { readOnly: true },
);

describe("renderTextPrompt", () => {
  test("puts system text, the tools and the protocol in system, and the transcript in prompt", () => {
    const call = { id: "c1", name: "search", args: { q: "x" } };
    const rendered = renderTextPrompt({
      messages: [system("Be precise."), user("find x"), assistant("looking", [call]), toolResult(call, "hits for x")],
      tools: [search],
    });
    assert.ok(rendered.system.startsWith("Be precise."));
    assert.ok(rendered.system.includes("- search{ q: string }"));
    assert.ok(rendered.system.endsWith(TEXT_TURN_PROTOCOL));
    assert.ok(!rendered.prompt.includes("Be precise."));
    assert.ok(rendered.prompt.includes("[user]\nfind x"));
    assert.ok(
      rendered.prompt.includes('[assistant]\n{"say":"looking","tool_calls":[{"name":"search","args":{"q":"x"}}]}'),
      "earlier turns are shown in the protocol's own format",
    );
    assert.ok(rendered.prompt.includes("[tool result: search]\nhits for x"));
  });
});

describe("parseTextTurn", () => {
  test("accepts a bare object, a fenced block, or an object with prose around it", () => {
    const body = '{"say": "ok", "tool_calls": [{"name": "search", "args": {"q": "a"}}]}';
    for (const text of [body, "```json\n" + body + "\n```", `Sure! Here you go:\n${body}\nHope that helps.`]) {
      const turn = parseTextTurn(text, "step-0003");
      assert.ok(turn.ok, text);
      assert.equal(turn.value.say, "ok");
      assert.deepEqual(turn.value.toolCalls, [{ id: "step-0003-call-1", name: "search", args: { q: "a" } }]);
    }
  });

  test("tool_calls and args may be left out", () => {
    const turn = parseTextTurn('{"say": "done", "tool_calls": [{"name": "list_files"}]}', "s");
    assert.ok(turn.ok);
    assert.deepEqual(turn.value.toolCalls, [{ id: "s-call-1", name: "list_files", args: {} }]);
    const answer = parseTextTurn('{"say": "the answer"}', "s");
    assert.ok(answer.ok && answer.value.toolCalls.length === 0);
  });

  test("text that is not JSON is correctable, and the message restates the protocol", () => {
    const turn = parseTextTurn("I think the answer is 42.", "s");
    assert.ok(!turn.ok);
    assert.equal(turn.error.class, Failure.Correctable);
    assert.equal(turn.error.code, "model.invalid_turn");
    assert.ok(turn.error.message.includes(TEXT_TURN_PROTOCOL));
  });

  test("the wrong shape is correctable too, naming every problem", () => {
    const turn = parseTextTurn('{"say": 3, "tool_calls": [{"args": []}]}', "s");
    assert.ok(!turn.ok);
    assert.equal(turn.error.class, Failure.Correctable);
    assert.match(turn.error.message, /say must be a string/);
    assert.match(turn.error.message, /tool_calls\[0\]\.name must be a string/);
    assert.match(turn.error.message, /tool_calls\[0\]\.args must be an object/);
  });
});

/** A text model that answers from a list, recording what it was sent. */
function fakeModel(replies: readonly string[]): TextModel & { readonly prompts: TextPrompt[] } {
  const prompts: TextPrompt[] = [];
  let i = 0;
  return {
    name: "fake-text",
    prompts,
    complete: async (input) => {
      prompts.push({ system: input.system, prompt: input.prompt });
      const text = replies[i++];
      return text === undefined ? err(transient("fake.empty", "no more replies")) : ok({ text });
    },
  };
}

describe("textProvider", () => {
  test("drives a whole run, and a malformed reply costs one corrective turn rather than the run", async () => {
    const model = fakeModel([
      "Let me search for that.",
      '{"say": "searching", "tool_calls": [{"name": "search", "args": {"q": "escapement"}}]}',
      '```json\n{"say": "It ticks.", "tool_calls": []}\n```',
    ]);
    const { outcome, ledger } = await run({
      goal: "what is an escapement?",
      provider: textProvider(model),
      tools: createRegistry([search]),
      deps: { clock: manualClock(0) },
    });
    assert.deepEqual(outcome, { status: "completed", output: "It ticks." });
    assert.deepEqual(toolSequence(ledger), ["search"]);
    assert.equal(ledger.usage.correctiveTurns, 1);
    assert.ok(model.prompts[1]?.prompt.includes("could not be used"), "the model is told what went wrong");

    const again = await reexecute(ledger, { tools: [search] });
    assert.equal(again.identical, true, "ids come from the step id, so the run re-executes exactly");
  });

  test("a client's own error passes through with its class", async () => {
    const provider = textProvider(fakeModel([]));
    const result = await provider.generate({ messages: [user("hi")], tools: [] }, { runId: "r", stepId: "s", attempt: 1 });
    assert.ok(!result.ok);
    assert.equal(result.error.class, Failure.Transient);
  });

  test("usage the client reports is used; otherwise it is estimated", async () => {
    const reported: TextModel = {
      name: "reported",
      complete: async () => ok({ text: '{"say": "hi"}', usage: { promptTokens: 7, completionTokens: 3 } }),
    };
    const a = await textProvider(reported).generate({ messages: [user("hi")], tools: [] }, { runId: "r", stepId: "s", attempt: 1 });
    assert.ok(a.ok);
    assert.deepEqual(a.value.usage, { promptTokens: 7, completionTokens: 3 });
    assert.equal(a.value.stopReason, "end_turn");

    const b = await textProvider(fakeModel(['{"say": "hi"}'])).generate(
      { messages: [user("hi")], tools: [] },
      { runId: "r", stepId: "s", attempt: 1 },
    );
    assert.ok(b.ok && b.value.usage.promptTokens > 0 && b.value.usage.completionTokens > 0);
  });
});
