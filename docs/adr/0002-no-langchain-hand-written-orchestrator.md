# ADR-0002: Write the orchestrator by hand rather than adopting a framework

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

Escapement's orchestrator is roughly 400 lines. LangChain, LangGraph,
LlamaIndex, CrewAI and the rest would each supply something in that shape for
free. Declining free code needs a better reason than taste.

The reason is what we are actually selling. Escapement's claims are:

1. **Every run is replayable.** Feed a recorded ledger back through the reducer
   and get the identical state sequence.
2. **Every limit is enforced.** A run declaring twelve steps takes at most twelve
   steps, whatever the model does.
3. **Every decision is inspectable.** You can point at the table that decided a
   transition, and at the ledger entry that recorded it.

Each is a claim about *everything the orchestrator does*, and each is falsified
by a single line of framework code we do not control. A retry hidden inside a
runnable, a callback that mutates state, an implicit `Date.now()` in a tracer —
any one of those breaks (1). A framework's own loop guard breaks (2), because
now there are two budget enforcers and only one is ours. Adopting a framework
would mean auditing it to the same depth we would have written it, and then
re-auditing on every minor version.

There is also a plain engineering observation. Once you strip prompt templating,
provider adapters, and vector-store integrations out of an agent framework, the
orchestration core is a loop with a switch statement in it. That is not a hard
thing to write. It is a hard thing to write *carefully*, and the care does not
transfer through a dependency.

## Decision

We write the orchestrator ourselves, with no agent-framework dependency of any
kind. Concretely:

- The state machine is an explicit, frozen transition table
  ([ADR-0006](0006-table-driven-fsm-pure-reducer.md)).
- The decision logic is a pure reducer. All I/O lives in a runtime that makes no
  decisions.
- Every run produces an append-only ledger that replays exactly
  ([ADR-0007](0007-append-only-run-ledger-replay.md)).
- The model, the tools, and the context assembler are ports we define.

We are not claiming these frameworks are bad. LangGraph in particular solves a
harder problem than we do — arbitrary user-defined graphs with checkpointing and
human-in-the-loop interrupts. We solve one narrow problem completely: a
single-agent tool-use loop whose every step is bounded and reproducible. That
narrowness is what lets the whole thing fit in a file you can read in one
sitting.

## Consequences

### What this buys us

- The claims are true of *all* our code, because it is all our code.
- The transition table is the specification. There is one place to look, and
  a generated diagram that cannot drift from it.
- Debugging is a stack trace in our own repository.
- Upgrades are ours to schedule. No framework release renames a class we depend
  on, or changes retry semantics in a minor version.
- Zero runtime dependencies stays achievable
  ([ADR-0003](0003-typescript-esm-zero-runtime-dependencies.md)).

### What this costs us

- Everything the ecosystem gives away, we build or go without: no prompt hub, no
  hundred pre-built tool integrations, no built-in tracing UI, no community
  cookbook.
- We will hit problems that framework maintainers have already solved, and we
  will solve some of them worse the first time.
- Contributors who know LangChain get no transfer. They have to read our table.
- Multi-agent topologies are out of scope. Anyone needing a supervisor over five
  specialists should use LangGraph, and we should say so plainly.

### What we are explicitly giving up

Breadth. Escapement will always do less than a framework does. The bet is that
for the specific job of "run one agent reliably, prove what it did, and stop it
when it misbehaves", a small system you can fully audit beats a large one you
cannot.

If that bet is wrong — if the narrow loop turns out to need graphs, sub-agents,
and checkpointing — the honest move is to supersede this ADR and adopt
something, not to grow a second-rate framework inside it.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| LangGraph | Closest fit, and genuinely good at durable multi-actor graphs. But its checkpointer, its own recursion limit, and its callback machinery all sit inside our determinism and budget claims, and we would have to audit them as carefully as writing this. |
| LangChain (AgentExecutor) | Retry, parsing and looping behaviour are spread across abstractions we would not control, and the version churn has been substantial. |
| A generic state-machine library (XState) | The most tempting: it would give us the table, guards, and a visualiser. But it brings actor semantics and a large API surface for what is one `switch` and one frozen object, and our reducer's real constraint — pure, JSON-serialisable, replayable — is a property we would still have to enforce ourselves. |
| Fork a framework and strip it | Inherits the audit burden with none of the upgrade benefit. |
