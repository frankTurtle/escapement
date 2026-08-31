import type { EvalSuite } from "../src/evals/types.ts";
import {
  allToolCallsSucceeded,
  callsTools,
  contextInvariant,
  contextWithinBudget,
  endsAs,
  failsWith,
  neverCalls,
  outputContains,
  replaysExactly,
  sectionNeverStarved,
  ToolMatch,
  trajectoryCloseTo,
  visitsPhase,
  withinCorrectiveTurns,
  withinRetries,
  usageEquals,
  withinSteps,
  withinToolCalls,
} from "../src/evals/graders.ts";
import { fatal, transient } from "../src/core/errors.ts";
import { assembler, DOCS, flakyReadTool, lookupTool, searchTool, sendEmailTool } from "./fixtures.ts";

/**
 * The regression suite.
 *
 * Every case is offline and deterministic: a scripted model, a manual clock, a
 * seeded RNG. What is being graded here is **orchestration**, not model quality
 * — whether the machine routes, budgets, retries and packs the way it claims to.
 * Grading model quality needs live runs, which is a slower and separate kind of
 * eval that has no business gating a pull request (ADR-0014).
 *
 * `critical: true` marks the properties that must never regress, whatever the
 * scores do. They are the promises on the tin.
 */
const suite: EvalSuite = {
  id: "escapement-core",
  description: "Orchestration, context assembly and failure-routing regressions.",
  cases: [
    // -- Happy paths ------------------------------------------------------
    {
      id: "direct-answer",
      description: "The model answers without reaching for a tool.",
      tags: ["happy-path"],
      goal: "What does an escapement do?",
      script: [{ say: "It releases the gear train one tooth per swing." }],
      tools: [searchTool],
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        outputContains("gear train"),
        neverCalls("search"),
        withinSteps(1),
        contextWithinBudget(),
        replaysExactly(),
      ],
    },
    {
      id: "single-tool-then-answer",
      description: "One search, then an answer citing it.",
      tags: ["happy-path", "tools"],
      goal: "Search the docs and explain what a ledger is.",
      script: [
        { say: "Looking that up.", callTools: [{ name: "search", args: { q: "ledger append-only" } }] },
        { say: "A ledger is an append-only record [ledger]." },
      ],
      tools: [searchTool, lookupTool],
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        callsTools(["search"], ToolMatch.Exact),
        allToolCallsSucceeded(),
        withinSteps(2),
        withinToolCalls(1),
        withinCorrectiveTurns(0),
        contextWithinBudget(),
        replaysExactly(),
      ],
    },
    {
      id: "parallel-readonly-tools",
      description: "Two read-only calls in one turn run concurrently and keep the model's order.",
      tags: ["tools", "concurrency"],
      goal: "Look up two terms at once.",
      script: [
        {
          say: "Checking both.",
          callTools: [
            { name: "search", args: { q: "escapement" } },
            { name: "lookup", args: { q: "ledger" } },
          ],
        },
        { say: "Both terms found." },
      ],
      tools: [searchTool, lookupTool],
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        callsTools(["search", "lookup"], ToolMatch.Exact),
        withinSteps(2),
        allToolCallsSucceeded(),
        replaysExactly(),
      ],
    },

    // -- Model-correctable failures ---------------------------------------
    {
      id: "unknown-tool-recovery",
      description: "A misspelled tool name costs one corrective turn, not the run.",
      tags: ["recovery"],
      goal: "Find the definition of an escapement.",
      script: [
        { say: "", callTools: [{ name: "serch", args: { q: "escapement" } }] },
        { say: "Sorry, retrying.", callTools: [{ name: "search", args: { q: "escapement" } }] },
        { say: "An escapement ticks." },
      ],
      tools: [searchTool],
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        callsTools(["serch", "search"], ToolMatch.Exact),
        withinCorrectiveTurns(1),
        withinSteps(3),
        replaysExactly(),
      ],
    },
    {
      id: "bad-arguments-recovery",
      description: "Wrong argument shape comes back as an observation, not an exception.",
      tags: ["recovery"],
      goal: "Search for the budget doc.",
      script: [
        { say: "", callTools: [{ name: "search", args: { query: "budget" } }] },
        { say: "Right key this time.", callTools: [{ name: "search", args: { q: "budget" } }] },
        { say: "Budgets allocate scarce resources." },
      ],
      tools: [searchTool],
      assembler: assembler(),
      graders: [endsAs("completed"), withinCorrectiveTurns(1), withinSteps(3), replaysExactly()],
    },
    {
      id: "empty-response-repair",
      description: "A response with no content and no tool call is repaired, never finalised.",
      tags: ["recovery"],
      critical: true,
      goal: "Say something useful.",
      script: [{ say: "   " }, { say: "Here is the answer." }],
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        outputContains("Here is the answer"),
        withinCorrectiveTurns(1),
        replaysExactly(),
      ],
    },

    // -- Runtime-recoverable failures -------------------------------------
    {
      id: "transient-retry",
      description: "A 429 is retried with backoff and costs no extra model turn.",
      tags: ["retry"],
      goal: "Answer despite a rate limit.",
      script: [{ failWith: transient("model.rate_limited", "429 slow down") }, { say: "Answered on the retry." }],
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        visitsPhase("backoff"),
        withinRetries(1),
        withinSteps(1),
        replaysExactly(),
      ],
    },
    {
      id: "retry-exhaustion",
      description: "Persistent transient failures stop, rather than looping forever.",
      tags: ["retry", "limits"],
      critical: true,
      goal: "Fail politely.",
      script: [
        { failWith: transient("model.rate_limited", "429") },
        { failWith: transient("model.rate_limited", "429") },
        { failWith: transient("model.rate_limited", "429") },
        { failWith: transient("model.rate_limited", "429") },
      ],
      retry: { baseDelayMs: 10 },
      budget: { maxModelAttempts: 3 },
      assembler: assembler(),
      graders: [endsAs("failed"), failsWith("model.retries_exhausted"), withinRetries(2), replaysExactly()],
    },
    {
      id: "readonly-tool-retried-by-runtime",
      description: "A transient read failure is retried without spending a model turn.",
      tags: ["retry", "tools"],
      goal: "Read the flaky source.",
      script: [{ say: "", callTools: [{ name: "flaky_read", args: {} }] }, { say: "Got it." }],
      tools: [flakyReadTool()],
      retry: { baseDelayMs: 5 },
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        allToolCallsSucceeded(),
        withinSteps(2),
        withinToolCalls(1),
        replaysExactly(),
      ],
    },
    {
      id: "write-tool-never-retried",
      description: "An irreversible tool is never retried by the runtime, whatever it returns.",
      tags: ["tools", "safety"],
      critical: true,
      goal: "Try to send an email.",
      script: [
        { say: "", callTools: [{ name: "send_email", args: { to: "a@b.c", body: "hi" } }] },
        { say: "The mail server is down; I have not sent anything." },
      ],
      tools: [sendEmailTool],
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        // Exactly one attempt. The tool failed transiently and the runtime must
        // still not have tried again — that is the whole point of readOnly.
        usageEquals({ toolCalls: 1, retries: 0 }),
        replaysExactly(),
      ],
    },

    // -- Fatal --------------------------------------------------------------
    {
      id: "fatal-not-retried",
      description: "A bad API key aborts immediately; retrying it would be pointless.",
      tags: ["failure", "safety"],
      critical: true,
      goal: "Answer with a broken credential.",
      script: [{ failWith: fatal("auth.invalid_key", "invalid x-api-key") }],
      assembler: assembler(),
      graders: [
        endsAs("failed"),
        failsWith("auth.invalid_key"),
        withinRetries(0),
        visitsPhase("backoff", false),
        replaysExactly(),
      ],
    },

    // -- Budgets ------------------------------------------------------------
    {
      id: "step-budget-halts-a-loop",
      description: "An agent that never answers is stopped at exactly the declared step count.",
      tags: ["limits"],
      critical: true,
      goal: "Loop forever.",
      script: [{ say: "still looking", callTools: [{ name: "search", args: { q: "again" } }] }],
      onScriptExhausted: "repeat-last",
      tools: [searchTool],
      budget: { maxSteps: 4 },
      assembler: assembler(),
      graders: [
        endsAs("halted"),
        failsWith("budget.steps"),
        // Exactly four, not "at most four": the assertion is that the limit
        // stopped it at the declared point, not merely somewhere before it.
        usageEquals({ modelCalls: 4 }),
        replaysExactly(),
      ],
    },
    {
      id: "tool-budget-refuses-an-overrunning-batch",
      description: "A batch that would exceed the tool budget is refused before any of it runs.",
      tags: ["limits"],
      critical: true,
      goal: "Call three tools at once with a budget of two.",
      script: [
        {
          say: "",
          callTools: [
            { name: "search", args: { q: "a" } },
            { name: "lookup", args: { q: "b" } },
            { name: "search", args: { q: "c" } },
          ],
        },
      ],
      tools: [searchTool, lookupTool],
      budget: { maxToolCalls: 2 },
      assembler: assembler(),
      graders: [
        endsAs("halted"),
        failsWith("budget.tool_calls"),
        withinToolCalls(0),
        callsTools([], ToolMatch.Exact),
        replaysExactly(),
      ],
    },

    // -- Context ------------------------------------------------------------
    {
      id: "context-report-is-recorded",
      description: "Every assembly is auditable from the ledger alone.",
      tags: ["context"],
      goal: "Explain what an escapement does, citing a document.",
      script: [
        { say: "", callTools: [{ name: "search", args: { q: "escapement ticks" } }] },
        { say: "It converts continuous force into discrete ticks [escapement]." },
      ],
      tools: [searchTool],
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        contextWithinBudget(),
        sectionNeverStarved("retrieval"),
        sectionNeverStarved("history.recent"),
        contextInvariant(
          "one-report-per-model-call",
          (reports) => reports.length === 2,
          "expected one assembly report per model call",
        ),
        replaysExactly(),
      ],
    },
    {
      id: "context-under-pressure-keeps-the-latest-turn",
      description: "A tight window squeezes retrieval and memory before the most recent turn.",
      tags: ["context", "limits"],
      critical: true,
      goal: `Summarise everything about ${DOCS.map((d) => d.id).join(", ")} in great detail.`,
      script: [
        { say: "", callTools: [{ name: "search", args: { q: "escapement ledger budget retrieval" } }] },
        { say: "A compressed summary." },
      ],
      tools: [searchTool, lookupTool],
      assembler: assembler({ total: 700, reserveForOutput: 100 }),
      graders: [
        endsAs("completed"),
        contextWithinBudget(),
        sectionNeverStarved("history.recent"),
        replaysExactly(),
      ],
    },

    // -- Trajectory ---------------------------------------------------------
    {
      id: "trajectory-shape-is-stable",
      description: "The canonical research trajectory: search, look up, answer.",
      tags: ["trajectory"],
      goal: "Research the ledger design and explain it.",
      script: [
        { say: "", callTools: [{ name: "search", args: { q: "ledger" } }] },
        { say: "", callTools: [{ name: "lookup", args: { q: "append-only" } }] },
        { say: "A ledger is append-only and replayable [ledger]." },
      ],
      tools: [searchTool, lookupTool],
      assembler: assembler(),
      graders: [
        endsAs("completed"),
        trajectoryCloseTo(["search", "lookup"], 1),
        callsTools(["search", "lookup"], ToolMatch.Subsequence),
        withinSteps(3),
        withinToolCalls(2),
        replaysExactly(),
      ],
    },
  ],
};

export default suite;
