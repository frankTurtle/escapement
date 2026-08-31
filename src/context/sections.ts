import { messageText, type Message, type Role } from "../core/messages.ts";

export type ContextItem = {
  readonly id: string;
  readonly message: Message;
  /** Relevance, where the section's source computed one. Used for ordering. */
  readonly score?: number;
};

export const Overflow = {
  /** Skip the item and try the next one. Smaller items may still fit. */
  Drop: "drop",
  /** Cut the item down to the space left, then stop. */
  Truncate: "truncate",
} as const;

export type OverflowPolicy = (typeof Overflow)[keyof typeof Overflow];

export type SectionRender =
  | { readonly mode: "messages" }
  | { readonly mode: "block"; readonly role: Role; readonly header?: string; readonly separator?: string };

export type Section = {
  readonly id: string;
  /**
   * Allocation precedence under contention. Lower wins. This is *not* where the
   * section appears in the window — that is `order`. Conflating the two is why
   * naive assemblers drop the wrong thing: the most important content
   * (the latest turn) is usually rendered last.
   */
  readonly priority: number;
  /** Position in the rendered window. Defaults to `priority`. */
  readonly order?: number;
  /**
   * Required and complete. Pinned sections are allocated first and are never
   * truncated or partially included. If the pinned set does not fit, assembly
   * fails rather than silently shortening something you declared essential.
   */
  readonly pinned?: boolean;
  /** Fair-share cap on the discretionary pool, 0..1. Applied only while
   *  sections are competing; leftover space ignores it. */
  readonly maxShare?: number;
  /** Below this allocation the section contributes nothing. Half a retrieved
   *  document is worse than none. */
  readonly minTokens?: number;
  readonly overflow?: OverflowPolicy;
  readonly items: readonly ContextItem[];
  readonly render?: SectionRender;
  /** Rendered into the window when items were left out. */
  readonly elisionNote?: (dropped: number) => string;
};

export const itemText = (item: ContextItem): string => messageText(item.message);

export function textItem(id: string, role: "system" | "user" | "assistant", content: string, score?: number): ContextItem {
  const message = { role, content } as Message;
  return score === undefined ? { id, message } : { id, message, score };
}

export function messageItem(id: string, message: Message, score?: number): ContextItem {
  return score === undefined ? { id, message } : { id, message, score };
}
