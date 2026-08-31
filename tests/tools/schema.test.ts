import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validate, validateArgs, renderSchema, type ObjectSchema } from "../../src/tools/schema.ts";
import { Failure } from "../../src/core/errors.ts";

const searchSchema: ObjectSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "what to look for", minLength: 1 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    scope: { type: "string", enum: ["docs", "code", "all"] },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["query"],
  additionalProperties: false,
};

describe("schema validation", () => {
  test("accepts a valid object", () => {
    assert.deepEqual(validate(searchSchema, { query: "ledger", limit: 5, scope: "docs" }), []);
  });

  test("reports every problem, not just the first", () => {
    const problems = validate(searchSchema, { limit: 0, scope: "wrong", tags: [1, 2] });
    const messages = problems.map((p) => `${p.path} ${p.message}`);
    assert.ok(messages.some((m) => m.includes('missing required property "query"')), messages.join("|"));
    assert.ok(messages.some((m) => m.includes("below minimum 1")), messages.join("|"));
    assert.ok(messages.some((m) => m.includes("expected one of")), messages.join("|"));
    assert.equal(problems.filter((p) => p.path.startsWith("$.tags[")).length, 2, "both bad array items reported");
  });

  test("optional properties are only checked when present", () => {
    assert.deepEqual(validate(searchSchema, { query: "x" }), []);
  });

  test("additionalProperties: false rejects extras", () => {
    const problems = validate(searchSchema, { query: "x", nope: true });
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.message ?? "", /unexpected property "nope"/);
  });

  test("integer rejects a non-integral number", () => {
    const problems = validate(searchSchema, { query: "x", limit: 2.5 });
    assert.match(problems[0]?.message ?? "", /expected an integer/);
  });

  test("type errors name what was actually received", () => {
    assert.match(validate(searchSchema, [])[0]?.message ?? "", /expected object, got array/);
    assert.match(validate(searchSchema, null)[0]?.message ?? "", /expected object, got null/);
    assert.match(validate({ type: "string" }, 3)[0]?.message ?? "", /expected string, got number/);
  });
});

describe("validateArgs", () => {
  test("returns the args unchanged when valid", () => {
    const r = validateArgs("search", searchSchema, { query: "x" });
    assert.ok(r.ok);
    assert.deepEqual(r.value, { query: "x" });
  });

  test("failures are correctable — the model can fix these itself", () => {
    const r = validateArgs("search", searchSchema, {});
    assert.ok(!r.ok);
    assert.equal(r.error.class, Failure.Correctable);
    assert.equal(r.error.code, "tool.invalid_arguments");
    assert.match(r.error.message, /missing required property "query"/);
    assert.deepEqual(r.error.detail?.tool, "search");
  });
});

describe("renderSchema", () => {
  test("renders a prompt-shaped signature, marking optionality", () => {
    const rendered = renderSchema(searchSchema);
    assert.match(rendered, /query: string/);
    assert.match(rendered, /limit\?: integer/);
    assert.match(rendered, /scope\?: "docs"\|"code"\|"all"/);
    assert.match(rendered, /tags\?: string\[\]/);
  });

  test("is materially cheaper than the JSON Schema it describes", () => {
    assert.ok(
      renderSchema(searchSchema).length < JSON.stringify(searchSchema).length / 2,
      "the whole point of the subset is that it is cheap to put in a prompt",
    );
  });
});
