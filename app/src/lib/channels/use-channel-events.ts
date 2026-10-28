import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { socketUrl as buildSocketUrl } from "@/lib/socket-url";
import {
  type AgentChannel,
  type ChannelPage,
  type ChannelSummary,
  type ChannelWork,
  channelKeys,
} from "./queries";

/**
 * Keep the roster live.
 *
 * The query remains the source of truth; socket events only patch its cache. Reconnects refetch the
 * list to recover events missed while disconnected.
 *
 * Two connections can drop and only one is this one. `onopen` covers this socket. The other is the
 * server's subscription to Postgres, which stays invisible here — so the server sends a resync when
 * it comes back, answered with the same refetch.
 */

/** The server saying it may have missed announcements, so the roster we hold may be wrong. */
export type ChannelResyncEvent = { resync: true };

/** What arrives on the socket. `resync` is the discriminant; an activity event never carries it. */
export type ChannelSocketMessage = ChannelActivityEvent | ChannelResyncEvent;

export function isResync(message: unknown): message is ChannelResyncEvent {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as ChannelResyncEvent).resync === true
  );
}

/**
 * Whether a parsed socket payload has the shape of anything this roster handles.
 *
 * The `try` around `JSON.parse` is not enough: `JSON.parse("null")` succeeds with
 * `null`, and `JSON.parse("5")` succeeds with `5`, and both used to reach `isResync`
 * — `null.resync` throwing a `TypeError` inside `onmessage` for the first, and a
 * spurious roster-wide refetch for the second when the channel id came back
 * `undefined`. Binary frames arrive as `Blob` rather than text and never parse.
 */
export function isChannelSocketMessage(
  value: unknown,
): value is ChannelSocketMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one socket frame into something the roster can act on, or `null` to drop it.
 *
 * Pure and exported so the drop rules are provable without a socket: unparseable
 * text, non-object JSON (`null`, numbers, strings, arrays) and activity events with
 * no string channel id are all ignored rather than crashing or refetching the roster.
 */
export function parseChannelSocketMessage(
  data: unknown,
): ChannelSocketMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isChannelSocketMessage(parsed)) return null;
  if (isResync(parsed)) return parsed;
  if (typeof parsed.channelId !== "string") return null;
  return parsed;
}

export type ChannelActivityEvent = {
  channelId: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** The channel's newly written summary. Absent on an ordinary activity event. */
  summary?: string;
  /** The channel is gone from every member's roster. Absent on an ordinary activity event. */
  deleted?: true;
  /**
   * This member's pin, changed. Absent on an ordinary activity event.
   *
   * The server scopes a pin to the member who made it, so one arriving here is the reader's own,
   * made in another tab or on another replica.
   */
  pinned?: boolean;
  /**
   * A turn started or ended in this channel. Absent on an ordinary activity event.
   *
   * Carries no message: it patches only the row's `busy` flag, so the roster can show a working
   * indicator without disturbing the preview or the order.
   */
  busy?: boolean;
  /**
   * Everything the channel is waiting on now, replacing what the row held. Absent on an ordinary
   * activity event. Rides on every busy event, and alone on the one the server sends when a hop
   * settles without a turn starting or ending.
   */
  work?: ChannelWork[];
  /**
   * When the server read `work`, as fixed-width UTC that compares as a string. Two events can
   * arrive in the other order from the one they were read in, so a list older than the one already
   * held is ignored. See `newerWork`.
   */
  workAt?: string;
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

  /* One field, and no re-sort: naming a conversation is not something anybody said in it. */
  if (activity.summary !== undefined) {
    if (previous.summary === activity.summary) return data;
    const channels = page.channels.slice();
    channels[index] = { ...previous, summary: activity.summary };
    const pages = data.pages.slice();
    pages[holdingPage] = { ...page, channels };
    return { ...data, pages };
  }

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

  /*
   * A busy signal patches the one field it is about, and never re-sorts.
   *
   * The spread below would carry this event's null message onto the row and wipe the preview. Busy
   * is also not activity — a channel does not jump to the top of the roster because a turn started
   * in it — so the order is left exactly as it was.
   */
  if (activity.busy !== undefined || activity.work !== undefined) {
    const busy = activity.busy ?? previous.busy;
    const fresh = newerWork(previous, activity);
    const work = fresh ? activity.work : previous.work;
    if (
      (previous.busy ?? false) === (busy ?? false) &&
      sameWork(previous.work, work)
    )
      return data;
    const channels = page.channels.slice();
    channels[index] = {
      ...previous,
      ...(busy === undefined ? {} : { busy }),
      ...(work === undefined ? {} : { work }),
      ...(fresh && activity.workAt ? { workAt: activity.workAt } : {}),
    };
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

/**
 * The same list, entry for entry. Compared rather than replaced so an event that changes nothing
 * leaves the cache alone and the transcript does not re-render to draw the same rows.
 */
function sameWork(
  left: readonly ChannelWork[] | undefined,
  right: readonly ChannelWork[] | undefined,
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return (
    a.length === b.length &&
    a.every(
      (entry, at) =>
        entry.key === b[at]?.key &&
        entry.since === b[at]?.since &&
        entry.botName === b[at]?.botName,
    )
  );
}

/**
 * Whether this event's work list should replace the one held.
 *
 * Only when it carries one, and was not read before the one already held. A list from a fetch has
 * no stamp and gives way to any event; an event without a stamp, from an older server, always
 * wins, as every event did before stamps.
 */
function newerWork(
  held: { workAt?: string },
  activity: ChannelActivityEvent,
): boolean {
  if (activity.work === undefined) return false;
  if (!held.workAt || !activity.workAt) return true;
  return activity.workAt >= held.workAt;
}

/**
 * Apply one event's work list to the open conversation's own read.
 *
 * The conversation screen reads the channel by id rather than from the roster: the roster is paged,
 * and the conversation somebody has open need not be on a page they have loaded. So the list is
 * patched there too, and only there when the event carries one.
 */
export function applyChannelWork(
  channel: AgentChannel | undefined,
  activity: ChannelActivityEvent,
): AgentChannel | undefined {
  if (!channel || !newerWork(channel, activity)) return channel;
  if (sameWork(channel.work, activity.work)) return channel;
  return {
    ...channel,
    work: activity.work,
    ...(activity.workAt ? { workAt: activity.workAt } : {}),
  };
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

function socketUrl() {
  return buildSocketUrl("/api/channels/events");
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
        void queryClient.invalidateQueries({ queryKey: channelKeys.details() });
      };

      socket.onmessage = (message) => {
        const parsed = parseChannelSocketMessage(message.data);
        if (!parsed) return;

        // Refetch rather than patch: there is no delta to apply. Checked before anything reads
        // `channelId`, because this message has none.
        if (isResync(parsed)) {
          void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
          void queryClient.invalidateQueries({
            queryKey: channelKeys.details(),
          });
          return;
        }

        const activity = parsed;
        // A group conversation's shared transcript moves with the same events; refetch it if open.
        void queryClient.invalidateQueries({
          queryKey: ["groups", activity.channelId],
        });

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

        if (activity.work !== undefined) {
          queryClient.setQueryData(
            channelKeys.detail(activity.channelId),
            (channel: AgentChannel | undefined) =>
              applyChannelWork(channel, activity),
          );
        }

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
          if (
            pathname === `/channel/${activity.channelId}` ||
            pathname === `/group/${activity.channelId}`
          ) {
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
