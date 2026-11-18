import type { Message } from "@ag-ui/core";

/**
 * Whether a turn that failed had already done something: said something, or called a tool.
 *
 * A failed send puts the person's words back in the box, or back in the queue, so they can send
 * them again (`deliver` in channel-chat.tsx). That is right for a turn that never got going: a
 * refused request, a gateway that answered 503. It is wrong for a turn that worked for minutes
 * first. FOUND IN DOGFOODING: a Bot looked up HubSpot deals for five minutes and then failed, and
 * the same message came back ready to send. Sent again, the whole request runs from the start and
 * repeats what already ran, writes included. The message stays sent, the failure is said under the
 * turn, and the person decides what to ask next.
 *
 * `before` is every message the conversation held when the turn began.
 */
export function turnDidWork(
  messages: readonly Message[],
  before: ReadonlySet<string>,
): boolean {
  return messages.some((message) => {
    if (before.has(message.id)) return false;
    if (message.role === "tool") return true;
    if (message.role !== "assistant") return false;
    if ((message.toolCalls?.length ?? 0) > 0) return true;
    return typeof message.content === "string" && message.content.trim() !== "";
  });
}
