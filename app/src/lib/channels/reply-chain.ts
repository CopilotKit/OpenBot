import type { Message } from "@ag-ui/core";
import {
  type MessageReply,
  splitMessageReplies,
} from "@openbot/shared/message-reply";

export type ChainMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};
/** Explicit reply links plus the assistant response to each reply form a connected chain. */
export function replyChain(
  messages: readonly Message[],
  selected: MessageReply,
  speakerByMessage?: ReadonlyMap<string, string>,
): ChainMessage[] {
  const nodes = new Map<string, ChainMessage>();
  const edges = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a)?.add(b);
    edges.get(b)?.add(a);
  };
  let replyingUser: string | undefined;
  let previousAssistant: string | undefined;
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const raw =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : "";
    const parsed = splitMessageReplies(raw);
    nodes.set(message.id, {
      id: message.id,
      role: message.role,
      text: parsed.text,
    });
    if (message.role === "user") {
      previousAssistant = undefined;
      replyingUser = parsed.replies.length ? message.id : undefined;
      for (const reply of parsed.replies) {
        if (!nodes.has(reply.messageId))
          nodes.set(reply.messageId, {
            id: reply.messageId,
            role: "assistant",
            text: reply.text,
          });
        link(message.id, reply.messageId);
      }
    } else {
      if (replyingUser) link(message.id, replyingUser);
      if (
        previousAssistant &&
        (!speakerByMessage ||
          speakerByMessage.get(previousAssistant) ===
            speakerByMessage.get(message.id))
      )
        link(message.id, previousAssistant);
      previousAssistant = message.id;
    }
  }
  if (!nodes.has(selected.messageId))
    nodes.set(selected.messageId, {
      id: selected.messageId,
      role: "assistant",
      text: selected.text,
    });
  const connected = new Set([selected.messageId]);
  for (const id of connected)
    for (const neighbor of edges.get(id) ?? []) connected.add(neighbor);
  // Snapshot-only ancestors come first; loaded messages keep their transcript order.
  const loaded = new Set(messages.map((message) => message.id));
  return [...nodes.values()]
    .filter((node) => connected.has(node.id) && node.text.trim())
    .sort((a, b) => Number(loaded.has(a.id)) - Number(loaded.has(b.id)));
}
