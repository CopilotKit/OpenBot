import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  type BotNotification,
  noteBotWaiting,
} from "@/lib/notifications/waiting";
import { type ChannelSummary, channelKeys } from "./queries";

/**
 * Keep the roster live, and hear about a Bot that has stopped and is waiting.
 *
 * The query remains the source of truth; socket events only patch its cache, and a reconnect refetches
 * the list to recover the activity missed while disconnected. Notifications have no equivalent, and
 * the gap is worth stating rather than leaving to be discovered: nothing on the server holds an
 * outstanding notification, so one raised while this socket was down is not delivered late. A Bot in
 * that position is still waiting on its own screen and the handover is still in the audit trail, but
 * the corner of the screen and the sidebar marker will not know about it.
 *
 * One socket for both, because it is one socket: the server tags what it sends and this dispatches
 * on the tag. A second connection would need its own upgrade, its own reconnect and its own backoff
 * to carry a payload this one is already open for. An event whose tag this build does not recognise
 * is ignored rather than guessed at, so a tab left open across a deploy skips what it cannot read
 * instead of corrupting its roster with it.
 */

type ChannelActivityEvent = {
  type: "channel.activity";
  channelId: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
};

type NotificationEvent = {
  type: "notification";
  notification: BotNotification;
};

type LiveEvent = ChannelActivityEvent | NotificationEvent;

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

function socketUrl() {
  const url = new URL("/api/channels/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function useChannelEvents() {
  const queryClient = useQueryClient();

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
        // Recover the roster activity missed while the socket was disconnected. Notifications are not
        // recovered here; see the header.
        void queryClient.invalidateQueries({ queryKey: channelKeys.list() });
      };

      socket.onmessage = (message) => {
        let event: LiveEvent;
        try {
          event = JSON.parse(message.data as string);
        } catch {
          return;
        }

        switch (event.type) {
          case "notification":
            noteBotWaiting(event.notification);
            return;
          case "channel.activity":
            break;
          default:
            // A tag this build has never heard of, from a server that has been deployed since this
            // tab was opened. Skipped, not guessed at.
            return;
        }
        const activity = event;

        queryClient.setQueryData(
          channelKeys.list(),
          (channels: ChannelSummary[] | undefined) => {
            if (!channels) return channels;
            // Unknown channel ids mean the roster is stale; refetch the list instead of patching.
            if (!channels.some((c) => c.id === activity.channelId)) {
              void queryClient.invalidateQueries({
                queryKey: channelKeys.list(),
              });
              return channels;
            }
            // Preserve object identity for unchanged rows so memoized rows do not re-render.
            const index = channels.findIndex(
              (channel) => channel.id === activity.channelId,
            );
            const previous = channels[index];
            if (!previous) return channels;

            // Named fields rather than a spread of the event. The event carries a tag as well as the
            // preview, and a spread would put it in the cached row for no reason.
            const patched = {
              ...previous,
              lastMessage: activity.lastMessage,
              lastMessageAt: activity.lastMessageAt,
              lastMessageAgentId: activity.lastMessageAgentId,
            };
            const next = channels.slice();
            next[index] = patched;
            next.sort(byRecency);

            // An event that changes nothing visible, a duplicate, or a report the server ignored
            // as stale, returns the original array, so React re-renders nothing at all.
            return next.every((channel, at) => channel === channels[at])
              ? channels
              : next;
          },
        );
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
  }, [queryClient]);
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
