import { Phase, TERMINAL_PHASES, TRANSITIONS, type EventType } from "./phases.ts";

/**
 * Render the transition table as a Mermaid state diagram.
 *
 * The point is not that it is pretty. The point is that the diagram is
 * *generated from the table the reducer asserts against*, so it cannot drift
 * from the implementation the way a hand-drawn diagram in a README always does.
 * `npm run diagram` writes it into the docs.
 */
export function toMermaid(options: { readonly includeUniversal?: boolean } = {}): string {
  const includeUniversal = options.includeUniversal ?? false;
  const universal: readonly EventType[] = ["budget.exceeded", "fault", "run.cancelled"];

  const lines: string[] = ["stateDiagram-v2", "    [*] --> init"];

  for (const [from, row] of Object.entries(TRANSITIONS)) {
    for (const [event, targets] of Object.entries(row)) {
      if (!includeUniversal && universal.includes(event as EventType)) continue;
      for (const to of targets ?? []) {
        lines.push(`    ${from} --> ${to}: ${event}`);
      }
    }
  }

  for (const terminal of TERMINAL_PHASES) lines.push(`    ${terminal} --> [*]`);

  if (!includeUniversal) {
    lines.push("");
    lines.push("    note right of init");
    lines.push("        budget.exceeded -> halted, fault -> failed and");
    lines.push("        run.cancelled -> failed are legal from every");
    lines.push("        non-terminal phase. Omitted here for legibility.");
    lines.push("    end note");
  }

  return lines.join("\n");
}

/** The table as a markdown grid, for docs and for eyeballing coverage. */
export function toMarkdownTable(): string {
  const events = new Set<string>();
  for (const row of Object.values(TRANSITIONS)) for (const event of Object.keys(row)) events.add(event);
  const columns = [...events].sort();

  const header = `| from \\ event | ${columns.join(" | ")} |`;
  const divider = `| --- | ${columns.map(() => "---").join(" | ")} |`;
  const rows = Object.values(Phase).map((phase) => {
    const row = TRANSITIONS[phase];
    const cells = columns.map((event) => {
      const targets = row[event as EventType];
      return targets ? targets.join(", ") : "·";
    });
    return `| **${phase}** | ${cells.join(" | ")} |`;
  });

  return [header, divider, ...rows].join("\n");
}
