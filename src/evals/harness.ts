import { manualClock } from "../core/clock.ts";
import { seededRng } from "../core/rng.ts";
import { sequentialIds } from "../core/ids.ts";
import { toEscapementError } from "../core/errors.ts";
import { scriptedProvider } from "../providers/scripted.ts";
import { createRegistry } from "../tools/registry.ts";
import { run } from "../orchestrator/runtime.ts";
import { trajectoryFingerprint } from "../orchestrator/ledger.ts";
import { ZERO_USAGE } from "../orchestrator/state.ts";
import type { CaseResult, EvalCase, EvalSuite, Grade, SuiteResult } from "./types.ts";

/**
 * Run one case (ADR-0013).
 *
 * Every source of variance is nailed down: a manual clock starting at zero, an
 * RNG seeded from the case id, sequential ids, and a scripted model. Two
 * executions of the same case therefore produce byte-identical ledgers, which
 * is the precondition for comparing scores across commits at all.
 */
export async function runCase(evalCase: EvalCase): Promise<CaseResult> {
  const base = {
    caseId: evalCase.id,
    critical: evalCase.critical === true,
    weight: evalCase.weight ?? 1,
    tags: evalCase.tags ?? [],
  };

  try {
    const { ledger, outcome } = await run({
      goal: evalCase.goal,
      runId: `run-${evalCase.id}`,
      seed: evalCase.id,
      provider: scriptedProvider(evalCase.script, {
        onExhausted: evalCase.onScriptExhausted ?? "fail",
      }),
      tools: createRegistry(evalCase.tools ?? []),
      ...(evalCase.assembler ? { assembler: evalCase.assembler } : {}),
      deps: { clock: manualClock(0), rng: seededRng(evalCase.id), ids: sequentialIds() },
      config: {
        ...(evalCase.budget ? { budget: evalCase.budget } : {}),
        ...(evalCase.retry ? { retry: evalCase.retry } : {}),
      },
    });

    const context = { ledger, outcome, evalCase };
    const grades: Grade[] = evalCase.graders.map((g) => {
      try {
        return g.grade(context);
      } catch (thrown) {
        // A grader that throws is a broken grader, and it must not be able to
        // silently pass the case it was supposed to judge.
        return {
          graderId: g.id,
          score: 0,
          passed: false,
          reason: `grader threw: ${toEscapementError(thrown, g.id).message}`,
        };
      }
    });

    return {
      ...base,
      passed: grades.every((g) => g.passed),
      score: weightedMean(grades, evalCase),
      grades,
      outcomeStatus: outcome.status,
      usage: ledger.usage,
      fingerprint: trajectoryFingerprint(ledger),
    };
  } catch (thrown) {
    // The harness itself fell over. Scoring zero is right, but the distinction
    // between "the agent did badly" and "the suite is broken" has to survive
    // into the report.
    return {
      ...base,
      passed: false,
      score: 0,
      grades: [],
      outcomeStatus: "failed",
      usage: ZERO_USAGE,
      fingerprint: "",
      error: toEscapementError(thrown, "harness").message,
    };
  }
}

export async function runSuite(suite: EvalSuite): Promise<SuiteResult> {
  const cases: CaseResult[] = [];
  // Sequential on purpose: cases are cheap, and a stable execution order keeps
  // the report diffable.
  for (const evalCase of suite.cases) cases.push(await runCase(evalCase));

  const totalWeight = cases.reduce((sum, c) => sum + c.weight, 0);
  const score = totalWeight === 0 ? 1 : cases.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight;

  return {
    suiteId: suite.id,
    cases,
    score,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
    criticalFailures: cases.filter((c) => c.critical && !c.passed).map((c) => c.caseId),
  };
}

function weightedMean(grades: readonly Grade[], evalCase: EvalCase): number {
  if (grades.length === 0) return 0;
  const weights = evalCase.graders.map((g) => g.weight ?? 1);
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total === 0) return 0;
  const sum = grades.reduce((acc, g, i) => acc + g.score * (weights[i] ?? 1), 0);
  return sum / total;
}
