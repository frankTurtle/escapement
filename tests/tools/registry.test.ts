import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, tool } from "../../src/tools/registry.ts";
import type { ToolContext } from "../../src/tools/registry.ts";
import { manualClock } from "../../src/core/clock.ts";
import { Failure, InvariantViolation, fatal } from "../../src/core/errors.ts";
import { err } from "../../src/core/result.ts";
import type { ObjectSchema } from "../../src/tools/schema.ts";

const echoSchema: ObjectSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
};

const ctx: ToolContext = { runId: "run-0001", stepId: "step-0001", clock: manualClock() };

const echo = tool("echo", "Return the text you were given.", echoSchema, (args) => ({ echoed: String(args["text"] ?? "") }), {
  readOnly: true,
});

describe("registry construction", () => {
  test("rejects duplicate names", () => {
    assert.throws(() => createRegistry([echo, echo]), InvariantViolation);
  });

  test("rejects names the model cannot reliably reproduce", () => {
    const bad = tool("Echo-Tool", "d", echoSchema, () => null);
    assert.throws(() => createRegistry([bad]), InvariantViolation);
  });

  test("renders every tool for the prompt", () => {
    const rendered = createRegistry([echo]).render();
    assert.match(rendered, /- echo\{ text: string \}/);
    assert.match(rendered, /Return the text you were given\./);
  });
});

describe("invoke", () => {
  test("runs a valid call", async () => {
    const r = await createRegistry([echo]).invoke({ id: "c1", name: "echo", args: { text: "hi" } }, ctx);
    assert.ok(r.ok);
    assert.deepEqual(r.value, { echoed: "hi" });
  });

  test("an unknown tool is correctable and lists what exists", async () => {
    const r = await createRegistry([echo]).invoke({ id: "c1", name: "ecko", args: {} }, ctx);
    assert.ok(!r.ok);
    assert.equal(r.error.class, Failure.Correctable);
    assert.equal(r.error.code, "tool.unknown");
    assert.match(r.error.message, /Available tools: echo\./, "listing them is what turns a loop into one corrective turn");
  });

  test("bad arguments are correctable, and the handler is never reached", async () => {
    let reached = false;
    const spy = tool("spy", "d", echoSchema, () => {
      reached = true;
      return null;
    });
    const r = await createRegistry([spy]).invoke({ id: "c1", name: "spy", args: { text: 42 } }, ctx);
    assert.ok(!r.ok);
    assert.equal(r.error.class, Failure.Correctable);
    assert.equal(reached, false);
  });

  test("a handler that throws is fatal, not retried into oblivion", async () => {
    const boom = tool("boom", "d", { type: "object", properties: {} }, () => {
      throw new TypeError("cannot read properties of undefined");
    });
    const r = await createRegistry([boom]).invoke({ id: "c1", name: "boom", args: {} }, ctx);
    assert.ok(!r.ok);
    assert.equal(r.error.class, Failure.Fatal);
    assert.equal(r.error.source, "tool:boom");
  });

  test("a handler may return a classified failure of its own", async () => {
    const flaky = {
      name: "flaky",
      description: "d",
      schema: { type: "object", properties: {} } as ObjectSchema,
      handler: async () => err(fatal("upstream.down", "the index is offline")),
    };
    const r = await createRegistry([flaky]).invoke({ id: "c1", name: "flaky", args: {} }, ctx);
    assert.ok(!r.ok);
    assert.equal(r.error.code, "upstream.down");
  });

  test("invoke never throws, whatever the handler does", async () => {
    const nasty = {
      name: "nasty",
      description: "d",
      schema: { type: "object", properties: {} } as ObjectSchema,
      handler: async () => {
        throw "a bare string";
      },
    };
    const r = await createRegistry([nasty]).invoke({ id: "c1", name: "nasty", args: {} }, ctx);
    assert.ok(!r.ok);
  });
});

describe("readOnly", () => {
  test("is a machine-readable permission, defaulting to false", () => {
    const registry = createRegistry([echo, tool("write", "d", echoSchema, () => null)]);
    assert.equal(registry.get("echo")?.readOnly, true);
    assert.equal(registry.get("write")?.readOnly, undefined, "absent means not safe to parallelise or retry");
  });
});
