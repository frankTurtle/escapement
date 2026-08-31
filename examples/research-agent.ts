/**
 * A complete Escapement agent, runnable with no API key.
 *
 *   node --experimental-strip-types examples/research-agent.ts
 *
 * The model is scripted so the example is deterministic and offline. Swapping
 * in a real one means replacing `provider` with ten lines around your SDK —
 * everything else here is unchanged.
 */
import { run } from "../src/orchestrator/runtime.ts";
import { replay, phasePath, toolSequence, contextReports } from "../src/orchestrator/ledger.ts";
import { createRegistry } from "../src/tools/registry.ts";
import { scriptedProvider } from "../src/providers/scripted.ts";
import { createAssembler } from "../src/context/assembler.ts";
import { bm25Retriever } from "../src/context/retrieval.ts";
import { inMemoryStore, memoryRecord, MemoryKind } from "../src/context/memory.ts";
import { transient } from "../src/core/errors.ts";
import { err, ok } from "../src/core/result.ts";
import type { ObjectSchema } from "../src/tools/schema.ts";

// --- the corpus ------------------------------------------------------------

const DOCS = [
  { id: "escapement", text: "An escapement releases a clock's gear train one tooth per swing of the pendulum, converting continuous force into discrete, countable ticks." },
  { id: "ledger", text: "A ledger is an append-only record of transitions. Replaying the entries reproduces the final state exactly." },
  { id: "budget", text: "A budget allocates a scarce resource among competing claimants. Priorities decide who is squeezed first when there is not enough to go round." },
];

// --- the tools -------------------------------------------------------------

const querySchema: ObjectSchema = {
  type: "object",
  properties: { q: { type: "string", description: "search terms" } },
  required: ["q"],
  additionalProperties: false,
};

const index = bm25Retriever(DOCS);

let searchAttempts = 0;
const search = {
  name: "search",
  description: "Search the documentation index. Returns the best matching passage.",
  schema: querySchema,
  // Declares two permissions to the runtime: safe to run concurrently with
  // other read-only calls in the same turn, and safe to retry without asking
  // the model. Both would be wrong for anything that writes.
  readOnly: true,
  handler: async (args: Record<string, unknown>) => {
    // Fail once, transiently, to show the runtime retrying on its own.
    if (++searchAttempts === 1) return err(transient("net.reset", "connection reset by peer"));
    const hits = index.search(String(args["q"]), 1);
    return ok(hits[0]?.text ?? "no results");
  },
};

// --- the agent -------------------------------------------------------------

const result = await run({
  goal: "What does an escapement do, and why does the ledger design mirror it?",

  provider: scriptedProvider([
    { say: "Let me look that up.", callTools: [{ name: "search", args: { q: "escapement gear train ticks" } }] },
    { say: "And the ledger.", callTools: [{ name: "search", args: { q: "ledger append-only replay" } }] },
    {
      say: "An escapement converts continuous force into discrete ticks [escapement]. The ledger does the same to a run: it records discrete transitions that replay exactly [ledger].",
    },
  ]),

  tools: createRegistry([search]),

  assembler: createAssembler({
    budget: { total: 8_000, reserveForOutput: 1_000 },
    systemPrompt: "You are a precise research assistant. Cite the document ids you used.",
    retrieval: { retriever: index, k: 2 },
    memory: {
      store: inMemoryStore([
        memoryRecord("m1", MemoryKind.Fact, "The user studies escapement mechanisms and prefers precise horological terminology.", {
          salience: 0.9,
        }),
      ]),
    },
  }),

  config: { budget: { maxSteps: 6, maxToolCalls: 10 } },
});

// --- what you get back -----------------------------------------------------

console.log("outcome    :", result.outcome.status);
console.log("answer     :", result.outcome.status === "completed" ? result.outcome.output : result.outcome.error.message);
console.log();
console.log("phases     :", phasePath(result.ledger).join(" → "));
console.log("tools      :", toolSequence(result.ledger).join(", "));
console.log("usage      :", `${result.ledger.usage.modelCalls} model calls,`,
  `${result.ledger.usage.toolCalls} tool calls,`,
  `${result.ledger.usage.retries} retries (the runtime absorbed the transient failure —`,
  `it cost no model turn)`);
console.log();

const reports = contextReports(result.ledger) as unknown as { used: number; usable: number; sections: { id: string; used: number }[] }[];
console.log("context windows:");
for (const [i, report] of reports.entries()) {
  const breakdown = report.sections.filter((s) => s.used > 0).map((s) => `${s.id}=${s.used}`).join(" ");
  console.log(`  step ${i + 1}: ${report.used}/${report.usable} tokens  ${breakdown}`);
}
console.log();
console.log("replays exactly:", replay(result.ledger).ok);
