import type { CaseResult, SuiteResult } from "./types.ts";

export const BASELINE_VERSION = 1;

export type BaselineCase = {
  readonly score: number;
  readonly passed: boolean;
  readonly critical: boolean;
  /** Shape of the trajectory. Changes here mean the agent took a different
   *  path, even when the score did not move. */
  readonly fingerprint: string;
};

export type Baseline = {
  readonly version: number;
  readonly suiteId: string;
  /** Score drop tolerated per case. Default 0: any drop is a regression.
   *  Floating-point noise is handled by EPSILON, not by slack. */
  readonly tolerance: number;
  /**
   * Score drop tolerated in the suite mean. Defaults to `tolerance`, at which
   * point it is mathematically redundant — the mean drop can never exceed the
   * largest per-case drop. It earns its place only when set *tighter*, which
   * catches the pattern a per-case threshold is structurally blind to: many
   * cases each slipping a little.
   */
  readonly aggregateTolerance?: number;
  readonly aggregate: { readonly score: number; readonly passed: number; readonly failed: number };
  readonly cases: Readonly<Record<string, BaselineCase>>;
};

export const FindingKind = {
  Regression: "regression",
  AggregateRegression: "aggregate-regression",
  CriticalFailure: "critical-failure",
  MissingCase: "missing-case",
  NewCase: "new-case",
  TrajectoryDrift: "trajectory-drift",
  Improvement: "improvement",
} as const;

export type FindingKind = (typeof FindingKind)[keyof typeof FindingKind];

export type GateFinding = {
  readonly kind: FindingKind;
  readonly severity: "error" | "warning" | "info";
  readonly caseId?: string;
  readonly message: string;
};

export type GateOptions = {
  /** Treat a changed trajectory fingerprint as a failure even when the score
   *  held. Off by default — see ADR-0012 for why this is a warning. */
  readonly strictTrajectory?: boolean;
};

export type GateResult = {
  readonly ok: boolean;
  readonly findings: readonly GateFinding[];
  readonly result: SuiteResult;
  readonly baseline: Baseline;
};

/** Comparisons are float-vs-float; this is noise tolerance, not score slack. */
const EPSILON = 1e-9;

/**
 * Compare a suite run against the recorded baseline (ADR-0012).
 *
 * Errors fail the build. Warnings are reported and do not.
 */
export function gate(result: SuiteResult, baseline: Baseline, options: GateOptions = {}): GateResult {
  const findings: GateFinding[] = [];
  const tolerance = baseline.tolerance;
  const byId = new Map<string, CaseResult>(result.cases.map((c) => [c.caseId, c]));

  for (const [caseId, recorded] of Object.entries(baseline.cases)) {
    const current = byId.get(caseId);

    if (!current) {
      // Deleting a case is a legitimate thing to do — on a release branch,
      // where the baseline is re-recorded. Silently dropping coverage is not.
      findings.push({
        kind: FindingKind.MissingCase,
        severity: "error",
        caseId,
        message: `Case "${caseId}" is in the baseline but was not run. Deleting coverage requires re-recording the baseline on a release branch.`,
      });
      continue;
    }

    if (current.critical && !current.passed) {
      findings.push({
        kind: FindingKind.CriticalFailure,
        severity: "error",
        caseId,
        message: `Critical case "${caseId}" failed: ${failureSummary(current)}`,
      });
    }

    const drop = recorded.score - current.score;
    if (drop > tolerance + EPSILON) {
      findings.push({
        kind: FindingKind.Regression,
        severity: "error",
        caseId,
        message: `"${caseId}" regressed ${recorded.score.toFixed(3)} → ${current.score.toFixed(3)} (drop ${drop.toFixed(3)} exceeds tolerance ${tolerance}). ${failureSummary(current)}`,
      });
    } else if (current.score > recorded.score + EPSILON) {
      findings.push({
        kind: FindingKind.Improvement,
        severity: "info",
        caseId,
        message: `"${caseId}" improved ${recorded.score.toFixed(3)} → ${current.score.toFixed(3)}. Re-record the baseline on the next release branch to lock it in.`,
      });
    }

    if (current.fingerprint !== recorded.fingerprint && drop <= tolerance + EPSILON) {
      findings.push({
        kind: FindingKind.TrajectoryDrift,
        severity: options.strictTrajectory ? "error" : "warning",
        caseId,
        message: `"${caseId}" scored the same but took a different path (${recorded.fingerprint} → ${current.fingerprint}). Worth a look: same destination, different route.`,
      });
    }
  }

  for (const current of result.cases) {
    if (!(current.caseId in baseline.cases)) {
      findings.push({
        kind: FindingKind.NewCase,
        severity: "warning",
        caseId: current.caseId,
        message: `"${current.caseId}" is new and has no baseline entry (scored ${current.score.toFixed(3)}). It will be recorded at the next release.`,
      });
    }
  }

  const aggregateTolerance = baseline.aggregateTolerance ?? baseline.tolerance;
  const aggregateDrop = baseline.aggregate.score - result.score;
  if (aggregateDrop > aggregateTolerance + EPSILON) {
    findings.push({
      kind: FindingKind.AggregateRegression,
      severity: "error",
      message: `Suite score regressed ${baseline.aggregate.score.toFixed(3)} → ${result.score.toFixed(3)} (drop ${aggregateDrop.toFixed(3)} exceeds the aggregate tolerance ${aggregateTolerance}). No single case tripped its own threshold; the suite slipped as a whole.`,
    });
  }

  return { ok: !findings.some((f) => f.severity === "error"), findings, result, baseline };
}

/** Record the current run as the new baseline. Only legal on a release branch. */
export function toBaseline(
  result: SuiteResult,
  tolerance = 0,
  aggregateTolerance: number = tolerance,
): Baseline {
  const cases: Record<string, BaselineCase> = {};
  for (const c of [...result.cases].sort((a, b) => (a.caseId < b.caseId ? -1 : 1))) {
    cases[c.caseId] = {
      score: round(c.score),
      passed: c.passed,
      critical: c.critical,
      fingerprint: c.fingerprint,
    };
  }
  return {
    version: BASELINE_VERSION,
    suiteId: result.suiteId,
    tolerance,
    aggregateTolerance,
    aggregate: { score: round(result.score), passed: result.passed, failed: result.failed },
    cases,
  };
}

export function emptyBaseline(suiteId: string, tolerance = 0): Baseline {
  return {
    version: BASELINE_VERSION,
    suiteId,
    tolerance,
    aggregateTolerance: tolerance,
    aggregate: { score: 0, passed: 0, failed: 0 },
    cases: {},
  };
}

/** Six decimal places: enough to catch a real movement, few enough to diff. */
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

function failureSummary(result: CaseResult): string {
  if (result.error) return `harness error: ${result.error}`;
  const failed = result.grades.filter((g) => !g.passed);
  if (failed.length === 0) return "no grader failed; the score moved without a pass/fail change.";
  return failed.map((g) => `${g.graderId}: ${g.reason}`).join("; ");
}
