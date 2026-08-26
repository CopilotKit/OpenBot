import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { type ChannelPage, type ChannelSummary, channelKeys } from "./queries";

/**
 * Keep the roster live.
 *
 * The query remains the source of truth; socket events only patch its cache. Reconnects refetch the
 * list to recover events missed while disconnected.
 */

export type ChannelActivityEvent = {
  channelId: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** The channel is gone from every member's roster. Absent on an ordinary activity event. */
  deleted?: true;
  /**
   * This member's pin, changed. Absent on an ordinary activity event.
   *
   * The server scopes a pin to the member who made it, so one arriving here is the reader's own,
   * made in another tab or on another replica.
   */
  pinned?: boolean;
};

/** The infinite query's cache, which holds pages rather than one array. */
type ChannelCache = { pages: ChannelPage[]; pageParams: unknown[] };

/**
 * Apply one event to the cached pages.
 *
 * Pure, and exported, because the patching rules are the whole of what a socket event does to the
 * screen and they should be provable without a socket. Returns the cache it was given when nothing
 * changed, so React re-renders nothing, and `"unknown"` when the event names a channel no page
 * holds — which the caller answers with a refetch rather than a patch.
 */
export function applyChannelEvent(
  data: ChannelCache,
  activity: ChannelActivityEvent,
): ChannelCache | "unknown" {
  const holdingPage = data.pages.findIndex((page) =>
    page.channels.some((channel) => channel.id === activity.channelId),
  );

  // Must run before the patch below, which spreads the event onto the existing row — reaching that
  // first would stamp `deleted: true` on the row instead of removing it. An unknown channel here is
  // already gone from this cache, so there is nothing to patch or invalidate for, unlike the
  // "unknown channel" case below for an ordinary event.
  if (activity.deleted) {
    if (holdingPage === -1) return data;
    const page = data.pages[holdingPage] as ChannelPage;
    const pages = data.pages.slice();
    pages[holdingPage] = {
      ...page,
      channels: page.channels.filter(
        (channel) => channel.id !== activity.channelId,
      ),
    };
    return { ...data, pages };
  }

  // An unknown channel id means the roster is stale; refetch rather than patch.
  if (holdingPage === -1) return "unknown";

  const page = data.pages[holdingPage] as ChannelPage;
  const index = page.channels.findIndex(
    (channel) => channel.id === activity.channelId,
  );
  const previous = page.channels[index];
  if (!previous) return data;

  /*
   * A pin patches the one field it is about.
   *
   * The spread below would carry this event's null message onto the row and wipe the preview the
   * roster renders. No re-sort either: a pin is not activity, and pinned rows are lifted at render
   * time by `pinnedFirst`, not by the order they sit in here.
   */
  if (activity.pinned !== undefined) {
    if (previous.pinned === activity.pinned) return data;
    const channels = page.channels.slice();
    channels[index] = { ...previous, pinned: activity.pinned };
    const pages = data.pages.slice();
    pages[holdingPage] = { ...page, channels };
    return { ...data, pages };
  }

  // Preserve object identity for unchanged rows so memoized rows do not re-render.
  const next = page.channels.slice();
  next[index] = { ...previous, ...activity };
  next.sort(byRecency);

  // An event that changes nothing visible, a duplicate, or a report the server ignored as stale,
  // returns the original object, so React re-renders nothing at all.
  if (next.every((channel, at) => channel === page.channels[at])) return data;

  const pages = data.pages.slice();
  pages[holdingPage] = { ...page, channels: next };
  return { ...data, pages };
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

function socketUrl() {
  const url = new URL("/api/channels/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useChannelEvents() {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retryTimer: number | undefined;
    let retryDelay = FIRST_RETRY_MS;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(socketUrl());

      socket.onopen = () => {
        retryDelay = FIRST_RETRY_MS;
        // Recover events missed while the socket was disconnected.
        void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
      };

      socket.onmessage = (message) => {
        let activity: ChannelActivityEvent;
        try {
          activity = JSON.parse(message.data as string);
        } catch {
          return;
        }

        /*
         * The list is paged, so the cache holds pages rather than one array.
         *
         * The channel is patched inside whichever page holds it and that page is re-sorted. Sorting
         * across pages is deliberately not attempted: a channel that has just become the most recent
         * belongs at the top of page one, and moving a row between pages would fight the cursors the
         * next fetch uses. The page it is on stays correct, and the next refetch puts it in order.
         */
        queryClient.setQueryData(
          channelKeys.list(),
          (data: ChannelCache | undefined) => {
            if (!data) return data;
            const patched = applyChannelEvent(data, activity);
            if (patched !== "unknown") return patched;
            // An unknown channel id means the roster is stale; refetch rather than patch.
            void queryClient.invalidateQueries({
              queryKey: channelKeys.list(),
            });
            return data;
          },
        );

        /*
         * A tab looking at the channel somebody just deleted in another tab.
         *
         * The tab that issued the delete moves itself once the request returns. Every other tab only
         * ever hears about it here, and dropping the row without moving leaves that tab on a route
         * whose channel no longer resolves: an error, or an empty conversation, depending on which
         * query answers first.
         *
         * Read off the router at event time rather than through `useParams`, so the effect does not
         * have to be torn down and reconnected on every navigation just to keep this value fresh.
         */
        if (activity.deleted) {
          const { pathname } = router.state.location;
          if (pathname === `/channel/${activity.channelId}`) {
            void router.navigate({ to: "/" });
          }
        }
      };

      // WebSocket needs explicit reconnect handling.
      socket.onclose = () => {
        if (stopped) return;
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      // Cleared first: the close below must not schedule a reconnect for a screen that is gone.
      if (socket) socket.onclose = null;
      socket?.close();
    };
  }, [queryClient, router]);
}

/**
 * Most recent first, where starting a conversation counts as activity.
 *
 * Deliberately the same rule the roster query uses, `coalesce(last_message_at, created_at) desc` in
 * channels/routes.ts. If these two disagree the list reorders itself the moment an event arrives,
 * which looks like rows jumping for no reason.
 */
function byRecency(left: ChannelSummary, right: ChannelSummary) {
  const at = (channel: ChannelSummary) =>
    channel.lastMessageAt ?? channel.createdAt;
  return at(right).localeCompare(at(left));
}
