import { useSyncExternalStore } from "react";

/**
 * Which Bots are waiting for this person, kept where a dismissed toast cannot take it with it.
 *
 * A toast is gone in a few seconds whether or not anybody read it, and the thing it was announcing
 * has not gone anywhere: a Bot stopped at a login wall is still stopped. So the toast is the
 * announcement and this is the record, and the sidebar marker reads from here. Somebody who was
 * making coffee finds the Bot by looking, which is the whole point.
 *
 * Kept in `localStorage` rather than in React state so a reload does not clear it. Reloading a tab
 * is not an answer to a Bot's question, and the marker disappearing when somebody refreshes would
 * make the product look like it had forgotten. The cost is that this is per browser: signing in
 * somewhere else shows nothing, which is honest, because the socket does not replay either.
 *
 * Deliberately not on the server. A row per outstanding notification would be a second answer to
 * "is this Bot waiting", and the first one already exists and is authoritative: the computer's own
 * control state, which the screen polls.
 */

/** A notification as it arrives from the server. See server/src/notifications.ts. */
export type BotNotification = {
  id: string;
  /**
   * Left as a plain string on purpose.
   *
   * The server owns the vocabulary and will grow it. A browser that has not been reloaded since the
   * last deploy should still show a notification of a kind it has never heard of, because the server
   * has already sent the words to render; narrowing this to a union here would turn a new kind into
   * a blank toast on every stale tab.
   */
  kind: string;
  botId: string;
  headline: string;
  detail: string;
  at: string;
};

/** One outstanding notification per Bot, keyed by the Bot, which is what the marker is attached to. */
export type WaitingBots = Record<string, BotNotification>;

export const WAITING_STORAGE_KEY = "openbot-bots-waiting";

const EMPTY: WaitingBots = {};

/**
 * Read what was stored, and treat anything unreadable as nothing.
 *
 * A stored value that cannot be parsed is from an older shape or a hand-edited key, and throwing
 * over it would take the whole sidebar down over a decoration.
 */
export function parseWaitingBots(raw: string | null): WaitingBots {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return EMPTY;
    }
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      ([, value]) => isNotification(value),
    );
    return Object.fromEntries(entries) as WaitingBots;
  } catch {
    return EMPTY;
  }
}

function isNotification(value: unknown): value is BotNotification {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BotNotification>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.botId === "string" &&
    typeof candidate.headline === "string" &&
    typeof candidate.detail === "string"
  );
}

/**
 * Record that a Bot is waiting.
 *
 * One per Bot, so a Bot that asks twice replaces its own entry rather than accumulating. The marker
 * answers "is this Bot waiting for me", which has one answer however many times it has asked, and a
 * count would invite somebody to clear them one at a time.
 *
 * Returns the same object when nothing changed, so a repeated event does not re-render the roster.
 */
export function withWaitingBot(
  waiting: WaitingBots,
  notification: BotNotification,
): WaitingBots {
  if (waiting[notification.botId]?.id === notification.id) return waiting;
  return { ...waiting, [notification.botId]: notification };
}

/** Forget a Bot, which is what opening it means. Returns the same object when there was nothing. */
export function withoutWaitingBot(
  waiting: WaitingBots,
  botId: string,
): WaitingBots {
  if (!waiting[botId]) return waiting;
  const { [botId]: _cleared, ...remaining } = waiting;
  return remaining;
}

/**
 * The live copy, held outside React.
 *
 * A module-level value rather than a context, because the two places that read it are far apart —
 * the sidebar and the toasts — and the thing that writes it is a socket handler that belongs to
 * neither. `useSyncExternalStore` needs a snapshot with stable identity, which is why this is
 * replaced rather than mutated.
 */
let current: WaitingBots = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Blocked storage is a browser setting, not a failure worth surfacing. The marker then lasts
    // until the tab is reloaded, which is still better than nothing.
    return null;
  }
}

function snapshot(): WaitingBots {
  if (!loaded) {
    current = parseWaitingBots(storage()?.getItem(WAITING_STORAGE_KEY) ?? null);
    loaded = true;
  }
  return current;
}

function commit(next: WaitingBots) {
  if (next === current) return;
  current = next;
  loaded = true;
  try {
    storage()?.setItem(WAITING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A quota failure loses persistence, not the marker in front of the person right now.
  }
  for (const listener of listeners) listener();
}

/** Announce that a Bot is waiting. Called by whatever is listening to the socket. */
export function noteBotWaiting(notification: BotNotification) {
  commit(withWaitingBot(snapshot(), notification));
}

/** Clear a Bot's marker. Called when somebody opens it, which is the only thing that answers it. */
export function clearBotWaiting(botId: string) {
  commit(withoutWaitingBot(snapshot(), botId));
}

/** Which Bots are waiting, live. */
export function useWaitingBots(): WaitingBots {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
    // The server never renders this, and there is nothing to render before the browser has read its
    // own storage.
    () => EMPTY,
  );
}
