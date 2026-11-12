/**
 * How the roster is narrowed and ordered before a section draws it.
 *
 * Both rules live here rather than in the sidebar component because the sidebar is not the only
 * surface that draws a roster — the skins' own sheets do too — and because the sidebar now applies
 * them per section: each of Group, Direct and every project holds its own pinned-first, newest
 * activity next. `app-sidebar.tsx` re-exports both, so what already imported them from there keeps
 * working.
 */
import type { ChannelSummary } from "./queries";

/**
 * The roster, narrowed to what the person typed.
 *
 * Matches the channel's name, its summary, its opening and the last message, because those are the
 * things the row can actually show — searching against something invisible returns results a person
 * cannot account for. The opening and the last message are included because one of them is what the
 * second line draws until the conversation has been named. Message history beyond that line is not
 * here to search: it lives in the thread store, and reaching for it is a server endpoint rather than
 * a filter.
 *
 * An empty query returns the input array unchanged rather than a copy, so typing and clearing does
 * not hand `AnimatePresence` a new array identity and restage the whole list.
 */
export function matchingChannels(
  channels: ChannelSummary[] | undefined,
  query: string,
): ChannelSummary[] {
  if (!channels) {
    return [];
  }
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return channels;
  }
  return channels.filter((channel) =>
    [channel.name, channel.summary, channel.opening, channel.lastMessage].some(
      (field) => field?.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Pinned channels first, everything else after, newest activity first within each group.
 *
 * The mirror of a server rule, not the rule itself: the roster query orders pinned-first and its
 * cursor carries the pin, so a pinned channel arrives on page one however long ago it was last
 * spoken in. Sorting here as well is for what happens between refetches — the socket patches a pin
 * onto a loaded row without moving it, and re-sorts a page by recency alone — which is the same
 * reason `byRecency` in use-channel-events.ts mirrors the recency rule. A stable partition, so the
 * recency order inside each group is whatever arrived.
 */
export function pinnedFirst(channels: ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}