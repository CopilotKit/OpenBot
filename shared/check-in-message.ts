/**
 * A check-in that found something, saying so in its own conversation: the marker a Bot's message
 * carries when it is the check-in speaking first, and what the transcript reads back out of it.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `./handoff-markers.ts` sets out at length
 * and `./connect-prompt.ts` follows. The message reaches the transcript as a Bot's text like any
 * other, so a renderer can only tell it from an ordinary reply by how it starts. Whatever writes the
 * message builds it with {@link checkInMessage} and the transcript reads it with
 * {@link readCheckInMessage}, so a rewording cannot leave one side behind.
 *
 * WHY IT IS WORTH TELLING APART AT ALL. What a check-in finds is filed under Bots → Needs you,
 * behind a dot, two clicks from the conversation the person already has with that Bot. A coworker
 * who found two things in somebody's inbox would say so. The marker is what lets the transcript
 * draw that message as what it is: a quiet line saying the check-in ran, the Bot's sentence, and a
 * card for each thing it raised, with the same answers the board gives.
 *
 * IT NAMES, AND CARRIES NOTHING ELSE. The check-in and the items are ids, and the one other field
 * is an instant. An item's title, its reason and whether it is still open are asked of the server
 * when the card is drawn, as `AppAccessCard` asks for an app's state, so a message scrolled back to
 * a week later says what is true now and never offers Work on it for something already started.
 * It is also what keeps the JSON free of anything a person or a model wrote, which is why the
 * reader can end the object at its first closing brace.
 */

/** The first characters of the message, immediately followed by its JSON. */
export const CHECK_IN_MESSAGE_MARKER = "[check-in]";

export type CheckInMessage = {
  /** The check-in that ran, as the API names it (`CheckIn.id`). */
  checkInId: string;
  /** When that run looked, as an ISO instant: what "Check-in ran." says the time of. */
  ranAt: string;
  /**
   * The items that run raised, as the API names them (`CheckInItem.id`), in the order the cards
   * are drawn. Never empty: a check-in that found nothing says nothing.
   */
  itemIds: string[];
  /** What the Bot said, in its own words: the sentence the cards sit under. */
  message: string;
};

/**
 * The text of a Bot's message that is a check-in speaking first.
 *
 * The sentence stays in the string, after the marker, so a reader with no card to draw (another
 * client, a search result, a transcript that cannot parse the marker) still ends on what the Bot
 * said.
 */
export function checkInMessage(said: CheckInMessage): string {
  const { checkInId, ranAt, itemIds, message } = said;
  return `${CHECK_IN_MESSAGE_MARKER}${JSON.stringify({
    checkInId,
    ranAt,
    itemIds,
  })} ${message}`;
}

/**
 * The check-in inside a Bot's message, or null for any other text.
 *
 * Fails to null on anything it does not fully recognise: a truncated marker, JSON that is not an
 * object, a check-in with no id, a time that is no instant, a list that is empty or holds anything
 * but ids. Every field is needed to draw the message, so none is dropped and guessed around: cards
 * drawn from a half-read list would be fewer than the sentence above them counts.
 *
 * A marker anywhere but the very start is somebody quoting one, and reads as the reply it is.
 */
export function readCheckInMessage(
  text: string | undefined | null,
): CheckInMessage | null {
  if (!text?.startsWith(CHECK_IN_MESSAGE_MARKER)) return null;
  const rest = text.slice(CHECK_IN_MESSAGE_MARKER.length);
  const end = rest.indexOf("}");
  if (end < 0) return null;
  try {
    const parsed: unknown = JSON.parse(rest.slice(0, end + 1));
    if (!parsed || typeof parsed !== "object") return null;
    const { checkInId, ranAt, itemIds } = parsed as {
      checkInId?: unknown;
      ranAt?: unknown;
      itemIds?: unknown;
    };
    if (typeof checkInId !== "string" || !checkInId) return null;
    if (typeof ranAt !== "string" || Number.isNaN(Date.parse(ranAt)))
      return null;
    if (!Array.isArray(itemIds) || itemIds.length === 0) return null;
    if (!itemIds.every((id) => typeof id === "string" && id)) return null;
    return {
      checkInId,
      ranAt,
      // An id named twice is one item, and is drawn once.
      itemIds: [...new Set(itemIds as string[])],
      message: rest.slice(end + 1).trim(),
    };
  } catch {
    return null;
  }
}

/**
 * Whether a message still being written has begun as a check-in's and its JSON is not all here.
 *
 * A message that reaches the transcript in pieces spends a moment as `[check-in]{"checkInId":"ch`,
 * which no reader can draw as a check-in yet and which nobody should be shown as a reply. This says
 * that moment is happening, so a transcript can hold the row back until the marker either reads or
 * turns out not to be one. True from the marker's first character, which costs an ordinary reply
 * that happens to open with a bracket one character of waiting.
 *
 * Only ever a question about text in flight. Once its JSON has closed, or the message has ended,
 * {@link readCheckInMessage} is the whole answer, and what it will not read is drawn as written.
 */
export function checkInMessageArriving(text: string): boolean {
  if (!text) return false;
  if (!text.startsWith(CHECK_IN_MESSAGE_MARKER))
    return CHECK_IN_MESSAGE_MARKER.startsWith(text);
  return !text.includes("}", CHECK_IN_MESSAGE_MARKER.length);
}
