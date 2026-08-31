# ADR-0013: Grade trajectories, with pure functions over the ledger

- **Status:** Accepted
- **Amended by:** [ADR-0017](0017-asynchronous-graders.md) — `grade` may return a
  promise, so the rubric grader this ADR points at can actually be written. The
  text below is left as it stood; the claim that such a grader "would fit the
  `Grader` interface exactly" was not true when written.
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

The default way to evaluate an agent is to compare its final answer to a
reference. For an agent, that measures the wrong thing and measures it badly.

**It is a weak signal.** An agent can reach the right answer having called the
wrong tool four times, ignored everything it retrieved, and burned its entire
step budget. Same score as the agent that got there in one call. The difference
between those two is most of what you care about in production.

**It is a noisy signal.** The output is sampled text. Two runs of an unchanged
agent produce different strings. Any threshold on output similarity is therefore
either so loose it catches nothing or so tight it fires constantly, and a suite
that fires constantly gets its baseline re-recorded until it means nothing.

**It cannot see context bugs at all.** When retrieval was starved and the
evidence never made it into the window, the output is confidently wrong and the
answer-comparison says "wrong answer" — pointing at the model, which is
innocent.

We have an artifact that fixes all three: the run ledger
([ADR-0007](0007-append-only-run-ledger-replay.md)), which records every
transition, every tool call and result, every retry, every budget event, and the
context assembly report for each step.

## Decision

**A grader is a pure function from a `GradeContext` to a `Grade`.** The context
holds the ledger, the outcome, and the case definition. Nothing else. No network,
no model, no clock.

```ts
type Grader = { id, weight?, grade(context): Grade }
type Grade  = { graderId, score: number /* 0..1 */, passed: boolean, reason: string }
```

### Scores are continuous, not boolean

A binary pass/fail cannot express "it still works, but it now takes two extra
tool calls" — which is the movement a regression gate most needs to see. So
`score` is a number in `[0, 1]` *and* `passed` is a boolean, and they answer
different questions: `passed` is "is this acceptable", `score` is "how far has
it moved".

Efficiency graders degrade linearly past their limit rather than snapping to
zero. A cliff makes every over-budget run look equally bad, and hides the
difference between 10% worse and 400% worse.

### `withinX` is a bound; `usageEquals` is an assertion

`withinSteps(4)` passes a run that took two. When the property under test is
"the budget stopped it at exactly the declared point", an upper bound is not the
assertion you meant. Both exist, and the suite uses the exact one for limit
cases.

### The grader library, and what each is for

| Grader | Question it answers |
| ------ | ------------------- |
| `endsAs`, `failsWith` | Did it terminate the way it should, with the right error code? |
| `callsTools`, `neverCalls` | Did it use the right tools, in the right shape? |
| `trajectoryCloseTo` | *How far* is this path from the reference one? |
| `withinSteps/ToolCalls/Tokens/Retries` | Is it still efficient? |
| `withinCorrectiveTurns` | Is the model fixing its own mistakes more than it used to? |
| `contextWithinBudget`, `sectionNeverStarved` | Did the model actually see what it needed? |
| `usageEquals` | Did the limit bite at exactly the declared point? |
| `replaysExactly` | Is the run still deterministic? |

`callsTools` defaults to **subsequence** matching, not exact. Exact
over-specifies: it fails on a harmless extra lookup, and a suite that fails on
harmless changes trains its maintainers to re-record the baseline reflexively.

`sectionNeverStarved` is the one that catches the invisible class of bug. It
reads the assembly report out of the ledger and asserts a section actually got
space. Without it, "retrieval was silently squeezed to nothing" presents as a
model quality problem forever.

`replaysExactly` is applied to every case in the suite. It makes the project's
central determinism claim a tested property of every trajectory rather than a
design intention.

### What this suite does not measure

**Model quality.** The model is scripted ([ADR-0014](0014-model-provider-port.md)),
so what is graded is *orchestration*: routing, budgeting, retrying, packing.
Whether a real model would have chosen those tool calls is a different question
requiring live runs, sampling across seeds, and a much slower and more expensive
harness. That is a legitimate kind of eval; it has no business gating a pull
request, and we are explicit that this suite is not it.

## Consequences

### What this buys us

- The whole suite runs offline in about a second, so it can gate every PR.
- Failures are diagnostic. "`sectionNeverStarved:retrieval` — starved in 3 of 4
  assemblies" points at the bug; "wrong answer" does not.
- Context and orchestration bugs become visible at all.
- No LLM-judge, so no cost, no latency, and no judge drift underneath the scores.

### What this costs us

- **Fixtures rot.** A scripted trajectory is a snapshot of how a model behaved
  once. As real models change, the suite keeps testing that the machine handles
  yesterday's model correctly. Cases need periodic re-recording with
  `recordingProvider`, and we have no automation for that.
- **Graders encode assumptions.** `callsTools(["search", "lookup"])` bakes in a
  belief about the right approach. A genuinely better strategy scores worse.
  Subsequence matching softens this; it does not remove it.
- **Writing a case is work.** Scripting the turns, choosing the graders, picking
  thresholds. Higher friction than "add a prompt and an expected answer", which
  means fewer cases.

### What we are explicitly giving up

LLM-as-judge scoring, and with it any assessment of whether the answer is
actually *good*. A rubric grader would fit the `Grader` interface exactly, and
we have deliberately not shipped one: it would introduce a non-deterministic,
paid, latency-bearing dependency into the gate that blocks every pull request.
The interface is open; anyone who wants one can write it and run it in a slower
suite where its cost is visible.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Exact-match final answers | Weak (ignores the path), noisy (sampled text), and blind to context bugs. |
| Embedding similarity to a reference answer | Less brittle than exact match, still measures only the destination, and adds an embedding dependency. |
| LLM-as-judge rubrics | The only way to grade answer *quality*, and unfit for a per-PR gate: non-deterministic, paid, slow, and it drifts when the judge model is updated. |
| Snapshot the whole ledger and diff it | Maximum sensitivity and unusable: every incidental change fails, and the fix is always "accept the snapshot". |
| Trajectory fingerprint equality only | Cheap and binary — it cannot say *how far* a run moved, which is what the gate needs to decide. Kept as a warning-level signal instead. |
