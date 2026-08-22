/**
 * The conversation AG-UI carries, as the shape the model provider expects.
 *
 * Its own module so it can be tested without starting a server: `index.ts` calls `serve()` at module
 * scope, so importing it to reach one pure function binds a port. `agent-langgraph/src/history.ts`
 * and `agent-computer/src/control.ts` were split out for the same reason.
 */
import type { RunAgentInput } from "@ag-ui/core";
import type OpenAI from "openai";
import { COMPUTER_GUIDANCE, NO_ANSWER_CAME } from "../../shared/bot-prompt";

export { NO_ANSWER_CAME };

/** Translate the conversation AG-UI carries into the shape the model provider expects. */
export function toProviderMessages(
  input: RunAgentInput,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: COMPUTER_GUIDANCE },
  ];

  /*
   * Which calls in this history were ever answered.
   *
   * Collected up front because an answer arrives as a later message than the call it answers. See
   * `NO_ANSWER_CAME` for what happens to a conversation carrying a call nothing ever answered.
   */
  const answered = new Set(
    input.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message as { toolCallId?: string }).toolCallId)
      .filter((id): id is string => Boolean(id)),
  );

  for (const message of input.messages) {
    if (message.role === "user") {
      messages.push({ role: "user", content: String(message.content ?? "") });
      continue;
    }
    if (message.role === "system" || message.role === "developer") {
      messages.push({ role: "system", content: String(message.content ?? "") });
      continue;
    }
    if (message.role === "tool") {
      // Tool results are appended so the model can continue from the completed call.
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: String(message.content ?? ""),
      });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.function.name,
          arguments: call.function.arguments,
        },
      }));
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      });

      /*
       * Close any of its calls that nothing ever answered, immediately after it.
       *
       * Position is not cosmetic: a tool result has to follow the assistant message that made the
       * call, so these go here rather than being appended at the end. A call answered later in the
       * history is left alone and its real answer arrives in its own turn.
       */
      for (const call of message.toolCalls ?? []) {
        if (call.id && !answered.has(call.id)) {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: NO_ANSWER_CAME,
          });
        }
      }
    }
  }

  return messages;
}
