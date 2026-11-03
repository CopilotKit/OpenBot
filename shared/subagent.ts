/**
 * A subagent: a fresh run of the same Bot, as the same person, given one piece of a larger answer.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES. The server runs `run_subagent` and answers the Bot that
 * called it with the result below; the browser draws the call's card from that same result, and
 * finds the subagent's own thread by the same derivation while it is still working, before any
 * result exists.
 */

/** What the model is offered. One name, so a transcript can find every subagent by searching for it. */
export const SUBAGENT_TOOL = "run_subagent";

/** How many subagents one answer may start. The next one is refused with a sentence. */
export const SUBAGENTS_PER_ANSWER = 5;

/** What a subagent hands back to the Bot that started it, and what its card is drawn from. */
export type SubagentResult =
  /** It finished: its answer, and where its steps are. */
  | { answer: string; threadId: string; steps: number }
  /**
   * It stopped before an action that needs the person's yes. Nothing was done and nobody was asked;
   * `next` tells the Bot to do it itself, in the conversation, where the person is asked as usual.
   */
  | {
      handedBack: {
        /** The tool it called, by the name the model is offered. */
        tool: string;
        args: unknown;
        /** Why it stopped, as the approval gate said it. */
        reason: string;
        /** What it had said before stopping, if anything: the why, in its own words. */
        said?: string;
      };
      next: string;
      threadId: string;
      steps: number;
    }
  /** It ran and did not finish. */
  | { error: string; threadId: string; steps: number };

/** The result, read back from the text a tool call carries, or null when it is not one. */
export function readSubagentResult(text: string): SubagentResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    // The runtime may carry a tool's string answer encoded once more.
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const result = parsed as Record<string, unknown>;
  if (typeof result.threadId !== "string" || typeof result.steps !== "number")
    return null;
  if (typeof result.answer === "string") return result as SubagentResult;
  if (typeof result.error === "string") return result as SubagentResult;
  const handedBack = result.handedBack as Record<string, unknown> | undefined;
  if (
    handedBack &&
    typeof handedBack === "object" &&
    typeof handedBack.tool === "string" &&
    typeof handedBack.reason === "string" &&
    typeof result.next === "string"
  )
    return result as SubagentResult;
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The thread a subagent runs in: its own, derived from the conversation and the call that started it.
 *
 * DERIVED RATHER THAN MINTED, so the browser can find it while the subagent is still working. A call
 * on screen knows its conversation and its own id and nothing else until its result arrives, and
 * the result is what arrives last. Both sides compute it the same way from those two values.
 *
 * A UUID because every thread id this deployment mints is one, and version 8 for the reason
 * `channels/thread-identity.ts` gives: these bits are not random. The first six bytes are the
 * parent's when the parent is a UUID, so a subagent's thread carries the same deployment fingerprint
 * as the conversation it belongs to.
 *
 * Nothing here is a secret. A thread is read as its owner only, so knowing the id reaches nothing.
 */
export async function subagentThreadId(
  parentThreadId: string,
  toolCallId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${SUBAGENT_TOOL}\n${parentThreadId}\n${toolCallId}`,
      ),
    ),
  );
  const bytes = digest.slice(0, 16);
  if (UUID.test(parentThreadId)) {
    const hex = parentThreadId.replaceAll("-", "");
    for (let index = 0; index < 6; index += 1)
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
