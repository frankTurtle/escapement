# ADR-0001: Record architecture decisions as ADRs

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

Escapement's whole value proposition is that an agent's behaviour should be
*explainable*. A system that asks users to trust a deterministic state machine,
a token budget, and a regression gate cannot itself be a pile of undocumented
choices. Six months from now the interesting question about any line of this
codebase will not be "what does it do" — the types answer that — but "why is it
this way, and what did we reject."

The alternative failure mode is well known: decisions live in a maintainer's
head, in a closed PR thread, or in a Slack message nobody can find. New
contributors then either cargo-cult the shape of existing code or relitigate a
settled question from scratch.

## Decision

We record every architecturally significant decision as a numbered Architecture
Decision Record in `docs/adr/`, using the format in
[`0000-template.md`](0000-template.md).

A decision is architecturally significant if changing it later would require
changing code in more than one module, would change a public API, or would
change the guarantees we advertise (determinism, budget enforcement, gate
semantics).

Rules:

1. ADRs are immutable once **Accepted**. We do not edit history; we supersede it.
   A superseded ADR keeps its text and gains a `Superseded by` link.
2. Numbers are allocated sequentially and never reused.
3. The ADR lands **in the same pull request** as the code that implements it.
   A decision without code is a proposal; code without a decision is a liability.
4. [`docs/DECISIONS.md`](../DECISIONS.md) is the generated-by-hand index. Every
   ADR appears there.
5. Every ADR must fill in **Alternatives considered**. An ADR with no rejected
   alternative is not a decision, it is a description.

## Consequences

### What this buys us

- The "why" survives contributor turnover.
- Code review can argue about the ADR rather than about the diff, which is a
  cheaper place to change your mind.
- The ADR set doubles as the project's design documentation, so we do not
  maintain a second, drifting copy in a wiki.

### What this costs us

- Writing overhead on every non-trivial PR.
- A risk of ADR inflation, where trivial choices get ceremonial treatment. The
  significance test above is the mitigation; reviewers enforce it.

### What we are explicitly giving up

Editable design docs. If we change our mind about ADR-0004, we write ADR-00NN
and mark 0004 superseded. Readers of an old commit see the reasoning that was
true at that commit, which is the point.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| A single `DESIGN.md` | Becomes a merge-conflict magnet and silently drifts; loses the record of rejected options entirely. |
| GitHub Discussions / issues | Not versioned with the code, not available offline, and invisible to anyone reading the repo at a tag. |
| Long code comments only | Explains local mechanics well, but has nowhere to put a cross-cutting trade-off or a rejected alternative. |
| No formal record | The status quo we are reacting to. |
