import type { ActivityMessage, Message, ToolCall } from "@ag-ui/core";

/**
 * Transcript projection that pairs assistant tool calls with later tool-result messages.
 */

export type VisibleChatItem =
  | { kind: "text"; id: string; role: "user" | "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      toolCall: ToolCall;
      /** The result, once there is one. Absent means the call is still in flight. */
      result?: string;
    }
  /**
   * Something a Bot is drawing rather than saying.
   *
   * Carried whole rather than projected into fields of our own, because what is inside an activity
   * belongs to whoever renders it: an interface a Bot generated arrives here as partial HTML that
   * grows on every chunk, and the renderer that paints it is the one that knows what a half-finished
   * one looks like. Reshaping it on the way past would mean this file had to understand every
   * activity type anybody registers.
   */
  | { kind: "activity"; id: string; message: ActivityMessage };

/**
 * The SDK's own tool for drawing an interface, whose output is an activity rather than a result.
 *
 * Named here rather than imported because the SDK exports the renderer and the argument schema but
 * not the tool name; it is the string the runtime middleware matches on to emit the activity.
 */
const GENERATE_SANDBOXED_UI = "generateSandboxedUi";

/** A tool result, as it arrives, its own message, pointing back at the call it answers. */
type ToolResultMessage = { role: "tool"; toolCallId: string; content?: string };

function isToolResult(
  message: Readonly<Message>,
): message is Readonly<Message> & ToolResultMessage {
  return message.role === "tool" && "toolCallId" in message;
}

export function toVisibleChatItems(
  messages: ReadonlyArray<Readonly<Message>>,
): VisibleChatItem[] {
  // Gather results first so calls render with their current completion state in the same pass.
  const results = new Map<string, string | undefined>();
  for (const message of messages) {
    if (isToolResult(message)) results.set(message.toolCallId, message.content);
  }

  return messages.flatMap((message): VisibleChatItem[] => {
    if (message.role === "assistant") {
      const items: VisibleChatItem[] = [];
      if (message.content) {
        items.push({
          kind: "text",
          id: message.id,
          role: "assistant",
          text: message.content,
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        /*
         * The call that draws an interface is not a row of its own; the interface is.
         *
         * Its renderer shows the waiting message and then returns nothing, so once the interface has
         * arrived this leaves an empty item behind — invisible in itself, but still a child of a
         * `gap-6` column, so every generated interface gained a stray gap under it. The activity
         * beside it already shows its own progress while it is being written.
         */
        if (toolCall.function.name === GENERATE_SANDBOXED_UI) continue;
        items.push({
          kind: "tool",
          // One assistant message can carry multiple tool calls.
          id: toolCall.id,
          toolCall,
          ...(results.has(toolCall.id)
            ? { result: results.get(toolCall.id) }
            : {}),
        });
      }
      return items;
    }

    /*
     * Activities are their own messages, in order, beside the prose.
     *
     * Kept rather than dropped, which is what this projection used to do with every role it did not
     * name. A Bot that draws its own interface says nothing in `content` and calls no tool the
     * transcript can pair a result with — the whole answer is the activity. Falling through to the
     * bail below meant the turn rendered as silence.
     */
    if (message.role === "activity") {
      return [{ kind: "activity", id: message.id, message }];
    }

    if (message.role !== "user") return [];

    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");

    return text ? [{ kind: "text", id: message.id, role: "user", text }] : [];
  });
}
