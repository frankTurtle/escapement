import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, defineTool, tool } from "../../src/tools/registry.ts";
import type { InferArgs, ObjectSchema } from "../../src/tools/schema.ts";
import type { JsonObject } from "../../src/core/json.ts";
import { correctable } from "../../src/core/errors.ts";
import { err, ok } from "../../src/core/result.ts";
import { manualClock } from "../../src/core/clock.ts";

// Compile-time assertions. `npm run typecheck` covers tests, so a wrong
// inference fails the build, not just this file.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T => true as T;

const fileSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    mode: { type: "string", enum: ["read", "write"] },
    lines: { type: "array", items: { type: "integer" } },
    options: { type: "object", properties: { follow: { type: "boolean" } }, required: ["follow"] },
  },
  required: ["path"],
} as const;

type FileArgs = InferArgs<typeof fileSchema>;

assertType<Equal<FileArgs["path"], string>>();
assertType<Equal<FileArgs["mode"], "read" | "write" | undefined>>();
assertType<Equal<FileArgs["lines"], readonly number[] | undefined>>();
assertType<Equal<NonNullable<FileArgs["options"]>["follow"], boolean>>();
// A schema annotated as plain ObjectSchema keeps the old JsonObject shape.
assertType<Equal<InferArgs<ObjectSchema>, JsonObject>>();

const ctx = { runId: "r", stepId: "s", clock: manualClock(0) };

describe("schema-typed tools", () => {
  test("an inline schema types the handler's args with no cast", async () => {
    const read = tool(
      "read_file",
      "Read a file.",
      { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] },
      (args) => {
        const path: string = args.path;
        const limit: number | undefined = args.limit;
        // @ts-expect-error -- not in the schema
        void args.other;
        return `${path}:${limit ?? "all"}`;
      },
    );
    const result = await createRegistry([read]).invoke({ id: "1", name: "read_file", args: { path: "a.ts" } }, ctx);
    assert.deepEqual(result, ok("a.ts:all"));
  });

  test("a schema typed as plain ObjectSchema still compiles, as before", async () => {
    const schema: ObjectSchema = { type: "object", properties: { q: { type: "string" } } };
    const t = tool("search", "Search.", schema, (args: JsonObject) => String(args["q"]));
    assert.deepEqual(await createRegistry([t]).invoke({ id: "1", name: "search", args: { q: "x" } }, ctx), ok("x"));
  });

  test("defineTool types a handler that returns a Result", async () => {
    const write = defineTool({
      name: "write_file",
      description: "Write a file.",
      schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      handler: (args) =>
        args.path.startsWith("/") ? err(correctable("tool.rejected", "paths are relative")) : ok(`wrote ${args.content.length} bytes`),
      requiresApproval: true,
    });
    assert.equal(write.requiresApproval, true);
    const registry = createRegistry([write]);
    assert.deepEqual(await registry.invoke({ id: "1", name: "write_file", args: { path: "a", content: "hi" } }, ctx), ok("wrote 2 bytes"));
    const rejected = await registry.invoke({ id: "2", name: "write_file", args: { path: "/etc", content: "" } }, ctx);
    assert.ok(!rejected.ok && rejected.error.code === "tool.rejected");
  });
});
