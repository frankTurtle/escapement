# ADR-0007: The ledger is the artifact, and replay is a first-class mode

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

Ask what an agent run produces and the obvious answer is "an answer string".
That answer is nearly useless for every job we actually have:

- **Grading.** Whether the agent reached the right answer is one signal, and a
  weak one. It might have got there by luck, after nine wasted tool calls, or by
  ignoring the retrieved context entirely. Trajectory quality is what we want to
  grade ([ADR-0013](0013-trajectory-graders-over-run-ledger.md)).
- **Regression detection.** "The output changed" is a coin flip on a stochastic
  system. "The agent now calls `search` twice before answering, where it used to
  call it once" is a fact.
- **Debugging.** A user reporting "it did something weird" needs to hand us
  something we can run.
- **Auditing.** For anything consequential, what the agent looked at matters as
  much as what it said.

Standard observability does not cover this. Traces and spans are built for
humans reading a UI: they are lossy, timestamped with wall-clock, often sampled,
and they are not an input to anything.

## Decision

Every run produces a `RunLedger`: an append-only list of transitions plus a
header, and it is **the** artifact of a run. The output string is one field
inside it.

```ts
type LedgerEntry = { seq, at, from: Phase, to: Phase, event: RunEvent, effects: EffectKind[] };
```

Four properties, each load-bearing.

**It is complete.** Every event that reached the reducer is recorded, including
the ones the reducer emitted to itself. Routing decisions appear as their own
entries rather than collapsing into the transition that caused them, so the
trace shows *that a decision was made* and which way it went.

**It is JSON.** Everything crossing the boundary is `JsonValue`
(`src/core/json.ts`). No class instances, no `Date`, no `Error` objects — which
is one of the reasons failures are data rather than exceptions
([ADR-0005](0005-error-taxonomy.md)). A ledger can be written to a file, posted
in a bug report, and read back a year later.

**It replays.** `replay(ledger)` feeds the recorded events back through the
reducer and asserts each one lands in the recorded phase. On divergence it
reports the sequence number, the event, and both phases. This is the test that
keeps every determinism claim in the project honest: it runs over every recorded
trajectory in the eval suite, so a change that makes the reducer depend on
anything other than `(state, event, config)` fails CI at the exact step where
the histories parted.

**It projects.** Graders do not walk raw entries. `toolSequence`, `phasePath`,
`toolCalls`, `contextReports` and `trajectoryFingerprint` are the vocabulary a
grader is written in, and adding a grader almost never means adding a
projection.

`trajectoryFingerprint` deserves a note: it digests the *shape* of a run —
phases and tool names — and deliberately excludes timings and content. Two runs
with the same fingerprint took the same path. It is the cheapest possible
regression signal, and it is stable across content edits that do not change
behaviour.

## Consequences

### What this buys us

- Trajectory grading, trajectory diffing, and regression gates all read one
  structure.
- A bug report can be a file. "Here is the ledger" is a complete reproduction.
- The replay-equality check makes purity a tested property rather than a
  convention.
- Recording a live run and replaying it offline forever
  ([ADR-0014](0014-model-provider-port.md)) needs no extra machinery.

### What this costs us

- **Size.** The ledger contains every message and every tool result. A long run
  with large retrieved documents produces a large ledger, and we currently
  neither truncate nor compress. A production deployment will want a retention
  policy, and possibly content-addressed storage for the large payloads.
- **Sensitivity.** It contains everything the agent saw, which for many
  applications means PII. It must be treated as sensitive data, and "attach the
  ledger to the bug report" is a decision with privacy consequences that we
  cannot make for our users. We flag this loudly in the docs rather than
  pretending redaction is solved.
- **Version churn.** `LEDGER_VERSION` is checked on parse, and any change to
  event shapes breaks old ledgers. We have no migration story yet; at `0.x` we
  will bump and re-record.
- **In-memory accumulation.** Entries are held in memory for the run's duration.
  Fine for the runs this is designed for; not fine for an agent running for a
  day.

### What we are explicitly giving up

Streaming and sampling. The ledger is written whole, at the end, and every run
is recorded in full — there is no head-based sampling, because a sampled ledger
cannot be replayed and a partial one cannot be graded. Anyone running a very high
volume of agents will need a retention policy, not a sampling rate.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| OpenTelemetry traces as the record | Built for humans reading a UI: lossy, sampled, wall-clock-stamped, and not designed to be replayed or diffed. We would rather *export* to OTel from the ledger than derive the ledger from spans. |
| Log the final transcript only | Loses routing decisions, retries, budget events, and everything that failed — which is most of what a grader wants. |
| Event sourcing with snapshots | Snapshots would bound memory, but a snapshot is a serialised `RunState`, which means a second schema to version and a second thing that can be wrong. Runs are short; not worth it yet. |
| Record effects instead of events | Effects are what we *intended*; events are what *happened*. Only the latter can be replayed. |
| Store only the fingerprint | Cheap and enough for a regression gate, but useless for debugging, and it cannot answer "what did it look at". |
