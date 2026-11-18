/**
 * A check-in saying something in a conversation: the marker a Bot's message carries when it is the
 * check-in speaking first, and what the transcript reads back out of it.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES, for the reason `./handoff-markers.ts` sets out at length
 * and `./connect-prompt.ts` follows. The message reaches the transcript as a Bot's text like any
 * other, so a renderer can only tell it from an ordinary reply by how it starts. Whatever writes the
 * message builds it with {@link checkInMessage} and the transcript reads it with
 * {@link readCheckInMessage}, so a rewording cannot leave one side behind.
 *
 * WHY IT IS WORTH TELLING APART AT ALL. What a check-in finds is filed under Bots → Needs you,
 * behind a dot, and nothing is said anywhere the person would look. A coworker who found two things
 * in somebody's inbox would say so. The marker is what lets the transcript draw that message as
 * what it is: a quiet line saying the check-in ran, the Bot's sentence, and under it the thing the
 * sentence is about.
 *
 * TWO THINGS A CHECK-IN HAS TO SAY, AND IT SAYS ONE OF THEM. That it found something: the items it
 * raised, each drawn as a card with the answers the board gives. Or that it could not look at all,
 * because the app it reads is not connected: that app, drawn as the card that connects it. Never
 * neither, because a check-in with nothing to say says nothing, and never both in one message.
 *
 * IT NAMES, AND CARRIES NOTHING ELSE. The check-in, the items and the app are ids, beside an
 * instant and the app's own name. An item's title, its reason and whether it is still open, and
 * whether the app has been connected since, are asked of the server when the card is drawn, as
 * `AppAccessCard` asks for an app's state. So a message scrolled back to a week later says what is
 * true now, and never offers Work on it for something already started.
 */

/** The first characters of the message, immediately followed by its JSON. */
export const CHECK_IN_MESSAGE_MARKER = "[check-in]";

/**
 * An app a check-in could not read because it is not connected, named as `./connect-prompt.ts`
 * names one, so the transcript can hand it to the same card.
 */
export type CheckInApp = {
  /** The app, as the server names it: what the card asks about (`ConnectPrompt.serverId`). */
  serverId: string;
  /** The app's own name, for a card that says what it is before its state has been read. */
  title: string;
  /**
   * The Bot whose check-in it was, so the card asks about the right one in a conversation several
   * Bots answer in. Absent, the card asks about the Bot the conversation declares.
   */
  agentId?: string;
};

/** What every check-in's message says, whichever of the two it is about. */
type Spoke = {
  /** The check-in that ran, as the API names it (`CheckIn.id`). */
  checkInId: string;
  /** When that run looked, as an ISO instant: what "Check-in ran." says the time of. */
  ranAt: string;
  /** What the Bot said, in its own words: the sentence the cards sit under. */
  message: string;
};

export type CheckInMessage = Spoke &
  (
    | {
        /**
         * The items that run raised, as the API names them (`CheckInItem.id`), in the order the
         * cards are drawn. Never empty: a check-in that found nothing says nothing.
         */
        itemIds: string[];
        app?: undefined;
      }
    | {
        /** The app that run could not read. See {@link CheckInApp}. */
        app: CheckInApp;
        itemIds?: undefined;
      }
  );

/**
 * The text of a Bot's message that is a check-in speaking first.
 *
 * The sentence stays in the string, after the marker, so a reader with no card to draw (another
 * client, a transcript that cannot parse the marker) still ends on what the Bot said.
 */
export function checkInMessage(said: CheckInMessage): string {
  const { checkInId, ranAt, message } = said;
  const about = said.app
    ? {
        app: {
          serverId: said.app.serverId,
          title: said.app.title,
          ...(said.app.agentId ? { agentId: said.app.agentId } : {}),
        },
      }
    : { itemIds: said.itemIds };
  return `${CHECK_IN_MESSAGE_MARKER}${JSON.stringify({
    checkInId,
    ranAt,
    ...about,
  })} ${message}`;
}

/**
 * Where the JSON object opening at `text[from]` closes, or -1 while it is still open or was never
 * one. Counted brace by brace and aware of strings, because the object holds another (the app) and
 * a name inside it is free to hold a brace of its own.
 */
function objectEnd(text: string, from: number): number {
  if (text[from] !== "{") return -1;
  let depth = 0;
  let quoted = false;
  for (let index = from; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === "\\") index++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/**
 * The check-in inside a Bot's message, or null for any other text.
 *
 * Fails to null on anything it does not fully recognise: a truncated marker, JSON that is not an
 * object, a check-in with no id, a time that is no instant, a list that is empty or holds anything
 * but ids, an app with no id or no name, a message about both or about neither. Every field is
 * needed to draw the message, so none is dropped and guessed around: cards drawn from a half-read
 * list would be fewer than the sentence above them counts, and a card for an app nobody named would
 * offer to connect nothing.
 *
 * The one field that is dropped rather than failing the message is the app's Bot, as
 * `readConnectPrompt` drops it: without it the card still names the right app, and asks about the
 * Bot the conversation declares.
 *
 * A marker anywhere but the very start is somebody quoting one, and reads as the reply it is.
 */
export function readCheckInMessage(
  text: string | undefined | null,
): CheckInMessage | null {
  if (!text?.startsWith(CHECK_IN_MESSAGE_MARKER)) return null;
  const start = CHECK_IN_MESSAGE_MARKER.length;
  const end = objectEnd(text, start);
  if (end < 0) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object") return null;
    const { checkInId, ranAt, itemIds, app } = parsed as {
      checkInId?: unknown;
      ranAt?: unknown;
      itemIds?: unknown;
      app?: unknown;
    };
    if (!isId(checkInId)) return null;
    if (typeof ranAt !== "string" || Number.isNaN(Date.parse(ranAt)))
      return null;
    const spoke = { checkInId, ranAt, message: text.slice(end + 1).trim() };
    // About the items it raised or the app it could not read: one of them, and never both.
    if ((itemIds === undefined) === (app === undefined)) return null;
    if (app === undefined) {
      if (!Array.isArray(itemIds) || itemIds.length === 0) return null;
      if (!itemIds.every(isId)) return null;
      // An id named twice is one item, and is drawn once.
      return { ...spoke, itemIds: [...new Set(itemIds)] };
    }
    if (!app || typeof app !== "object") return null;
    const { serverId, title, agentId } = app as {
      serverId?: unknown;
      title?: unknown;
      agentId?: unknown;
    };
    if (!isId(serverId) || !isId(title)) return null;
    return {
      ...spoke,
      app: { serverId, title, ...(isId(agentId) ? { agentId } : {}) },
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
  const start = CHECK_IN_MESSAGE_MARKER.length;
  if (text.length === start) return true;
  return text[start] === "{" && objectEnd(text, start) < 0;
}

/**
 * What a Bot's message says in words, for every place that shows a message as a line of text and
 * draws no card: a conversation's row before it has a name, the notice a reply raises, a search
 * over recent messages. A check-in's message is its sentence there. Any other text is itself.
 *
 * LENIENT WHERE {@link readCheckInMessage} IS STRICT, AND ON PURPOSE. The transcript can afford to
 * draw a marker it cannot read exactly as it was written, because that is the one place a broken
 * message ought to be seen for what it is. A sidebar row or a notification is not: nobody reading
 * `[check-in]{"checkInId":…` there learns anything, least of all what their Bot said. So whatever
 * follows the marker's JSON is the words, whether or not that JSON was all a check-in needs, and a
 * preview cut off before the JSON closed has no words left in it and reads as empty.
 */
export function checkInWords(text: string): string {
  const start = CHECK_IN_MESSAGE_MARKER.length;
  if (!text.startsWith(CHECK_IN_MESSAGE_MARKER) || text[start] !== "{")
    return text;
  const end = objectEnd(text, start);
  return end < 0 ? "" : text.slice(end + 1).trim();
}

/**
 * WHAT THE BOT WOULD DO ABOUT AN ITEM, which rides in the item's own `detail`.
 *
 * An item says what it is (`title`) and why it was raised (`detail`). Said in a conversation, there
 * is a third thing worth a line of its own: what the Bot would do if asked to work on it ("I'd
 * draft a reply accepting 2:00 PM for you to read before it's sent"). It needs no field. `detail`
 * is prose and already free to run to a second paragraph, and everything that shows one line of it
 * (the board's row, the hourly notice) shows the first. So the first paragraph is the why, and what
 * follows it, when anything does, is what the Bot would do.
 *
 * Declared here with both directions, for the reason the marker is: the side that writes an item
 * and the card that draws it have to agree on where one ends and the other starts.
 */
export type ItemDetail = {
  /** Why the item was raised and what the Bot found. */
  why: string;
  /** What the Bot would do about it, in its own words. Null when it said only why. */
  wouldDo: string | null;
};

/** An item's `detail`, with what the Bot would do as its second paragraph when there is one. */
export function itemDetail({ why, wouldDo }: ItemDetail): string {
  return wouldDo?.trim() ? `${why.trim()}\n\n${wouldDo.trim()}` : why.trim();
}

/**
 * The why and the would-do out of an item's `detail`.
 *
 * Paragraphs are parted by a blank line. Everything after the first is the would-do, kept whole: a
 * `detail` written before this meant anything is one paragraph and reads as all why, exactly as it
 * always has.
 */
export function readItemDetail(detail: string | undefined | null): ItemDetail {
  const [why = "", ...rest] = (detail ?? "").trim().split(/\n[^\S\n]*\n\s*/);
  const wouldDo = rest.join("\n\n").trim();
  return { why: why.trim(), wouldDo: wouldDo || null };
}
