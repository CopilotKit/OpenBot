import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { Database } from "../db/client";
import type { Notification } from "../notifications";

/**
 * Live events, from whichever server process produced them to whichever one the person is connected
 * to.
 *
 * Two things travel this way. Channel activity tells a channel's other members that something was
 * said; the person who ran the agent already has the reply and reports it over HTTP, so this is the
 * other direction. Notifications tell one person that a Bot of theirs has stopped and is waiting on
 * them.
 *
 * Neither is a source of truth. The roster query stays authoritative for activity, and a Bot that is
 * waiting is still visibly waiting on its own screen; a client that misses events while disconnected
 * recovers by refetching on reconnect. Nothing may be knowable only through the socket.
 *
 * Delivery goes through Postgres rather than an in-process list, because an in-process list is
 * silently wrong the moment a second server instance exists: the writer is on one and the listener
 * on the other, and the message is never delivered. That is not a hypothetical for a notification.
 * A deployment runs more than one process, the browser holds its socket to whichever one answered
 * the upgrade, and the handover that raises the notification is served by whichever one answered
 * that request. Nothing arranges for those to be the same process, so an event raised in memory
 * reaches the person only when they happen to have got lucky, which is worse than not having the
 * feature: it works on a laptop and stops working in production, silently.
 *
 * One socket carries both, so the events are tagged. A second WebSocket would need its own upgrade,
 * its own session guard, its own reconnect and its own backoff, all to move a payload the existing
 * one is already open for.
 */

export const CHANNEL_ACTIVITY_TOPIC = "channel_activity";

/**
 * Notifications, on a topic of their own rather than folded into channel activity.
 *
 * Separate because the two are addressed differently. Activity goes to a channel's members, which
 * the writer resolved from the membership table; a notification goes to one person, and the rule
 * for who that is belongs to notifications.ts. Sharing a topic would mean every listener parsing
 * every event to discover it was not for them.
 */
export const NOTIFICATION_TOPIC = "user_notification";

export type ChannelActivityEvent = {
  type: "channel.activity";
  channelId: string;
  /** Who may receive it. Resolved by the writer, which already had to check membership. */
  recipientIds: string[];
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
};

export type NotificationEvent = {
  type: "notification";
  /** Whose Bot is waiting. One person, in practice; a list because the hub addresses everything that way. */
  recipientIds: string[];
  notification: Notification;
};

/**
 * Anything the hub can fan out.
 *
 * `type` is on the wire rather than inferred from the shape, so a browser that receives an event it
 * was not built to understand can ignore it by name instead of by guessing. A deployment can be
 * mid-rollout with an older tab open, and an old tab treating a notification as channel activity
 * would corrupt its roster rather than skip an event.
 */
export type LiveEvent = ChannelActivityEvent | NotificationEvent;

type Send = (payload: string) => void;

export type ChannelEventHub = {
  /** Attach a connection for a person. Returns the detach. */
  register(userId: string, send: Send): () => void;
  /** Fan one event out to this instance's own connections. */
  deliver(event: LiveEvent): void;
  connectionCount(userId: string): number;
};

export function createChannelEventHub(): ChannelEventHub {
  const connections = new Map<string, Set<Send>>();

  return {
    register(userId, send) {
      const existing = connections.get(userId) ?? new Set<Send>();
      existing.add(send);
      connections.set(userId, existing);

      return () => {
        const remaining = connections.get(userId);
        if (!remaining) return;
        remaining.delete(send);
        // Dropped entirely rather than left empty, so a long-lived process does not accumulate a
        // set per person who ever connected.
        if (remaining.size === 0) connections.delete(userId);
      };
    },

    deliver(event) {
      for (const userId of event.recipientIds) {
        for (const send of connections.get(userId) ?? []) {
          try {
            send(JSON.stringify(event));
          } catch {
            // A connection that cannot be written to is one that is closing. Its own close handler
            // detaches it; failing here would deny the event to everybody after it in the set.
          }
        }
      }
    },

    connectionCount(userId) {
      return connections.get(userId)?.size ?? 0;
    },
  };
}

export type LiveEventListener = { stop: () => Promise<void> };

/**
 * Listen for events announced by any instance, including this one.
 *
 * On its own connection, because `LISTEN` holds one for the life of the subscription: taken from the
 * pool, it would be a connection the rest of the server never gets back. Both topics share that one
 * connection for the same reason, a second subscription is a second connection held forever, and
 * nothing about a notification needs its own.
 */
export async function startLiveEventListener(
  databaseUrl: string,
  hub: ChannelEventHub,
): Promise<LiveEventListener> {
  const connection = postgres(databaseUrl, { max: 1 });

  const fanOut = (payload: string) => {
    try {
      hub.deliver(JSON.parse(payload) as LiveEvent);
    } catch {
      // A payload we cannot read is not a reason to tear down the subscription: the roster query is
      // still correct, the Bot is still visibly waiting on its own screen, and the next refetch
      // shows whatever this event would have.
    }
  };

  await connection.listen(CHANNEL_ACTIVITY_TOPIC, fanOut);
  await connection.listen(NOTIFICATION_TOPIC, fanOut);

  return {
    stop: async () => {
      await connection.end();
    },
  };
}

/**
 * Announce a notification to whoever it is for, wherever they are connected.
 *
 * Takes an executor rather than a pool so a caller inside a transaction can announce on commit, the
 * way the channel store does. Nothing raises a notification inside a transaction today, and the
 * first thing that does should not have to move this function to do it.
 *
 * `NOTIFY` caps its payload at 8000 bytes. A notification is a couple of ids, a fixed headline and a
 * detail that notifications.ts has already clipped, so the cap is not close; it is worth knowing
 * about before somebody adds a field that carries a transcript.
 */
export async function announceNotification(
  executor: Pick<Database, "execute">,
  event: NotificationEvent,
): Promise<void> {
  await executor.execute(
    sql`select pg_notify(${NOTIFICATION_TOPIC}, ${JSON.stringify(event)})`,
  );
}
