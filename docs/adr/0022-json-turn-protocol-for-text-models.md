# ADR-0022: A JSON turn protocol for models without native tool calls

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Core maintainers

## Context

`ModelProvider` ([ADR-0014](0014-model-provider-port.md)) returns an
`AssistantMessage` with structured `toolCalls`. That fits an API with native
tool use. Many clients only return text: a shared in-house LLM client, a local
model server, a gateway that strips tool use. Rollcage piece 13 is one. It
wrote its own adapter: a protocol line in the system prompt asking for
`{"say": ..., "tool_calls": [...]}`, a renderer that flattens the transcript
into one prompt, and a Zod schema to parse the reply.

Two details of that adapter are worth fixing rather than copying. An
unparseable reply was `fatal`, which ends the run, when it is the model's
mistake and the model can usually fix it if told. And the parser was a runtime
dependency, which Escapement does not take
([ADR-0003](0003-typescript-esm-zero-runtime-dependencies.md)).

## Decision

Ship the protocol in `escapement` (providers), in four parts that can be used
together or separately.

- **`TEXT_TURN_PROTOCOL`**, the instruction: reply with one JSON object,
  `{"say": string, "tool_calls": [{"name": string, "args": object}]}`, and leave
  `tool_calls` empty to answer.
- **`renderTextPrompt(request)`** returns `{ system, prompt }`. `system` is the
  request's system messages, the tool list rendered with `renderSchema`, and the
  protocol. `prompt` is the rest of the transcript, one labelled block per
  message. Earlier assistant turns are rendered *in the protocol's own JSON*, so
  the model sees the format it is asked for in its own history.
- **`parseTextTurn(text, stepId)`** accepts a bare object, a fenced ` ```json `
  block, or an object with prose around it. Anything else, or an object of the
  wrong shape, is a **`correctable`** `model.invalid_turn` whose message
  restates the protocol, so the reducer hands it back to the model as a repair
  ([ADR-0005](0005-error-taxonomy.md)) rather than ending the run. Shape checks
  are hand-written; there is no dependency.
- **`textProvider(model)`** wraps a `TextModel`, whose single method is
  `complete({ system, prompt, maxOutputTokens?, temperature? }, ctx)` returning
  `Result<{ text, usage?, stopReason? }, EscapementError>`. It renders, calls,
  parses, and fills in usage with a chars/4 estimate when the client reports
  none.

Tool call ids are `${stepId}-call-${n}`. The step id comes from the injected
id factory, so ids are deterministic, and the recorded ledger re-executes with
the same ids ([ADR-0018](0018-re-execution-from-the-ledger.md)).

## Consequences

### What this buys us

- A text-only client becomes a provider with one function, and the
  orchestrator, evals and replay work unchanged on top of it.
- A model that breaks the format costs one corrective turn, counted in
  `usage.correctiveTurns`, instead of the run.

### What this costs us

- The protocol spends prompt tokens, and the estimate it falls back to is as
  rough as the passthrough assembler's.
- Any prose the model writes outside the JSON object is dropped. A reply with
  two objects in it keeps the outermost braces, which may not parse; that is
  then a repair.

### What we are explicitly giving up

Provider-specific prompting. The protocol is one fixed instruction. A client
that needs a different format can still use `parseTextTurn` and
`renderTextPrompt` piecemeal, or write its own provider.

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| Leave it to each consumer | Every text-only consumer writes the same adapter, and the first one made format errors fatal. |
| Make an invalid reply `fatal` | It is the model's mistake and the model can fix it; that is what `correctable` means. |
| Validate with a schema library | A runtime dependency for two fields. |
| A ReAct-style text format (`Action: ...`) | Harder to parse unambiguously than JSON, and arguments are JSON anyway. |
