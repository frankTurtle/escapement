import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reduce } from "../../src/orchestrator/reducer.ts";
import { EventType, Phase, isAtRest, isTerminal, isLegalTransition } from "../../src/orchestrator/phases.ts";
import { DEFAULT_CONFIG, initialState, type RunConfig, type RunState } from "../../src/orchestrator/state.ts";
import type { RunEvent } from "../../src/orchestrator/events.ts";
import { run, resume } from "../../src/orchestrator/runtime.ts";
import { parseLedger, replay, serializeLedger, toolSequence, phaseTrace } from "../../src/orchestrator/ledger.ts";
import { reexecute } from "../../src/orchestrator/reexecute.ts";
import { scriptedProvider, type ScriptedTurn } from "../../src/providers/scripted.ts";
import { createRegistry, tool } from "../../src/tools/registry.ts";
import type { ObjectSchema } from "../../src/tools/schema.ts";
import { assistant } from "../../src/core/messages.ts";
import { manualClock } from "../../src/core/clock.ts";
import { InvariantViolation } from "../../src/core/errors.ts";
import { runCase } from "../../src/evals/harness.ts";
import { caseFromLedger } from "../../src/evals/from-ledger.ts";
import { callsTools, endsAs, replaysExactly } from "../../src/evals/graders.ts";

const gated: RunConfig = { ...DEFAULT_CONFIG, approvalRequired: ["commit"] };
const usage = { promptTokens: 10, completionTokens: 5 };
const commitCall = { id: "c1", name: "commit", args: { message: "fix" } };

function drive(events: readonly RunEvent[], cfg: RunConfig = gated, start?: RunState) {
  let state = start ?? initialState("run-0001", "goal", 0);
  const queue = [...events];
  const trace: string[] = [];
  let lastEffects: string[] = [];
  while (queue.length > 0) {
    const event = queue.shift() as RunEvent;
    const from = state.phase;
    const t = reduce(state, event, cfg);
    state = t.state;
    lastEffects = t.effects.map((e) => e.kind);
    trace.push(`${from}->${state.phase}`);
    queue.unshift(...t.emit);
  }
  return { state, trace, lastEffects };
}

const toSuspension: readonly RunEvent[] = [
  { type: EventType.RunStarted, at: 0, goal: "goal" },
  { type: EventType.ContextAssembled, at: 1, context: { messages: [], tokens: 10 } },
  { type: EventType.ModelSucceeded, at: 2, message: assistant("committing", [commitCall]), usage, stopReason: "tool_use" },
];

describe("the reducer suspends before a gated tool runs", () => {
  test("route.tools with a call that needs approval goes to suspended, with nothing to execute", () => {
    const { state, trace, lastEffects } = drive(toSuspension);
    assert.deepEqual(trace.slice(-2), ["model->route", "route->suspended"]);
    assert.equal(state.phase, Phase.Suspended);
    assert.deepEqual(lastEffects, [], "the tool must not run before the decision");
    assert.deepEqual(state.outcome, { status: "suspended", awaiting: { kind: "approval", calls: [commitCall] } });
    assert.deepEqual(state.pendingCalls, [commitCall]);
  });

  test("an ungated call is unaffected", () => {
    const { state } = drive(toSuspension, DEFAULT_CONFIG);
    assert.equal(state.phase, Phase.Tools);
  });

  test("approval runs exactly the pending calls", () => {
    const { state } = drive(toSuspension);
    const t = reduce(state, { type: EventType.RunResumed, at: 3, approved: true, by: "ana" }, gated);
    assert.equal(t.state.phase, Phase.Tools);
    assert.deepEqual(t.effects, [{ kind: "execute-tools", calls: [commitCall] }]);
    assert.equal(t.state.outcome, null);
  });

  test("a decline is an observation for the model, not a failure", () => {
    const { state } = drive(toSuspension);
    const { state: after, trace } = drive(
      [{ type: EventType.RunResumed, at: 3, approved: false, by: "ana", note: "wrong branch" }],
      gated,
      state,
    );
    assert.deepEqual(trace, ["suspended->observe", "observe->assemble"]);
    const last = after.transcript[after.transcript.length - 1];
    assert.equal(last?.role, "tool");
    assert.ok(last?.role === "tool" && last.isError && last.callId === "c1");
    assert.match(last?.content ?? "", /ana declined.*wrong branch/);
    assert.equal(after.usage.correctiveTurns, 0);
    assert.equal(after.consecutiveFailures, 0);
    assert.equal(after.usage.toolCalls, 0, "a declined call never ran");
  });

  test("time spent suspended does not count against the wall-clock budget", () => {
    const cfg: RunConfig = { ...gated, budget: { ...gated.budget, maxWallClockMs: 1_000 } };
    const { state } = drive(toSuspension, cfg);
    const weekend = 3 * 24 * 3_600_000;
    const { state: after } = drive(
      [{ type: EventType.RunResumed, at: 2 + weekend, approved: false, by: "ana" }],
      cfg,
      state,
    );
    assert.equal(after.phase, Phase.Assemble, "not halted on the wall clock");
    assert.equal(after.pausedMs, weekend);
  });

  test("only a suspended run can be resumed, and a suspended run accepts nothing else", () => {
    const { state } = drive(toSuspension.slice(0, 2));
    assert.throws(() => reduce(state, { type: EventType.RunResumed, at: 3, approved: true, by: "ana" }, gated), InvariantViolation);
    const { state: suspended } = drive(toSuspension);
    assert.throws(
      () => reduce(suspended, { type: EventType.RouteAnswer, at: 3, content: "sneaky" }, gated),
      InvariantViolation,
    );
  });
});

describe("the table", () => {
  test("suspended is at rest but not terminal; it can be resumed, cancelled or halted", () => {
    assert.equal(isTerminal(Phase.Suspended), false);
    assert.equal(isAtRest(Phase.Suspended), true);
    assert.equal(isAtRest(Phase.Done), true);
    assert.equal(isAtRest(Phase.Model), false);
    assert.ok(isLegalTransition(Phase.Route, EventType.RouteTools, Phase.Suspended));
    assert.ok(isLegalTransition(Phase.Suspended, EventType.RunResumed, Phase.Tools));
    assert.ok(isLegalTransition(Phase.Suspended, EventType.RunResumed, Phase.Observe));
    assert.ok(isLegalTransition(Phase.Suspended, EventType.RunCancelled, Phase.Failed));
    assert.ok(!isLegalTransition(Phase.Suspended, EventType.RunResumed, Phase.Done));
  });
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const msgSchema: ObjectSchema = { type: "object", properties: { message: { type: "string" } }, required: ["message"] };

function commitTool() {
  const commits: string[] = [];
  const def = tool("commit", "Commit the change.", msgSchema, (args) => {
    commits.push(String(args["message"]));
    return `committed "${String(args["message"])}"`;
  }, { requiresApproval: true });
  return { commits, def };
}

const SCRIPT: readonly ScriptedTurn[] = [
  { say: "ready", callTools: [{ id: "toolu_1", name: "commit", args: { message: "fix the bug" } }] },
  { say: "Committed." },
];

describe("run and resume", () => {
  test("a run stops at the gate, and the ledger it returns is the checkpoint", async () => {
    const { commits, def } = commitTool();
    const { outcome, ledger } = await run({
      goal: "fix it",
      provider: scriptedProvider(SCRIPT),
      tools: createRegistry([def]),
      deps: { clock: manualClock(0) },
    });
    assert.equal(outcome.status, "suspended");
    assert.equal(ledger.finalPhase, Phase.Suspended);
    assert.deepEqual(ledger.config.approvalRequired, ["commit"]);
    assert.deepEqual(commits, [], "nothing ran before approval");
    assert.ok(replay(ledger).ok, "a suspended ledger replays");

    // Written to disk and read back, as it would be while someone decides.
    const stored = parseLedger(serializeLedger(ledger));
    const provider = scriptedProvider(SCRIPT.slice(1));
    const resumed = await resume(stored, {
      decision: { approved: true, by: "ana" },
      provider,
      tools: createRegistry([def]),
      deps: { clock: manualClock(60_000) },
    });
    assert.deepEqual(resumed.outcome, { status: "completed", output: "Committed." });
    assert.deepEqual(commits, ["fix the bug"]);
    assert.equal(resumed.ledger.runId, ledger.runId);
    assert.equal(resumed.ledger.startedAt, ledger.startedAt);
    assert.deepEqual(resumed.ledger.entries.slice(0, ledger.entries.length), ledger.entries, "the history is kept");
    assert.ok(phaseTrace(resumed.ledger).includes("suspended->tools"));
    assert.ok(replay(resumed.ledger).ok, "the whole history replays, both halves");
    assert.deepEqual(toolSequence(resumed.ledger), ["commit"]);
  });

  test("a declined call never runs, and the model is told why", async () => {
    const { commits, def } = commitTool();
    const first = await run({ goal: "fix it", provider: scriptedProvider(SCRIPT), tools: createRegistry([def]), deps: { clock: manualClock(0) } });
    const provider = scriptedProvider([{ say: "Understood, not committing." }]);
    const resumed = await resume(first.ledger, {
      decision: { approved: false, by: "ana", note: "use a branch" },
      provider,
      tools: createRegistry([def]),
      deps: { clock: manualClock(10) },
    });
    assert.equal(resumed.outcome.status, "completed");
    assert.deepEqual(commits, []);
    const seen = provider.requests[0]?.messages.at(-1);
    assert.ok(seen?.role === "tool" && seen.isError);
    assert.match(seen?.content ?? "", /use a branch/);
  });

  test("resuming a run that is not suspended is a programming error", async () => {
    const { ledger } = await run({ goal: "g", provider: scriptedProvider([{ say: "done" }]), deps: { clock: manualClock(0) } });
    await assert.rejects(
      resume(ledger, { decision: { approved: true, by: "ana" }, provider: scriptedProvider([]) }),
      InvariantViolation,
    );
  });

  test("a suspended and resumed run re-executes byte for byte", async () => {
    const { def } = commitTool();
    const first = await run({ goal: "fix it", provider: scriptedProvider(SCRIPT), tools: createRegistry([def]), deps: { clock: manualClock(0) } });
    const done = await resume(first.ledger, {
      decision: { approved: true, by: "ana" },
      provider: scriptedProvider(SCRIPT.slice(1)),
      tools: createRegistry([def]),
      deps: { clock: manualClock(90_000) },
    });
    const again = await reexecute(done.ledger, { tools: [def] });
    assert.equal(again.identical, true, `diverged at ${again.firstDifference}`);
  });
});

describe("evals", () => {
  test("a case can approve, and caseFromLedger carries the recorded decisions", async () => {
    const { def } = commitTool();
    const graders = [endsAs("completed"), callsTools(["commit"]), replaysExactly()];
    const handWritten = await runCase({
      id: "approve-commit",
      goal: "fix it",
      script: SCRIPT,
      tools: [def],
      approvals: [{ approved: true, by: "reviewer" }],
      graders,
    });
    assert.equal(handWritten.passed, true, JSON.stringify(handWritten.grades));

    const unapproved = await runCase({ id: "no-approval", goal: "fix it", script: SCRIPT, tools: [def], graders: [endsAs("suspended")] });
    assert.equal(unapproved.passed, true, "with no decision the case ends suspended");

    const first = await run({ goal: "fix it", provider: scriptedProvider(SCRIPT), tools: createRegistry([def]), deps: { clock: manualClock(0) } });
    const done = await resume(first.ledger, {
      decision: { approved: true, by: "ana" },
      provider: scriptedProvider(SCRIPT.slice(1)),
      tools: createRegistry([def]),
    });
    const fromLedger = caseFromLedger(done.ledger, graders, { tools: [def] });
    assert.deepEqual(fromLedger.approvals, [{ approved: true, by: "ana" }]);
    assert.equal((await runCase(fromLedger)).passed, true);
  });
});
