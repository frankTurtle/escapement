# ADR-0011: Context assembly is deterministic budgeted packing

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

Most agent loops build their context window by concatenation: system prompt,
plus tool descriptions, plus the whole transcript, plus whatever retrieval
returned. This works until it doesn't, and it fails in two characteristic ways.

**It fails suddenly.** Everything is fine, and then one large tool result pushes
the request over the model's limit and the run dies with a 400. The failure lands
on whichever step happened to be unlucky, not on the thing that was actually too
big.

**It fails silently.** Something — usually a naive "keep the last N messages"
rule — drops the retrieved document that contained the answer. The agent then
gives a confidently wrong response, and nothing in the trace says the evidence
was cut. Debugging this is genuinely miserable: the output is wrong, every
component looks fine, and the cause is a truncation nobody recorded.

Both are resource-allocation failures. There is a fixed budget and several
claimants, and concatenation is the allocation policy "first come, first served,
then crash".

## Decision

Context assembly is an explicit, deterministic packing problem.

### Sections, not strings

The window is a list of `Section`s, each with items, an allocation policy, and
an overflow policy. Assembly runs four passes:

1. **Reserve.** Subtract the output reservation, and — when the tokenizer is
   inexact ([ADR-0008](0008-pluggable-tokenizer.md)) — a safety margin.
2. **Pinned.** Allocate required sections in full, in priority order.
3. **Fair share.** Give each remaining section `min(want, maxShare × pool)` in
   priority order, then redistribute leftover space ignoring the caps.
4. **Fill.** Walk each section's items, applying its overflow policy.

### Priority and order are different numbers

`priority` decides who wins when space is scarce. `order` decides where the
section appears in the window. Conflating them is precisely why naive
assemblers drop the wrong thing: the most important content — the latest turn —
is usually rendered *last*, so any scheme that treats position as importance
gets it backwards.

### Pinned means pinned

Pinned sections are never truncated and never partially included. If the pinned
set does not fit, assembly **fails** with `context.pinned_overflow`, naming the
sections and their sizes. We will not silently shorten something the caller
declared essential. In a run, that surfaces as a `fatal` fault and the run stops
— which is the correct outcome, because the alternative is a model answering
from a window that is missing its instructions.

Only `system` and `goal` and the tool signatures are pinned by default. Notably,
the most recent turn is **not**: it gets the top discretionary priority instead,
so it wins every contest for space but degrades under a single enormous tool
result rather than failing the run.

### `minTokens` is all-or-nothing

A section allocated less than its floor gets nothing. Half a retrieved document
is worse than no retrieved document: it looks like evidence, and it has had its
conclusion cut off.

### Elisions are visible, and paid for

When items are dropped, the section emits a note saying how many. The note's
cost is reserved *before* filling, so it cannot itself be squeezed out — a
reader who cannot see that something was cut will assume nothing was.

### Every assembly emits a report

Per-section requested/allocated/used counts, items included, dropped and
truncated, and whether a section was starved. The report goes into the ledger
([ADR-0007](0007-append-only-run-ledger-replay.md)), which means graders can
assert on **what the model was given**, not only on what it produced:
"retrieval was never starved", "the window never exceeded budget", "memory got
its floor". Without that, context bugs are invisible until they surface as bad
answers, and by then they look like model problems.

## Consequences

### What this buys us

- Overflow is impossible by construction, and there is a runtime invariant that
  says so.
- Degradation is declared per section instead of emergent.
- Context becomes a graded, testable component rather than a string built in
  the dark.
- The same inputs always give the same window, so an eval that moves can be
  attributed to the agent rather than to what it happened to be shown.

### What this costs us

- Configuration surface. Priorities, orders, shares, floors and overflow
  policies are five knobs where concatenation had none. The defaults have to be
  good, because most users will never touch them.
- Packing is O(items) with token counting per item, which is fast but not free,
  and it happens before every model call. We cache counts within an assembly and
  not across them.
- The fair-share pass is greedy, not optimal. A knapsack solver would pack
  marginally more in; it would also be non-obvious, and "why did it include that
  one" matters more here than three per cent more content.
- Pinned overflow is a hard failure. Some users will hit it and be annoyed. We
  think an error naming the oversized section beats a silent truncation.

### What we are explicitly giving up

Summarisation. When history does not fit we drop it and say so; we do not
compress it with a model call. Summarisation is a genuinely better use of scarce
tokens — and it is also a second, unbudgeted, non-deterministic model call
inside the context assembler, which would put sampling variance underneath
every eval in the suite. The `extraSections` hook is where an application can
add its own summarised section, built on its own terms, and pay for the call
where it can see it.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Concatenate and hope | The status quo. Fails suddenly (400s) or silently (drops the evidence). |
| Keep the last N messages | Cheap, and it throws away the retrieved document that contained the answer with no record that it did. |
| Summarise on overflow | Better use of tokens, but it is an unbudgeted non-deterministic model call inside the assembler, which would put sampling variance under every eval. Available via `extraSections` where the application owns it. |
| Optimal knapsack packing | Marginally denser windows, materially harder to explain. Explicability wins for a component whose failures are otherwise invisible. |
| Let the provider truncate | Providers truncate from whichever end they choose, silently, with no report. That is the failure mode we are trying to eliminate. |
