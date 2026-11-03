/**
 * The part of a shared thread that one responsibility's turn is sent: its own earlier firings and
 * what answered each of them, and nothing else.
 *
 * WHY THIS EXISTS. Every responsibility of one Bot in one conversation runs in the SAME Intelligence
 * thread — the (person, channel) thread, because that mapping is what decides who may read it. A
 * headless turn seeds the whole thread as history, so each run was sent every earlier run of every
 * goal. Measured with a real model: 16 runs over 4 goals, the first call's input went 10k → 29k
 * tokens, about 1.8k more per run, which fills a 200k context after roughly 110 runs — and lets one
 * goal's data leak into another goal's judgement.
 *
 * WHAT IS KEPT. The thread is cut into SEGMENTS at each user message: a segment is that user message
 * and every assistant, tool and activity message after it, up to the next user message. A segment is
 * kept only if its user message is a firing of THIS responsibility, as {@link readResponsibilityTurn}
 * reads it (the id is the last thing the server appends, after the untrusted event data, so the
 * event cannot decide it). Segments are kept or dropped WHOLE, which is what keeps a tool call and its
 * result together: the model API only pairs a result with a call inside the same user-to-user span.
 *
 * WHAT IS DROPPED, and why that is safe:
 *  - other goals' segments: they are other goals' business;
 *  - the person's own chat in the channel, and anything before the first user message. A
 *    responsibility turn is self-contained: its message carries the instruction, the success
 *    criteria, the progress recorded so far (from the database, not the thread) and the event. The
 *    person's steering of a goal belongs in its instruction or criteria, where it survives; a chat
 *    line is not where a standing goal reads its orders.
 *
 * READ-SIDE ONLY. Nothing is removed from the platform: the thread still holds every row and the
 * person still reads all of it. Ids are never changed, so `persistedInputMessages`' id subtraction in
 * `run-turn.ts` — which is computed against the WHOLE history, not this filtered view — still
 * persists exactly the new messages.
 *
 * The result is sanitized again, because a segment of this goal can itself hold a call an interrupted
 * run left dangling, and a dangling call makes the provider refuse the whole request.
 */
import type { Message } from "@ag-ui/client";
import { readResponsibilityTurn } from "@openbot/shared/responsibility-turn";
import { sanitizeSeededHistory } from "./history-sanitize";

/** The text of a user message, whether it was stored as a string or as text parts. */
function textOf(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

/** Whether this message opens a segment that belongs to the given responsibility. */
function isFiringOf(message: Message, responsibilityId: string): boolean {
  return (
    readResponsibilityTurn(textOf(message))?.responsibilityId ===
    responsibilityId
  );
}

/** This responsibility's own segments of the thread, in order, ready to seed its next turn. */
export function responsibilityHistory(
  messages: readonly Message[],
  responsibilityId: string,
): Message[] {
  const kept: Message[] = [];
  let keeping = false;
  for (const message of messages) {
    if (message.role === "user")
      keeping = isFiringOf(message, responsibilityId);
    if (keeping) kept.push(message);
  }
  return sanitizeSeededHistory(kept);
}
