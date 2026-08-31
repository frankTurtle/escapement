# ADR-0015: A deliberately small tool schema, and `readOnly` as a machine-readable permission

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

Tool schemas do two jobs at once, and the two pull in opposite directions.

1. **Validation.** Check what the model sent before running anything.
2. **Prompting.** The schema is rendered *into the context window*. Every
   keyword costs tokens, and those tokens come out of a budget the context
   assembler has to defend ([ADR-0011](0011-deterministic-budgeted-context-packing.md)).

A schema language rich enough to express `oneOf` with `$ref` is a schema language
that spends four hundred tokens describing a two-field function. Full JSON
Schema optimises hard for job 1 and is actively bad at job 2.

Separately: when a model asks for three tool calls in one turn, the orchestrator
has to decide whether it may run them concurrently, and whether it may retry one
that failed transiently without going back to the model. Both are safe for a
search; neither is safe for a payment. Today that decision is usually made by
the framework guessing, or by not doing it at all.

## Decision

### The schema subset

We support `object`, `string`, `number`, `integer`, `boolean`, `array`, plus
`required`, `enum`, `additionalProperties`, and simple bounds
(`minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`).

We deliberately exclude:

- **`$ref`** — needs a resolver and a cycle story, for a feature most tools do
  not use.
- **`oneOf` / `anyOf` / `allOf`** — needs a satisfiability story for error
  reporting ("which branch did you mean?"), and models handle a flat argument
  list markedly better than a discriminated union anyway.
- **`pattern`** — compiling a regex supplied by config or, worse, reflected from
  model output, is a ReDoS vector. Declined.

Validation **collects every problem** rather than stopping at the first, because
the result goes back to the model as an observation
([ADR-0005](0005-error-taxonomy.md)) and a model told about one missing field at
a time costs one round trip per field.

Rendering produces a signature line, not JSON: `search{ query: string; limit?:
integer }`. Roughly a third the token cost, and empirically no worse for tool
selection.

### `readOnly`

`ToolDefinition.readOnly` is not documentation. The orchestrator reads it:

- read-only calls in a single assistant turn **may be executed concurrently**;
- a read-only call that fails `transient` **may be retried by the runtime**
  without spending a model turn.

Neither is permitted otherwise. **The default is `false`** — absent means unsafe.
A tool author who does nothing gets the conservative behaviour, and the
dangerous behaviour requires typing the word out.

## Consequences

### What this buys us

- Tool descriptions cost roughly a third of what a JSON Schema block costs, which
  is real budget returned to retrieval and history.
- One corrective turn instead of N, because every argument problem is reported at
  once.
- Parallelism and retry become declared properties of a tool rather than a guess
  the framework makes, and the unsafe default is the silent one.

### What this costs us

- Tools whose arguments genuinely are a union have to flatten them, usually into
  a `kind` enum plus optional fields, and validate the combination inside the
  handler.
- We are not JSON-Schema compatible, so a tool catalogue defined elsewhere needs
  a conversion step, and conversion can fail on constructs we do not support.
- `noUncheckedIndexedAccess` means validated arguments still index as
  `JsonValue | undefined` at the handler. Type-level proof that validation
  narrowed the object would need generic schema inference, which we judged not
  worth the type-system complexity — see the alternatives.

### What we are explicitly giving up

Compile-time argument types derived from the schema. `zod`-style inference would
give handlers a typed `args` object, and it is genuinely nice. It also requires a
dependency or a substantial homegrown type-level interpreter, and it does not
help the token-cost problem at all. The `ToolSchema` port is the escape hatch:
bring your own validator if you want inference.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Full JSON Schema (`ajv`) | A dependency, a large one, and it optimises for validation while making the prompting job worse. |
| `zod` with schema-to-JSON conversion | Excellent inference, but it is a runtime dependency and the generated JSON Schema is verbose in exactly the place we are trying to save tokens. |
| TypeScript types only, validate nothing | Model output is untrusted input. Skipping validation moves the failure from a corrective turn into the tool handler, where it becomes a `fatal`. |
| Infer `readOnly` from the tool name (`get_*`, `list_*`) | Cute, and wrong the first time someone writes `get_and_reserve_inventory`. |
