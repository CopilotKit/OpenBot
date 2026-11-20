import { checkInWords } from "./check-in-message";

/**
 * What a conversation is called before it has a name: the person's first words, or its last message
 * where nobody spoke first (a routine's own conversation, say). Undefined for one nobody has used.
 *
 * Not the last message alone, which by the time anybody looks is usually the Bot's reply: a new
 * conversation used to be called by its answer, Markdown and all, until naming finished, and for
 * good when naming gave up. The server writes both lines as plain text.
 *
 * A last message that is a check-in speaking first names the conversation by the Bot's sentence,
 * never by the marker in front of it: a conversation a check-in opened for itself has no first
 * words from a person, so until it has a name this line is all its row says. See `checkInWords`.
 *
 * Here rather than in the app so the server's tests read a roster row the way the sidebar does.
 */
export function untitledLine(channel: {
  opening?: string | null;
  lastMessage?: string | null;
}): string | undefined {
  return (
    channel.opening?.trim() ||
    checkInWords(channel.lastMessage ?? "").trim() ||
    undefined
  );
}
