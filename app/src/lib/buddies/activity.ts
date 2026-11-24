import type { Message } from "@ag-ui/core";
import type { BuddyActivity } from "./buddy";

/**
 * What a conversation's Bot is doing, as its buddy plays it: waiting on the person while a question
 * is open; while a turn runs, thinking until it does something, working while a step it called has
 * no result yet, and talking while it writes its answer; else idle. "Done", the moment after a turn,
 * is the caller's, since it needs a clock (`useConversationBuddyActivity`).
 */
export function conversationActivity({
  busy,
  waiting,
  messages,
}: {
  busy: boolean;
  waiting: boolean;
  messages: readonly Message[];
}): BuddyActivity {
  if (waiting) return "waiting";
  if (!busy) return "idle";
  // The turn's own messages: everything after the person's last one.
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role !== "user") start--;
  const turn = messages.slice(start);
  const answered = new Set(
    turn.flatMap((message) =>
      message.role === "tool" ? [message.toolCallId] : [],
    ),
  );
  const last = turn.at(-1);
  if (!last) return "thinking";
  if (last.role === "tool") return "thinking";
  if (last.role !== "assistant") return "thinking";
  if ((last.toolCalls ?? []).some((call) => !answered.has(call.id)))
    return "working";
  return typeof last.content === "string" && last.content.trim()
    ? "talking"
    : "thinking";
}
