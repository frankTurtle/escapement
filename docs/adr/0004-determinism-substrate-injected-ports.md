# ADR-0004: Determinism is a substrate — clock, randomness, and identity are injected

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

"Deterministic orchestration" is the claim on the tin. It is worth being precise
about what it can and cannot mean, because the interesting part of an agent — the
model — is a sampling process we do not control.

An agent run touches four sources of non-determinism:

1. **The model.** Genuinely stochastic. Out of scope for this ADR; handled by
   recording responses in the ledger ([ADR-0007](0007-append-only-run-ledger-replay.md))
   and by the scripted provider ([ADR-0014](0014-model-provider-port.md)).
2. **Wall-clock time.** `Date.now()`, timeouts, backoff schedules.
3. **Randomness.** Jitter, sampling, tie-breaks in ranking and packing.
4. **Identity.** `crypto.randomUUID()` for run, step, and tool-call ids.

Items 2–4 are *incidental* non-determinism. They exist because the standard
library makes the non-deterministic version the easy one to reach for. Each one
independently destroys the property we want: that a recorded run can be replayed
and produce a byte-identical ledger.

That property is not an aesthetic preference. The eval harness diffs
trajectories ([ADR-0013](0013-trajectory-graders-over-run-ledger.md)). If two
runs of the same fixture differ in their timestamps or their step ids, every
diff is noise and the grader is useless.

## Decision

The orchestrator never calls `Date.now()`, `Math.random()`, `setTimeout`, or
`crypto.randomUUID()`. Those three capabilities are ports on the run context:

```ts
type Deps = { clock: Clock; rng: Rng; ids: IdFactory };
```

- **`Clock`** — `now()` and `sleep(ms)`. Production uses `systemClock`. Tests and
  replay use `manualClock`, where `sleep` advances virtual time and resolves
  immediately. A run with 45 seconds of retry backoff therefore executes in
  microseconds *and still records 45 seconds of elapsed time in its ledger*.
- **`Rng`** — seeded mulberry32. The seed is part of the run configuration and is
  recorded in the ledger header, so "reproduce this run" is a complete
  instruction.
- **`IdFactory`** — `sequentialIds()` yields `step-0001`, `call-0001`, counting
  per prefix. Ids are a pure function of the ordinal, which makes them readable
  in a diff, stable across executions, and trivially comparable.

Any module that needs one of these takes it as an argument. There is no module-
level default and no ambient singleton, because an ambient default is a
non-determinism leak that nothing will catch until an eval flakes at 3am.

### What this does *not* claim

Determinism here means: **given the same inputs and the same recorded model
responses, the state sequence is identical.** It does not mean the model is
deterministic, and it does not mean a live run against a real API is
reproducible. It means the *orchestration* is not a second source of variance,
so when a trajectory changes you know it was the model or your code — never the
framework.

## Consequences

### What this buys us

- Replay is exact, so trajectory diffs are signal.
- The whole test suite runs in about a second with no fake timers, because
  `manualClock` makes backoff free.
- Reproducing a user's bug report is `runId` + `seed` + the recorded ledger.
- Time-dependent bugs (a retry schedule that grows unbounded) become unit
  testable instead of "run it and watch".

### What this costs us

- `Deps` is threaded through the call graph. Every internal function that used
  to be a free function now takes a context argument.
- It is only as good as our discipline. One stray `Date.now()` in a contributed
  PR reintroduces the flake. A lint rule would help; we have chosen not to run
  a linter ([ADR-0003](0003-typescript-esm-zero-runtime-dependencies.md)), so
  this is enforced in review and, in practice, by the replay-equality test in
  the eval suite failing.

### What we are explicitly giving up

Convenience at the call site. `sequentialIds()` also means ids are not globally
unique across runs — `step-0001` exists in every single run. Any external store
that persists steps must key on `(runId, stepId)`. We consider readable,
diffable ids worth that constraint; a UUID would be globally unique and useless
to a human reading a trajectory.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Global module singletons with a `setClock()` test hook | Mutable global state, order-dependent tests, and no way to run two differently-seeded runs concurrently in one process. |
| Fake timers (`sinon`, `node:test` mock timers) | Solves time only, not ids or randomness, and it patches globals — which means it patches them for everything else in the process too. |
| Record-and-replay of timestamps only | Fixes the diff noise but not the wall-clock cost: a run with real backoff still takes 45 seconds in CI. |
| Content-hash ids (hash of the step's inputs) | Genuinely deterministic and appealing, but two identical steps in one run collide, and a one-character change to a prompt renumbers the whole trajectory, making diffs worse rather than better. |
