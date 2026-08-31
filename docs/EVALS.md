# Evals

The suite grades **orchestration**, offline, in about a second.

```bash
npm run eval          # run the suite, print a report
npm run eval:gate     # run it and compare against evals/baseline.json
npm run eval:baseline # re-record the baseline (release/* branches only)
```

## What is being measured

A case is a scripted model conversation plus a set of graders. The model is
scripted ([ADR-0014](adr/0014-model-provider-port.md)), so there is no sampling
variance and no network: what is graded is whether the machine **routes,
budgets, retries and packs** the way it claims to.

This suite deliberately does **not** measure model quality. That needs live runs
across seeds, and it has no business gating a pull request. See
[ADR-0013](adr/0013-trajectory-graders-over-run-ledger.md).

## Writing a case

```ts
{
  id: "unknown-tool-recovery",
  description: "A misspelled tool name costs one corrective turn, not the run.",
  goal: "Find the definition of an escapement.",
  script: [
    { say: "", callTools: [{ name: "serch", args: { q: "escapement" } }] },  // typo
    { say: "Retrying.", callTools: [{ name: "search", args: { q: "escapement" } }] },
    { say: "An escapement ticks." },
  ],
  tools: [searchTool],
  assembler: assembler(),
  graders: [
    endsAs("completed"),
    callsTools(["serch", "search"], ToolMatch.Exact),
    withinCorrectiveTurns(1),
    replaysExactly(),
  ],
}
```

Notes that save time:

- The scripted provider **fails loudly** when it runs out of turns. If your case
  reports `scripted.exhausted`, the agent took more model calls than you wrote —
  which is usually the finding, not a fixture bug.
- `callsTools` defaults to subsequence matching. Use `ToolMatch.Exact` only when
  the exact sequence is genuinely the property under test.
- `withinSteps(4)` is an upper bound. If you mean "the limit stopped it at
  exactly four", use `usageEquals({ modelCalls: 4 })`.
- Mark a case `critical: true` when its failure should fail the gate whatever the
  scores did. Reserve it for the promises on the tin — budgets enforced, fatal
  errors not retried, runs replay exactly.
- Add `replaysExactly()` to every case. It is nearly free and it is what keeps
  the determinism claim honest.

## Graders

| Grader | Answers |
| ------ | ------- |
| `endsAs(status)` / `failsWith(code)` | Did it terminate correctly? |
| `outputContains` / `outputMatches` | Is the answer right? |
| `callsTools(names, mode)` / `neverCalls(...)` | Right tools, right shape? |
| `trajectoryCloseTo(reference, threshold)` | *How far* from the reference path? |
| `withinSteps` / `withinToolCalls` / `withinTokens` / `withinRetries` | Still efficient? |
| `withinCorrectiveTurns(n)` | Is the model fixing its own mistakes more often? |
| `usageEquals({...})` | Did a limit bite at exactly the declared point? |
| `contextWithinBudget()` | Did any assembly overrun the window? |
| `sectionNeverStarved(id)` | Did the model actually *see* what it needed? |
| `contextInvariant(id, fn, reason)` | Anything else about the assembly reports. |
| `replaysExactly()` | Is the run still deterministic? |
| `grader(id, fn, weight?)` | Anything bespoke. |

Scores are continuous in `[0, 1]` and `passed` is separate, because "still works
but takes two extra tool calls" is exactly the movement a gate needs to see and a
boolean cannot express it.

### Graders that need I/O

`grade` may return a promise ([ADR-0017](adr/0017-asynchronous-graders.md)), so a
grader that has to call out — an LLM-as-judge rubric being the obvious one — can
be written against the same interface. Nothing here ships one, and one does not
belong in `eval:gate`: put it in a separate, slower suite where its cost and its
non-determinism are visible. The harness grades sequentially in declaration
order, and a rejected promise fails the case exactly like a thrown error.

## The gate

`npm run eval:gate` compares the run to `evals/baseline.json`.

**Errors** (fail the build): a case regressed beyond tolerance; a `critical` case
failed; a baselined case was not run; the suite mean dropped beyond the aggregate
tolerance.

**Warnings** (reported, do not fail): the trajectory fingerprint changed at an
unchanged score; a new case has no baseline entry.

### When your change legitimately moves the scores

Leave the gate red. Explain the movement in the pull request.

The baseline is re-recorded **only on a `release/*` branch**, where the whole
suite is judged at once with the release notes open — not on a feature branch,
where the only thing in view is one red case and the fastest route to green.
`escapement baseline` refuses to run elsewhere, and CI independently refuses a
pull request that modifies `evals/baseline.json` from a non-release branch.

Full reasoning in [ADR-0012](adr/0012-eval-regression-gates.md).

## Turning a production failure into a permanent test

```ts
const recorder = recordingProvider(myRealProvider);
await run({ goal, provider: recorder, tools });
// recorder.script is now a replayable fixture — paste it into a case.
```

Failures are recorded too, so a rate-limit storm that produced a bad trajectory
becomes a reproducible case rather than an anecdote.
