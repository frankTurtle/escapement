import { digest, type JsonValue } from "../core/json.ts";
import { budgetExceeded, invariant, type EscapementError } from "../core/errors.ts";
import { replay, type RunLedger } from "./ledger.ts";
import type { Outcome } from "./state.ts";
import { run, type RunOptions, type RunResult } from "./runtime.ts";

/** One run in a pipeline, as the next stage and the audit trail see it (ADR-0020). */
export type Handoff = {
  /** 1-based position in the pipeline. */
  readonly seq: number;
  readonly stage: string;
  readonly runId: string;
  /** The previous handoff's run, or `null` for the first. */
  readonly parentRunId: string | null;
  readonly outcome: Outcome;
  readonly ledger: RunLedger;
  /** `digest()` of the ledger, so a stored handoff can be checked against it. */
  readonly ledgerDigest: string;
};

export type StageInput = {
  readonly pipelineId: string;
  readonly seq: number;
  readonly stage: string;
  /** Every earlier handoff, oldest first. */
  readonly prior: readonly Handoff[];
};

/** The options for one run. The pipeline supplies `runId` and `parentRunId`. */
export type StageRun = Omit<RunOptions, "runId" | "parentRunId">;

export type PipelineStage = (input: StageInput) => StageRun | Promise<StageRun>;

export type PipelineOptions = {
  readonly id: string;
  readonly start: string;
  readonly stages: Readonly<Record<string, PipelineStage>>;
  /** After each completed run: the next stage's name, or `null` to finish. */
  readonly next: (handoff: Handoff, prior: readonly Handoff[]) => string | null;
  /** Defaults to 8. Reaching it halts the pipeline. */
  readonly maxHandoffs?: number;
  /** Handoffs already made, to continue a pipeline, for example after
   *  resuming its suspended last run (see `handoffOf`). */
  readonly history?: readonly Handoff[];
};

export type PipelineStatus = "completed" | "failed" | "halted" | "suspended";

export type PipelineResult = {
  readonly id: string;
  readonly status: PipelineStatus;
  /** Why it did not complete, when it did not. */
  readonly reason?: EscapementError;
  readonly handoffs: readonly Handoff[];
};

const digestOf = (ledger: RunLedger): string => digest(ledger as unknown as JsonValue);

/** A handoff for `result`, in the slot `previous` held. Use it after a resume. */
export function handoffOf(previous: Handoff, result: RunResult): Handoff {
  invariant(result.ledger.runId === previous.runId, "a handoff can only be replaced by the same run", {
    expected: previous.runId,
    got: result.ledger.runId,
  });
  return { ...previous, outcome: result.outcome, ledger: result.ledger, ledgerDigest: digestOf(result.ledger) };
}

/**
 * Run agents in sequence, each run linked to the one before (ADR-0020).
 *
 * Stages build their run from the earlier handoffs; `next` picks the stage
 * that follows. A run that does not complete stops the pipeline with its
 * status. Each run is an ordinary run with an ordinary ledger, so replay,
 * re-execution, evals and approval all apply per handoff.
 */
export async function pipeline(options: PipelineOptions): Promise<PipelineResult> {
  const maxHandoffs = options.maxHandoffs ?? 8;
  const handoffs: Handoff[] = [...(options.history ?? [])];
  const finish = (status: PipelineStatus, reason?: EscapementError): PipelineResult => ({
    id: options.id,
    status,
    ...(reason ? { reason } : {}),
    handoffs,
  });

  let stage: string | null = options.start;
  const last = handoffs.at(-1);
  if (last !== undefined) {
    if (last.outcome.status !== "completed") return stopped(last, finish);
    stage = options.next(last, handoffs.slice(0, -1));
  }

  while (stage !== null) {
    if (handoffs.length >= maxHandoffs) {
      return finish(
        "halted",
        budgetExceeded("pipeline.max_handoffs", `The pipeline reached ${maxHandoffs} handoff(s) without finishing.`, {
          limit: maxHandoffs,
          next: stage,
        }),
      );
    }
    const build = options.stages[stage];
    invariant(build !== undefined, `no stage named "${stage}"`, { stages: Object.keys(options.stages) });

    const seq = handoffs.length + 1;
    const runId = `${options.id}-${seq}-${stage}`;
    const parentRunId = handoffs.at(-1)?.runId ?? null;
    const spec = await build({ pipelineId: options.id, seq, stage, prior: [...handoffs] });
    const result = await run({
      seed: runId,
      ...spec,
      runId,
      ...(parentRunId !== null ? { parentRunId } : {}),
    });

    const handoff: Handoff = {
      seq,
      stage,
      runId,
      parentRunId,
      outcome: result.outcome,
      ledger: result.ledger,
      ledgerDigest: digestOf(result.ledger),
    };
    const prior = [...handoffs];
    handoffs.push(handoff);
    if (handoff.outcome.status !== "completed") return stopped(handoff, finish);
    stage = options.next(handoff, prior);
  }

  return finish("completed");
}

function stopped(
  handoff: Handoff,
  finish: (status: PipelineStatus, reason?: EscapementError) => PipelineResult,
): PipelineResult {
  const outcome = handoff.outcome;
  if (outcome.status === "failed" || outcome.status === "halted") return finish(outcome.status, outcome.error);
  return finish("suspended");
}

export type PipelineProblem = { readonly seq: number; readonly problem: string };

/**
 * Check every link in a pipeline (ADR-0020). Empty means sound.
 *
 * Use it on a pipeline read back from storage: it catches an edited ledger, a
 * handoff moved out of order, and a ledger swapped for another run's.
 */
export function verifyPipeline(result: PipelineResult): readonly PipelineProblem[] {
  const problems: PipelineProblem[] = [];
  result.handoffs.forEach((h, i) => {
    const bad = (problem: string): void => void problems.push({ seq: h.seq, problem });
    const expectedParent = i === 0 ? null : (result.handoffs[i - 1]?.runId ?? null);
    if (h.seq !== i + 1) bad(`sequence number ${h.seq} where ${i + 1} was expected`);
    if (h.parentRunId !== expectedParent) bad(`parent is ${h.parentRunId ?? "none"}, expected ${expectedParent ?? "none"}`);
    if (h.ledger.runId !== h.runId) bad(`ledger belongs to ${h.ledger.runId}, not ${h.runId}`);
    if ((h.ledger.parentRunId ?? null) !== h.parentRunId) bad("ledger parent does not match the handoff's parent");
    if (h.ledgerDigest !== digestOf(h.ledger)) bad("ledger digest does not match the ledger");
    if (!replay(h.ledger).ok) bad("ledger does not replay");
  });
  return problems;
}
