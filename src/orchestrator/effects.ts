import type { ToolCall } from "../core/messages.ts";
import type { AssembledContext } from "./state.ts";

/**
 * The reducer's only way to touch the world (ADR-0006).
 *
 * An effect is a *request*, described as data: "call the model with this
 * context", not "here is a promise that is already running". The reducer builds
 * them and returns them; the runtime executes them and feeds the outcome back
 * as an event. That is the seam that makes the reducer pure and replay exact.
 */
export type Effect =
  | { readonly kind: "assemble" }
  | { readonly kind: "call-model"; readonly context: AssembledContext; readonly attempt: number }
  | { readonly kind: "execute-tools"; readonly calls: readonly ToolCall[] }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "finalize"; readonly draft: string };

export type EffectKind = Effect["kind"];

export const effectKinds = (effects: readonly Effect[]): readonly EffectKind[] => effects.map((e) => e.kind);
