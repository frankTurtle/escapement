import type { JsonObject } from "./json.ts";

export type Role = "system" | "user" | "assistant" | "tool";

/** A tool invocation the model asked for. `args` is unvalidated at this point. */
export type ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
};

export type SystemMessage = { readonly role: "system"; readonly content: string };
export type UserMessage = { readonly role: "user"; readonly content: string };

export type AssistantMessage = {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[];
};

/**
 * The result of a tool call, as the model sees it.
 *
 * Note `isError`: a failed tool call is still an *observation*, not a crash.
 * That is the `correctable` class from ADR-0005 crossing back into the
 * conversation so the model can fix its own mistake.
 */
export type ToolMessage = {
  readonly role: "tool";
  readonly callId: string;
  readonly name: string;
  readonly content: string;
  readonly isError: boolean;
};

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export const system = (content: string): SystemMessage => ({ role: "system", content });
export const user = (content: string): UserMessage => ({ role: "user", content });

export const assistant = (content: string, toolCalls?: readonly ToolCall[]): AssistantMessage =>
  toolCalls && toolCalls.length > 0 ? { role: "assistant", content, toolCalls } : { role: "assistant", content };

export const toolResult = (
  call: Pick<ToolCall, "id" | "name">,
  content: string,
  isError = false,
): ToolMessage => ({ role: "tool", callId: call.id, name: call.name, content, isError });

/** Flattens a message to the text that will actually occupy context budget. */
export function messageText(message: Message): string {
  switch (message.role) {
    case "system":
    case "user":
      return message.content;
    case "assistant": {
      const calls = message.toolCalls ?? [];
      if (calls.length === 0) return message.content;
      const rendered = calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join("\n");
      return message.content ? `${message.content}\n${rendered}` : rendered;
    }
    case "tool":
      return message.content;
  }
}
