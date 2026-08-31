# Decision log

Every architecturally significant choice in Escapement has a numbered ADR.
The process itself is [ADR-0001](adr/0001-record-architecture-decisions.md).

| # | Decision | Status |
| - | -------- | ------ |
| [0001](adr/0001-record-architecture-decisions.md) | Record architecture decisions as ADRs | Accepted |
| [0002](adr/0002-no-langchain-hand-written-orchestrator.md) | Write the orchestrator by hand rather than adopting a framework | Accepted |
| [0003](adr/0003-typescript-esm-zero-runtime-dependencies.md) | TypeScript + ESM, and zero runtime dependencies | Accepted |
| [0004](adr/0004-determinism-substrate-injected-ports.md) | Determinism is a substrate — clock, randomness, and identity are injected | Accepted |
| [0005](adr/0005-error-taxonomy.md) | Classify failures by who can fix them | Accepted |
| [0006](adr/0006-table-driven-fsm-pure-reducer.md) | A frozen transition table, a pure reducer, and effects as data | Accepted |
| [0007](adr/0007-append-only-run-ledger-replay.md) | The ledger is the artifact, and replay is a first-class mode | Accepted |
| [0008](adr/0008-pluggable-tokenizer.md) | A tokenizer port, with a heuristic default that admits it is one | Accepted |
| [0009](adr/0009-in-process-bm25-retriever.md) | Retrieval is a port, with in-process BM25 as the default | Accepted |
| [0010](adr/0010-gitflow-branching-model.md) | GitFlow branching model | Accepted |
| [0011](adr/0011-deterministic-budgeted-context-packing.md) | Context assembly is deterministic budgeted packing | Accepted |
| [0012](adr/0012-eval-regression-gates.md) | Regression gates with a committed baseline and a release-only ratchet | Accepted |
| [0013](adr/0013-trajectory-graders-over-run-ledger.md) | Grade trajectories, with pure functions over the ledger | Accepted · amended by [0017](adr/0017-asynchronous-graders.md) |
| [0014](adr/0014-model-provider-port.md) | The model is a port, and the scripted provider is first-class | Accepted |
| [0015](adr/0015-small-tool-schema-and-readonly.md) | A deliberately small tool schema, and `readOnly` as a machine-readable permission | Accepted |
| [0016](adr/0016-publish-on-tag.md) | Publishing is automated from tags, with guards and no long-lived secret | Accepted |
| [0017](adr/0017-asynchronous-graders.md) | Graders may be asynchronous, so a judge grader can exist outside the gate | Accepted |

> Gaps in the numbering are ADRs that land with a later feature branch. Numbers
> are allocated when a decision is made, not when it is merged.
