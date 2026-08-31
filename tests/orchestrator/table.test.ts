import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  Phase,
  EventType,
  TRANSITIONS,
  TERMINAL_PHASES,
  isTerminal,
  isLegalTransition,
  allowedEvents,
} from "../../src/orchestrator/phases.ts";
import { toMermaid, toMarkdownTable } from "../../src/orchestrator/diagram.ts";

const nonTerminal = Object.values(Phase).filter((p) => !isTerminal(p));

describe("the transition table is the specification", () => {
  test("terminal phases accept nothing at all", () => {
    for (const phase of TERMINAL_PHASES) {
      assert.deepEqual(allowedEvents(phase), [], `${phase} must be a sink`);
    }
  });

  test("every non-terminal phase can be interrupted by all three universal events", () => {
    for (const phase of nonTerminal) {
      assert.ok(isLegalTransition(phase, EventType.BudgetExceeded, Phase.Halted), `${phase} cannot halt`);
      assert.ok(isLegalTransition(phase, EventType.Fault, Phase.Failed), `${phase} cannot fault`);
      assert.ok(isLegalTransition(phase, EventType.RunCancelled, Phase.Failed), `${phase} cannot be cancelled`);
    }
  });

  test("every non-terminal phase has a way forward that is not an interruption", () => {
    const universal = new Set<string>([EventType.BudgetExceeded, EventType.Fault, EventType.RunCancelled]);
    for (const phase of nonTerminal) {
      const productive = allowedEvents(phase).filter((e) => !universal.has(e));
      assert.ok(productive.length > 0, `${phase} is a dead end: only interruptions can leave it`);
    }
  });

  test("every phase is reachable from init", () => {
    const seen = new Set<string>([Phase.Init]);
    const queue: string[] = [Phase.Init];
    while (queue.length > 0) {
      const current = queue.shift() as Phase;
      for (const targets of Object.values(TRANSITIONS[current])) {
        for (const target of targets ?? []) {
          if (!seen.has(target)) {
            seen.add(target);
            queue.push(target);
          }
        }
      }
    }
    for (const phase of Object.values(Phase)) {
      assert.ok(seen.has(phase), `${phase} is unreachable — it is dead code in the table`);
    }
  });

  test("every declared event type appears somewhere in the table", () => {
    const used = new Set<string>();
    for (const row of Object.values(TRANSITIONS)) for (const event of Object.keys(row)) used.add(event);
    for (const event of Object.values(EventType)) {
      assert.ok(used.has(event), `${event} is declared but no phase accepts it`);
    }
  });

  test("no transition targets a phase that does not exist", () => {
    const phases = new Set<string>(Object.values(Phase));
    for (const [from, row] of Object.entries(TRANSITIONS)) {
      for (const [event, targets] of Object.entries(row)) {
        for (const target of targets ?? []) {
          assert.ok(phases.has(target), `${from} --${event}--> ${target} targets an unknown phase`);
        }
      }
    }
  });

  test("the table is frozen — nobody patches the state machine at runtime", () => {
    assert.ok(Object.isFrozen(TRANSITIONS));
  });
});

describe("generated diagram", () => {
  test("mermaid output covers every non-universal edge", () => {
    const diagram = toMermaid();
    assert.match(diagram, /^stateDiagram-v2/);
    assert.match(diagram, /init --> assemble: run\.started/);
    assert.match(diagram, /route --> tools: route\.tools/);
    assert.match(diagram, /model --> backoff: model\.failed/);
    assert.ok(
      !/^\s+\w+ --> \w+: fault$/m.test(diagram),
      "universal edges are omitted by default for legibility (the explanatory note still mentions them)",
    );
  });

  test("universal edges can be included", () => {
    assert.match(toMermaid({ includeUniversal: true }), /assemble --> failed: fault/);
  });

  test("markdown table has a row per phase", () => {
    const table = toMarkdownTable();
    for (const phase of Object.values(Phase)) assert.ok(table.includes(`**${phase}**`), phase);
  });
});
