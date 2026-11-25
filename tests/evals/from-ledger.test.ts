import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { run } from "../../src/orchestrator/runtime.ts";
import { scriptedProvider } from "../../src/providers/scripted.ts";
import { createRegistry, tool } from "../../src/tools/registry.ts";
import type { ObjectSchema } from "../../src/tools/schema.ts";
import { manualClock } from "../../src/core/clock.ts";
import { transient } from "../../src/core/errors.ts";
import { caseFromLedger } from "../../src/evals/from-ledger.ts";
import { runCase } from "../../src/evals/harness.ts";
import { callsTools, endsAs, outputContains, replaysExactly, ToolMatch, usageEquals } from "../../src/evals/graders.ts";

const q: ObjectSchema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
let liveCalls = 0;
const search = tool(
  "search",
  "Search.",
  q,
  (args) => {
    liveCalls += 1;
    return `hits for ${String(args["q"])}`;
  },
  { readOnly: true },
);

async function recordProductionRun() {
  return run({
    goal: "what is a ledger?",
    provider: scriptedProvider([
      { say: "", callTools: [{ id: "toolu_1", name: "search", args: { q: "ledger" } }] },
      { failWith: transient("model.overloaded", "529") },
      { say: "A ledger is the record of a run." },
    ]),
    tools: createRegistry([search]),
    config: { budget: { maxSteps: 5 } },
    deps: { clock: manualClock(1_700_000_000_000) },
  });
}

describe("caseFromLedger", () => {
  test("a recorded run becomes an eval case that passes with no live tool calls", async () => {
    const { ledger } = await recordProductionRun();
    const before = liveCalls;
    const evalCase = caseFromLedger(
      ledger,
      [
        endsAs("completed"),
        outputContains("record of a run"),
        callsTools(["search"], ToolMatch.Exact),
        usageEquals({ modelCalls: 2, retries: 1 }),
        replaysExactly(),
      ],
      { id: "prod-ledger-question", tools: [search], tags: ["from-production"] },
    );

    assert.equal(evalCase.id, "prod-ledger-question");
    assert.equal(evalCase.goal, "what is a ledger?");
    assert.equal(evalCase.budget?.maxSteps, 5, "the budget the run had is the budget the case has");
    assert.deepEqual(evalCase.tags, ["from-production"]);

    const result = await runCase(evalCase);
    assert.equal(result.passed, true, JSON.stringify(result.grades.filter((g) => !g.passed)));
    assert.equal(liveCalls, before, "recorded results answered; the live handler never ran");
  });

  test("the id defaults to the ledger's run id, and tools can be left out", async () => {
    const { ledger } = await recordProductionRun();
    const evalCase = caseFromLedger(ledger, [endsAs("completed")]);
    assert.equal(evalCase.id, ledger.runId);
    const result = await runCase(evalCase);
    assert.equal(result.passed, true);
  });
});
