import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createAssembler } from "../../src/context/assembler.ts";
import { inMemoryStore, memoryRecord, MemoryKind } from "../../src/context/memory.ts";
import { bm25Retriever } from "../../src/context/retrieval.ts";
import { tokenizerFrom } from "../../src/context/tokenizer.ts";
import { tool } from "../../src/tools/registry.ts";
import { assistant, toolResult, user, system } from "../../src/core/messages.ts";
import type { AssemblyRequest } from "../../src/orchestrator/assembler.ts";
import type { PackReport } from "../../src/context/packer.ts";
import { CarriedError } from "../../src/core/errors.ts";
import { run } from "../../src/orchestrator/runtime.ts";
import { scriptedProvider } from "../../src/providers/scripted.ts";
import { createRegistry } from "../../src/tools/registry.ts";
import { manualClock } from "../../src/core/clock.ts";
import { seededRng } from "../../src/core/rng.ts";
import { sequentialIds } from "../../src/core/ids.ts";
import { contextReports } from "../../src/orchestrator/ledger.ts";

const chars = tokenizerFrom("chars", (t) => t.length);

const search = tool(
  "search",
  "Search the docs.",
  { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  () => "ok",
  { readOnly: true },
);

const request = (overrides: Partial<AssemblyRequest> = {}): AssemblyRequest => ({
  runId: "run-0001",
  step: 0,
  goal: "explain what an escapement does",
  transcript: [user("explain what an escapement does")],
  tools: [],
  ...overrides,
});

const docs = [
  { id: "clock", text: "An escapement releases the gear train one tooth per swing of the pendulum." },
  { id: "ledger", text: "A ledger records transactions in append-only order." },
  { id: "budget", text: "Budgets allocate scarce resources among competing claimants." },
];

const report = (r: { report?: unknown }): PackReport => r.report as unknown as PackReport;

describe("section composition", () => {
  test("system prompt and goal are always present", async () => {
    const assemble = createAssembler({
      budget: { total: 1000, reserveForOutput: 100 },
      systemPrompt: "You are careful.",
      tokenizer: chars,
    });
    const result = await assemble(request());
    const contents = result.messages.map((m) => m.content);
    assert.ok(contents.includes("You are careful."));
    assert.ok(contents.includes("explain what an escapement does"));
  });

  test("tool signatures are rendered as one block, not one message each", async () => {
    const assemble = createAssembler({
      budget: { total: 1000, reserveForOutput: 100 },
      systemPrompt: "sys",
      tokenizer: chars,
    });
    const result = await assemble(request({ tools: [search] }));
    const block = result.messages.find((m) => m.content.startsWith("Tools you may call:"));
    assert.ok(block, "expected a single tools block");
    assert.match(block.content, /- search\{ q: string \}/);
  });

  test("tool schemas can be turned off", async () => {
    const assemble = createAssembler({
      budget: { total: 1000, reserveForOutput: 100 },
      systemPrompt: "sys",
      tokenizer: chars,
      includeToolSchemas: false,
    });
    const result = await assemble(request({ tools: [search] }));
    assert.ok(!result.messages.some((m) => m.content.includes("Tools you may call")));
  });

  test("retrieval pulls the relevant document, not all of them", async () => {
    const assemble = createAssembler({
      budget: { total: 1000, reserveForOutput: 100 },
      systemPrompt: "sys",
      tokenizer: chars,
      retrieval: { retriever: bm25Retriever(docs), k: 1 },
    });
    const result = await assemble(request());
    const block = result.messages.find((m) => m.content.startsWith("Retrieved context:"));
    assert.ok(block);
    assert.match(block.content, /\[clock\]/);
    assert.ok(!block.content.includes("[ledger]"));
  });

  test("memory is recalled against the goal", async () => {
    const store = inMemoryStore([
      memoryRecord("m1", MemoryKind.Instruction, "Always mention the pendulum.", { salience: 1 }),
      memoryRecord("m2", MemoryKind.Fact, "Unrelated trivia about submarines.", { salience: 0.1 }),
    ]);
    const assemble = createAssembler({
      budget: { total: 1000, reserveForOutput: 100 },
      systemPrompt: "sys",
      tokenizer: chars,
      memory: { store, limit: 1, query: () => "pendulum" },
    });
    const result = await assemble(request());
    const block = result.messages.find((m) => m.content.startsWith("What you already know:"));
    assert.match(block?.content ?? "", /pendulum/);
    assert.ok(!(block?.content ?? "").includes("submarines"));
  });

  test("sections with nothing to say are omitted entirely", async () => {
    const assemble = createAssembler({
      budget: { total: 1000, reserveForOutput: 100 },
      systemPrompt: "sys",
      tokenizer: chars,
      retrieval: { retriever: bm25Retriever(docs), query: () => "submarine periscope" },
    });
    const result = await assemble(request());
    assert.ok(!result.messages.some((m) => m.content.startsWith("Retrieved context:")));
  });
});

describe("window ordering", () => {
  test("system, tools, memory, retrieval, goal, then history", async () => {
    const store = inMemoryStore([memoryRecord("m", MemoryKind.Fact, "escapement fact", { salience: 1 })]);
    const assemble = createAssembler({
      budget: { total: 4000, reserveForOutput: 100 },
      systemPrompt: "SYSTEM",
      tokenizer: chars,
      memory: { store },
      retrieval: { retriever: bm25Retriever(docs) },
    });
    const result = await assemble(
      request({
        tools: [search],
        transcript: [user("explain what an escapement does"), assistant("thinking"), user("go on")],
      }),
    );
    const kinds = result.messages.map((m) =>
      m.content.startsWith("Tools you may call")
        ? "tools"
        : m.content.startsWith("What you already know")
          ? "memory"
          : m.content.startsWith("Retrieved context")
            ? "retrieval"
            : m.content === "SYSTEM"
              ? "system"
              : m.content === "explain what an escapement does"
                ? "goal"
                : "history",
    );
    assert.deepEqual(kinds.slice(0, 5), ["system", "tools", "memory", "retrieval", "goal"]);
    assert.deepEqual(kinds.slice(5), ["history", "history"]);
  });
});

describe("budget pressure", () => {
  test("under pressure, retrieval and memory are squeezed before the recent turn", async () => {
    const store = inMemoryStore([memoryRecord("m", MemoryKind.Fact, "m".repeat(200), { salience: 1 })]);
    const assemble = createAssembler({
      budget: { total: 320, reserveForOutput: 20 },
      systemPrompt: "sys",
      tokenizer: chars,
      memory: { store },
      retrieval: { retriever: bm25Retriever([{ id: "big", text: "escapement ".repeat(40) }]) },
    });
    const result = await assemble(
      request({ transcript: [user("explain what an escapement does"), assistant("the crucial latest turn")] }),
    );
    const sections = new Map(report(result).sections.map((s) => [s.id, s]));
    assert.equal(sections.get("history.recent")?.itemsIncluded, 1, "the latest turn must survive");
    assert.ok(
      (sections.get("memory")?.used ?? 0) === 0 || (sections.get("retrieval")?.used ?? 0) === 0,
      "something optional had to give",
    );
    assert.ok(result.tokens <= report(result).usable);
  });

  test("older history is elided with a note saying how much", async () => {
    const transcript = [
      user("explain what an escapement does"),
      ...Array.from({ length: 12 }, (_, i) => assistant(`turn ${i} ${"z".repeat(60)}`)),
    ];
    const assemble = createAssembler({
      budget: { total: 500, reserveForOutput: 20 },
      systemPrompt: "sys",
      tokenizer: chars,
      history: { recentMessages: 2 },
    });
    const result = await assemble(request({ transcript }));
    assert.ok(
      result.messages.some((m) => /earlier message\(s\) elided/.test(m.content)),
      "a reader who cannot see that something was cut will assume nothing was",
    );
  });

  test("an impossible pinned set fails loudly and says which sections", async () => {
    const assemble = createAssembler({
      budget: { total: 40, reserveForOutput: 0 },
      systemPrompt: "s".repeat(500),
      tokenizer: chars,
    });
    await assert.rejects(
      () => Promise.resolve(assemble(request())),
      (thrown: unknown) => {
        assert.ok(thrown instanceof CarriedError);
        assert.equal(thrown.escapement.code, "context.pinned_overflow");
        assert.equal(thrown.escapement.source, "context");
        return true;
      },
    );
  });
});

describe("determinism", () => {
  test("the same request always produces the same window", async () => {
    const build = () =>
      createAssembler({
        budget: { total: 600, reserveForOutput: 50 },
        systemPrompt: "sys",
        tokenizer: chars,
        memory: { store: inMemoryStore([memoryRecord("m", MemoryKind.Fact, "escapement fact")]) },
        retrieval: { retriever: bm25Retriever(docs) },
      });
    const a = await build()(request({ tools: [search] }));
    const b = await build()(request({ tools: [search] }));
    assert.deepEqual(a, b);
  });
});

describe("integration with the orchestrator", () => {
  test("the assembly report lands in the ledger, so graders can see what was in context", async () => {
    const assemble = createAssembler({
      budget: { total: 2000, reserveForOutput: 200 },
      systemPrompt: "sys",
      tokenizer: chars,
      retrieval: { retriever: bm25Retriever(docs) },
    });
    const { ledger, outcome } = await run({
      goal: "explain what an escapement does",
      provider: scriptedProvider([
        { say: "", callTools: [{ name: "search", args: { q: "escapement" } }] },
        { say: "it releases the gear train one tooth at a time" },
      ]),
      tools: createRegistry([search]),
      assembler: assemble,
      deps: { clock: manualClock(0), rng: seededRng("t"), ids: sequentialIds() },
    });

    assert.equal(outcome.status, "completed");
    const reports = contextReports(ledger) as unknown as PackReport[];
    assert.equal(reports.length, 2, "one report per model call");
    for (const r of reports) {
      assert.ok(r.used <= r.usable, "the packer's guarantee holds inside a real run");
      assert.ok(r.sections.some((s) => s.id === "retrieval"), "retrieval was in the window");
    }
  });

  test("a context that cannot be assembled fails the run rather than sending a truncated one", async () => {
    const assemble = createAssembler({
      budget: { total: 30, reserveForOutput: 0 },
      systemPrompt: "s".repeat(400),
      tokenizer: chars,
    });
    const { outcome } = await run({
      goal: "g",
      provider: scriptedProvider([{ say: "never reached" }]),
      assembler: assemble,
      deps: { clock: manualClock(0), rng: seededRng("t"), ids: sequentialIds() },
    });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.status === "failed" ? outcome.error.code : "", "context.pinned_overflow");
  });
});

describe("message shapes survive packing", () => {
  test("tool messages keep their callId and error flag", async () => {
    const call = { id: "call-1", name: "search" };
    const assemble = createAssembler({
      budget: { total: 2000, reserveForOutput: 100 },
      systemPrompt: "sys",
      tokenizer: chars,
    });
    const result = await assemble(
      request({
        transcript: [user("goal"), assistant("calling"), toolResult(call, "boom", true), system("note")],
      }),
    );
    const toolMessage = result.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage);
    assert.equal(toolMessage.role === "tool" ? toolMessage.callId : "", "call-1");
    assert.equal(toolMessage.role === "tool" ? toolMessage.isError : false, true);
  });
});
