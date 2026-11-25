import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pipeline, verifyPipeline, handoffOf, type PipelineStage } from "../../src/orchestrator/pipeline.ts";
import { resume } from "../../src/orchestrator/runtime.ts";
import { replayProvider } from "../../src/orchestrator/reexecute.ts";
import { serializeLedger } from "../../src/orchestrator/ledger.ts";
import { scriptedProvider } from "../../src/providers/scripted.ts";
import { createRegistry, tool } from "../../src/tools/registry.ts";
import { manualClock } from "../../src/core/clock.ts";
import { fatal } from "../../src/core/errors.ts";

const deps = () => ({ clock: manualClock(0) });

/** A stage whose model says `reply`, and whose goal quotes the previous output. */
const say = (reply: string): PipelineStage => ({ prior }) => ({
  goal: `previous: ${prior.at(-1)?.outcome.status === "completed" ? (prior.at(-1)?.outcome as { output: string }).output : "none"}`,
  provider: scriptedProvider([{ say: reply }]),
  deps: deps(),
});

describe("pipeline", () => {
  test("runs stages in order, linking each ledger to the one before", async () => {
    const result = await pipeline({
      id: "wf",
      start: "plan",
      stages: { plan: say("the plan"), build: say("built it") },
      next: (h) => (h.stage === "plan" ? "build" : null),
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(
      result.handoffs.map((h) => [h.seq, h.stage, h.runId, h.parentRunId]),
      [
        [1, "plan", "wf-1-plan", null],
        [2, "build", "wf-2-build", "wf-1-plan"],
      ],
    );
    assert.equal(result.handoffs[1]?.ledger.parentRunId, "wf-1-plan");
    assert.equal(result.handoffs[0]?.ledger.parentRunId, undefined, "absent, not null, on the first run");
    assert.equal(result.handoffs[1]?.ledger.goal, "previous: the plan", "a stage reads what came before");
    assert.deepEqual(verifyPipeline(result), []);
  });

  test("routing can loop back, and maxHandoffs halts a loop that never ends", async () => {
    const result = await pipeline({
      id: "loop",
      start: "build",
      stages: { build: say("built"), review: say("request changes") },
      next: (h) => (h.stage === "build" ? "review" : "build"),
      maxHandoffs: 5,
    });
    assert.equal(result.status, "halted");
    assert.equal(result.reason?.code, "pipeline.max_handoffs");
    assert.deepEqual(result.handoffs.map((h) => h.stage), ["build", "review", "build", "review", "build"]);
  });

  test("a run that does not complete stops the pipeline with its status", async () => {
    const failing: PipelineStage = () => ({
      goal: "g",
      provider: scriptedProvider([{ failWith: fatal("model.bad_request", "400") }]),
      deps: deps(),
    });
    const result = await pipeline({
      id: "f",
      start: "a",
      stages: { a: failing, b: say("never") },
      next: () => "b",
    });
    assert.equal(result.status, "failed");
    assert.equal(result.handoffs.length, 1);
  });

  test("routing to a stage that does not exist is a programming error", async () => {
    await assert.rejects(
      pipeline({ id: "x", start: "a", stages: { a: say("hi") }, next: () => "nope" }),
      /no stage named "nope"/,
    );
  });

  test("verifyPipeline catches a tampered ledger and a broken link", async () => {
    const result = await pipeline({
      id: "wf",
      start: "plan",
      stages: { plan: say("p"), build: say("b") },
      next: (h) => (h.stage === "plan" ? "build" : null),
    });
    const [first, second] = result.handoffs;
    assert.ok(first && second);
    const tampered = {
      ...result,
      handoffs: [
        { ...first, ledger: { ...first.ledger, goal: "edited" } },
        { ...second, parentRunId: "someone-else" },
      ],
    };
    const problems = verifyPipeline(tampered).map((p) => `${p.seq}:${p.problem}`);
    assert.ok(problems.some((p) => p.startsWith("1:") && /digest/.test(p)), problems.join("\n"));
    assert.ok(problems.some((p) => p.startsWith("2:") && /parent/.test(p)), problems.join("\n"));
  });

  test("a suspended stage suspends the pipeline, and history continues it after the resume", async () => {
    const commit = tool("commit", "Commit.", { type: "object", properties: {} }, () => "committed", {
      requiresApproval: true,
    });
    const script = [{ say: "", callTools: [{ name: "commit", args: {} }] }, { say: "Committed." }];
    const ship: PipelineStage = () => ({
      goal: "ship it",
      provider: scriptedProvider(script),
      tools: createRegistry([commit]),
      deps: deps(),
    });
    const options = {
      id: "rel",
      start: "ship",
      stages: { ship, announce: say("announced") },
      next: (h: { stage: string }) => (h.stage === "ship" ? "announce" : null),
    };
    const paused = await pipeline(options);
    assert.equal(paused.status, "suspended");

    const last = paused.handoffs.at(-1);
    assert.ok(last);
    const resumed = await resume(last.ledger, {
      decision: { approved: true, by: "ana" },
      provider: scriptedProvider(script.slice(1)),
      tools: createRegistry([commit]),
      deps: deps(),
    });
    const done = await pipeline({ ...options, history: [...paused.handoffs.slice(0, -1), handoffOf(last, resumed)] });
    assert.equal(done.status, "completed");
    assert.deepEqual(done.handoffs.map((h) => h.stage), ["ship", "announce"]);
    assert.deepEqual(verifyPipeline(done), []);
  });

  test("the whole pipeline re-executes byte for byte from its recorded handoffs", async () => {
    const options = {
      id: "wf",
      start: "plan",
      stages: { plan: say("the plan"), build: say("built it") },
      next: (h: { stage: string }) => (h.stage === "plan" ? "build" : null),
    };
    const recorded = await pipeline(options);
    const replayed = await pipeline({
      ...options,
      stages: Object.fromEntries(
        Object.entries(options.stages).map(([name, stage]) => [
          name,
          async (input: Parameters<PipelineStage>[0]) => ({
            ...(await stage(input)),
            provider: replayProvider(recorded.handoffs[input.seq - 1]!.ledger),
          }),
        ]),
      ),
    });
    assert.deepEqual(
      replayed.handoffs.map((h) => serializeLedger(h.ledger)),
      recorded.handoffs.map((h) => serializeLedger(h.ledger)),
    );
  });
});
