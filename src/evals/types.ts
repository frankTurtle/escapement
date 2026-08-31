import type { JsonObject } from "../core/json.ts";
import type { ToolDefinition } from "../tools/registry.ts";
import type { ScriptedTurn } from "../providers/scripted.ts";
import type { ContextAssembler } from "../orchestrator/assembler.ts";
import type { Budget, Outcome, RetryPolicy, Usage } from "../orchestrator/state.ts";
import type { RunLedger } from "../orchestrator/ledger.ts";

/** Everything a grader is allowed to look at. Note: no live anything. */
export type GradeContext = {
  readonly ledger: RunLedger;
  readonly outcome: Outcome;
  readonly evalCase: EvalCase;
};

export type Grade = {
  readonly graderId: string;
  /** 0..1. Continuous on purpose — a binary pass/fail cannot express "it still
   *  works but it now takes two extra tool calls", which is the movement a
   *  regression gate most needs to see. */
  readonly score: number;
  readonly passed: boolean;
  readonly reason: string;
  readonly detail?: JsonObject;
};

/**
 * A pure function from a recorded run to a score (ADR-0013).
 *
 * Graders never call a model, never touch the network, and never look at
 * anything but the ledger. That is what makes the suite fast, hermetic, and
 * able to run on every pull request.
 */
export type Grader = {
  readonly id: string;
  /** Relative weight within the case. Defaults to 1. */
  readonly weight?: number;
  grade(context: GradeContext): Grade;
};

export type EvalCase = {
  readonly id: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly goal: string;
  /** The model's scripted turns. Deterministic by construction (ADR-0014). */
  readonly script: readonly ScriptedTurn[];
  readonly onScriptExhausted?: "fail" | "repeat-last";
  readonly tools?: readonly ToolDefinition[];
  readonly assembler?: ContextAssembler;
  readonly budget?: Partial<Budget>;
  readonly retry?: Partial<RetryPolicy>;
  readonly graders: readonly Grader[];
  /**
   * A case whose failure fails the gate outright, whatever the scores did.
   * Reserve it for the properties that must never regress: budgets are
   * enforced, fatal errors are not retried, runs replay exactly.
   */
  readonly critical?: boolean;
  /** Relative weight in the suite aggregate. Defaults to 1. */
  readonly weight?: number;
};

export type EvalSuite = {
  readonly id: string;
  readonly description?: string;
  readonly cases: readonly EvalCase[];
};

export type CaseResult = {
  readonly caseId: string;
  readonly passed: boolean;
  readonly score: number;
  readonly critical: boolean;
  readonly weight: number;
  readonly grades: readonly Grade[];
  readonly outcomeStatus: Outcome["status"];
  readonly usage: Usage;
  /** Shape of the trajectory: phases and tool names. Content-independent. */
  readonly fingerprint: string;
  readonly tags: readonly string[];
  /** Present only when the harness itself failed to run the case. */
  readonly error?: string;
};

export type SuiteResult = {
  readonly suiteId: string;
  readonly cases: readonly CaseResult[];
  readonly score: number;
  readonly passed: number;
  readonly failed: number;
  readonly criticalFailures: readonly string[];
};
