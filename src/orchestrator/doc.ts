import { Phase, TERMINAL_PHASES, allowedEvents } from "./phases.ts";
import { toMarkdownTable, toMermaid } from "./diagram.ts";

const PHASE_NOTES: Readonly<Record<Phase, string>> = {
  [Phase.Init]: "Nothing has happened yet.",
  [Phase.Assemble]: "Building the context window for the next model call.",
  [Phase.Model]: "Waiting on the model.",
  [Phase.Route]: "The decision point: tool calls, an answer, or a repair.",
  [Phase.Tools]: "Executing the tool calls the model asked for.",
  [Phase.Observe]: "Folding results back into the transcript as observations.",
  [Phase.Backoff]: "Waiting out a transient failure before retrying.",
  [Phase.Finalize]: "Turning a draft answer into the run's output.",
  [Phase.Done]: "Terminal. Produced an answer.",
  [Phase.Failed]: "Terminal. Gave up; something was wrong.",
  [Phase.Halted]: "Terminal. Hit a declared limit; nothing was wrong.",
};

/** The whole document, derived from the table. Never hand-edit the output. */
export function renderStateMachineDoc(): string {
  const phases = Object.values(Phase)
    .map((phase) => {
      const terminal = TERMINAL_PHASES.includes(phase) ? " *(terminal)*" : "";
      const events = allowedEvents(phase);
      const accepts = events.length === 0 ? "nothing" : events.map((e) => `\`${e}\``).join(", ");
      return `### \`${phase}\`${terminal}\n\n${PHASE_NOTES[phase]}\n\nAccepts: ${accepts}`;
    })
    .join("\n\n");

  return `<!-- GENERATED FILE — do not edit.
     Run \`npm run diagram\`. CI fails if this drifts from src/orchestrator/phases.ts. -->

# The state machine

Generated from \`TRANSITIONS\` in [\`src/orchestrator/phases.ts\`](../src/orchestrator/phases.ts),
which is the same table the reducer asserts every transition against
([ADR-0006](adr/0006-table-driven-fsm-pure-reducer.md)). If this diagram is
wrong, the machine is wrong.

\`\`\`mermaid
${toMermaid()}
\`\`\`

## Every transition

${toMarkdownTable()}

\`·\` means the phase does not accept that event; attempting it throws
\`InvariantViolation\` rather than being ignored.

Three events are legal from every non-terminal phase and are omitted from the
diagram above for legibility:

| Event | Goes to | Meaning |
| ----- | ------- | ------- |
| \`budget.exceeded\` | \`halted\` | A declared limit was reached. |
| \`fault\` | \`failed\` | Something outside the machine broke. |
| \`run.cancelled\` | \`failed\` | The caller aborted. |

## Phases

${phases}
`;
}
