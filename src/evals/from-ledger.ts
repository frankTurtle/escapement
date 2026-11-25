import type { ToolDefinition } from "../tools/registry.ts";
import type { ContextAssembler } from "../orchestrator/assembler.ts";
import type { RunLedger } from "../orchestrator/ledger.ts";
import { recordedTools, scriptFromLedger } from "../orchestrator/reexecute.ts";
import type { EvalCase, Grader } from "./types.ts";

export type CaseFromLedgerOptions = {
  /** Defaults to the ledger's run id. */
  readonly id?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /** The original tool definitions. Their handlers are replaced with the
   *  recorded results; schemas, descriptions and `readOnly` are kept. */
  readonly tools?: readonly ToolDefinition[];
  /** The assembler the run used. Without it the case uses the passthrough
   *  assembler, which changes token counts but not the trajectory. */
  readonly assembler?: ContextAssembler;
  readonly critical?: boolean;
  readonly weight?: number;
};

/**
 * An eval case built from a recorded run (ADR-0018).
 *
 * The script is the run's model turns, failures and call ids included; the
 * tools answer with what the run saw; the budget and retry policy are the
 * ones the run had. A run that misbehaved in production becomes a permanent,
 * offline regression case in one call.
 */
export function caseFromLedger(
  ledger: RunLedger,
  graders: readonly Grader[],
  options: CaseFromLedgerOptions = {},
): EvalCase {
  return {
    id: options.id ?? ledger.runId,
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
    goal: ledger.goal,
    script: scriptFromLedger(ledger),
    onScriptExhausted: "fail",
    tools: recordedTools(ledger, options.tools),
    ...(options.assembler ? { assembler: options.assembler } : {}),
    budget: ledger.config.budget,
    retry: ledger.config.retry,
    graders,
    ...(options.critical !== undefined ? { critical: options.critical } : {}),
    ...(options.weight !== undefined ? { weight: options.weight } : {}),
  };
}
