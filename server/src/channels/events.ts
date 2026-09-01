import postgres from "postgres";

/**
 * Live channel activity, from whoever ran an agent to everybody else in the channel.
 *
 * The person who ran it already has the reply and reports it over HTTP; this is the other direction,
 * telling the channel's other members that something was said. It is an optimisation and never a
 * source of truth: the roster query stays authoritative, and a client that misses events while
 * disconnected recovers by refetching on reconnect. Nothing may be knowable only through the socket.
 *
 * Delivery goes through Postgres rather than an in-process list, because an in-process list is
 * silently wrong the moment a second server instance exists: the writer is on one and the listener
 * on the other, and the message is never delivered.
 *
 * A NOTIFY is never replayed, so an announcement made while this subscription is down is gone. The
 * client's own "refetch on reconnect" does not cover it: the socket that dropped is this server's,
 * not the browser's. `resyncAll` is the signal that closes that gap.
 */

export const CHANNEL_ACTIVITY_TOPIC = "channel_activity";

export type ChannelActivityEvent = {
  channelId: string;
  /** Who may receive it. Resolved by the writer, which already had to check membership. */
  memberIds: string[];
  lastMessage: string | null;
  lastMessageAt: string | null;
  lastMessageAgentId: string | null;
  /** The channel is hidden from every member's roster. Absent on an ordinary activity event. */
  deleted?: true;
  /**
   * One member's pin, changed. Absent on an ordinary activity event.
   *
   * A pin lives on one membership row, so the writer names that member alone in `memberIds` and the
   * hub's delivery rule does the rest: nobody else in the channel hears a pin they did not make.
   */
  pinned?: boolean;
  /**
   * A turn started or ended in this channel. Absent on an ordinary activity event.
   *
   * Transient and message-less: it is never written to a table, only announced, so the roster can
   * show a working indicator for a headless turn — a handoff hop, a relay — that no browser
   * streams. A missed one costs at most a stuck-looking dot until the next real event, never data.
   */
  busy?: boolean;
};

/** "The roster you hold may be wrong." Carries no delta, because what was lost is not recoverable. */
export type ChannelResyncEvent = { resync: true };

const RESYNC_PAYLOAD = JSON.stringify({
  resync: true,
} satisfies ChannelResyncEvent);

type Send = (payload: string) => void;

export type ChannelEventHub = {
  /** Attach a connection for a person. Returns the detach. */
  register(userId: string, send: Send): () => void;
  /** Fan one event out to this instance's own connections. */
  deliver(event: ChannelActivityEvent): void;
  /** Tell every connection to refetch. Everybody, because the lost events named their own members. */
  resyncAll(): void;
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
      for (const userId of event.memberIds) {
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

    resyncAll() {
      for (const sends of connections.values()) {
        for (const send of sends) {
          try {
            send(RESYNC_PAYLOAD);
          } catch {
            // Closing, and detached by its own close handler. See `deliver`.
          }
        }
      }
    },

    connectionCount(userId) {
      return connections.get(userId)?.size ?? 0;
    },
  };
}

export type ChannelActivityListener = { stop: () => Promise<void> };

/**
 * Listen for activity announced by any instance, including this one.
 *
 * On its own connection, because `LISTEN` holds one for the life of the subscription: taken from the
 * pool, it would be a connection the rest of the server never gets back.
 */
export async function startChannelActivityListener(
  databaseUrl: string,
  hub: ChannelEventHub,
): Promise<ChannelActivityListener> {
  const connection = postgres(databaseUrl, { max: 1 });

  /*
   * `onlisten` fires on every establish, reconnects included — the same hook `policy-listener.ts`
   * uses to re-read its row. There is no row to re-read here, so the browsers are told to refetch
   * instead.
   *
   * The first establish is skipped so the message means one thing. It has no earlier subscription
   * behind it, so nothing can have been missed, and a resync there would say "possibly a gap" — not
   * something a client can act on differently.
   */
  let subscribed = false;
  const resync = () => {
    if (!subscribed) {
      subscribed = true;
      return;
    }
    hub.resyncAll();
  };

  await connection.listen(
    CHANNEL_ACTIVITY_TOPIC,
    (payload) => {
      try {
        hub.deliver(JSON.parse(payload) as ChannelActivityEvent);
      } catch {
        // A payload we cannot read is not a reason to tear down the subscription: the roster query
        // is still correct, and the next refetch shows whatever this event would have.
      }
    },
    resync,
  );

  return {
    stop: async () => {
      await connection.end();
    },
  };
}
