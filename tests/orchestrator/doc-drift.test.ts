import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderStateMachineDoc } from "../../src/orchestrator/doc.ts";

describe("generated documentation", () => {
  test("docs/STATE-MACHINE.md matches the transition table", () => {
    const committed = readFileSync(new URL("../../docs/STATE-MACHINE.md", import.meta.url), "utf8");
    assert.equal(
      committed,
      renderStateMachineDoc(),
      "The state machine changed but the docs did not. Run `npm run diagram` and commit the result.",
    );
  });
});
