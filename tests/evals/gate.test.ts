import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gate, toBaseline, emptyBaseline, FindingKind } from "../../src/evals/baseline.ts";
import { renderMarkdown, renderText } from "../../src/evals/report.ts";
import { ZERO_USAGE } from "../../src/orchestrator/state.ts";
import type { CaseResult, SuiteResult } from "../../src/evals/types.ts";

const caseResult = (overrides: Partial<CaseResult>): CaseResult => ({
  caseId: "c1",
  passed: true,
  score: 1,
  critical: false,
  weight: 1,
  grades: [],
  outcomeStatus: "completed",
  usage: ZERO_USAGE,
  fingerprint: "aaaa1111",
  tags: [],
  ...overrides,
});

const suiteResult = (cases: readonly CaseResult[]): SuiteResult => ({
  suiteId: "s",
  cases,
  score: cases.length === 0 ? 1 : cases.reduce((sum, c) => sum + c.score * c.weight, 0) / cases.reduce((s, c) => s + c.weight, 0),
  passed: cases.filter((c) => c.passed).length,
  failed: cases.filter((c) => !c.passed).length,
  criticalFailures: cases.filter((c) => c.critical && !c.passed).map((c) => c.caseId),
});

const kinds = (result: ReturnType<typeof gate>) => result.findings.map((f) => f.kind);
const errors = (result: ReturnType<typeof gate>) => result.findings.filter((f) => f.severity === "error");

describe("the gate blocks", () => {
  test("an unchanged suite", () => {
    const run = suiteResult([caseResult({})]);
    const outcome = gate(run, toBaseline(run));
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.findings, []);
  });

  test("a score regression beyond tolerance", () => {
    const before = suiteResult([caseResult({ score: 1 })]);
    const after = suiteResult([caseResult({ score: 0.8, passed: false })]);
    const outcome = gate(after, toBaseline(before));
    assert.equal(outcome.ok, false);
    assert.ok(kinds(outcome).includes(FindingKind.Regression));
    assert.match(errors(outcome)[0]?.message ?? "", /1\.000 → 0\.800/);
  });

  test("a regression within tolerance is allowed through", () => {
    const before = suiteResult([caseResult({ score: 1 })]);
    const after = suiteResult([caseResult({ score: 0.95 })]);
    const outcome = gate(after, toBaseline(before, 0.1));
    assert.equal(outcome.ok, true);
  });

  test("a critical case failing, even at the same score", () => {
    const before = suiteResult([caseResult({ critical: true, score: 0.5, passed: false })]);
    const baseline = toBaseline(before);
    const outcome = gate(before, baseline);
    assert.equal(outcome.ok, false);
    assert.ok(kinds(outcome).includes(FindingKind.CriticalFailure));
  });

  test("a case disappearing from the suite", () => {
    const before = suiteResult([caseResult({ caseId: "kept" }), caseResult({ caseId: "deleted" })]);
    const after = suiteResult([caseResult({ caseId: "kept" })]);
    const outcome = gate(after, toBaseline(before));
    assert.equal(outcome.ok, false);
    assert.ok(kinds(outcome).includes(FindingKind.MissingCase));
    assert.match(errors(outcome)[0]?.message ?? "", /Deleting coverage requires re-recording/);
  });

  test("many cases each slipping a little, which no per-case threshold can see", () => {
    // The mean drop can never exceed the largest per-case drop, so this check
    // only earns its place when the aggregate tolerance is tighter than the
    // per-case one. Here every case slips 0.1 — allowed individually — and the
    // suite mean slips 0.1, which is not.
    const before = suiteResult([caseResult({ caseId: "a" }), caseResult({ caseId: "b" })]);
    const after = suiteResult([
      caseResult({ caseId: "a", score: 0.9 }),
      caseResult({ caseId: "b", score: 0.9 }),
    ]);
    const lenientPerCase = toBaseline(before, 0.15, 0.05);
    const outcome = gate(after, lenientPerCase);
    assert.equal(outcome.ok, false);
    assert.deepEqual(kinds(outcome), [FindingKind.AggregateRegression]);
  });

  test("a shared tolerance makes the aggregate check redundant, and that is documented", () => {
    const before = suiteResult([caseResult({ caseId: "a" }), caseResult({ caseId: "b" })]);
    const after = suiteResult([
      caseResult({ caseId: "a", score: 0.9 }),
      caseResult({ caseId: "b", score: 0.9 }),
    ]);
    assert.equal(gate(after, toBaseline(before, 0.15, 0.15)).ok, true);
  });
});

describe("the gate does not block", () => {
  test("a new case", () => {
    const before = suiteResult([caseResult({ caseId: "old" })]);
    const after = suiteResult([caseResult({ caseId: "old" }), caseResult({ caseId: "new" })]);
    const outcome = gate(after, toBaseline(before));
    assert.equal(outcome.ok, true);
    assert.ok(kinds(outcome).includes(FindingKind.NewCase));
  });

  test("an improvement, but it says to lock it in at the next release", () => {
    const before = suiteResult([caseResult({ score: 0.5 })]);
    const after = suiteResult([caseResult({ score: 0.9 })]);
    const outcome = gate(after, toBaseline(before));
    assert.equal(outcome.ok, true);
    assert.ok(kinds(outcome).includes(FindingKind.Improvement));
    assert.match(outcome.findings[0]?.message ?? "", /Re-record the baseline/);
  });

  test("a trajectory change at the same score — by default", () => {
    const before = suiteResult([caseResult({ fingerprint: "aaaa1111" })]);
    const after = suiteResult([caseResult({ fingerprint: "bbbb2222" })]);
    const outcome = gate(after, toBaseline(before));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.findings[0]?.kind, FindingKind.TrajectoryDrift);
    assert.equal(outcome.findings[0]?.severity, "warning");
  });

  test("...unless strict trajectory checking is on", () => {
    const before = suiteResult([caseResult({ fingerprint: "aaaa1111" })]);
    const after = suiteResult([caseResult({ fingerprint: "bbbb2222" })]);
    const outcome = gate(after, toBaseline(before), { strictTrajectory: true });
    assert.equal(outcome.ok, false);
  });

  test("floating-point noise", () => {
    const before = suiteResult([caseResult({ score: 0.1 + 0.2 })]);
    const after = suiteResult([caseResult({ score: 0.3 })]);
    assert.notEqual(0.1 + 0.2, 0.3, "the premise of this test");
    assert.equal(gate(after, toBaseline(before)).ok, true);
  });
});

describe("baseline recording", () => {
  test("is sorted by case id, so diffs are readable", () => {
    const run = suiteResult([caseResult({ caseId: "zulu" }), caseResult({ caseId: "alpha" })]);
    assert.deepEqual(Object.keys(toBaseline(run).cases), ["alpha", "zulu"]);
  });

  test("rounds to six places, so noise does not churn the file", () => {
    const run = suiteResult([caseResult({ score: 1 / 3 })]);
    assert.equal(toBaseline(run).cases["c1"]?.score, 0.333333);
  });

  test("records criticality and fingerprint alongside the score", () => {
    const run = suiteResult([caseResult({ critical: true, fingerprint: "deadbeef" })]);
    const recorded = toBaseline(run).cases["c1"];
    assert.equal(recorded?.critical, true);
    assert.equal(recorded?.fingerprint, "deadbeef");
  });

  test("an empty baseline treats everything as new", () => {
    const run = suiteResult([caseResult({})]);
    const outcome = gate(run, emptyBaseline("s"));
    assert.equal(outcome.ok, true);
    assert.deepEqual(kinds(outcome), [FindingKind.NewCase]);
  });
});

describe("reports", () => {
  const before = suiteResult([caseResult({ caseId: "a" })]);
  const after = suiteResult([
    caseResult({
      caseId: "a",
      score: 0.4,
      passed: false,
      grades: [{ graderId: "ends-as:completed", score: 0, passed: false, reason: "expected completed, got failed" }],
    }),
  ]);

  test("text output names the failing graders", () => {
    const text = renderText(after);
    assert.match(text, /FAIL/);
    assert.match(text, /ends-as:completed: expected completed, got failed/);
  });

  test("markdown shows the delta against the baseline and refuses to suggest re-recording", () => {
    const markdown = renderMarkdown(gate(after, toBaseline(before)));
    assert.match(markdown, /Eval gate — failed/);
    assert.match(markdown, /-0\.600/);
    assert.match(markdown, /do not re-record to go green/);
  });

  test("markdown marks critical cases", () => {
    const critical = suiteResult([caseResult({ caseId: "c", critical: true })]);
    assert.match(renderMarkdown(gate(critical, toBaseline(critical))), /⚠️/);
  });
});
