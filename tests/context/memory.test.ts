import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inMemoryStore, memoryRecord, MemoryKind } from "../../src/context/memory.ts";

const records = [
  memoryRecord("m1", MemoryKind.Fact, "The user prefers metric units.", { createdAt: 100, salience: 0.9 }),
  memoryRecord("m2", MemoryKind.Episode, "The database migration failed on 2026-08-14.", { createdAt: 200 }),
  memoryRecord("m3", MemoryKind.Instruction, "Never email customers without approval.", {
    createdAt: 50,
    salience: 1,
    tags: ["policy"],
  }),
];

describe("recall", () => {
  test("with a query, ranks by relevance", () => {
    const store = inMemoryStore(records);
    const hits = store.recall({ text: "migration database", limit: 2 });
    assert.equal(hits[0]?.id, "m2");
  });

  test("without a query, ranks by salience then recency", () => {
    const store = inMemoryStore(records);
    assert.deepEqual(
      store.recall({ limit: 3 }).map((r) => r.id),
      ["m3", "m1", "m2"],
    );
  });

  test("filters by kind", () => {
    const store = inMemoryStore(records);
    const hits = store.recall({ kinds: [MemoryKind.Instruction], limit: 5 });
    assert.deepEqual(hits.map((r) => r.id), ["m3"]);
  });

  test("filters by tag", () => {
    const store = inMemoryStore(records);
    assert.deepEqual(store.recall({ tags: ["policy"], limit: 5 }).map((r) => r.id), ["m3"]);
    assert.deepEqual(store.recall({ tags: ["absent"], limit: 5 }), []);
  });

  test("respects the limit", () => {
    assert.equal(inMemoryStore(records).recall({ limit: 1 }).length, 1);
  });

  test("a query that matches nothing returns nothing, not everything", () => {
    assert.deepEqual(inMemoryStore(records).recall({ text: "submarine", limit: 5 }), []);
  });

  test("is deterministic — never dependent on insertion order", () => {
    const forward = inMemoryStore(records).recall({ limit: 3 }).map((r) => r.id);
    const backward = inMemoryStore([...records].reverse()).recall({ limit: 3 }).map((r) => r.id);
    assert.deepEqual(forward, backward);
  });
});

describe("remember", () => {
  test("adds a record and overwrites by id", () => {
    const store = inMemoryStore();
    store.remember(memoryRecord("x", MemoryKind.Fact, "first"));
    store.remember(memoryRecord("x", MemoryKind.Fact, "second"));
    assert.equal(store.all().length, 1);
    assert.equal(store.all()[0]?.text, "second");
  });

  test("nothing is written unless the application writes it", () => {
    // Escapement never decides on its own that something is worth remembering.
    const store = inMemoryStore();
    assert.deepEqual(store.all(), []);
  });
});
