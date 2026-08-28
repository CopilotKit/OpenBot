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
 * The same messages, with every tool call answered by a result that FOLLOWS it.
 *
 * Returns the original array when no repair is needed.
 *
 * POSITION IS THE WHOLE POINT, and it was the half this function did not check. It decided which
 * calls were answered by collecting every tool result in the array regardless of where it sat, so a
 * result stored BEFORE its own call marked that call answered and the array was returned untouched.
 * A provider matches a result to the call above it, so what it saw was a call with nothing after it:
 * `AI_MissingToolResultsError`, thrown while converting the prompt, which fails the whole
 * conversation rather than one turn. Every later message in that channel then failed the same way,
 * including "what is 2 plus 2" — the conversation was dead for good and said only that a tool result
 * was missing.
 *
 * Threads really are stored that way. Read back from the platform after a Bot handed work to another
 * Bot, the result sat three messages ahead of the call that produced it, and the same inversion held
 * for `ask_person` and for an MCP tool call; only the computer's own tools came back in order. So
 * this is not a hypothetical ordering: it is what a transcript looks like after using the features
 * this release is named for.
 *
 * An early result is MOVED rather than replaced, because it is the real one — "Handed to Knowledge"
 * says more than this function's apology ever could. Only a call with no result anywhere gets the
 * sentence below. A result whose call never appears at all is dropped: it answers nothing, and a
 * provider rejects it for the same reason it rejects the mirror image.
 */
export function repairUnansweredToolCalls(
  messages: ReadonlyArray<Message>,
  /*
   * Named so it cannot shadow the import it defaults to. A parameter called `newId` defaulting to
   * `newId()` resolves to itself and recurses until the stack goes, and it does so only on the
   * repair branch, which every test avoided by passing its own. Biome said so, as an unused import.
   */
  mintId: () => string = newId,
): ReadonlyArray<Message> {
  const called = new Set<string>();
  /** Answered where a provider can see it: by a result later in the array than the call. */
  const answered = new Set<string>();
  /** A real result that arrived before its own call, kept so it can be put back in the right place. */
  const early = new Map<string, Message>();
  /** Results that answer nothing where they sit, and so must not be sent where they sit. */
  const misplaced = new Set<Message>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) called.add(call.id);
      continue;
    }
    if (!isToolResult(message)) continue;
    const id = message.toolCallId;
    if (called.has(id) && !answered.has(id)) {
      answered.add(id);
      continue;
    }
    // Before its call, or a second result for a call already answered, or answering no call at all.
    if (!early.has(id)) early.set(id, message);
    misplaced.add(message);
  }

  const missing = messages.some(
    (message) =>
      message.role === "assistant" &&
      (message.toolCalls ?? []).some((call) => !answered.has(call.id)),
  );
  if (!missing && misplaced.size === 0) return messages;

  const repaired: Message[] = [];
  const filled = new Set(answered);
  for (const message of messages) {
    if (misplaced.has(message)) continue;
    repaired.push(message);
    if (message.role !== "assistant") continue;

    for (const call of message.toolCalls ?? []) {
      if (filled.has(call.id)) continue;
      // Immediately after the assistant message that made the call, and before any later message:
      // OpenAI requires the results to follow their calls, and some providers require the order to
      // match the `tool_calls` array as well.
      const moved = early.get(call.id);
      repaired.push(
        moved ??
          ({
            id: mintId(),
            role: "tool",
            toolCallId: call.id,
            content: UNANSWERED,
          } as Message),
      );
      // A duplicated call id may only receive one repair result.
      filled.add(call.id);
    }
  }

  return repaired;
}
