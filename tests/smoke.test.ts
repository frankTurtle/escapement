import { test } from "node:test";
import assert from "node:assert/strict";
import { ping } from "../src/core/smoke.ts";

test("toolchain runs typescript directly", () => {
  assert.equal(ping().kind, "ping");
});
