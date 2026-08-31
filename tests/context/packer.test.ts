import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pack, type PackBudget } from "../../src/context/packer.ts";
import { textItem, Overflow, type Section } from "../../src/context/sections.ts";
import { tokenizerFrom, heuristicTokenizer } from "../../src/context/tokenizer.ts";

/** One token per character. Makes every assertion below arithmetic. */
const chars = tokenizerFrom("chars", (t) => t.length);
const budget = (total: number, reserveForOutput = 0): PackBudget => ({ total, reserveForOutput });

const filler = (id: string, size: number, count: number): Section["items"] =>
  Array.from({ length: count }, (_, i) => textItem(`${id}:${i}`, "system", "x".repeat(size)));

describe("reservation", () => {
  test("output reservation is never packed into", () => {
    const section: Section = { id: "s", priority: 0, items: filler("s", 10, 20) };
    const result = pack([section], budget(100, 40), chars);
    assert.ok(result.ok);
    assert.ok(result.value.tokens <= 60);
    assert.equal(result.value.report.usable, 60);
  });

  test("an inexact tokenizer costs a safety margin", () => {
    const section: Section = { id: "s", priority: 0, items: filler("s", 4, 200) };
    const result = pack([section], { total: 1000, reserveForOutput: 0, safetyMargin: 0.1 }, heuristicTokenizer);
    assert.ok(result.ok);
    assert.equal(result.value.report.usable, 900);
    assert.equal(result.value.report.exact, false);
  });

  test("an exact tokenizer gets the whole window", () => {
    const section: Section = { id: "s", priority: 0, items: filler("s", 10, 100) };
    const result = pack([section], { total: 500, reserveForOutput: 0, safetyMargin: 0.5 }, chars);
    assert.ok(result.ok);
    assert.equal(result.value.report.usable, 500, "the margin exists only because estimates are estimates");
    assert.equal(result.value.report.safetyMargin, 0);
  });

  test("a reservation larger than the window is a clear error, not a crash", () => {
    const result = pack([], budget(100, 100), chars);
    assert.ok(!result.ok);
    assert.equal(result.error.code, "context.no_space");
  });
});

describe("pinned sections", () => {
  test("are allocated in full before anything else", () => {
    const sections: Section[] = [
      { id: "pinned", priority: 5, pinned: true, items: filler("p", 30, 1) },
      { id: "greedy", priority: 0, items: filler("g", 10, 20) },
    ];
    const result = pack(sections, budget(100), chars);
    assert.ok(result.ok);
    const pinned = result.value.report.sections.find((s) => s.id === "pinned");
    assert.equal(pinned?.used, 30, "pinned wins even though it has the worse priority number");
  });

  test("failing to fit is a loud error, not a silent truncation", () => {
    const sections: Section[] = [{ id: "huge", priority: 0, pinned: true, items: filler("h", 200, 1) }];
    const result = pack(sections, budget(100), chars);
    assert.ok(!result.ok);
    assert.equal(result.error.code, "context.pinned_overflow");
    assert.deepEqual(result.error.detail?.usable, 100);
  });
});

describe("fair share", () => {
  test("maxShare caps a section while others are competing", () => {
    const sections: Section[] = [
      { id: "a", priority: 0, maxShare: 0.25, items: filler("a", 10, 20) },
      { id: "b", priority: 1, items: filler("b", 10, 20) },
    ];
    const result = pack(sections, budget(100), chars);
    assert.ok(result.ok);
    const a = result.value.report.sections.find((s) => s.id === "a");
    assert.equal(a?.allocated, 25);
  });

  test("leftover space ignores maxShare — the cap is for contention, not waste", () => {
    const sections: Section[] = [
      { id: "a", priority: 0, maxShare: 0.25, items: filler("a", 10, 20) },
      { id: "b", priority: 1, items: filler("b", 10, 1) },
    ];
    const result = pack(sections, budget(100), chars);
    assert.ok(result.ok);
    const a = result.value.report.sections.find((s) => s.id === "a");
    assert.ok((a?.allocated ?? 0) > 25, `expected more than the 25 cap, got ${a?.allocated}`);
    assert.equal(result.value.report.remaining, 0, "no space left on the table");
  });

  test("priority decides who is squeezed", () => {
    const sections: Section[] = [
      { id: "important", priority: 0, items: filler("i", 10, 8) },
      { id: "optional", priority: 9, items: filler("o", 10, 8) },
    ];
    const result = pack(sections, budget(100), chars);
    assert.ok(result.ok);
    const byId = new Map(result.value.report.sections.map((s) => [s.id, s]));
    assert.equal(byId.get("important")?.itemsIncluded, 8);
    assert.ok((byId.get("optional")?.itemsDropped ?? 0) > 0);
  });

  test("a section below its floor gets nothing at all", () => {
    const sections: Section[] = [
      { id: "hog", priority: 0, items: filler("h", 10, 9) },
      { id: "needs-room", priority: 1, minTokens: 50, items: filler("n", 10, 5) },
    ];
    const result = pack(sections, budget(100), chars);
    assert.ok(result.ok);
    const starved = result.value.report.sections.find((s) => s.id === "needs-room");
    assert.equal(starved?.used, 0, "half a retrieved document is worse than none");
    assert.equal(starved?.starved, true);
  });
});

describe("overflow policies", () => {
  test("drop skips an oversized item but keeps trying smaller ones", () => {
    const sections: Section[] = [
      {
        id: "s",
        priority: 0,
        overflow: Overflow.Drop,
        items: [textItem("big", "system", "x".repeat(80)), textItem("small", "system", "y".repeat(5))],
      },
    ];
    const result = pack(sections, budget(50), chars);
    assert.ok(result.ok);
    assert.equal(result.value.report.sections[0]?.itemsIncluded, 1);
    assert.match(result.value.messages[0]?.content ?? "", /^y+$/);
  });

  test("truncate cuts the item down and then stops", () => {
    const sections: Section[] = [
      {
        id: "s",
        priority: 0,
        overflow: Overflow.Truncate,
        items: [textItem("big", "system", "x".repeat(80)), textItem("next", "system", "y")],
      },
    ];
    const result = pack(sections, budget(50), chars);
    assert.ok(result.ok);
    const report = result.value.report.sections[0];
    assert.equal(report?.itemsTruncated, 1);
    assert.equal(report?.itemsIncluded, 1);
    assert.ok((result.value.tokens ?? 0) <= 50);
  });

  test("an elision note is emitted, and charged for", () => {
    const sections: Section[] = [
      {
        id: "s",
        priority: 0,
        items: filler("s", 20, 5),
        render: { mode: "block", role: "system", header: "Context:" },
        elisionNote: (n) => `(${n} omitted)`,
      },
    ];
    const result = pack(sections, budget(60), chars);
    assert.ok(result.ok);
    assert.match(result.value.messages[0]?.content ?? "", /omitted/);
    assert.ok(result.value.tokens <= 60);
  });
});

describe("ordering", () => {
  test("allocation priority and render order are independent", () => {
    const sections: Section[] = [
      { id: "last-but-vital", priority: 0, order: 9, items: [textItem("a", "system", "AAA")] },
      { id: "first-but-optional", priority: 9, order: 0, items: [textItem("b", "system", "BBB")] },
    ];
    const result = pack(sections, budget(100), chars);
    assert.ok(result.ok);
    assert.deepEqual(result.value.messages.map((m) => m.content), ["BBB", "AAA"]);
  });

  test("order defaults to priority", () => {
    const sections: Section[] = [
      { id: "second", priority: 1, items: [textItem("a", "system", "second")] },
      { id: "first", priority: 0, items: [textItem("b", "system", "first")] },
    ];
    const result = pack(sections, budget(100), chars);
    assert.ok(result.ok);
    assert.deepEqual(result.value.messages.map((m) => m.content), ["first", "second"]);
  });
});

describe("guarantees", () => {
  test("the window never exceeds the usable budget, across many shapes", () => {
    for (let total = 20; total <= 400; total += 7) {
      const sections: Section[] = [
        { id: "pinned", priority: 0, pinned: true, items: filler("p", 5, 1) },
        { id: "a", priority: 1, maxShare: 0.5, items: filler("a", 13, 9), overflow: Overflow.Truncate },
        { id: "b", priority: 2, maxShare: 0.3, items: filler("b", 7, 15) },
        { id: "c", priority: 3, minTokens: 20, items: filler("c", 11, 6) },
      ];
      const result = pack(sections, budget(total, 5), chars);
      if (!result.ok) {
        assert.equal(result.error.code, "context.pinned_overflow", `unexpected failure at total=${total}`);
        continue;
      }
      assert.ok(
        result.value.tokens <= result.value.report.usable,
        `total=${total}: used ${result.value.tokens} > usable ${result.value.report.usable}`,
      );
      const summed = result.value.report.sections.reduce((s, r) => s + r.used, 0);
      assert.equal(summed, result.value.tokens, "the report must add up");
    }
  });

  test("packing is a pure function of its inputs", () => {
    const sections: Section[] = [
      { id: "a", priority: 0, maxShare: 0.4, items: filler("a", 9, 12) },
      { id: "b", priority: 1, items: filler("b", 6, 12) },
    ];
    const first = pack(sections, budget(120, 10), chars);
    const second = pack(sections, budget(120, 10), chars);
    assert.deepEqual(first, second);
  });

  test("an empty section list produces an empty window", () => {
    const result = pack([], budget(100), chars);
    assert.ok(result.ok);
    assert.deepEqual(result.value.messages, []);
    assert.equal(result.value.tokens, 0);
  });
});
