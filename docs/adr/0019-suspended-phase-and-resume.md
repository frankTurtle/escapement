# ADR-0019: A `suspended` phase for approval, resumed from the ledger

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Core maintainers

## Context

A run ends in `done`, `failed` or `halted`. There is no way for it to stop and
wait for a person. Rollcage piece 13 needed exactly that: an agent proposes a
change to a shared branch, and the commit waits for a named human to approve
it. It built the checkpoint outside Escapement, as a workflow status
(`awaiting-approval`) and a separate audit log, because the run itself could
only finish.

The natural place for the wait is the tool call. "Commit this" and "send this
email" are tools; the approval is about whether one particular call, with these
arguments, may run. The waiting can take hours, so the run cannot sit in
memory: it has to stop, be written down, and be picked up again later, possibly
in another process.

The ledger already is the record that can be written down and picked up again
([ADR-0007](0007-append-only-run-ledger-replay.md)). Replaying its events
through the reducer rebuilds the exact state the run was in.

## Decision

**A tool can require approval.** `ToolDefinition.requiresApproval` is a flag,
like `readOnly` ([ADR-0015](0015-small-tool-schema-and-readonly.md)). The
runtime copies the names of flagged tools into `RunConfig.approvalRequired`, so
the decision is recorded in the ledger and the reducer can make it without
seeing the registry.

**`suspended` is a new phase.** When the model asks for tool calls and any of
them needs approval, the reducer checks the tool-call budget as it always does
and then moves `route --route.tools--> suspended` instead of `tools`. No effect
runs. The outcome is `{ status: "suspended", awaiting: { kind: "approval",
calls } }`, and the runtime returns the ledger.

`suspended` is not terminal: it accepts `run.resumed` and the three universal
events. But the runtime stops there, just as it stops at a terminal phase.
`isAtRest(phase)` names that set.

**`resume(ledger, { decision, provider, tools, ... })` picks the run up.** It
replays the ledger to rebuild the state, checks that the state is `suspended`,
and feeds a `run.resumed` event carrying the decision `{ approved, by, note? }`.
The ledger continues: same run id, `seq` carries on, and the final ledger holds
the whole history, so `replay()` covers both halves.

- **Approved:** `suspended --run.resumed--> tools`. The calls the model asked for
  run as they would have.
- **Declined:** `suspended --run.resumed--> observe`. Each pending call gets an
  error tool message saying who declined it and why, and the model takes the
  next turn. Declining is an observation, not a failure: it does not count as a
  corrective turn or towards `maxConsecutiveFailures`.

The decision covers every call in that turn. A turn that mixes a gated call
with ungated ones is approved or declined as a whole, because running half of a
turn the model planned as one is a third outcome nobody asked for.

**Time spent suspended does not count against `maxWallClockMs`.** On resume the
reducer adds the gap between the suspension and the `run.resumed` timestamp to
`state.pausedMs`, and the wall-clock check subtracts it. A run that waits a
weekend for approval is not over budget on Monday.

**The eval harness can resume.** `EvalCase.approvals` lists the decisions to
apply, in order, each time the case suspends. `caseFromLedger` fills it from
the ledger's `run.resumed` events, and `reexecute` replays them
([ADR-0018](0018-re-execution-from-the-ledger.md)).

`LEDGER_VERSION` stays `1`. Every change is additive: old ledgers have no
`approvalRequired`, never enter `suspended`, and parse and replay as before.

## Consequences

### What this buys us

- A human checkpoint is part of the machine, in the table, in the generated
  diagram and in the ledger, with the approver's name in the `run.resumed`
  event.
- Suspension survives a process restart: the ledger is the checkpoint.
- Approval is per call and recorded with the exact arguments, so "approved"
  cannot drift from "what ran".

### What this costs us

- One phase, one event, one state field and one outcome variant. Code that
  switches on `outcome.status` has a fourth case to handle.
- The resumed run must be given the same provider, tools and assembler as the
  original, or what follows the resume is a different run. That is the same
  contract as any replay.
- The approval is all-or-nothing per turn (see above).

### What we are explicitly giving up

Suspension anywhere else. A model asking a human a question, or a run pausing
between steps, would also fit a `suspended` phase, but neither has a user yet.
The phase and the event are general; only the tool-approval trigger is built.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Keep approval outside the run, as Rollcage does | Works, but the checkpoint is then invisible to the ledger, the evals and replay, and every consumer writes its own. |
| Make `suspended` terminal and start a new run on approval | The new run would not have the transcript or the pending calls, and the two ledgers would have to be stitched back together to grade or replay. |
| A tool returns a "needs approval" result | The tool would already be running, which is what approval is meant to prevent. The decision has to be made before the effect. |
| Await a callback inside the run | Holds the run in memory for as long as the human takes, and is lost on restart. |
| Approve calls individually within a turn | Possible later; nobody needs it yet, and a partial turn is harder to reason about than a declined one. |
| Bump `LEDGER_VERSION` | Nothing an old reader relies on changed meaning; bumping would only make old ledgers unreadable. |
