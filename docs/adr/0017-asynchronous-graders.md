# ADR-0017: Graders may be asynchronous

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers
- **Amends:** [ADR-0013](0013-trajectory-graders-over-run-ledger.md)

## Context

[ADR-0013](0013-trajectory-graders-over-run-ledger.md) decided that a grader is
a pure function over the run ledger, and that we would not ship an LLM-as-judge
rubric because it has no business in the gate that blocks every pull request.
That reasoning stands. But the ADR went on to leave a door open:

> A rubric grader would fit the `Grader` interface exactly, and we have
> deliberately not shipped one. […] The interface is open; anyone who wants one
> can write it and run it in a slower suite where its cost is visible.

That was not true. `grade(context: GradeContext): Grade` was synchronous, and
the harness mapped over the graders with no `await` in sight. A rubric grader
has to call a model; there was no way to express it. The extension point the
ADR advertised was a wall, and the "we chose not to" framing quietly depended
on a "you could" that did not hold.

Two honest repairs are available: withdraw the claim, or make it true. The
claim is the more valuable half — an eval library whose grader interface cannot
express the most commonly requested grader is answering a question nobody asked.

## Decision

**`grade` returns `Grade | Promise<Grade>`, and the harness awaits it.**

- The return type is *widened*, not replaced. Every grader in `graders.ts` is
  unchanged and none of them allocates a promise.
- `grader(id, fn, weight?)` accepts an async body and keeps the synchronous
  path synchronous, so the escape hatch covers both kinds.
- The harness grades **sequentially, in declaration order**. Pure graders never
  suspend, so the gate suite pays nothing for this; a grader that does I/O gets
  predictable ordering rather than an unannounced fan-out.
- A rejected promise is handled exactly like a thrown exception: score `0`,
  `passed: false`, and the reason names the grader. A judge that times out must
  not be able to silently pass the case it was supposed to judge.

Purity is now a property we assert about the graders we ship and about the
suite that gates pull requests. It is no longer something the type enforces.

## Consequences

### What this buys us

- ADR-0013's escape hatch is real. A rubric grader can be written against
  `Grader` without forking the type or the harness.
- The extension point sits behind the same weighting, the same throw guard, and
  the same report as every other grader, so a judge suite does not need a second
  set of everything.

### What this costs us

- **Callers must await.** Anyone invoking `grade()` outside the harness now gets
  a union. Breaking for those callers; graders themselves are untouched.
- **Sequential is the sum, not the max.** A suite of slow judge graders costs
  the total. Deliberate: if that becomes a real pain, the fix is a concurrency
  bound on the slow suite, not an unbounded `Promise.all` in the harness.

### What we are explicitly giving up

The type-level guarantee that a grader cannot touch the network. ADR-0013 got
that guarantee for free from the synchronous signature — an accident of the
type that happened to act as enforcement. Nothing now stops someone putting an
API call in a grader and wiring it into the gate suite, making per-PR CI slow,
paid and flaky. Review is the guard, and this paragraph is the warning.

We are **not** giving up ADR-0013's actual decision. No judge grader ships here,
the shipped graders remain pure, and the gate suite still runs offline in about
a second.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Keep `grade` synchronous, withdraw the ADR-0013 claim | Honest, and it leaves no way to write the grader the ADR itself points readers at. Cheaper, and it resolves the contradiction in the wrong direction. |
| Always return `Promise<Grade>` | A simpler type that makes twenty pure graders allocate a promise apiece so one impure grader can exist. The gate suite pays for a feature it does not use. |
| A separate `AsyncGrader` type with its own harness path | Two interfaces and two code paths, with weighting, the throw guard and the report duplicated across both, to serve one hypothetical grader. |
| `Promise.all` over a case's graders | Faster for a judge suite, and it fires an unbounded number of paid calls at whatever rate limit is behind them from a loop with no concurrency control. |
| Pre-compute judgements outside the suite and pass them into the case | Keeps graders sync, but the case definition then carries scores it did not compute, and the grader degrades into a lookup with no diagnostic `reason` of its own. |
