import type { Message } from "@ag-ui/core";

/** A user message starts a turn; tool results belong to the assistant turn they complete. */
export function assistantTurn(messages: readonly Message[], messageId: string) {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  let start = index;
  while (start > 0 && messages[start - 1]?.role !== "user") start--;
  let end = index + 1;
  while (end < messages.length && messages[end]?.role !== "user") end++;
  const answers = messages
    .slice(start, end)
    .filter((message) => message.role === "assistant");
  return {
    messageId: answers.at(-1)?.id ?? messageId,
    text: answers
      .map((message) =>
        typeof message.content === "string" ? message.content.trim() : "",
      )
      .filter(Boolean)
      .join("\n\n"),
    settled: end < messages.length,
  };
}
