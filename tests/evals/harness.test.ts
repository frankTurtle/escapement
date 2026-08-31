import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runCase, runSuite } from "../../src/evals/harness.ts";
import {
  callsTools,
  endsAs,
  editDistance,
  failsWith,
  grader,
  neverCalls,
  outputContains,
  replaysExactly,
  ToolMatch,
  trajectoryCloseTo,
  usageEquals,
  withinSteps,
} from "../../src/evals/graders.ts";
import type { EvalCase } from "../../src/evals/types.ts";
import { tool } from "../../src/tools/registry.ts";
import { transient } from "../../src/core/errors.ts";

const search = tool(
  "search",
  "search",
  { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  () => "hit",
  { readOnly: true },
);

const base = (overrides: Partial<EvalCase>): EvalCase => ({
  id: "case",
  goal: "goal",
  script: [{ say: "done" }],
  graders: [endsAs("completed")],
  ...overrides,
});

describe("running a case", () => {
  test("scores a passing case at 1", async () => {
    const result = await runCase(base({}));
    assert.equal(result.passed, true);
    assert.equal(result.score, 1);
    assert.equal(result.outcomeStatus, "completed");
  });

  test("is deterministic — same case, same fingerprint and score", async () => {
    const evalCase = base({
      script: [{ say: "", callTools: [{ name: "search", args: { q: "x" } }] }, { say: "done" }],
      tools: [search],
      graders: [endsAs("completed"), callsTools(["search"])],
    });
    const a = await runCase(evalCase);
    const b = await runCase(evalCase);
    assert.equal(a.fingerprint, b.fingerprint);
    assert.deepEqual(a.grades, b.grades);
  });

  test("a grader that throws fails the case rather than silently passing it", async () => {
    const broken = {
      id: "broken",
      grade: () => {
        throw new Error("bad grader");
      },
    };
    const result = await runCase(base({ graders: [broken] }));
    assert.equal(result.passed, false);
    assert.equal(result.score, 0);
    assert.match(result.grades[0]?.reason ?? "", /grader threw: bad grader/);
  });

  test("a harness failure is distinguishable from a badly performing agent", async () => {
    const result = await runCase(
      base({
        graders: [
          {
            id: "x",
            grade: () => {
              throw new Error("nope");
            },
          },
        ],
      }),
    );
    assert.equal(result.error, undefined, "a grader throwing is not a harness error");

    const exhausted = await runCase(base({ script: [] }));
    assert.equal(exhausted.outcomeStatus, "failed", "an empty script is a failed run, not a crashed harness");
  });

  test("grader weights shape the case score", async () => {
    const pass = grader("pass", () => ({ score: 1, passed: true, reason: "" }), 3);
    const fail = grader("fail", () => ({ score: 0, passed: false, reason: "" }), 1);
    const result = await runCase(base({ graders: [pass, fail] }));
    assert.equal(result.score, 0.75);
    assert.equal(result.passed, false, "a weighted score of 0.75 still fails if any grader failed");
  });
});

describe("graders discriminate", () => {
  test("endsAs fails when the run did not end that way", async () => {
    const result = await runCase(base({ script: [{ failWith: transient("x", "y") }], graders: [endsAs("completed")] }));
    assert.equal(result.passed, false);
  });

  test("outputContains fails on the wrong answer", async () => {
    const result = await runCase(base({ script: [{ say: "wrong" }], graders: [outputContains("right")] }));
    assert.equal(result.grades[0]?.passed, false);
  });

  test("neverCalls fails when the forbidden tool is used", async () => {
    const result = await runCase(
      base({
        script: [{ say: "", callTools: [{ name: "search", args: { q: "x" } }] }, { say: "done" }],
        tools: [search],
        graders: [neverCalls("search")],
      }),
    );
    assert.equal(result.grades[0]?.passed, false);
    assert.match(result.grades[0]?.reason ?? "", /forbidden/);
  });

  test("callsTools:subsequence scores partial credit", async () => {
    const result = await runCase(
      base({
        script: [{ say: "", callTools: [{ name: "search", args: { q: "x" } }] }, { say: "done" }],
        tools: [search],
        graders: [callsTools(["search", "lookup"], ToolMatch.Subsequence)],
      }),
    );
    assert.equal(result.grades[0]?.score, 0.5, "half the expected calls happened, in order");
    assert.equal(result.grades[0]?.passed, false);
  });

  test("withinSteps degrades rather than snapping to zero", async () => {
    const result = await runCase(
      base({
        script: [
          { say: "", callTools: [{ name: "search", args: { q: "a" } }] },
          { say: "", callTools: [{ name: "search", args: { q: "b" } }] },
          { say: "done" },
        ],
        tools: [search],
        graders: [withinSteps(2)],
      }),
    );
    const grade = result.grades[0];
    assert.equal(grade?.passed, false);
    assert.ok((grade?.score ?? 0) > 0 && (grade?.score ?? 0) < 1, `expected partial credit, got ${grade?.score}`);
  });

  test("usageEquals is exact, where withinSteps is only an upper bound", async () => {
    const evalCase = base({ graders: [withinSteps(5), usageEquals({ modelCalls: 5 })] });
    const result = await runCase(evalCase);
    assert.equal(result.grades[0]?.passed, true, "one call is within five");
    assert.equal(result.grades[1]?.passed, false, "one call is not exactly five");
  });

  test("failsWith distinguishes error codes", async () => {
    const result = await runCase(
      base({
        script: [{ failWith: transient("model.rate_limited", "429") }],
        budget: { maxModelAttempts: 1 },
        graders: [failsWith("model.retries_exhausted"), failsWith("something.else")],
      }),
    );
    assert.equal(result.grades[0]?.passed, true);
    assert.equal(result.grades[1]?.passed, false);
  });

  test("replaysExactly passes on every honest run", async () => {
    const result = await runCase(base({ graders: [replaysExactly()] }));
    assert.equal(result.grades[0]?.passed, true);
    assert.match(result.grades[0]?.reason ?? "", /entries replayed identically/);
  });

  test("trajectoryCloseTo turns a changed path into a magnitude", async () => {
    const result = await runCase(
      base({
        script: [{ say: "", callTools: [{ name: "search", args: { q: "x" } }] }, { say: "done" }],
        tools: [search],
        graders: [trajectoryCloseTo(["search", "search", "search"], 0.9)],
      }),
    );
    const grade = result.grades[0];
    assert.ok((grade?.score ?? 0) > 0.3 && (grade?.score ?? 0) < 0.9, `got ${grade?.score}`);
  });
});

describe("edit distance", () => {
  test("is zero for identical sequences", () => {
    assert.equal(editDistance(["a", "b"], ["a", "b"]), 0);
  });
  test("counts insertions, deletions and substitutions", () => {
    assert.equal(editDistance(["a"], ["a", "b"]), 1);
    assert.equal(editDistance(["a", "b"], ["a"]), 1);
    assert.equal(editDistance(["a", "b"], ["a", "c"]), 1);
    assert.equal(editDistance([], ["a", "b", "c"]), 3);
    assert.equal(editDistance(["a", "b", "c"], []), 3);
  });
});

describe("running a suite", () => {
  test("aggregates by case weight", async () => {
    const result = await runSuite({
      id: "s",
      cases: [
        base({ id: "heavy", weight: 3 }),
        base({ id: "light", weight: 1, script: [{ say: "x" }], graders: [outputContains("nope")] }),
      ],
    });
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.score, 0.75);
  });

  test("reports critical failures separately", async () => {
    const result = await runSuite({
      id: "s",
      cases: [base({ id: "must-hold", critical: true, graders: [outputContains("absent")] })],
    });
    assert.deepEqual(result.criticalFailures, ["must-hold"]);
  });

  test("an empty suite scores 1 rather than dividing by zero", async () => {
    const result = await runSuite({ id: "empty", cases: [] });
    assert.equal(result.score, 1);
  });
});
