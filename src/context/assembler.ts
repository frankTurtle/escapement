import { throwing } from "../core/errors.ts";
import type { AssemblyRequest, ContextAssembler } from "../orchestrator/assembler.ts";
import { renderSchema } from "../tools/schema.ts";
import { heuristicTokenizer, type Tokenizer } from "./tokenizer.ts";
import { pack, reportToJson, type PackBudget } from "./packer.ts";
import { messageItem, textItem, Overflow, type Section } from "./sections.ts";
import type { MemoryStore } from "./memory.ts";
import type { Retriever } from "./retrieval.ts";

export type QueryBuilder = (request: AssemblyRequest) => string;

export type MemoryConfig = {
  readonly store: MemoryStore;
  readonly limit?: number;
  readonly maxShare?: number;
  readonly minTokens?: number;
  readonly query?: QueryBuilder;
  readonly header?: string;
};

export type RetrievalConfig = {
  readonly retriever: Retriever;
  readonly k?: number;
  readonly maxShare?: number;
  readonly minTokens?: number;
  readonly query?: QueryBuilder;
  readonly header?: string;
};

export type HistoryConfig = {
  /** Messages at the tail that must survive. The model loses the thread
   *  without them, so they get the highest discretionary priority. */
  readonly recentMessages?: number;
  readonly olderMaxShare?: number;
};

export type AssemblerConfig = {
  readonly budget: PackBudget;
  readonly systemPrompt: string;
  readonly tokenizer?: Tokenizer;
  readonly memory?: MemoryConfig;
  readonly retrieval?: RetrievalConfig;
  readonly history?: HistoryConfig;
  readonly includeToolSchemas?: boolean;
  /** Anything application-specific. Merged into the section list as-is. */
  readonly extraSections?: (request: AssemblyRequest) => readonly Section[];
};

/**
 * Allocation precedence (lower wins) and render position, kept deliberately
 * separate (ADR-0011). The most important content is rendered last, so a single
 * number cannot express both.
 */
const PRIORITY = { system: 0, goal: 1, tools: 2, recent: 3, retrieval: 4, memory: 5, older: 6 } as const;
const ORDER = { system: 0, tools: 1, memory: 2, retrieval: 3, goal: 4, older: 5, recent: 6 } as const;

/**
 * Build a token-budgeted context assembler (ADR-0011).
 *
 * Produces the same window every time for the same inputs: retrieval is ranked
 * deterministically, ties break on id, and nothing consults a clock. That is
 * what lets the eval harness attribute a behaviour change to the agent rather
 * than to the context it happened to get.
 */
export function createAssembler(config: AssemblerConfig): ContextAssembler {
  const tokenizer = config.tokenizer ?? heuristicTokenizer;
  const recentCount = config.history?.recentMessages ?? 4;

  return async (request) => {
    const sections: Section[] = [];

    sections.push({
      id: "system",
      priority: PRIORITY.system,
      order: ORDER.system,
      pinned: true,
      items: [textItem("system", "system", config.systemPrompt)],
      render: { mode: "messages" },
    });

    if (config.includeToolSchemas !== false && request.tools.length > 0) {
      sections.push({
        id: "tools",
        priority: PRIORITY.tools,
        order: ORDER.tools,
        pinned: true,
        items: request.tools.map((t) =>
          textItem(`tool:${t.name}`, "system", `- ${t.name}${renderSchema(t.schema)}\n  ${t.description}`),
        ),
        render: { mode: "block", role: "system", header: "Tools you may call:" },
      });
    }

    sections.push({
      id: "goal",
      priority: PRIORITY.goal,
      order: ORDER.goal,
      pinned: true,
      items: [textItem("goal", "user", request.goal)],
      render: { mode: "messages" },
    });

    if (config.memory) {
      const limit = config.memory.limit ?? 8;
      const query = (config.memory.query ?? defaultQuery)(request);
      const recalled = config.memory.store.recall({ text: query, limit });
      if (recalled.length > 0) {
        sections.push({
          id: "memory",
          priority: PRIORITY.memory,
          order: ORDER.memory,
          maxShare: config.memory.maxShare ?? 0.15,
          ...(config.memory.minTokens === undefined ? {} : { minTokens: config.memory.minTokens }),
          overflow: Overflow.Drop,
          items: recalled.map((r) => textItem(`memory:${r.id}`, "system", `(${r.kind}) ${r.text}`, r.salience)),
          render: { mode: "block", role: "system", header: config.memory.header ?? "What you already know:" },
          elisionNote: (n) => `(${n} further memory item(s) omitted for space.)`,
        });
      }
    }

    if (config.retrieval) {
      const k = config.retrieval.k ?? 6;
      const query = (config.retrieval.query ?? defaultQuery)(request);
      const hits = await config.retrieval.retriever.search(query, k);
      if (hits.length > 0) {
        sections.push({
          id: "retrieval",
          priority: PRIORITY.retrieval,
          order: ORDER.retrieval,
          maxShare: config.retrieval.maxShare ?? 0.35,
          ...(config.retrieval.minTokens === undefined ? {} : { minTokens: config.retrieval.minTokens }),
          overflow: Overflow.Drop,
          items: hits.map((h) => textItem(`doc:${h.id}`, "system", `[${h.id}] ${h.text}`, h.score)),
          render: { mode: "block", role: "system", header: config.retrieval.header ?? "Retrieved context:" },
          elisionNote: (n) => `(${n} lower-ranked result(s) omitted for space.)`,
        });
      }
    }

    // The goal is transcript[0] and is pinned separately; history is the rest.
    const conversation = request.transcript.slice(1);
    const split = Math.max(0, conversation.length - recentCount);
    const older = conversation.slice(0, split);
    const recent = conversation.slice(split);

    if (older.length > 0) {
      sections.push({
        id: "history.older",
        priority: PRIORITY.older,
        order: ORDER.older,
        maxShare: config.history?.olderMaxShare ?? 0.4,
        overflow: Overflow.Drop,
        items: older.map((m, i) => messageItem(`older:${i}`, m)),
        render: { mode: "messages" },
        elisionNote: (n) => `(${n} earlier message(s) elided to fit the context budget.)`,
      });
    }

    if (recent.length > 0) {
      sections.push({
        id: "history.recent",
        priority: PRIORITY.recent,
        order: ORDER.recent,
        // Highest discretionary priority rather than pinned: it wins every
        // contest for space, but a single enormous tool result degrades the
        // window instead of failing the run outright.
        overflow: Overflow.Truncate,
        items: recent.map((m, i) => messageItem(`recent:${i}`, m)),
        render: { mode: "messages" },
      });
    }

    if (config.extraSections) sections.push(...config.extraSections(request));

    const packed = pack(sections, config.budget, tokenizer);
    if (!packed.ok) throw throwing({ ...packed.error, source: "context" });

    return {
      messages: packed.value.messages,
      tokens: packed.value.tokens,
      report: reportToJson(packed.value.report),
    };
  };
}

/** Goal plus the most recent thing said. Enough for lexical retrieval. */
export const defaultQuery: QueryBuilder = (request) => {
  const last = [...request.transcript].reverse().find((m) => m.role !== "system");
  return last ? `${request.goal}\n${last.content}` : request.goal;
};
