# ADR-0008: A tokenizer port, with a heuristic default that admits it is one

- **Status:** Accepted
- **Date:** 2026-08-31
- **Deciders:** Core maintainers

## Context

The packer ([ADR-0011](0011-deterministic-budgeted-context-packing.md)) needs to
know how many tokens a string costs. Exact counts require the target model's BPE
vocabulary — a megabytes-large data file, per model family, that changes when
the provider changes it.

Shipping that conflicts directly with zero runtime dependencies
([ADR-0003](0003-typescript-esm-zero-runtime-dependencies.md)), and it does not
even solve the problem completely: exact *text* counts still do not tell you the
provider's per-message and per-tool-schema overhead, which is undocumented and
varies by API version. Nobody's local count matches the provider's bill exactly.

## Decision

`Tokenizer` is a port with three members and one flag:

```ts
{ name, exact, count(text), truncate(text, maxTokens) }
```

**`exact` is the load-bearing field.** A packer that does not know whether its
counts are estimates will fill the window to 100% and get a context-length error
from the provider. Ours reads the flag: when `exact` is false it holds back a
safety margin (8% by default) on top of the output reservation. When an exact
tokenizer is injected, the margin drops to zero and the whole window is used.

The default, `heuristicTokenizer`, models BPE crudely: runs of letters merge into
subwords of roughly four characters, so they cost `ceil(length / 4)`;
punctuation, digits and symbols usually stand alone, so they cost one each. That
last part is why it charges JSON and code more per character than prose, which is
the direction real tokenizers go.

**We do not claim an error bound.** We have not measured this against a real BPE
vocabulary, and pretending otherwise would be worse than the approximation
itself. `exact: false` is the honest encoding of "we do not know how wrong this
is", and the safety margin is what we do about it.

`truncate` is a binary search over the cut point using `count`, so it works for
any injected tokenizer and never overshoots — the only property the packer
actually depends on.

The adapter seam is `tokenizerFrom(name, count, exact)`. Wrapping `tiktoken` or a
provider's own counting endpoint is one line, in the user's package, with the
user's version pin.

## Consequences

### What this buys us

- No dependency, no vocabulary download, no per-model data files.
- The approximation is *safe* rather than merely close: the margin comes out of
  the flag automatically, so nobody has to remember to leave headroom.
- Users who need exactness get it by injecting one function, and are rewarded
  with the full window.
- Deterministic and fast: counting is pure arithmetic with a per-assembly cache.

### What this costs us

- We waste roughly 8% of the window by default. On a 200k context that is 16k
  tokens of retrieval we could have included.
- The heuristic will be wrong for languages it was not shaped around. CJK text
  has few "wordish" runs by our regex, so nearly every character is charged as a
  token — an over-estimate, which is at least the safe direction, but a
  substantial one. Non-Latin users should inject a real tokenizer.
- Two tokenizers in play (ours for planning, the provider's for billing) means
  reported usage and packed size will never quite agree.

### What we are explicitly giving up

Precision by default. A framework that shipped `tiktoken` would pack more into
the window out of the box. We would rather be visibly approximate and safe than
invisibly precise for one model family and wrong for the next.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Depend on `tiktoken`/`gpt-tokenizer` | Breaks the zero-dependency rule, adds megabytes, and is still only correct for the model families it ships vocabularies for. |
| `chars / 4` everywhere | Simpler, and materially wrong for code and JSON — which is most of what a tool-using agent's context contains. |
| Ask the provider to count | Accurate, and a network round trip per assembly. Unusable in a packer that runs before every model call. |
| Count on the provider's usage numbers after the fact | Tells you what you spent, not what you can afford. The packer needs the second one. |
| No margin, retry on context-length errors | Turns a planning problem into a runtime failure, and burns a model call to discover something arithmetic could have told us. |
