# ADR-0021: Tool handlers are typed from their schema

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Core maintainers

## Context

A tool handler receives `args: JsonObject`. The registry has already
validated them against the tool's schema before the handler runs
([ADR-0015](0015-small-tool-schema-and-readonly.md)), so the handler knows
`path` is a string, but the compiler does not. Every handler in Rollcage piece
13 reads its arguments as `a['path'] as string`. Each cast is a place where the
schema and the code can drift apart without the compiler noticing.

The schema language is small on purpose: five node types, `enum`, `required`,
no references and no combinators. That makes it small enough to map to a
TypeScript type completely.

## Decision

**`InferArgs<S>`** maps an `ObjectSchema` type to the type of the arguments it
validates: `string` (or the union of an `enum`), `number` for `number` and
`integer`, `boolean`, `readonly T[]` for arrays, nested objects likewise, with
the keys in `required` required and every other property optional.

**`tool()` takes the schema as a `const` type parameter** and types the
handler's `args` as `InferArgs<S>`. An inline schema needs no `as const`.
When the schema is a variable annotated as plain `ObjectSchema`, its
properties are `Record<string, SchemaNode>`, and `InferArgs` falls back to
`JsonObject`, which is what `tool()` accepted before. Existing call sites
therefore compile unchanged.

**`defineTool({ name, description, schema, handler, ... })`** does the same for
a handler that returns a full `ToolOutcome` (a `Result`), which is what a tool
needs when some of its failures are `correctable` rather than bugs.

The one cast lives inside the library, at the point where validated arguments
are handed to the typed handler. That is the one place where the cast is
justified, because validation has just happened.

## Consequences

### What this buys us

- Handlers read `args.path` as a `string`, and a schema change that drops or
  renames a field breaks the handler at compile time.
- No change at runtime: validation, rendering and the ledger are untouched.

### What this costs us

- A recursive conditional type in the public surface. Error messages for a
  wrong handler mention `InferArgs<...>`, which is more to read than
  `JsonObject`.
- `additionalProperties` is not reflected in the type. Extra properties the
  schema allows are still present at runtime but invisible to the handler,
  which is the safe direction.

### What we are explicitly giving up

A schema builder (`s.object({ path: s.string() })`). It would infer just as
well, but it is a second way to write every schema, and the plain object form
is the one rendered into prompts and recorded in docs.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Leave handlers on `JsonObject` | Keeps the casts and the drift they allow. |
| Accept a Zod (or other) schema | A runtime dependency ([ADR-0003](0003-typescript-esm-zero-runtime-dependencies.md)) and a second schema language beside the one we render. |
| A separate `typedTool()` and keep `tool()` untyped | Two names for one thing; the generic signature is backward compatible, so there is nothing to keep apart. |
| Generate types from schemas at build time | A build step for something the compiler can already do. |
