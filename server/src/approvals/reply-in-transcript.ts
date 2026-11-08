/**
 * The reply of a turn the server carried a conversation on in, as the conversation will read it.
 *
 * After the person answers an approval, the approval resume loop carries the conversation on in a
 * headless turn no browser streams (`resume-sweep.ts`), and the conversation reads its history again
 * when the channel says the Bot replied. The platform's read of a thread can trail the run that
 * wrote it, and a conversation that read the reply half written kept that half ("...shared with")
 * until it was opened again. So the channel is told only once the stored history holds the reply.
 */

/** The end of a reply, as much as is needed to tell a whole one from a half-written one. */
const REPLY_TAIL = 160;

const words = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether a thread's stored messages hold this reply to its end.
 *
 * By the end of the reply, because a half-written reply holds its beginning too; read as the Bot's
 * words joined, because a reply the turn reports is the text of every message it said. Whitespace is
 * not compared: the store and the stream may break the same words differently.
 */
export function holdsReply(
  messages: readonly { role?: unknown; content?: unknown }[],
  replyText: string,
): boolean {
  const reply = words(replyText);
  if (!reply) return true;
  const said = words(
    messages
      .filter(
        (message) =>
          message.role === "assistant" && typeof message.content === "string",
      )
      .map((message) => message.content as string)
      .join(" "),
  );
  return said.includes(reply.slice(-REPLY_TAIL));
}

/**
 * Wait until the thread's stored history holds the reply, reading it again until it does or the
 * time runs out. Giving up is not a failure: the turn has finished either way, and telling the
 * channel late is better than never.
 */
export function waitForReplyInTranscript(deps: {
  read: (input: {
    ownerUserId: string;
    threadId: string;
  }) => Promise<readonly { role?: unknown; content?: unknown }[]>;
  everyMs?: number;
  forMs?: number;
}) {
  const everyMs = deps.everyMs ?? 250;
  const forMs = deps.forMs ?? 10_000;
  return async (input: {
    ownerUserId: string;
    threadId: string;
    replyText: string;
  }) => {
    const deadline = Date.now() + forMs;
    for (;;) {
      const messages = await deps.read(input).catch(() => null);
      if (messages && holdsReply(messages, input.replyText)) return;
      if (Date.now() + everyMs > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
  };
}
