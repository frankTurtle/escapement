export type { EvalCase, EvalSuite, Grader, Grade, GradeContext, CaseResult, SuiteResult } from "./types.ts";
export { runCase, runSuite } from "./harness.ts";

export {
  grader,
  endsAs,
  failsWith,
  outputContains,
  outputMatches,
  callsTools,
  neverCalls,
  visitsPhase,
  trajectoryCloseTo,
  withinSteps,
  withinToolCalls,
  withinTokens,
  withinCorrectiveTurns,
  withinRetries,
  usageEquals,
  contextWithinBudget,
  sectionNeverStarved,
  contextInvariant,
  replaysExactly,
  allToolCallsSucceeded,
  editDistance,
  ToolMatch,
} from "./graders.ts";
export type { ToolMatchMode } from "./graders.ts";

export { gate, toBaseline, emptyBaseline, BASELINE_VERSION, FindingKind } from "./baseline.ts";
export type { Baseline, BaselineCase, GateFinding, GateResult, GateOptions } from "./baseline.ts";

export { renderText, renderMarkdown, renderJson } from "./report.ts";
