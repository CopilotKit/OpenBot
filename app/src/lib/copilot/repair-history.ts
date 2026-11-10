import type { Message } from "@ag-ui/core";
import { notRun } from "@openbot/shared/approval-outcomes";
import { newId } from "../new-id";
import { withoutWaitingPlaceholders } from "./approval-context";

/**
 * Insert explanatory tool results for unanswered tool calls before sending history to providers.
 */

/**
 * What a call nothing answered is answered with, in the voice of every "not run" result (see
 * `notRun`). It used to say only "Do not assume it succeeded", and a Bot told that much did nothing
 * with the gap: it neither fetched the thing again nor said in its answer that it was missing.
 */
export const UNANSWERED = notRun(
  "no result came back for this call before the conversation moved on.",
);

/** A tool result message, which AG-UI models as its own role. */
type ToolResult = { role: "tool"; toolCallId: string };

function isToolResult(message: Message): message is Message & ToolResult {
  return message.role === "tool" && "toolCallId" in message;
}

/**
 * The tool calls in these messages that nothing here answers yet. A held step's stand-in is not an
 * answer (see `withoutWaitingPlaceholders`).
 */
export function unansweredToolCalls(
  messages: ReadonlyArray<Message>,
): ReadonlySet<string> {
  const answered = new Set<string>();
  for (const message of withoutWaitingPlaceholders(messages))
    if (isToolResult(message)) answered.add(message.toolCallId);
  const unanswered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? [])
      if (!answered.has(call.id)) unanswered.add(call.id);
  }
  return unanswered;
}

/**
 * This browser's copy of a conversation, with each call it holds no answer for answered from the
 * stored thread when the store has the answer.
 *
 * A CALL WITH NO ANSWER HERE IS USUALLY ONE THAT ANSWERED SOMEWHERE ELSE. A Bot's own tools run on
 * the server, and their answers reach this copy only through the stream it is joined to. Opened, or
 * opened again, while the Bot was part way through a step, a conversation can be left holding the
 * step's calls and only the answers that had arrived by then: found live, 20 lookups sent together,
 * 11 answered on screen and 9 still running when the person came back to it. The server finished
 * all 20 and stored them; this copy never heard. The next message then went out with
 * {@link repairUnansweredToolCalls}'s "interrupted" sentence for those 9, and the Bot told the
 * person that 9 of its lookups had failed for no reason it could name, when every one had answered.
 *
 * So the stored answer is put in its place, and only a call the store has no answer for either is
 * left for the repair to explain. Each answer goes after the answers already following its call,
 * so the call's message keeps its answers together and in front of anything said after it.
 *
 * Returns `local` itself when nothing was added.
 */
export function withStoredAnswers(
  local: Message[],
  stored: ReadonlyArray<Message>,
): Message[] {
  const unanswered = unansweredToolCalls(local);
  if (unanswered.size === 0) return local;
  const found = new Map<string, Message>();
  for (const message of withoutWaitingPlaceholders(stored)) {
    if (!isToolResult(message)) continue;
    if (!unanswered.has(message.toolCallId) || found.has(message.toolCallId))
      continue;
    found.set(message.toolCallId, message);
  }
  if (found.size === 0) return local;

  const merged: Message[] = [];
  for (let index = 0; index < local.length; index++) {
    const message = local[index] as Message;
    merged.push(message);
    if (message.role !== "assistant") continue;
    const answers = (message.toolCalls ?? []).flatMap((call) => {
      const answer = found.get(call.id);
      return answer ? [answer] : [];
    });
    if (answers.length === 0) continue;
    // After the answers already following this message, which belong to it.
    while (local[index + 1]?.role === "tool") {
      index++;
      merged.push(local[index] as Message);
    }
    merged.push(...answers);
  }
  return merged;
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
  given: ReadonlyArray<Message>,
  /*
   * Named so it cannot shadow the import it defaults to. A parameter called `newId` defaulting to
   * `newId()` resolves to itself and recurses until the stack goes, and it does so only on the
   * repair branch, which every test avoided by passing its own. Biome said so, as an unused import.
   */
  mintId: () => string = newId,
): ReadonlyArray<Message> {
  /*
   * A held step's stand-in is not its answer. Counted as one, it sat right after the call, so the
   * real answer the server's continuation put in later read as a second answer and was dropped as
   * misplaced: the next message went out with no answer for the step, and the transcript drew a
   * declined file save as "Saved file". See `withoutWaitingPlaceholders`.
   */
  const messages = withoutWaitingPlaceholders(given);
  const changed = messages.length !== given.length;
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
  if (!missing && misplaced.size === 0) return changed ? messages : given;

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
