# ADR-0020: Multi-agent pipelines chain runs and link their ledgers

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Core maintainers

## Context

One `run()` is one agent. Rollcage piece 13 runs four in sequence (planner,
implementer, tester, reviewer), with a bounded loop back to the implementer
when the tests fail or the reviewer asks for changes. It wrote that loop
itself, plus the bookkeeping around it: a run id per handoff, the order of
handoffs, a digest of each ledger, and a check that every handoff still matches
the ledger it points to.

None of that is specific to Rollcage. What is specific is the routing: which
agent goes next, given what the last one produced.

Two things we do not want: a graph language, and a second state machine with
its own transition table, budget rules and failure taxonomy. The orchestrator
already has one of each, and a pipeline of runs is a sequence of those runs.

## Decision

**`pipeline(options)`** runs stages in sequence and records each run as a
handoff.

```ts
const result = await pipeline({
  id: "fix-1142",
  start: "planner",
  stages: { planner, implementer, tester, reviewer }, // (input) => RunOptions minus runId
  next: (handoff, prior) => /* stage name, or null to stop */,
  maxHandoffs: 8,
});
```

- A stage is a function from what came before to the options of one run (goal,
  provider, tools, assembler, deps). It decides its own goal from the prior
  handoffs' outputs.
- `next` is the routing: called after each completed run with that handoff and
  all prior ones, it returns the next stage's name or `null`. It is ordinary
  code over recorded outcomes, so for the same handoffs it makes the same
  choice.
- Each run gets the id `${id}-${seq}-${stage}` and the previous run's id as
  `parentRunId`. **`RunLedger.parentRunId`** is a new optional header field,
  present only when set, so existing ledgers keep their bytes.
- A handoff is `{ seq, stage, runId, parentRunId, outcome, ledger,
  ledgerDigest }`.
- A run that does not complete stops the pipeline with that status: `failed`,
  `halted` or `suspended`. Routing a failure onwards would be a decision about
  someone else's error, and that belongs in the caller.
- `maxHandoffs` bounds the loop. Running out halts the pipeline with
  `pipeline.max_handoffs`, the same way a step budget halts a run.

**A suspended pipeline continues with `history`.** Resume the last handoff's run
([ADR-0019](0019-suspended-phase-and-resume.md)), replace that handoff with
`handoffOf(...)` of the resumed result, and call `pipeline` again with
`history`. Routing picks up from the last handoff.

**`verifyPipeline(result)`** checks each link: sequence numbers are contiguous,
each `parentRunId` names the previous run, each ledger's header agrees, each
digest matches its ledger, and each ledger replays. It returns the problems
found, empty when the chain is sound.

## Consequences

### What this buys us

- A multi-agent workflow is a stage map and a routing function, with run ids,
  links and integrity checks done once.
- Every agent is still an ordinary run, so evals, replay, re-execution
  ([ADR-0018](0018-re-execution-from-the-ledger.md)) and approval work on each
  handoff unchanged.

### What this costs us

- A new optional ledger header field.
- The pipeline has no budget of its own beyond `maxHandoffs`. Each run has its
  own budget; a token budget across the whole pipeline is the caller's to add.

### What we are explicitly giving up

Concurrency and graphs. Stages run one at a time, in the order routing picks.
Fan-out (two reviewers at once) is not modelled; a workflow that needs it can
run two pipelines, or run the runs itself and still use `parentRunId`.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| A pipeline phase inside the state machine | Turns one agent's machine into a workflow engine, with a second set of budgets and failure rules. |
| A declarative graph (nodes, edges, conditions) | Every condition ends up as a function anyway; a function is the honest form. |
| Continue routing after a failed run | Whether a tester's crash means "rework" or "stop" is the workflow's call, and it can make it by calling `pipeline` again with `history`. |
| Nest child ledgers inside the parent | Makes one ledger the size of the whole workflow, and breaks `replay()`, which expects one run. Links by id keep each ledger self-contained. |
