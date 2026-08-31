import { tool, type ToolDefinition } from "../src/tools/registry.ts";
import { createAssembler } from "../src/context/assembler.ts";
import { bm25Retriever } from "../src/context/retrieval.ts";
import { inMemoryStore, memoryRecord, MemoryKind } from "../src/context/memory.ts";
import { tokenizerFrom } from "../src/context/tokenizer.ts";
import { transient } from "../src/core/errors.ts";
import { err, ok } from "../src/core/result.ts";
import type { ContextAssembler } from "../src/orchestrator/assembler.ts";
import type { ObjectSchema } from "../src/tools/schema.ts";

/**
 * One token per four characters, exactly.
 *
 * The suite uses an exact tokenizer so that context assertions are arithmetic
 * rather than approximate. The heuristic estimator has its own unit tests; what
 * the evals grade is the *packer's* behaviour, and an inexact counter would put
 * estimation noise underneath every context assertion.
 */
export const evalTokenizer = tokenizerFrom("eval-chars-4", (t) => Math.ceil(t.length / 4));

const queryish: ObjectSchema = {
  type: "object",
  properties: { q: { type: "string", description: "search terms" } },
  required: ["q"],
  additionalProperties: false,
};

export const searchTool = tool(
  "search",
  "Search the documentation index.",
  queryish,
  (args) => `hits for "${String(args["q"])}"`,
  { readOnly: true },
);

export const lookupTool = tool(
  "lookup",
  "Look up a term in the glossary.",
  queryish,
  (args) => `definition of "${String(args["q"])}"`,
  { readOnly: true },
);

/** Not readOnly: the runtime must never retry it on its own. */
export const sendEmailTool: ToolDefinition = {
  name: "send_email",
  description: "Send an email. Irreversible.",
  schema: {
    type: "object",
    properties: { to: { type: "string" }, body: { type: "string" } },
    required: ["to", "body"],
  },
  handler: async () => err(transient("smtp.timeout", "the mail server did not answer")),
};

/** Fails transiently once, then succeeds. Declared readOnly, so retryable. */
export function flakyReadTool(): ToolDefinition {
  let attempts = 0;
  return {
    name: "flaky_read",
    description: "A read that fails the first time.",
    schema: { type: "object", properties: {} },
    readOnly: true,
    handler: async () => (++attempts === 1 ? err(transient("net.reset", "connection reset")) : ok("recovered")),
  };
}

export const DOCS = [
  { id: "escapement", text: "An escapement releases a clock's gear train one tooth per swing, converting continuous force into discrete ticks." },
  { id: "ledger", text: "A ledger is an append-only record. Every entry is a transition, and replaying them reproduces the final state." },
  { id: "budget", text: "A budget allocates a scarce resource among competing claimants, with priorities deciding who is squeezed first." },
  { id: "retrieval", text: "BM25 ranks documents by term frequency, inverse document frequency, and length normalisation." },
];

export const MEMORIES = [
  memoryRecord("m-units", MemoryKind.Fact, "The user works in horology and prefers precise terminology.", {
    createdAt: 10,
    salience: 0.8,
  }),
  memoryRecord("m-policy", MemoryKind.Instruction, "Never send email without explicit confirmation.", {
    createdAt: 20,
    salience: 1,
    tags: ["policy"],
  }),
];

export function assembler(overrides: { total?: number; reserveForOutput?: number } = {}): ContextAssembler {
  return createAssembler({
    budget: {
      total: overrides.total ?? 4000,
      reserveForOutput: overrides.reserveForOutput ?? 512,
    },
    systemPrompt: "You are a precise research assistant. Cite the document ids you used.",
    tokenizer: evalTokenizer,
    memory: { store: inMemoryStore(MEMORIES) },
    retrieval: { retriever: bm25Retriever(DOCS), k: 3 },
    history: { recentMessages: 4 },
  });
}
