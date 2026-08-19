/**
 * The rule for what is worth interrupting somebody for.
 *
 * A Bot that is blocked on you is worth interrupting somebody for. A Bot that is merely working is
 * not. That is the entire rule, and it is written down in one place so that a new notification has
 * to argue with it rather than being added quietly somewhere else.
 *
 * Kept small on purpose, because the worth of a notification is relative to the others. A deployment
 * that announces six things a person cannot act on has also stopped announcing the seventh, which
 * they could have: the learned response to a notification from this product becomes to dismiss it
 * without reading it. Blocked-on-a-person is the one class where the interruption buys something,
 * because nothing further happens at all until it is answered.
 *
 * Delivery is deliberately somebody else's problem. This module decides WHETHER, and produces the
 * frame; where that frame travels and which screens it reaches belongs to channels/events.ts. The
 * two are apart because they change for different reasons: this changes when somebody argues a new
 * kind of event into the product, and the transport changes when a deployment grows a second server
 * process.
 */

/** One kind of thing that could become a notification, and the product's own words for it. */
type NotificationRule = {
  /**
   * Whether nothing further happens until a person acts.
   *
   * The whole decision, and not a hint. False is a legitimate answer for a kind that is worth
   * naming in the vocabulary but not worth a person's attention, which is how a kind earns its way
   * in without every kind earning an interruption.
   */
  blocking: boolean;
  /**
   * What happened, said by the product rather than by the model.
   *
   * Fixed text, because this is the line a person reads while looking at something else, and a
   * model that has just failed to log in is not the right author for the sentence that describes
   * its own failure. What the model said goes in `detail`, where it is treated as words rather than
   * as a claim about what the product wants.
   */
  headline: string;
};

/**
 * Every kind, and whether it earns an interruption.
 *
 * A table rather than a switch so that a kind being added lands beside the ones already here and
 * has to state its `blocking` answer out loud, in the same place a reader can compare it against
 * the others. Adding "a scheduled run failed" or "a Bot is asking to be allowed to do something" is
 * an entry here and nothing else; the frame, the transport and the surface all follow from it.
 */
const KINDS = {
  help_requested: {
    blocking: true,
    headline: "needs you at the keyboard",
  },
  secret_requested: {
    blocking: true,
    headline: "is asking you for a value it must not be told",
  },
} as const satisfies Record<string, NotificationRule>;

export type NotificationKind = keyof typeof KINDS;

/** The vocabulary, for anything that has to validate a kind that arrived from outside. */
export const notificationKinds = Object.keys(KINDS) as NotificationKind[];

/**
 * How much of the Bot's own words survive into the notification.
 *
 * Short because the two places this lands are a toast beside somebody's work and the operating
 * system's own notification, and both truncate whatever they are given without saying they have.
 * Clipping here means the sentence ends with an ellipsis a person can recognise rather than in the
 * middle of a word.
 */
export const NOTIFICATION_DETAIL_LIMIT = 140;

/** What is handed over when a Bot becomes blocked. Facts only; the rule is applied here. */
export type BlockedBot = {
  kind: NotificationKind;
  /**
   * Which Bot is waiting.
   *
   * The one field a click cannot be routed without. A notification a person cannot act on from the
   * notification itself is a worse interruption than none, because it costs the attention and then
   * makes them go looking.
   */
  botId: string;
  /**
   * Who it is for: the person whose session the Bot is acting under.
   *
   * Deliberately not everybody who can see this Bot. A login wall is one person's problem at one
   * moment, and paging a whole deployment for it would teach everybody else to ignore the next one.
   */
  userId: string;
  /** The Bot's own words about what it needs. Flattened before it is shown; never trusted as markup. */
  detail: string;
};

/** A notification, framed and ready for whatever carries it. */
export type Notification = {
  /** Stable for one raising, so a surface can key a toast on it and not show the same one twice. */
  id: string;
  kind: NotificationKind;
  /** Which Bot is waiting, and therefore where a click goes. */
  botId: string;
  headline: string;
  detail: string;
  /** ISO-8601. */
  at: string;
};

/** Whether this kind of event is one a person should be interrupted for. */
export function isWorthInterrupting(kind: NotificationKind): boolean {
  return KINDS[kind].blocking;
}

/**
 * Decide, and frame it if the answer is yes.
 *
 * Null is the ordinary answer, not an error: a kind that does not block, or a Bot this person has
 * muted, produces nothing at all rather than a notification somebody downstream is trusted to throw
 * away. One place decides, so a surface that renders whatever it is handed is correct by
 * construction.
 *
 * The Bot's name is not here. The frame carries the id because the id is what routes the click, and
 * the roster the browser already holds is where a name comes from; resolving one here would put a
 * query on the path of a handover to buy a string the surface has anyway.
 */
export function notificationFor(
  blocked: BlockedBot,
  /** What this person has said about this Bot. See `agentPreferences`. */
  preference: { muted: boolean },
  now: Date = new Date(),
): Notification | null {
  if (preference.muted) return null;
  if (!isWorthInterrupting(blocked.kind)) return null;

  return {
    id: crypto.randomUUID(),
    kind: blocked.kind,
    botId: blocked.botId,
    headline: KINDS[blocked.kind].headline,
    detail: summarize(blocked.detail),
    at: now.toISOString(),
  };
}

/**
 * Flatten a model's answer into one line fit for a notification.
 *
 * A model asked for one sentence will sometimes send back three paragraphs and a fenced code block,
 * and a notification is one line by definition. Fences are unwrapped rather than dropped along with
 * what is inside them: a Bot that puts the whole of what it needs inside backticks would otherwise
 * produce an empty notification, which is the one outcome worse than an untidy one.
 *
 * Control characters go too. This text is rendered in a toast and handed to the operating system's
 * own notification, and a terminal escape somebody's page put in front of the model has no business
 * following it into either.
 */
export function summarize(
  text: string,
  limit = NOTIFICATION_DETAIL_LIMIT,
): string {
  const unfenced = text.replaceAll(/```[^\n`]*/g, " ").replaceAll("`", "");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
  const printable = unfenced.replaceAll(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  const collapsed = printable.replaceAll(/\s+/g, " ").trim();

  // Counted in code points rather than UTF-16 units, so a clip never lands between the halves of a
  // surrogate pair and leaves a replacement character in front of somebody.
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= limit) return collapsed;
  return `${codePoints.slice(0, Math.max(limit - 1, 0)).join("")}…`;
}

/**
 * Raise one, and carry on.
 *
 * Returns nothing and is never awaited by its caller. A handover is the escape hatch that makes a
 * blocked Bot recoverable at all, and it must not fail, or wait, because the thing that tells
 * somebody about it is slow or broken. The cost is that a notification which cannot be delivered is
 * lost rather than retried, which is the right trade for a courtesy: the audit row is the record,
 * and the Bot is still visibly waiting on its own screen.
 */
export type NotificationRaiser = (blocked: BlockedBot) => void;
