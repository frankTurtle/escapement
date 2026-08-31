import { canonicalJson, digest, type JsonValue } from "../core/json.ts";
import { invariant } from "../core/errors.ts";
import type { EffectKind } from "./effects.ts";
import type { RunEvent } from "./events.ts";
import { Phase, isTerminal, type EventType } from "./phases.ts";
import { reduce } from "./reducer.ts";
import { initialState, type Outcome, type RunConfig, type RunState, type Usage } from "./state.ts";

export const LEDGER_VERSION = 1;

/** One transition. The unit of everything the eval harness grades. */
export type LedgerEntry = {
  readonly seq: number;
  readonly at: number;
  readonly from: Phase;
  readonly to: Phase;
  readonly event: RunEvent;
  readonly effects: readonly EffectKind[];
};

/**
 * The complete, append-only record of a run (ADR-0007).
 *
 * This is the artifact. Not the output string — the ledger. It is JSON, it is
 * self-contained, and feeding its events back through the reducer reproduces
 * the run exactly. Everything downstream (graders, diffs, regression gates,
 * bug reports) reads this and nothing else.
 */
export type RunLedger = {
  readonly version: number;
  readonly runId: string;
  readonly goal: string;
  readonly seed: string;
  readonly config: RunConfig;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly finalPhase: Phase;
  readonly usage: Usage;
  readonly outcome: Outcome | null;
  readonly entries: readonly LedgerEntry[];
};

export type Recorder = {
  record(entry: Omit<LedgerEntry, "seq">): LedgerEntry;
  readonly entries: readonly LedgerEntry[];
};

export function createRecorder(onEntry?: (entry: LedgerEntry) => void): Recorder {
  const entries: LedgerEntry[] = [];
  return {
    entries,
    record: (partial) => {
      const entry: LedgerEntry = { seq: entries.length + 1, ...partial };
      entries.push(entry);
      onEntry?.(entry);
      return entry;
    },
  };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export type Divergence = {
  readonly seq: number;
  readonly event: EventType;
  readonly recorded: Phase;
  readonly replayed: Phase;
};

export type ReplayResult = {
  readonly ok: boolean;
  readonly state: RunState;
  readonly divergence: Divergence | null;
  readonly entriesReplayed: number;
};

/**
 * Re-run a ledger through the reducer and check it lands in the same places.
 *
 * This is the test that keeps every determinism claim in the project honest. It
 * runs in the eval suite over every recorded trajectory, so a change that makes
 * the reducer depend on anything other than (state, event, config) fails CI
 * with the exact sequence number where the two histories parted.
 */
export function replay(ledger: RunLedger, config: RunConfig = ledger.config): ReplayResult {
  let state = initialState(ledger.runId, ledger.goal, ledger.startedAt);
  let replayed = 0;

  for (const entry of ledger.entries) {
    if (isTerminal(state.phase)) {
      return {
        ok: false,
        state,
        divergence: { seq: entry.seq, event: entry.event.type, recorded: entry.to, replayed: state.phase },
        entriesReplayed: replayed,
      };
    }
    const transition = reduce(state, entry.event, config);
    state = transition.state;
    replayed += 1;
    if (state.phase !== entry.to) {
      return {
        ok: false,
        state,
        divergence: { seq: entry.seq, event: entry.event.type, recorded: entry.to, replayed: state.phase },
        entriesReplayed: replayed,
      };
    }
  }

  return { ok: state.phase === ledger.finalPhase, state, divergence: null, entriesReplayed: replayed };
}

// ---------------------------------------------------------------------------
// Projections — the shapes graders actually want
// ---------------------------------------------------------------------------

/** `init->assemble`, `assemble->model`, ... One string per transition. */
export function phaseTrace(ledger: RunLedger): readonly string[] {
  return ledger.entries.map((e) => `${e.from}->${e.to}`);
}

/** Just the phases visited, deduplicated consecutively. */
export function phasePath(ledger: RunLedger): readonly Phase[] {
  const path: Phase[] = [];
  for (const entry of ledger.entries) {
    if (path[path.length - 1] !== entry.to) path.push(entry.to);
  }
  return path;
}

/** Tool names in the order they were called. The workhorse projection. */
export function toolSequence(ledger: RunLedger): readonly string[] {
  const names: string[] = [];
  for (const entry of ledger.entries) {
    if (entry.event.type === "tools.completed") {
      for (const result of entry.event.results) names.push(result.call.name);
    }
  }
  return names;
}

export type ToolCallRecord = {
  readonly name: string;
  readonly args: Readonly<Record<string, JsonValue>>;
  readonly ok: boolean;
  readonly content: string;
  readonly errorCode: string | null;
};

export function toolCalls(ledger: RunLedger): readonly ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  for (const entry of ledger.entries) {
    if (entry.event.type === "tools.completed") {
      for (const r of entry.event.results) {
        calls.push({
          name: r.call.name,
          args: r.call.args,
          ok: r.ok,
          content: r.content,
          errorCode: r.error?.code ?? null,
        });
      }
    }
  }
  return calls;
}

/** Everything the model was asked to look at, per step. */
export function contextReports(ledger: RunLedger): readonly JsonValue[] {
  const reports: JsonValue[] = [];
  for (const entry of ledger.entries) {
    if (entry.event.type === "context.assembled" && entry.event.context.report !== undefined) {
      reports.push(entry.event.context.report);
    }
  }
  return reports;
}

export const elapsedMs = (ledger: RunLedger): number => ledger.finishedAt - ledger.startedAt;

/**
 * A stable fingerprint of the *shape* of a run: phases and tool names, not
 * timings or content. Two runs with the same fingerprint took the same path.
 */
export function trajectoryFingerprint(ledger: RunLedger): string {
  return digest([...phaseTrace(ledger), "|", ...toolSequence(ledger)]);
}

export function serializeLedger(ledger: RunLedger): string {
  return canonicalJson(ledger as unknown as JsonValue);
}

export function parseLedger(text: string): RunLedger {
  const parsed = JSON.parse(text) as RunLedger;
  invariant(parsed.version === LEDGER_VERSION, "unsupported ledger version", parsed.version ?? null);
  return parsed;
}
