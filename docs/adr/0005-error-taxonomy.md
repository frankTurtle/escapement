# ADR-0005: Classify failures by who can fix them

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

An agent fails constantly and most of it is routine. In one run you will see a
429 from the model API, a tool called with a missing required argument, a search
that returns nothing, a malformed JSON response, an expired credential, and a
step budget running out. The orchestrator has to do something specific with each.

The usual approach is to grow a `catch` block: check the status code, sniff the
message, special-case the tool name. That code is untestable, incomplete by
construction, and it is where agent frameworks go to die — the routing logic
ends up scattered across the retry wrapper, the tool executor, and the model
adapter, with no single place that says what happens next.

The observation that unlocks this: from the orchestrator's point of view, the
*cause* of a failure barely matters. What matters is **who is able to do
something about it.** There are only ever four answers.

## Decision

Every failure is normalised into an `EscapementError` with one of five classes,
and each class maps to exactly one remedy:

| Class | Who can fix it | Remedy | Examples |
| ----- | -------------- | ------ | -------- |
| `transient` | The runtime, by trying again | `retry` | 429, 5xx, socket reset, tool timeout |
| `correctable` | The **model**, by seeing the error | `reprompt` | Unknown tool, bad arguments, empty search result, schema violation |
| `fatal` | Nobody, inside this run | `abort` | Bad config, contract violation, invariant broken |
| `budget` | Nobody — the limit was the point | `halt` | Step, token, wall-clock, or tool-call limit reached |
| `cancelled` | The caller already did | `abort` | Caller aborted the run |

```ts
const REMEDY_FOR: Record<FailureClass, RemedyKind> = { ... };  // total, frozen
```

The mapping is a frozen table, not a `switch`, and a test asserts it is total in
both directions. Routing in the state machine is then a lookup, which is why the
transition table can be exhaustive.

### The load-bearing distinction

`correctable` is the class that matters and the one most frameworks miss. A tool
call with a missing argument is **not an exception** — it is an observation. It
goes back into the conversation as a `tool` message with `isError: true`, and
the model gets to fix its own mistake. Treating that as a runtime error and
retrying it verbatim produces the classic agent failure mode: the identical
broken call, three times, then an abort.

Conversely, a 429 is *not* something the model can fix. Feeding it back into the
conversation burns context to no purpose. It is a `transient`, and the runtime
handles it silently with backoff.

### Two error channels, on purpose

`EscapementError` is **data the machine routes on**. `InvariantViolation` is a
thrown exception meaning *the program is wrong* — an illegal transition, a
malformed machine definition. Nothing catches an `InvariantViolation` to keep
going; if you are tempted to, the transition table is missing a case, and that
is the bug to fix.

## Consequences

### What this buys us

- Retry policy is declared once, over classes, instead of re-derived at every
  call site.
- The model-correctable path is explicit, so "let the agent fix its own bad tool
  call" is the default behaviour rather than a feature someone remembers to add.
- Graders can assert on `code` and `class`, which are stable, instead of on
  error message text, which is not.
- New failure sources only have to answer one question — who can fix this — and
  the routing follows.

### What this costs us

- Classification happens at the boundary, and a wrong classification is a real
  bug with an ugly failure mode: a `fatal` mislabelled `transient` gets retried
  three times before aborting; a `transient` mislabelled `correctable` puts
  "HTTP 503" into the model's context and asks it to think about it.
- Five classes is a coarse instrument. Some failures genuinely want "retry twice
  then reprompt". We express that with retry limits rather than by adding
  classes, and we would rather have a coarse total mapping than a fine partial
  one.

### What we are explicitly giving up

Exception-based control flow. Failures that the machine routes on are values;
`throw` is reserved for programmer error. Contributors coming from codebases
where everything throws will find this verbose, and the `Result` type in
`src/core/result.ts` is the price.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| An `Error` subclass hierarchy | Classification via `instanceof` breaks across module realms and does not survive the JSON round-trip into the ledger, which is a hard requirement ([ADR-0007](0007-append-only-run-ledger-replay.md)). |
| HTTP-style numeric codes | Forces a mapping layer for everything that is not HTTP, and encodes cause rather than remedy — the wrong axis. |
| Retryable boolean | Collapses `transient` and `correctable` into one bit, which is precisely the distinction that produces good agent behaviour. |
| Per-tool bespoke error handling | Maximum precision, no reusable routing, and every new tool re-litigates retry policy. |
