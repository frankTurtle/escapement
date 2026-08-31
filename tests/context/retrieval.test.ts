import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bm25Retriever, tokenize, type Document } from "../../src/context/retrieval.ts";

const docs: readonly Document[] = [
  { id: "d1", text: "The escapement regulates a clock by releasing the gear train one tooth at a time." },
  { id: "d2", text: "A ledger is an append-only record of transactions used for auditing." },
  { id: "d3", text: "Clock escapements include the anchor, the deadbeat and the grasshopper escapement." },
  { id: "d4", text: "Budget allocation distributes a scarce resource across competing claimants." },
];

const index = bm25Retriever(docs);

describe("tokenize", () => {
  test("lowercases, splits on non-alphanumerics, drops stopwords and single chars", () => {
    assert.deepEqual(tokenize("The QUICK, brown-fox! a b c1"), ["quick", "brown", "fox", "c1"]);
  });
});

describe("bm25", () => {
  test("ranks the document that is actually about the query first", () => {
    const hits = index.search("escapement clock", 2);
    assert.equal(hits[0]?.id, "d3", "d3 mentions both terms, twice");
    assert.ok(hits.length <= 2);
  });

  test("returns nothing when no term matches", () => {
    assert.deepEqual(index.search("submarine periscope", 5), []);
  });

  test("returns nothing for a query of only stopwords", () => {
    assert.deepEqual(index.search("the and of", 5), []);
  });

  test("respects k", () => {
    assert.equal(index.search("escapement", 1).length, 1);
  });

  test("scores are positive and descending", () => {
    const hits = index.search("escapement clock ledger", 4);
    assert.ok(hits.length > 1);
    for (let i = 1; i < hits.length; i++) {
      assert.ok((hits[i - 1]?.score ?? 0) >= (hits[i]?.score ?? 0), "not sorted");
      assert.ok((hits[i]?.score ?? 0) > 0, "zero-scoring documents must not be returned");
    }
  });

  test("is deterministic across constructions", () => {
    const a = bm25Retriever(docs).search("escapement", 4);
    const b = bm25Retriever(docs).search("escapement", 4);
    assert.deepEqual(a, b);
  });

  test("ties break on document id, never on insertion order", () => {
    const twins: Document[] = [
      { id: "zeta", text: "identical text about widgets" },
      { id: "alpha", text: "identical text about widgets" },
    ];
    const forward = bm25Retriever(twins).search("widgets", 2).map((h) => h.id);
    const reversed = bm25Retriever([...twins].reverse()).search("widgets", 2).map((h) => h.id);
    assert.deepEqual(forward, ["alpha", "zeta"]);
    assert.deepEqual(forward, reversed);
  });

  test("an empty index is not an error", () => {
    assert.deepEqual(bm25Retriever([]).search("anything", 5), []);
  });

  test("a term in every document contributes almost nothing", () => {
    const uniform: Document[] = [
      { id: "a", text: "common term alpha" },
      { id: "b", text: "common term beta" },
    ];
    const hits = bm25Retriever(uniform).search("common alpha", 2);
    assert.equal(hits[0]?.id, "a", "the discriminating term must dominate the ubiquitous one");
  });

  test("carries metadata through", () => {
    const withMeta = bm25Retriever([{ id: "m", text: "escapement", metadata: { source: "wiki" } }]);
    assert.deepEqual(withMeta.search("escapement", 1)[0]?.metadata, { source: "wiki" });
  });
});
