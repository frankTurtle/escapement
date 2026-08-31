# ADR-0003: TypeScript + ESM, and zero runtime dependencies

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

Escapement is infrastructure that other people's agents sit on top of. Two
constraints follow from that position:

1. **Supply chain.** An orchestration library is in the blast radius of every
   secret an agent touches — API keys, tool credentials, retrieved documents. A
   transitive dependency tree of 300 packages is 300 chances to lose all of it.
2. **Version pinning.** Anything we depend on, our users must also tolerate. A
   hard dependency on a specific tokenizer, HTTP client, schema validator, or
   vector-store SDK forces a version negotiation on every consumer.

Separately, we need the *tests* to be as deterministic as the runtime. A test
suite that reaches the network is a test suite that is flaky at 3am.

## Decision

**Language:** TypeScript, ESM-only, targeting Node >= 22.6.

**Runtime dependencies: zero.** `package.json` has an empty `dependencies` block
and CI enforces that it stays empty. Development dependencies are limited to
`typescript` and `@types/node`.

Everything that would ordinarily be a dependency is instead a **port** — a
narrow interface we define, with an in-repo default implementation that is good
enough to run and test against:

| Would-be dependency | Our port | Default implementation |
| ------------------- | -------- | ---------------------- |
| `tiktoken` | `Tokenizer` | Calibrated heuristic estimator (see [ADR-0008](0008-pluggable-tokenizer.md)) |
| Vector DB SDK | `Retriever` | In-process BM25 index (see [ADR-0009](0009-in-process-bm25-retriever.md)) |
| `zod` | `ToolSchema` | Structural validator over a JSON-Schema subset |
| Model SDK | `ModelProvider` | Scripted provider (see [ADR-0014](0014-model-provider-port.md)) |
| Test framework | — | `node:test` |

Adapters for the real thing (tiktoken, a vector store, an LLM SDK) live outside
this package or in `examples/`, where the user's own `package.json` owns the
version.

**Two toolchain rules follow from ESM-only + Node-native TypeScript:**

- Relative imports are written with the `.ts` extension. `node --experimental-strip-types`
  requires the real on-disk specifier; `rewriteRelativeImportExtensions` makes
  `tsc` emit `.js`. Source runs unbuilt in dev and ships compiled.
- `erasableSyntaxOnly` is on, so no `enum`, no `namespace`, no parameter
  properties. Node's type stripping erases types without a transform; anything
  needing codegen is banned. We use `const` objects plus union types instead,
  which are better values anyway.

**We do not use a separate linter.** The strict compiler flags in
`tsconfig.json` — `noUncheckedIndexedAccess`, `noUnusedLocals`,
`noFallthroughCasesInSwitch`, `verbatimModuleSyntax` — cover the rules we would
actually enforce, with no second config to keep in sync.

## Consequences

### What this buys us

- `npm install escapement` adds exactly one node_modules entry.
- The full test suite runs offline, hermetically, in about a second.
- Ports force us to be honest about our seams. The scripted `ModelProvider` that
  exists for tests is the same seam a user needs for their own gateway.
- No build step in development: `node --test tests/**/*.test.ts` runs the source.

### What this costs us

- We reimplement things. BM25 and a token estimator are ours to maintain and to
  get wrong.
- The default tokenizer is approximate. [ADR-0008](0008-pluggable-tokenizer.md)
  covers the safety margin this forces on budget arithmetic.
- No `zod`, so our schema validation is deliberately less expressive than what
  users may want. The `ToolSchema` port lets them bring their own.

### What we are explicitly giving up

Batteries-included convenience. There is no `escapement.fromOpenAI()`. Wiring a
real model provider is ten lines the user writes, and we think ten explicit
lines beat a hidden adapter with its own version skew.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Python | The evals story is stronger, but we want the orchestrator to run in the same process as TypeScript app servers and edge runtimes, and we want compile-time exhaustiveness on the transition table. |
| TypeScript with a normal dep tree (zod, tiktoken, vitest) | Faster to write, but hands our supply chain and our version constraints to consumers. The tokenizer and validator are the two we would actually want; both are viable as ports. |
| Vitest instead of `node:test` | Better watch mode and richer assertions, but it is a large dev dependency plus a transform pipeline, in exchange for ergonomics we can live without. |
| CommonJS or dual-publish | Dual-publish doubles the build matrix and creates the dual-package hazard, where two copies of our state constants fail `===`. ESM-only is a defensible floor in 2026. |
