# Changelog

Notable changes to Escapement. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[semver](https://semver.org/). While the major version is `0`, minor releases
may change behaviour — including eval scores, which the baseline records.

## [0.3.0] — 2026-11-25

Seven gaps found while building a four-agent planner, implementer, tester and
reviewer workflow on 0.2.0 (Rollcage piece 13), which had to work around each of
them with an adapter. Five new ADRs (0018–0022). The eval baseline is untouched
and the gate still scores 1.000. 252 tests pass, 44 of them new. Still zero
runtime dependencies.

### Added

- **Re-execution from a ledger.** `replayProvider(ledger)` serves a run's
  recorded model turns back, and by default checks each request against the
  recorded context, failing with `replay.diverged` when they differ.
  `recordedTools(ledger, definitions?)` answers each tool call with its
  recorded result, retries included. `reexecute(ledger, options)` runs the
  whole run again with both and reports `identical` and `firstDifference`.
  `scriptFromLedger(ledger)` returns the model turns as a script.
  ([ADR-0018](docs/adr/0018-re-execution-from-the-ledger.md))
- **`caseFromLedger(ledger, graders, options?)`** builds an `EvalCase` from a
  recorded run: script, recorded tools, budget, retry policy and approval
  decisions. (ADR-0018)
- **Approval and resume.** `ToolDefinition.requiresApproval` stops the run in a
  new `suspended` phase before the call runs, with outcome
  `{ status: "suspended", awaiting: { kind: "approval", calls } }`.
  `resume(ledger, { decision: { approved, by, note? }, ... })` rebuilds the
  state from the ledger and feeds a `run.resumed` event. Approved calls run.
  Declined calls go back to the model as an error observation naming who
  declined. Time spent suspended does not count against `maxWallClockMs`. The
  eval harness applies `EvalCase.approvals`. `isAtRest(phase)` covers terminal
  phases and `suspended`.
  ([ADR-0019](docs/adr/0019-suspended-phase-and-resume.md))
- **Pipelines.** `pipeline({ id, start, stages, next, maxHandoffs, history })`
  runs one agent per stage in the order a routing function picks. It gives each
  run the id `<id>-<seq>-<stage>` and records the previous run as
  `parentRunId`. `verifyPipeline(result)` checks every link, digest and replay.
  `handoffOf(previous, resumed)` continues a pipeline after a resume.
  ([ADR-0020](docs/adr/0020-pipelines-of-runs.md))
- **Schema-typed tools.** `tool()` takes its schema as a `const` type parameter
  and types the handler's `args` as `InferArgs<S>`, so `args.path` is a
  `string` with no cast. `defineTool({ ... })` does the same for handlers that
  return a `Result`. `InferArgs` and `InferSchema` are exported.
  ([ADR-0021](docs/adr/0021-schema-typed-tool-handlers.md))
- **Text-only models.** `textProvider(client)` wraps a client that only returns
  text, using a JSON turn protocol (`TEXT_TURN_PROTOCOL`, `renderTextPrompt`,
  `parseTextTurn`). A malformed reply is a `correctable` `model.invalid_turn`,
  so it costs a repair turn rather than the run.
  ([ADR-0022](docs/adr/0022-json-turn-protocol-for-text-models.md))
- `ScriptedToolCall.id` is optional and kept when present, and
  `recordingProvider` records it, so a script reproduces another provider's
  call ids. (ADR-0018)
- `RunLedger.parentRunId` and `RunOptions.parentRunId`, present only when set.
- `RunConfig.approvalRequired`, filled from the registry and present only when
  a tool requires approval.

### Changed

Breaking for some TypeScript consumers. Ledgers and runtime behaviour without
gated tools are unchanged byte for byte.

- `Outcome` has a fourth variant, `suspended`, with no `error`. Code that reads
  `outcome.error` after ruling out only `completed` no longer compiles; narrow
  on `failed` or `halted`. The bundled example and `failsWith` were updated the
  same way.
- `Phase` gains `suspended` and `EventType` gains `run.resumed`, so
  exhaustive `switch`es and `Record<Phase, …>` maps need a new case.
- `RunState` gains `pausedMs`, which the wall-clock budget subtracts.
- `tool()` now infers `args` from an inline schema. A handler that reads a key
  the schema does not declare (`args["other"]`) now fails to compile. A schema
  annotated as plain `ObjectSchema` still gives `JsonObject`.
- `createRecorder(onEntry?, history?)` accepts earlier entries to continue.

`LEDGER_VERSION` stays `1`: every ledger change is additive, and old ledgers
parse and replay as before.

### Not closed

- Re-execution is byte-identical only for runs recorded on a deterministic
  clock, which the harness uses. A system-clock ledger re-executes with the
  same events and trajectory but different timestamps. Replaying the clock was
  rejected in ADR-0018.
- A provider that *throws*, rather than returning a `Result`, records a `fault`
  that the replay provider cannot serve back. Cancellation is not replayed
  either.
- Approval is all-or-nothing per model turn, and only tool calls can suspend a
  run. Pipelines run their stages one after another, with no fan-out.

[0.3.0]: https://github.com/frankTurtle/escapement/releases/tag/v0.3.0

## [0.2.0] — 2026-08-31

One API change, made to keep a promise ADR-0013 had already written down. The
eval baseline is untouched and the gate still scores 1.000; 208 tests pass, four
of them new.

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

[0.2.0]: https://github.com/frankTurtle/escapement/releases/tag/v0.2.0

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
