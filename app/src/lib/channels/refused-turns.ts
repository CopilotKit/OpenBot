import type { Message } from "@ag-ui/core";
import { frameBrief, readBrief } from "@openbot/shared/orchestration";
import { frameFiring, readFiring } from "@openbot/shared/routine-firing";
import type { RefusedTurn } from "./queries";

/**
 * The conversation as the transcript draws it, with the turns the server refused put back.
 *
 * Nothing of a refused turn reaches the thread: the run was refused before it started. So after a
 * reload the person's message was gone, and the notice that said why with it. The server keeps
 * each refused turn (`listRefusedTurns`), and this puts it back where it was sent:
 *
 * - its message after `afterMessageId`, or after the thread's messages where that is null or names
 *   a message this thread doesn't hold. Refused turns after the same message go oldest first, and
 *   a turn sent after an earlier refused one follows it.
 * - the person's message as a message they sent; what a routine asked as the transcript draws a
 *   routine's turn ("Routine ran." and its instruction, `readFiring`); what a task asked as a
 *   task's brief (sent from the Bot, `readBrief`). Each is framed the way its own turn is when it
 *   does run, so the transcript's own readers draw it.
 * - a message the thread already holds (the live turn, before a reload) is not drawn twice.
 * - the refusal, by the id of the message it answers (`refusals`), drawn under that message. A
 *   turn with no message has its notice under the message it came after.
 */
export function withRefusedTurns(
  messages: readonly Message[],
  turns: readonly RefusedTurn[],
): { messages: Message[]; refusals: Map<string, string> } {
  const refusals = new Map<string, string>();
  if (turns.length === 0) return { messages: [...messages], refusals };
  const held = new Set(messages.map((message) => message.id));
  /** The messages to draw after each message, by its id; `null` for after the last. */
  const after = new Map<string | null, Message[]>();
  const oldestFirst = [...turns].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  for (const turn of oldestFirst) {
    const anchor =
      turn.afterMessageId !== null && held.has(turn.afterMessageId)
        ? turn.afterMessageId
        : null;
    if (turn.message === null) {
      // Nothing was said: the notice goes under the message the turn came after.
      const under = anchor ?? messages.at(-1)?.id;
      if (under !== undefined && !refusals.has(under))
        refusals.set(under, turn.detail);
      continue;
    }
    const id = turn.message.id ?? `refused-turn:${turn.id}`;
    if (!held.has(id)) {
      const drawn: Message = {
        id,
        role: "user",
        content: asked(turn.initiator, turn.message.text),
      };
      after.set(anchor, [...(after.get(anchor) ?? []), drawn]);
      held.add(id);
    }
    refusals.set(id, turn.detail);
  }
  const shown: Message[] = [];
  const emit = (message: Message) => {
    shown.push(message);
    for (const next of after.get(message.id) ?? []) emit(next);
  };
  for (const message of messages) emit(message);
  for (const message of after.get(null) ?? []) emit(message);
  return { messages: shown, refusals };
}

/** What a refused turn asked, framed as its own kind of turn is, so the transcript draws it so. */
function asked(initiator: string, text: string): string {
  if (initiator === "routine")
    return readFiring(text) !== null ? text : frameFiring(text);
  if (initiator === "task")
    return readBrief(text) !== null ? text : frameBrief(text);
  return text;
}
