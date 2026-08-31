import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Failure,
  Remedy,
  REMEDY_FOR,
  remedyFor,
  transient,
  correctable,
  fatal,
  budgetExceeded,
  cancelled,
  invariant,
  InvariantViolation,
  toEscapementError,
} from "../../src/core/errors.ts";

describe("failure taxonomy", () => {
  test("every failure class maps to exactly one remedy", () => {
    const classes = Object.values(Failure);
    for (const cls of classes) {
      assert.ok(REMEDY_FOR[cls], `no remedy declared for '${cls}'`);
    }
    assert.equal(Object.keys(REMEDY_FOR).length, classes.length, "remedy table has entries for unknown classes");
  });

  test("the remedy is the point: who can fix it", () => {
    assert.equal(remedyFor(transient("model.timeout", "timed out")), Remedy.Retry);
    assert.equal(remedyFor(correctable("tool.unknown", "no such tool")), Remedy.Reprompt);
    assert.equal(remedyFor(fatal("config.invalid", "bad config")), Remedy.Abort);
    assert.equal(remedyFor(budgetExceeded("budget.steps", "out of steps")), Remedy.Halt);
    assert.equal(remedyFor(cancelled()), Remedy.Abort);
  });

  test("optional fields are omitted rather than set to undefined", () => {
    const e = transient("x.y", "z");
    assert.ok(!("detail" in e), "detail must be absent, not undefined — it is serialised to the ledger");
    assert.ok(!("source" in e));
    const withDetail = transient("x.y", "z", { attempt: 2 });
    assert.deepEqual(withDetail.detail, { attempt: 2 });
  });
});

describe("invariants", () => {
  test("holds silently when true", () => {
    assert.doesNotThrow(() => invariant(true, "fine"));
  });

  test("throws InvariantViolation, which is not an EscapementError", () => {
    assert.throws(() => invariant(false, "the table is wrong"), InvariantViolation);
  });

  test("normalising a violation classifies it as fatal", () => {
    const e = toEscapementError(new InvariantViolation("boom"), "reducer");
    assert.equal(e.class, Failure.Fatal);
    assert.equal(e.code, "invariant.violated");
    assert.equal(e.source, "reducer");
  });

  test("normalising an arbitrary throw never itself throws", () => {
    for (const thrown of [new TypeError("nope"), "a string", 42, null, undefined, { weird: true }]) {
      const e = toEscapementError(thrown);
      assert.equal(e.class, Failure.Fatal);
      assert.ok(e.code.startsWith("unknown."), e.code);
    }
  });
});
