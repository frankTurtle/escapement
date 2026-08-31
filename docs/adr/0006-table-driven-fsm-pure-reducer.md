# ADR-0006: A frozen transition table, a pure reducer, and effects as data

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

The usual agent loop looks like this:

```js
while (true) {
  const response = await model.call(messages);
  if (response.toolCalls) { ... } else break;
  if (steps++ > MAX) break;
}
```

It works, and it is very hard to reason about. The control flow is implicit in
the nesting; "what can happen after a tool fails" is answered by reading every
branch; the budget check is one `if` that a later refactor can move above a
`continue`; and none of it can be tested without a live model, because the
decisions and the I/O are the same statements.

We need the opposite properties. We want to be able to say what the machine can
do by *reading a table*, to enforce budgets in a place no alternative driver can
skip, and to test the decision logic with no I/O at all.

## Decision

Three separations, in order of importance.

### 1. The transition table is the specification

`TRANSITIONS` maps `(phase, event) -> allowed next phases`. It is a frozen
object. Every transition the reducer produces is asserted against it, and a
transition not in the table throws `InvariantViolation` rather than proceeding.

The value is a *list* of phases, not one, because one event legitimately has
several outcomes: `model.failed` goes to `backoff`, `observe`, `failed` or
`halted` depending on the failure class ([ADR-0005](0005-error-taxonomy.md)).
The reducer picks; the table constrains.

The table also declares terminal targets on ordinary events — `context.assembled`
can lead to `halted`, `tools.completed` can lead to `failed`. That is verbose,
and it is the point: budget enforcement and fatal aborts are visible in the
specification instead of being special cases the reducer knows about privately.

`docs/STATE-MACHINE.md` is generated from this table, and a test fails if the
committed file drifts. A diagram that can lie is worse than no diagram.

### 2. The reducer is pure

```ts
reduce(state: RunState, event: RunEvent, config: RunConfig): Transition
```

No clock, no randomness, no I/O, no dependency argument. Feed it the events out
of a ledger and you get the identical state sequence back — which is exactly
what `replay()` does, and what makes trajectory diffs signal rather than noise
([ADR-0007](0007-append-only-run-ledger-replay.md)).

**Budgets are enforced here and nowhere else.** A limit the runtime enforces is a
limit a different runtime — a test harness, a replayer, someone's custom driver —
can forget to enforce. Putting it in the pure function makes "this run cannot
exceed twelve model calls" a property of the state machine rather than a promise
about one particular loop.

Two budget checks are *prospective*: the token check refuses a call the run
cannot afford before making it, and the tool-call check refuses a batch that
would overrun. Discovering you are over budget after paying is not enforcement.

### 3. Effects are data

The reducer cannot perform I/O, so it returns descriptions of it:

```ts
{ kind: "call-model", context, attempt }
{ kind: "execute-tools", calls }
{ kind: "wait", ms }
```

The runtime executes them and feeds outcomes back as events. It makes no
decisions — no branch in `runtime.ts` chooses a next phase. That is what lets a
completely different driver (a debugger stepping one event at a time, a worker
that persists between steps) produce identical behaviour.

Jitter is the clean illustration. The reducer computes `wait: 250ms` —
deterministic, exponential, pure. The runtime randomises it within the declared
band and records what it actually waited. Replay reads the recorded number and
never touches the RNG.

A transition may return effects **or** emitted events, never both; their relative
order would otherwise be ambiguous. The runtime asserts this.

## Consequences

### What this buys us

- "What can happen next" is answered by reading one frozen object.
- The decision logic is tested with no I/O: 30-odd reducer tests, no provider,
  no clock, milliseconds.
- Budget guarantees hold for any driver, including ones we did not write.
- Illegal transitions are loud. A missing case in the table is a crash with the
  triple that failed, not a silently swallowed event.
- Generated docs cannot drift from the implementation.

### What this costs us

- Ceremony. Adding a capability means a phase, an event, an effect, a table row,
  and a reducer case — five edits where the naive loop needs one `if`.
- Two-file indirection: reading a feature end to end means reading the reducer
  and the runtime.
- The state is a single record with a phase tag rather than a discriminated
  union per phase, so `state.pendingCalls` is typed as present in phases where
  it is meaningless. A per-phase union would be more precise; it would also make
  the table generic over eleven state shapes, which we judged a bad trade.
- Effects-as-data means no streaming and no partial results mid-effect.

### What we are explicitly giving up

Parallel branches within a run. The machine is in exactly one phase at a time,
so "call the model twice and take the better answer" is not expressible. Tool
calls within a single turn are the one concurrency we allow, and only when the
tools declare `readOnly` ([ADR-0015](0015-small-tool-schema-and-readonly.md)).
A genuinely concurrent agent would need a different machine, and we would rather
say that than bolt fork/join onto this one.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| The naive `while` loop | Control flow implicit in nesting; budget checks movable by refactor; untestable without a live model. |
| Reducer that performs its own I/O (async reducer) | Kills replay, kills the pure-function test suite, and puts the retry decision back next to the retry mechanism. |
| A statechart library (XState) | Would give us guards and a visualiser, but brings actor semantics and a large API for what is one `switch` plus one frozen object — and the properties we actually need (JSON-serialisable, replayable) we would still enforce ourselves. |
| Discriminated union state, one shape per phase | Genuinely more precise types, at the cost of making the transition table generic over eleven state types. Reconsider if the state grows fields that only make sense in one phase. |
| Budget checks in the runtime | Simpler to write, but then the guarantee belongs to the loop rather than the machine, and any other driver silently drops it. |
