/**
 * What a message says, whichever shape it says it in.
 *
 * A MESSAGE IS NOT ALWAYS A STRING. AG-UI's user message takes `string | InputContent[]`, and the
 * platform types a thread message's content as unknown "structured AG-UI content". Nothing in this
 * deployment writes an array yet, which is exactly why a `typeof content === "string"` test looks
 * complete: the day attachments ship, every message carrying one silently stops counting wherever
 * that test is made.
 *
 * Two places were making it — the tool selector, reading the message it is choosing tools for, and a
 * hop, deciding what of a conversation to carry across. They are the same question and are answered
 * here once.
 *
 * Only text is taken. A part this does not understand contributes nothing rather than being guessed
 * at, and is dropped before joining so an image between two sentences does not leave a double space
 * in the middle of the one thing the caller reads.
 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part !== "object" || part === null) return "";
      const { text } = part as { text?: unknown };
      return typeof text === "string" ? text : "";
    })
    .filter((part) => part !== "")
    .join(" ")
    .trim();
}
