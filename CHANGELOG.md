# Changelog

Notable changes to Escapement. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semver](https://semver.org/). While the major version is `0`, minor releases
may change behaviour — including eval scores, which the baseline records.

## [Unreleased]

### Changed

- **`Grader.grade` may now return a promise.** The signature widens to
  `grade(context): Grade | Promise<Grade>`, and the harness awaits each grade
  sequentially, in declaration order. Every grader shipped here is unchanged and
  still synchronous — the sync path is not wrapped in a resolved promise — so the
  eval baseline is untouched and the gate still scores 1.000. Breaking only for
  code that calls `grade()` directly outside the harness.
  ([ADR-0017](docs/adr/0017-asynchronous-graders.md))
- `grader(id, fn, weight?)` accepts an async body, so the bespoke escape hatch
  covers both kinds of grader.
- A grader that *rejects* now fails its case the same way a grader that throws
  already did: score `0`, and a reason naming the grader. A judge that times out
  must not be able to silently pass the case it was meant to judge.

### Fixed

- **ADR-0013 advertised an extension point that did not exist.** It stated that
  a rubric grader "would fit the `Grader` interface exactly" — but `grade` was
  synchronous and the harness never awaited, so a grader that calls a model
  could not be written against it at all. ADR-0017 makes the claim true; ADR-0013
  keeps its text and gains a forward link, per
  [ADR-0001](docs/adr/0001-record-architecture-decisions.md).

### Added

- Four tests covering the async grader path: awaiting, rejection handling,
  declaration-order sequencing, and the guarantee that a synchronous body stays
  synchronous.

## [0.1.1] — 2026-08-31

Packaging and hygiene. No behaviour change: the eval baseline is untouched and
all 204 tests are unmoved.

### Fixed

- **`prepublishOnly` now builds before publishing.** `files` ships `dist/`,
  which is gitignored — publishing without a build would have uploaded a package
  containing no code. This was the one genuine footgun.
- **Type resolution for consumers.** `exports` now carries explicit `types`
  conditions per entry point, plus a top-level `types` field for legacy
  resolvers. Verified against `moduleResolution` `nodenext` and `bundler` (all
  four entry points) and `node10` (root import; subpath exports are not
  resolvable under legacy resolution by design, and TypeScript says so clearly).
- **Source maps now resolve.** The package shipped `.js.map` and `.d.ts.map`
  but not the sources they point at. `src/` is now included, so stepping into
  the library and "go to definition" both land on real TypeScript.

### Added

- `repository`, `homepage`, `bugs` and `author` metadata, so the npm page links
  back to the source, the issues and the README.
- `./package.json` to the `exports` map, which some tooling reads.

### Changed

- `contextWithinBudget` no longer destructures an `evalCase` it immediately
  discarded, and both it and `sectionNeverStarved` now use the `reportsOf`
  helper that already existed instead of inlining its body. Found by a slop
  scan; no functional change.

[0.1.1]: https://github.com/frankTurtle/escapement/releases/tag/v0.1.1

## [0.1.0] — 2026-08-31

The first release. Three components, fifteen decision records, and a promise
that runs replay exactly.

### Orchestrator

- A frozen transition table (`TRANSITIONS`) that every transition is asserted
  against. Anything not in the table throws rather than limping on.
- A **pure reducer**: `reduce(state, event, config)` takes no clock, no
  randomness and no I/O. Effects are returned as data for the runtime to
  execute.
- **Budgets enforced in the reducer**, not the runtime — steps, tool calls,
  tokens, wall clock, consecutive failures and model attempts. Token and
  tool-call checks are *prospective*: a call the run cannot afford is refused
  rather than discovered after the fact.
- A five-class failure taxonomy routed by remedy — who can fix it: the runtime
  (retry), the model (reprompt), or nobody (abort/halt).
- An append-only `RunLedger`, JSON and self-contained, with `replay()` that
  reproduces a run and names the sequence number where it diverged.
- `docs/STATE-MACHINE.md` generated from the table, with a CI check for drift.

### Context assembler

- Deterministic budgeted packing over sections, in four passes: reserve,
  pinned, fair share, fill.
- Separate `priority` (who is squeezed) and `order` (position in the window).
- Per-section `maxShare`, `minTokens` and overflow policy; elisions emit a note
  whose cost is reserved before filling.
- Pinned sections fail loudly rather than being silently truncated.
- Every assembly emits a report that lands in the ledger, so graders can assert
  on what the model was given.
- `Tokenizer` port with an `exact` flag; the heuristic default declares itself
  inexact and the packer keeps a safety margin accordingly.
- `Retriever` port with in-process BM25; `MemoryStore` port with an in-memory
  default. Both fully ordered, so nothing depends on insertion order.

### Eval harness

- Graders as pure functions over the ledger, with continuous `[0, 1]` scores
  alongside a separate `passed`.
- Built-ins for outcome, tool sequence, trajectory distance, efficiency, exact
  usage, context invariants and replay equality.
- A committed baseline and a regression gate that blocks on regressions,
  critical-case failures, disappearing cases and aggregate slippage; reports
  trajectory drift and new cases as warnings.
- The ratchet: baselines are re-recorded on `release/*` branches only, enforced
  by both the CLI and CI.
- `escapement` CLI: `run`, `gate`, `baseline`.
- 16 cases covering routing, recovery, retry, budgets, tool safety and context
  pressure. Every case asserts `replaysExactly()`.

### Project

- Zero runtime dependencies, enforced in CI.
- TypeScript, ESM-only, running unbuilt under Node's type stripping.
- 204 unit tests, all offline.
- GitFlow, with branch policy enforced in CI.
- Fifteen ADRs in `docs/adr/`, each with its rejected alternatives.

[0.1.0]: https://github.com/frankTurtle/escapement/releases/tag/v0.1.0
