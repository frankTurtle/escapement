# Decision log

Every architecturally significant choice in Escapement has a numbered ADR.
The process itself is [ADR-0001](adr/0001-record-architecture-decisions.md).

| # | Decision | Status |
| - | -------- | ------ |
| [0001](adr/0001-record-architecture-decisions.md) | Record architecture decisions as ADRs | Accepted |
| [0003](adr/0003-typescript-esm-zero-runtime-dependencies.md) | TypeScript + ESM, and zero runtime dependencies | Accepted |
| [0004](adr/0004-determinism-substrate-injected-ports.md) | Determinism is a substrate — clock, randomness, and identity are injected | Accepted |
| [0005](adr/0005-error-taxonomy.md) | Classify failures by who can fix them | Accepted |
| [0010](adr/0010-gitflow-branching-model.md) | GitFlow branching model | Accepted |
| [0014](adr/0014-model-provider-port.md) | The model is a port, and the scripted provider is first-class | Accepted |
| [0015](adr/0015-small-tool-schema-and-readonly.md) | A deliberately small tool schema, and `readOnly` as a machine-readable permission | Accepted |

> Gaps in the numbering are ADRs that land with a later feature branch. Numbers
> are allocated when a decision is made, not when it is merged.
