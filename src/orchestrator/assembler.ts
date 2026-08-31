import { system, type Message } from "../core/messages.ts";
import type { ToolDefinition } from "../tools/registry.ts";
import type { AssembledContext } from "./state.ts";

export type AssemblyRequest = {
  readonly runId: string;
  /** Model calls completed so far. 0 on the first assembly. */
  readonly step: number;
  readonly goal: string;
  readonly transcript: readonly Message[];
  readonly tools: readonly ToolDefinition[];
};

/**
 * The context port.
 *
 * The orchestrator does not know how the window is built. It knows it gets
 * messages and a token count, and it enforces a budget against that count. The
 * real implementation lives in `escapement/context`; this seam is what keeps
 * the state machine independent of packing policy.
 */
export type ContextAssembler = (request: AssemblyRequest) => AssembledContext | Promise<AssembledContext>;

/**
 * The trivial assembler: the whole transcript, every time.
 *
 * Deliberately shipped, and deliberately named. It is what most agent loops do,
 * it makes the orchestrator usable on its own, and it is the baseline the
 * budgeted assembler is measured against. Its token count is a chars/4
 * estimate, which is exactly as approximate as it sounds — see
 * `escapement/context` for a real one.
 */
export const passthroughAssembler: ContextAssembler = (request) => {
  const preamble: Message[] =
    request.tools.length > 0
      ? [
          system(
            `You have access to the following tools:\n${request.tools
              .map((t) => `- ${t.name}: ${t.description}`)
              .join("\n")}`,
          ),
        ]
      : [];
  const messages = [...preamble, ...request.transcript];
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return { messages, tokens: Math.ceil(chars / 4) };
};

/** What turns a draft answer into the run's output. Identity, by default. */
export type Finalizer = (draft: string, request: AssemblyRequest) => string | Promise<string>;

export const trimFinalizer: Finalizer = (draft) => draft.trim();
