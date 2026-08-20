import type { Message } from "@ag-ui/core";
import { newId } from "../new-id";

/**
 * Insert explanatory tool results for unanswered tool calls before sending history to providers.
 */

const UNANSWERED =
  "This call produced no result: the surface was interrupted before it could answer. Do not assume it succeeded.";

/** A tool result message, which AG-UI models as its own role. */
type ToolResult = { role: "tool"; toolCallId: string };

function isToolResult(message: Message): message is Message & ToolResult {
  return message.role === "tool" && "toolCallId" in message;
}

/**
 * The same messages, with a result inserted for any tool call that has none.
 *
 * Returns the original array when no repair is needed.
 */
export function repairUnansweredToolCalls(
  messages: ReadonlyArray<Message>,
  newId: () => string = () => newId(),
): ReadonlyArray<Message> {
  const answered = new Set<string>();
  for (const message of messages) {
    if (isToolResult(message)) answered.add(message.toolCallId);
  }

  const missing = messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.toolCalls ?? []).some((call) => !answered.has(call.id)),
  );
  if (!missing) return messages;

  const repaired: Message[] = [];
  for (const message of messages) {
    repaired.push(message);
    if (message.role !== "assistant") continue;

    for (const call of message.toolCalls ?? []) {
      if (answered.has(call.id)) continue;
      // Immediately after the assistant message that made the call, and before any later message:
      // OpenAI requires the results to follow their calls, and some providers require the order to
      // match the `tool_calls` array as well.
      repaired.push({
        id: newId(),
        role: "tool",
        toolCallId: call.id,
        content: UNANSWERED,
      } as Message);
      // A duplicated call id may only receive one repair result.
      answered.add(call.id);
    }
  }

  return repaired;
}
