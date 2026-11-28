import { useCallback, useRef, useState } from "react";
import type { ChannelSummary } from "@/lib/channels/queries";

/** How many of a Bot's conversations the Bots panel lists at a time, and Show more adds. */
export const BOT_CONVERSATIONS_PAGE = 5;

/** How many Bots, from the top, start open when the panel first has its Bots. */
export const DEFAULT_EXPANDED = 3;

/** Where this browser remembers which Bots the person opened or closed. */
export const EXPANDED_BOTS_STORAGE_KEY = "openbot-expanded-bots";

/** What the order needs of a Bot: `lastConversationAt` is the server's (listBots). */
type Ordered = {
  id: string;
  name: string;
  lastConversationAt?: string | null;
};

/** A conversation's place in time, as the roster orders it: its last message, or its start. */
const recencyOf = (channel: ChannelSummary): string =>
  channel.lastMessageAt ?? channel.createdAt;

/**
 * Every Bot, newest conversation first. A Bot's time is the server's `lastConversationAt` or a
 * conversation the live roster has heard about since (a group one counts for each of its Bots),
 * whichever is later: the socket keeps the roster current, so the order moves with a new message
 * without reading every Bot again. ISO date-times compare as strings. Bots with no conversation go
 * last, and Bots on the same time go by name.
 */
export function orderBots<T extends Ordered>(
  bots: readonly T[],
  roster: readonly ChannelSummary[] = [],
): T[] {
  const latest = new Map<string, string>();
  for (const channel of roster) {
    const at = recencyOf(channel);
    for (const id of channel.agentIds) {
      const known = latest.get(id);
      if (!known || at > known) latest.set(id, at);
    }
  }
  const timeOf = (bot: T): string | null => {
    const server = bot.lastConversationAt ?? null;
    const live = latest.get(bot.id) ?? null;
    if (server === null) return live;
    if (live === null) return server;
    return live > server ? live : server;
  };
  return [...bots]
    .map((bot) => ({ bot, at: timeOf(bot) }))
    .sort((one, two) => {
      if (one.at !== two.at) {
        if (one.at === null) return 1;
        if (two.at === null) return -1;
        return one.at > two.at ? -1 : 1;
      }
      return one.bot.name.localeCompare(two.bot.name);
    })
    .map(({ bot }) => bot);
}

/** Which Bots this browser stored as open or closed, keeping only true and false. */
export function readExpanded(stored: string | null): Record<string, boolean> {
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
      ),
    );
  } catch {
    return {};
  }
}

function stored(): Record<string, boolean> {
  try {
    return readExpanded(window.localStorage.getItem(EXPANDED_BOTS_STORAGE_KEY));
  } catch {
    return {};
  }
}

/**
 * Which Bots are open in the panel. A Bot the person opened or closed stays so, in this browser. Any
 * other Bot is open when it was among the top {@link DEFAULT_EXPANDED} the first time the panel had
 * Bots in this page: taken once, so a Bot that climbs into the top later does not open itself and
 * one that drops does not close, and nothing moves under the pointer.
 */
export function useExpandedBots(orderedIds: readonly string[]): {
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
} {
  const [choices, setChoices] = useState(stored);
  const defaults = useRef<ReadonlySet<string> | null>(null);
  if (defaults.current === null && orderedIds.length > 0)
    defaults.current = new Set(orderedIds.slice(0, DEFAULT_EXPANDED));

  const isExpanded = useCallback(
    (id: string) => choices[id] ?? defaults.current?.has(id) ?? false,
    [choices],
  );
  const toggle = useCallback((id: string) => {
    setChoices((current) => {
      const open = current[id] ?? defaults.current?.has(id) ?? false;
      const next = { ...current, [id]: !open };
      try {
        window.localStorage.setItem(
          EXPANDED_BOTS_STORAGE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // Not remembered past this page, but changed for as long as it stays open.
      }
      return next;
    });
  }, []);
  return { isExpanded, toggle };
}
