# ADR-0012: Regression gates with a committed baseline and a release-only ratchet

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

An eval suite that nobody enforces is documentation. To change behaviour, the
suite has to be able to *block a merge* — which immediately raises the question
every team with an eval suite eventually gets wrong.

**Against what?** Not "all cases pass": agent evals are rarely all-green, and a
suite that only fires at zero has no resolution in the range where behaviour
actually lives. Not "above a threshold" either — a hand-picked number nobody can
justify, which drifts as cases are added.

The answer that works is *against the last accepted run*. Which raises the
question that actually matters: **who may move the bar, and when?**

The failure mode here is well known and quiet. A contributor's change drops one
case from 1.0 to 0.7. The gate goes red. The fastest way to green is
`--update-baseline`. It gets committed with the change, the review focuses on
the diff rather than the recorded score, and the bar has moved down by 0.3 with
nobody having decided that it should. Repeat over six months and the suite
records whatever the code currently does, which is the definition of no suite at
all.

## Decision

### The baseline is a committed file

`evals/baseline.json` records, per case, the score, the pass/fail, whether it is
critical, and the trajectory fingerprint — plus the suite aggregate. It is
reviewed like code, because it is a claim about behaviour.

### The gate blocks on five things

| Finding | Severity | Why |
| ------- | -------- | --- |
| Case score dropped beyond tolerance | **error** | The regression itself. |
| A `critical` case failed | **error** | Whatever the scores did. These are the promises on the tin. |
| A baselined case was not run | **error** | Deleting coverage must be deliberate. |
| Suite mean dropped beyond the aggregate tolerance | **error** | Catches broad slippage. |
| Trajectory fingerprint changed at an unchanged score | warning | Same destination, different route. |
| A new case with no baseline entry | warning | Recorded at the next release. |
| A case improved | info | With a note to lock it in at the next release. |

Two of these are worth spelling out.

**The aggregate tolerance must be tighter than the per-case one to mean
anything.** The suite mean's drop can never exceed the largest per-case drop, so
with a shared tolerance the aggregate check is mathematically redundant. It
earns its place only when set tighter, where it catches the pattern a per-case
threshold is structurally blind to: many cases each slipping a little. It
defaults to the per-case tolerance — redundant but harmless — and tightening it
is a deliberate act.

**Trajectory drift is a warning, not an error.** An agent that reaches the same
result by a different route is usually fine and occasionally the most important
signal in the report. Failing on it would make every harmless refactor red;
ignoring it would hide the case where a change quietly rerouted the agent.
Warning is the honest severity. `--strict-trajectory` promotes it for anyone who
wants it.

### The ratchet: baselines are re-recorded on `release/*` only

This is the load-bearing rule.

`escapement baseline` refuses to run unless the current branch starts with
`release/`. CI independently refuses any pull request that modifies
`evals/baseline.json` from a branch that is not `release/*`. Belt and braces, on
purpose: the CLI check catches the local mistake before it becomes a PR, and the
CI check catches anyone who edited the file by hand.

The reasoning: **a baseline refresh is a whole-suite judgement, not a per-feature
one.** On a release branch you are looking at every case at once, with the
release notes open, deciding whether the new numbers are the numbers you want to
ship. On a feature branch you are looking at one red case and the fastest path
to green. Those two situations produce different decisions, and only the first
one deserves to move the bar.

So the workflow when a feature legitimately moves scores is: **leave the gate
red**, explain the movement in the pull request, and let the reviewer decide.
The report says so explicitly, at the bottom, every time.

### Bootstrap

With no baseline file, the gate falls back to "every case passes" and says so
loudly. A repository that has never cut a release has nothing to regress from.
Deleting the file later is a diff to `evals/baseline.json`, which the
branch-policy job already refuses outside a release branch — so this is not a
hole to hide in.

## Consequences

### What this buys us

- Behaviour changes cannot land silently; something has to go red first.
- The bar moves at a moment designed for deciding where it should be.
- The baseline diff is a readable record of how behaviour changed release over
  release.
- Reviewers argue about the recorded score, which is the right thing to argue
  about.

### What this costs us

- **Friction, deliberately.** A legitimate improvement leaves the gate red until
  the release. That is annoying, and it is the mechanism working: the annoyance
  is what stops the reflexive re-record.
- **Merge conflicts** in `baseline.json` when two release branches are open. Rare
  at our size; genuinely painful at a larger one.
- **Someone will use `--force`.** The flag exists because a bootstrap or a
  legitimate emergency needs it, and it prints why the rule exists before
  yielding. CI still refuses the resulting diff, so the escape hatch is local
  only.
- The gate is only as good as the suite. A baseline over three shallow cases is
  a false sense of security wearing a green check.

### What we are explicitly giving up

Fast iteration on scores. A team optimising an agent daily would find this
model obstructive, and they would be right — they should hold the baseline
somewhere mutable and gate on trend instead. We are a library making a
behavioural promise to people who pin a version, and for that the ratchet is
worth its friction.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Fixed pass thresholds per case | A hand-picked number nobody can justify, which drifts as cases are added and says nothing about movement. |
| Baseline updated automatically on merge to `develop` | Convenient, and it is exactly the silent ratchet-down this ADR exists to prevent. |
| No baseline; require every case to pass | No resolution in the range where behaviour actually lives, and it forces graders to be binary. |
| Baseline in an external store (S3, a dashboard) | Loses reviewability and offline reproducibility, and makes `git checkout v0.3.1 && npm run eval:gate` impossible. |
| Statistical significance testing across seeds | The right answer for a live-model suite where scores are distributions. Ours are deterministic: a change of 0.001 is a real change, not noise. |
