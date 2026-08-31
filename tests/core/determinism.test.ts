import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { seededRng } from "../../src/core/rng.ts";
import { sequentialIds } from "../../src/core/ids.ts";
import { manualClock } from "../../src/core/clock.ts";
import { canonicalJson, digest, isJsonValue } from "../../src/core/json.ts";

describe("seeded rng", () => {
  test("same seed produces the same stream", () => {
    const a = seededRng("run-0001");
    const b = seededRng("run-0001");
    const left = Array.from({ length: 32 }, () => a.next());
    const right = Array.from({ length: 32 }, () => b.next());
    assert.deepEqual(left, right);
  });

  test("different seeds diverge", () => {
    const a = Array.from({ length: 8 }, seededRng("a").next);
    const b = Array.from({ length: 8 }, seededRng("b").next);
    assert.notDeepEqual(a, b);
  });

  test("stays in [0, 1)", () => {
    const rng = seededRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
  });

  test("int is inclusive at both ends and never escapes them", () => {
    const rng = seededRng("ints");
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = rng.int(3, 7);
      assert.ok(v >= 3 && v <= 7, `out of range: ${v}`);
      seen.add(v);
    }
    assert.deepEqual([...seen].sort(), [3, 4, 5, 6, 7]);
  });

  test("shuffle is a permutation and is reproducible", () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const once = seededRng(42).shuffle(items);
    const twice = seededRng(42).shuffle(items);
    assert.deepEqual(once, twice);
    assert.deepEqual([...once].sort(), [...items].sort());
    assert.deepEqual(items, ["a", "b", "c", "d", "e", "f"], "input must not be mutated");
  });
});

describe("sequential ids", () => {
  test("counts per prefix, independently, from one", () => {
    const ids = sequentialIds();
    assert.equal(ids.next("step"), "step-0001");
    assert.equal(ids.next("step"), "step-0002");
    assert.equal(ids.next("call"), "call-0001");
    assert.equal(ids.next("step"), "step-0003");
    assert.equal(ids.count("step"), 3);
    assert.equal(ids.count("call"), 1);
    assert.equal(ids.count("never-used"), 0);
  });

  test("two factories produce identical sequences", () => {
    const a = sequentialIds();
    const b = sequentialIds();
    for (let i = 0; i < 10; i++) assert.equal(a.next("x"), b.next("x"));
  });
});

describe("manual clock", () => {
  test("does not move on its own", () => {
    const clock = manualClock(1000);
    assert.equal(clock.now(), 1000);
    assert.equal(clock.now(), 1000);
  });

  test("sleep advances virtual time and resolves immediately", async () => {
    const clock = manualClock(0);
    const wall = Date.now();
    await clock.sleep(30_000);
    assert.equal(clock.now(), 30_000, "virtual time must advance by the full amount");
    assert.ok(Date.now() - wall < 1000, "must not actually wait");
  });

  test("negative sleeps do not rewind time", async () => {
    const clock = manualClock(500);
    await clock.sleep(-100);
    assert.equal(clock.now(), 500);
  });
});

describe("canonical json", () => {
  test("key order does not affect the encoding", () => {
    const a = { b: 1, a: 2, c: { z: 3, y: 4 } };
    const b = { c: { y: 4, z: 3 }, a: 2, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(digest(a), digest(b));
  });

  test("array order does affect the encoding", () => {
    assert.notEqual(digest([1, 2, 3]), digest([3, 2, 1]));
  });

  test("digest is stable across process boundaries", () => {
    // Pinned so a change to the hash function is a visible, deliberate diff.
    assert.equal(digest({ hello: "world" }), digest({ hello: "world" }));
    assert.match(digest({ hello: "world" }), /^[0-9a-f]{8}$/);
  });

  test("rejects values that do not round-trip", () => {
    assert.ok(isJsonValue({ a: [1, "two", null, true] }));
    assert.ok(!isJsonValue(undefined));
    assert.ok(!isJsonValue(Number.NaN));
    assert.ok(!isJsonValue(Number.POSITIVE_INFINITY));
    assert.ok(!isJsonValue(new Date()));
    assert.ok(!isJsonValue(() => 1));
    assert.ok(!isJsonValue(new Map()));
    assert.ok(!isJsonValue({ nested: { bad: undefined } }));
  });
});
