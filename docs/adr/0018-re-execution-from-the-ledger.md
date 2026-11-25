# ADR-0018: Re-execute a run from its ledger, and build eval cases from one

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Core maintainers

## Context

`replay(ledger)` ([ADR-0007](0007-append-only-run-ledger-replay.md)) feeds the
recorded events back through the reducer. That proves the reducer is pure. It
does not exercise the runtime, the assembler, the finalizer or the tool
registry, because none of them runs during a replay.

The first real multi-agent consumer (Rollcage piece 13) needed the stronger
check: run the whole workflow again, with the model's recorded turns served
back, and compare the result byte for byte. It had to write three adapters to
do it:

- a provider that serves the `model.succeeded` / `model.failed` events of a
  ledger, in order;
- `scriptFor(ledger)`, the same turns as a `ScriptedTurn[]`, so a recorded run
  could become an `EvalCase`;
- `recordedTools(...)`, tool handlers that answer with what the recording saw,
  so the eval needs no repository on disk.

The scripted provider also made byte-identical re-execution impossible through
the eval harness. It made up its own tool call ids (`call-01-01`), so a script
taken from another provider's ledger produced different `callId`s in every tool
message. The trajectory was the same; the ledger was not.

## Decision

Ship the adapters, with the gaps they had closed.

**`ScriptedToolCall.id` is optional, and kept when present.** A script without
ids behaves exactly as before, so every existing fixture and the eval baseline
are unchanged. `recordingProvider` now records ids, so a recorded script
reproduces the original call ids.

**`replayProvider(ledger)`** serves the ledger's model turns, successes and
failures, in order. By default it also checks each request against the context
the ledger recorded for that call (`context.assembled`). A different request
means the run has already diverged, so the provider returns a `fatal`
`replay.diverged` naming the model call, rather than serving a turn that answers
a question nobody asked. `{ verifyRequests: false }` turns the check off for
callers who swap the assembler on purpose. Running past the last recorded turn
is a `fatal` `replay.exhausted`, the same as the scripted provider.

**`recordedTools(ledger, definitions?)`** returns tool definitions whose
handlers answer with the recorded results. Calls are matched by tool name and
canonical arguments, in recorded order. A recorded success comes back as its
rendered content and a recorded failure as its exact `EscapementError`. A call
the runtime retried is reproduced too: the handler returns `attempts - 1`
transient failures and then the recorded result, keyed by the call's `stepId`
so concurrent read-only calls cannot steal each other's retries. A call the
recording does not contain is a `fatal` `replay.unrecorded_tool_call`. Pass
the original definitions to keep their schemas, `readOnly` flags and
descriptions. Without them, definitions are synthesised from the ledger with an
open schema. That is enough for most cases, but validation and concurrency may
then differ from the original.

**`scriptFromLedger(ledger)`** returns the model turns as a script, ids
included.

**`reexecute(ledger, options)`** composes these. It runs the ledger's goal,
run id, seed and config again with `replayProvider`, `recordedTools` (unless
live tools are passed), a manual clock starting at `startedAt`, a seeded RNG
and sequential ids. It returns the new run with `identical` (the two
serialised ledgers are equal) and `firstDifference` (the first entry `seq`
that differs, or `null`). If the ledger was suspended and resumed
([ADR-0019](0019-suspended-phase-and-resume.md)), each resume is replayed with
its recorded decision.

**`caseFromLedger(ledger, graders, options?)`** (in `escapement/evals`) builds
an `EvalCase`: goal, budget and retry from the ledger, script from
`scriptFromLedger`, tools from `recordedTools`. It is how "it broke in
production" becomes a permanent case in one line.

## Consequences

### What this buys us

- Re-execution covers the runtime, assembler, finalizer and tool plumbing, not
  just the reducer. A change that makes any of them depend on something other
  than its inputs shows up as `identical: false`, with the entry where the two
  runs split.
- Consumers stop writing the same three adapters.
- A recorded run becomes an eval case without a hand-written script.

### What this costs us

- **Byte-identical needs deterministic clocks.** Event timestamps come from
  the clock. A ledger recorded on `systemClock` re-executes with the same
  events and trajectory but different `at` values, so `identical` is `false`.
  The eval harness, and anything else that runs on a manual clock, re-executes
  byte for byte. We record this rather than replaying the clock, because the
  number of `now()` calls is a runtime detail we do not want to freeze into
  the ledger format.
- **Provider faults are not served back.** A provider that *threw* produced a
  `fault` event, not a `model.*` event, and the replay provider cannot tell it
  apart from an assembler fault. Such a run re-executes up to that point and
  then diverges.
- **Cancellation is not replayed.** `run.cancelled` comes from an
  `AbortSignal`, not from an effect.

### What we are explicitly giving up

Recording the clock. A `replayClock` would make system-clock ledgers
byte-identical too, but only by fixing the exact sequence of `now()` calls the
runtime makes, which would turn every harmless runtime refactor into a
format break.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Keep `replay()` as the only check | It never runs the runtime, assembler or tools, which is where a real nondeterminism bug (a `Date.now()`, an unordered `Map`) would hide. |
| Generate scripted call ids from the step id | Still invents ids, so a foreign ledger still could not be reproduced. Accepting the recorded id is simpler and is a no-op for scripts that have none. |
| Serve tool results by call id | Call ids are provider-chosen and not guaranteed unique across turns. Name plus canonical arguments, in order, is what the run itself depends on. |
| Make `replayProvider` lenient by default | Serving a recorded answer to a different question hides the divergence it is meant to find. The strict check costs one comparison per call. |
| Record the clock and replay it | See "What we are explicitly giving up". |
