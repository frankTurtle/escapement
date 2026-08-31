import type { JsonObject } from "../core/json.ts";
import {
  contextReports,
  phasePath,
  replay,
  toolCalls,
  toolSequence,
} from "../orchestrator/ledger.ts";
import type { Outcome, Usage } from "../orchestrator/state.ts";
import type { Grade, GradeContext, Grader } from "./types.ts";

/** What a grader body returns: a grade without the id, which the helper fills in. */
type GradeBody = Omit<Grade, "graderId">;

const isThenable = (value: unknown): value is PromiseLike<GradeBody> =>
  typeof (value as { then?: unknown } | null)?.then === "function";

/**
 * Build a grader from a plain function. The escape hatch for anything bespoke.
 *
 * `fn` may be async (ADR-0017). The synchronous path stays synchronous rather
 * than being wrapped in a resolved promise: every grader below takes it, and
 * they should not start suspending because one hypothetical judge might.
 */
export function grader(
  id: string,
  fn: (context: GradeContext) => GradeBody | Promise<GradeBody>,
  weight?: number,
): Grader {
  return {
    id,
    ...(weight === undefined ? {} : { weight }),
    grade: (context) => {
      const body = fn(context);
      return isThenable(body) ? Promise.resolve(body).then((b) => ({ graderId: id, ...b })) : { graderId: id, ...body };
    },
  };
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export function endsAs(status: Outcome["status"]): Grader {
  return grader(`ends-as:${status}`, ({ outcome }) => {
    const ok = outcome.status === status;
    return {
      score: ok ? 1 : 0,
      passed: ok,
      reason: ok ? `run ended as ${status}` : `expected ${status}, got ${outcome.status}`,
    };
  });
}

export function failsWith(code: string): Grader {
  return grader(`fails-with:${code}`, ({ outcome }) => {
    const actual = outcome.status === "completed" ? null : outcome.error.code;
    const ok = actual === code;
    return {
      score: ok ? 1 : 0,
      passed: ok,
      reason: ok ? `ended with ${code}` : `expected error ${code}, got ${actual ?? "completion"}`,
    };
  });
}

export function outputContains(needle: string): Grader {
  return grader(`output-contains:${needle}`, ({ outcome }) => {
    const output = outcome.status === "completed" ? outcome.output : "";
    const ok = output.includes(needle);
    return { score: ok ? 1 : 0, passed: ok, reason: ok ? "found" : `output did not contain "${needle}"` };
  });
}

export function outputMatches(pattern: RegExp): Grader {
  return grader(`output-matches:${pattern.source}`, ({ outcome }) => {
    const output = outcome.status === "completed" ? outcome.output : "";
    const ok = pattern.test(output);
    return { score: ok ? 1 : 0, passed: ok, reason: ok ? "matched" : `output did not match ${pattern}` };
  });
}

// ---------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------

export const ToolMatch = { Exact: "exact", Subsequence: "subsequence", Set: "set" } as const;
export type ToolMatchMode = (typeof ToolMatch)[keyof typeof ToolMatch];

/**
 * Did the agent use the tools we expected, in the shape we expected?
 *
 * `subsequence` is usually the right mode. `exact` over-specifies: it fails on a
 * harmless extra lookup, and a suite that fails on harmless changes gets its
 * baseline re-recorded until it means nothing.
 */
export function callsTools(expected: readonly string[], mode: ToolMatchMode = ToolMatch.Subsequence): Grader {
  return grader(`calls-tools:${mode}:${expected.join(">")}`, ({ ledger }) => {
    const actual = toolSequence(ledger);
    const detail: JsonObject = { expected: [...expected], actual: [...actual] };

    if (mode === ToolMatch.Exact) {
      const ok = actual.length === expected.length && actual.every((name, i) => name === expected[i]);
      return { score: ok ? 1 : 0, passed: ok, reason: ok ? "exact match" : "tool sequence differs", detail };
    }
    if (mode === ToolMatch.Set) {
      const seen = new Set(actual);
      const missing = expected.filter((name) => !seen.has(name));
      const score = expected.length === 0 ? 1 : (expected.length - missing.length) / expected.length;
      return {
        score,
        passed: missing.length === 0,
        reason: missing.length === 0 ? "all expected tools used" : `never called: ${missing.join(", ")}`,
        detail,
      };
    }

    let cursor = 0;
    for (const name of actual) if (name === expected[cursor]) cursor += 1;
    const score = expected.length === 0 ? 1 : cursor / expected.length;
    return {
      score,
      passed: cursor === expected.length,
      reason:
        cursor === expected.length
          ? "expected calls appear in order"
          : `matched ${cursor} of ${expected.length} expected calls in order`,
      detail,
    };
  });
}

export function neverCalls(...names: readonly string[]): Grader {
  return grader(`never-calls:${names.join(",")}`, ({ ledger }) => {
    const forbidden = toolSequence(ledger).filter((name) => names.includes(name));
    const ok = forbidden.length === 0;
    return {
      score: ok ? 1 : 0,
      passed: ok,
      reason: ok ? "no forbidden tool used" : `called forbidden tool(s): ${[...new Set(forbidden)].join(", ")}`,
    };
  });
}

export function visitsPhase(phase: string, shouldVisit = true): Grader {
  return grader(`${shouldVisit ? "visits" : "avoids"}-phase:${phase}`, ({ ledger }) => {
    const visited = phasePath(ledger).includes(phase as never);
    const ok = visited === shouldVisit;
    return {
      score: ok ? 1 : 0,
      passed: ok,
      reason: ok ? "as expected" : `phase ${phase} was ${visited ? "visited" : "never visited"}`,
    };
  });
}

/**
 * Normalised edit distance against a reference trajectory.
 *
 * The continuous grader. A run that took one extra step scores near 1; a run
 * that took a completely different path scores near 0. This is what turns
 * "the trajectory changed" from a boolean into a magnitude the gate can have
 * an opinion about.
 */
export function trajectoryCloseTo(reference: readonly string[], threshold = 0.8): Grader {
  return grader(`trajectory-close-to:${reference.length}`, ({ ledger }) => {
    const actual = toolSequence(ledger);
    const distance = editDistance(reference, actual);
    const span = Math.max(reference.length, actual.length);
    const score = span === 0 ? 1 : 1 - distance / span;
    return {
      score,
      passed: score >= threshold,
      reason: `edit distance ${distance} over ${span} steps (similarity ${score.toFixed(2)})`,
      detail: { reference: [...reference], actual: [...actual], distance },
    };
  });
}

// ---------------------------------------------------------------------------
// Efficiency
// ---------------------------------------------------------------------------

/**
 * Efficiency graders degrade rather than snapping to zero: at the limit the
 * score is 1, and it falls off linearly beyond it. A cliff would make every
 * over-budget run look equally bad, and "20% worse" is exactly the signal a
 * regression gate exists to notice.
 */
function budgetGrade(id: string, actual: number, limit: number, unit: string): Grade {
  const passed = actual <= limit;
  const score = passed ? 1 : Math.max(0, 1 - (actual - limit) / Math.max(1, limit));
  return {
    graderId: id,
    score,
    passed,
    reason: passed ? `${actual} ${unit} (limit ${limit})` : `${actual} ${unit}, over the limit of ${limit}`,
    detail: { actual, limit },
  };
}

export const withinSteps = (limit: number): Grader => ({
  id: `within-steps:${limit}`,
  grade: ({ ledger }) => budgetGrade(`within-steps:${limit}`, ledger.usage.modelCalls, limit, "model calls"),
});

export const withinToolCalls = (limit: number): Grader => ({
  id: `within-tool-calls:${limit}`,
  grade: ({ ledger }) => budgetGrade(`within-tool-calls:${limit}`, ledger.usage.toolCalls, limit, "tool calls"),
});

export const withinTokens = (limit: number): Grader => ({
  id: `within-tokens:${limit}`,
  grade: ({ ledger }) => budgetGrade(`within-tokens:${limit}`, ledger.usage.totalTokens, limit, "tokens"),
});

/** Turns spent letting the model fix its own mistake. High counts mean bad prompting. */
export const withinCorrectiveTurns = (limit: number): Grader => ({
  id: `within-corrective-turns:${limit}`,
  grade: ({ ledger }) =>
    budgetGrade(`within-corrective-turns:${limit}`, ledger.usage.correctiveTurns, limit, "corrective turns"),
});

export const withinRetries = (limit: number): Grader => ({
  id: `within-retries:${limit}`,
  grade: ({ ledger }) => budgetGrade(`within-retries:${limit}`, ledger.usage.retries, limit, "retries"),
});

/**
 * Exact usage, not an upper bound.
 *
 * `withinSteps(4)` passes a run that took two. When the property under test is
 * "the limit was enforced at exactly the declared point", an upper bound is not
 * the assertion you meant.
 */
export function usageEquals(expected: Partial<Record<keyof Usage, number>>): Grader {
  const label = Object.entries(expected)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return grader(`usage-equals:${label}`, ({ ledger }) => {
    const wrong = Object.entries(expected).filter(([key, value]) => ledger.usage[key as keyof Usage] !== value);
    return {
      score: wrong.length === 0 ? 1 : 0,
      passed: wrong.length === 0,
      reason:
        wrong.length === 0
          ? `usage is exactly ${label}`
          : wrong
              .map(([key, value]) => `${key} was ${ledger.usage[key as keyof Usage]}, expected ${value}`)
              .join("; "),
      detail: { expected: { ...expected }, actual: { ...ledger.usage } },
    };
  });
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type SectionShape = { id: string; used: number; allocated: number; itemsIncluded: number; starved: boolean };
type ReportShape = { used: number; usable: number; sections: SectionShape[] };

const reportsOf = (context: GradeContext): ReportShape[] =>
  contextReports(context.ledger) as unknown as ReportShape[];

/** The packer's core promise, checked from outside the packer. */
export const contextWithinBudget = (): Grader =>
  grader("context-within-budget", (context) => {
    const reports = reportsOf(context);
    if (reports.length === 0) return { score: 1, passed: true, reason: "no assembly reports (no assembler configured)" };
    const over = reports.filter((r) => r.used > r.usable);
    return {
      score: over.length === 0 ? 1 : 0,
      passed: over.length === 0,
      reason:
        over.length === 0
          ? `${reports.length} assemblies all within budget`
          : `${over.length} assemblies exceeded the usable budget`,
      detail: { assemblies: reports.length, over: over.length },
    };
  });

/** A section that exists but never gets space is a silent context bug. */
export function sectionNeverStarved(sectionId: string): Grader {
  return grader(`section-never-starved:${sectionId}`, (context) => {
    const relevant = reportsOf(context).flatMap((r) => r.sections.filter((s) => s.id === sectionId));
    if (relevant.length === 0) {
      return { score: 0, passed: false, reason: `section "${sectionId}" never appeared in any assembly` };
    }
    const starved = relevant.filter((s) => s.starved);
    const score = 1 - starved.length / relevant.length;
    return {
      score,
      passed: starved.length === 0,
      reason:
        starved.length === 0
          ? `"${sectionId}" had space in all ${relevant.length} assemblies`
          : `"${sectionId}" was starved in ${starved.length} of ${relevant.length} assemblies`,
      detail: { assemblies: relevant.length, starved: starved.length },
    };
  });
}

/** Assert against the assembly reports directly. */
export function contextInvariant(
  id: string,
  predicate: (reports: readonly ReportShape[]) => boolean,
  reason: string,
): Grader {
  return grader(`context:${id}`, (context) => {
    const ok = predicate(reportsOf(context));
    return { score: ok ? 1 : 0, passed: ok, reason: ok ? "held" : reason };
  });
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/**
 * The keystone grader.
 *
 * Feeds the recorded ledger back through the reducer and checks it lands in the
 * same phases. Applied to every case, it makes the project's central claim a
 * tested property of every trajectory rather than a design intention.
 */
export const replaysExactly = (): Grader =>
  grader("replays-exactly", ({ ledger }) => {
    const result = replay(ledger);
    return {
      score: result.ok ? 1 : 0,
      passed: result.ok,
      reason: result.ok
        ? `${result.entriesReplayed} entries replayed identically`
        : `diverged at entry ${result.divergence?.seq}: recorded ${result.divergence?.recorded}, replayed ${result.divergence?.replayed}`,
      ...(result.divergence ? { detail: { ...result.divergence } } : {}),
    };
  });

/** Every tool call succeeded. Useful as a soft quality signal, not a hard gate. */
export const allToolCallsSucceeded = (): Grader =>
  grader("all-tool-calls-succeeded", ({ ledger }) => {
    const calls = toolCalls(ledger);
    if (calls.length === 0) return { score: 1, passed: true, reason: "no tool calls" };
    const failed = calls.filter((c) => !c.ok);
    const score = 1 - failed.length / calls.length;
    return {
      score,
      passed: failed.length === 0,
      reason:
        failed.length === 0
          ? `all ${calls.length} tool calls succeeded`
          : `${failed.length} of ${calls.length} failed: ${[...new Set(failed.map((f) => f.errorCode))].join(", ")}`,
    };
  });

// ---------------------------------------------------------------------------

/** Levenshtein over arrays of labels. */
export function editDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] as number) + 1;
      const deletion = (previous[j] as number) + 1;
      current.push(Math.min(substitution, insertion, deletion));
    }
    previous = current;
  }
  return previous[b.length] as number;
}
