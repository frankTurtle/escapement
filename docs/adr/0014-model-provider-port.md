# ADR-0014: The model is a port, and the scripted provider is first-class

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

The model is the one component of an agent we genuinely cannot make
deterministic. Everything else in Escapement is arranged so that the model is
the *only* source of variance ([ADR-0004](0004-determinism-substrate-injected-ports.md)).
That arrangement is worth nothing unless we can also, in tests and evals,
remove the model from the picture entirely.

There is a second force. Provider SDKs differ in how they surface failure: some
throw, some return an error envelope, some return HTTP 200 with a body that says
the request failed. If that variation reaches the orchestrator, the transition
table stops being total and grows provider-specific branches.

## Decision

`ModelProvider` is a two-member interface: a `name`, and

```ts
generate(request, ctx): Promise<Result<ModelResponse, EscapementError>>
```

Three things follow from that signature, and each is deliberate.

**It returns `Result`, it does not throw.** An adapter's real job is
*classification*: a 429 is `transient`, a 400 complaining about a malformed tool
schema is `fatal`, a response whose tool arguments are unparseable is
`correctable`. Doing that at the boundary is precisely what keeps the transition
table total ([ADR-0005](0005-error-taxonomy.md)). An adapter that classifies
everything as `fatal` still works; it just retries nothing.

**`stopReason` is a closed set** — `end_turn | tool_use | max_tokens |
stop_sequence`. The orchestrator routes on it, so it cannot be a
provider-specific string.

**We ship no adapter for any real API.** No `dependencies`
([ADR-0003](0003-typescript-esm-zero-runtime-dependencies.md)) means no model
SDK. Adapters live in `examples/`, where the user's own `package.json` pins the
version.

### `scriptedProvider` is not a mock

It implements the same interface a real adapter implements, and it is a supported
part of the public API rather than a test fixture that leaked out. You give it
turns; it says them, in order, with deterministic tool-call ids.

Its default behaviour when the script runs out is to **fail loudly**, with
`scripted.exhausted`. This is the most important design choice in the file. An
agent that took more turns than its fixture anticipated has changed behaviour,
and improvising a plausible extra reply would hide exactly the regression the
eval exists to catch. `repeat-last` exists for cases where turn count is
genuinely not what is under test, and it is opt-in.

### `recordingProvider` closes the loop

Wrap a real provider, run once, keep `script`. That is the path from "it broke in
production" to "there is an eval case for it, and it replays offline forever."
Failures are recorded too, so a rate-limit storm that produced a bad trajectory
becomes a reproducible fixture rather than an anecdote.

## Consequences

### What this buys us

- The entire test and eval suite runs offline, hermetically, in about a second.
- Provider quirks are quarantined in one file per provider, outside our package.
- Recorded production failures become permanent regression tests.
- Users can put a gateway, a cache, a router, or a budget enforcer behind the
  same interface, because it is the interface we ourselves use.

### What this costs us

- No batteries. `escapement` alone cannot talk to any model; wiring one is ten
  lines the user writes.
- Recorded fixtures rot. The script is a snapshot of how a model behaved on one
  day, and grading against it measures *orchestration*, not model quality.
  Measuring model quality needs live runs, which are a different and much slower
  kind of eval. We are explicit that the fast suite does not do that.
- Streaming is not in the interface. `generate` resolves once, with a complete
  response.

### What we are explicitly giving up

Token streaming, and with it any orchestrator-level feature that depends on
partial output — cancelling mid-token, or acting on a tool call before the
message finishes. Streaming is a presentation concern, and modelling it here
would put a `ReadableStream` into the ledger, which is not JSON and therefore
not replayable ([ADR-0007](0007-append-only-run-ledger-replay.md)). An
application that wants to stream to a UI can do so in its own adapter and hand
the orchestrator the assembled message.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Depend on one official SDK and adapt others to it | Imports that SDK's types, its versioning, and its opinion about retries into our public API. |
| `generate` throws on failure | Pushes classification into `catch` blocks in the runtime, which is where the routing logic goes to rot. |
| Streaming-first interface (`AsyncIterable<Delta>`) | Every consumer then has to reassemble, and deltas cannot be recorded to a JSON ledger without a normalisation step that loses the property we wanted. |
| Fixtures as JSON files matched on prompt hash | Attractive for record/replay, but a one-character prompt edit misses every fixture, and the failure mode is a silent re-record rather than a loud miss. |
