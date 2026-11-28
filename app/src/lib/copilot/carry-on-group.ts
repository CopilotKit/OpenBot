/**
 * THE APP CARDS OF ONE CONVERSATION, which carry its task on together rather than one by one.
 *
 * A Bot that needs several apps for one task draws a card for each in the same reply. Each card
 * used to carry on by itself, so connecting the first sent "Notion is ready now" alone: the Bot
 * started its next turn, the other cards were no longer the latest thing in the conversation, and
 * connecting them told the Bot nothing (reported in dogfooding, with four cards). The person had to
 * stop the Bot and say the others were connected.
 *
 * So the cards that are still the latest thing are counted here, as one set, and the task is carried
 * on once for all of them: by itself when the last of them is ready and the person watched at least
 * one of them change, in one message naming them all; or with Continue, offered once under the last
 * card that is ready, when some are ready and the rest still wait (an app only an admin can give, one
 * the person means to skip) or none was seen to change.
 *
 * One per conversation, kept by `ConversationProvider`. A card drawn outside a conversation has no
 * `ask` and nothing to carry on, so it never joins one.
 */

/** One card's part in carrying on, as its `useCarryOn` reports it. */
export type CarryOnMember = {
  /** The tool call the card was drawn for: what "only once" is counted against. */
  toolCallId: string;
  /** The app's name, as the message to the Bot names it. */
  app: string;
  /** Null until the card knows. */
  ready: boolean | null;
  /** The card saw the app blocked here, so becoming ready is a change the person watched. */
  sawBlocked: boolean;
  /** The app was out of reach when the Bot asked, so the Bot is waiting on it. */
  blockedWhenAsked: boolean;
};

/** What a card draws: whether it offers Continue. Carried on or not is read from the marks. */
export type CarryOnView = { offer: boolean };

const MARK = "openbot:carried-on:";

/** Marks kept here as well, for a browser that refuses `localStorage` (a private window, a policy). */
const carriedHere = new Set<string>();

/** Whether the card drawn for this tool call has carried on, here or in another tab. */
export function hasCarriedOn(toolCallId: string): boolean {
  if (carriedHere.has(toolCallId)) return true;
  try {
    return window.localStorage.getItem(MARK + toolCallId) !== null;
  } catch {
    return false;
  }
}

/** Mark this card as carried on. False when something already had: this caller must not send. */
function markCarriedOn(toolCallId: string): boolean {
  if (hasCarriedOn(toolCallId)) return false;
  carriedHere.add(toolCallId);
  try {
    window.localStorage.setItem(MARK + toolCallId, new Date().toISOString());
  } catch {
    // The in-memory mark still holds for this tab.
  }
  return true;
}

/*
 * SEEN BLOCKED, FOR THE LIFE OF THE TAB rather than of the card. An app connected with a typed key is
 * connected on its own page, in this tab, so the conversation and its cards are drawn again from
 * nothing when the person comes back. A card that forgot it had seen the app blocked would read the
 * change as one made while nobody watched, and wait for a Continue the person has no reason to press.
 */
const seenBlocked = new Set<string>();

/** Note that the card drawn for this tool call saw its app out of reach. */
export function noteBlocked(toolCallId: string): void {
  seenBlocked.add(toolCallId);
}

/** Whether the card drawn for this tool call has seen its app out of reach, in this tab. */
export function wasSeenBlocked(toolCallId: string): boolean {
  return seenBlocked.has(toolCallId);
}

/** "Notion", "Notion and Slack", "Notion, Slack and Granola". */
function namesOf(apps: readonly string[]): string {
  if (apps.length <= 1) return apps[0] ?? "";
  return `${apps.slice(0, -1).join(", ")} and ${apps.at(-1)}`;
}

/** What is sent as the person when the task carries on. Short, and true whoever made them ready. */
export function carryOnMessage(...apps: string[]): string {
  return `${namesOf(apps)} ${apps.length > 1 ? "are" : "is"} ready now. Please carry on.`;
}

export class CarryOnGroup {
  /** The cards still the latest thing, by their hook, in the order they joined (the transcript's). */
  private readonly members = new Map<string, CarryOnMember>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private ask: ((text: string) => void) | null = null;
  private checking = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Changes whenever what any card should draw may have changed. */
  snapshot = (): number => this.version;

  /** A card joins or reports a change; null leaves, as a card the conversation moved on from does. */
  set(
    key: string,
    member: CarryOnMember | null,
    ask: ((text: string) => void) | null,
  ): void {
    if (ask) this.ask = ask;
    const known = this.members.get(key);
    if (member === null) {
      if (!known) return;
      this.members.delete(key);
    } else {
      if (known && sameMember(known, member)) return;
      this.members.set(key, member);
    }
    this.changed();
    /*
     * Decided once every card drawn in the same commit has reported, not by whichever reports first:
     * a card that is ready must not carry on past a sibling whose report is a moment behind it.
     */
    if (this.checking) return;
    this.checking = true;
    queueMicrotask(() => {
      this.checking = false;
      if (this.state().auto) this.carryOn();
    });
  }

  /** What the card that joined under `key` draws. */
  view(key: string): CarryOnView {
    const { auto, offerOn } = this.state();
    return { offer: !auto && offerOn === key };
  }

  /** Carry the task on for every card that is ready, in one message. Once per card, ever. */
  carryOn(): void {
    const ask = this.ask;
    if (!ask) return;
    const { ready, waitedOn } = this.state();
    const named = waitedOn
      .filter(([, member]) => markCarriedOn(member.toolCallId))
      .map(([, member]) => member.app);
    // A ready card the Bot was not waiting on is settled too, so it is never offered on its own.
    for (const [, member] of ready) markCarriedOn(member.toolCallId);
    this.changed();
    if (named.length > 0) ask(carryOnMessage(...named));
  }

  private state() {
    const open = [...this.members].filter(
      ([, member]) => !hasCarriedOn(member.toolCallId),
    );
    const ready = open.filter(([, member]) => member.ready === true);
    const waiting = open.length - ready.length;
    // The apps the Bot stopped for, ready now: what the message names.
    const waitedOn = ready.filter(
      ([, member]) => member.blockedWhenAsked || member.sawBlocked,
    );
    const auto =
      waiting === 0 &&
      waitedOn.length > 0 &&
      ready.some(([, member]) => member.sawBlocked);
    return { ready, waitedOn, auto, offerOn: waitedOn.at(-1)?.[0] ?? null };
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

function sameMember(a: CarryOnMember, b: CarryOnMember): boolean {
  return (
    a.toolCallId === b.toolCallId &&
    a.app === b.app &&
    a.ready === b.ready &&
    a.sawBlocked === b.sawBlocked &&
    a.blockedWhenAsked === b.blockedWhenAsked
  );
}
