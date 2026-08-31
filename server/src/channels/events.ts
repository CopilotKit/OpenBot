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
 * A NOTIFY reaches whoever is subscribed at the time and is never replayed, so an announcement made
 * while this server's subscription is down is gone. "Recovers by refetching on reconnect" is the
 * client's rule for ITS OWN socket dropping, and that socket is not the one at risk here: the
 * browser's connection to this server is untouched while the server's connection to Postgres is
 * away, so nothing on the client ever learns it missed anything. `resyncAll` below is that missing
 * signal, sent when the subscription is re-established. See `startChannelActivityListener`.
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
};

/**
 * Told to every connection that this server may have missed announcements.
 *
 * Carries no channel and no delta, because a missed NOTIFY cannot be reconstructed: what was lost is
 * per-member and Postgres does not keep it. All this says is "the roster you hold may be wrong", and
 * the client answers it by refetching the roster — the same recovery it already runs when its own
 * socket reconnects, reached from the one direction that had no way to trigger it.
 */
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
  /**
   * Tell every connection on this instance to refetch, because announcements may have been missed.
   *
   * Everybody rather than a member list, because what was missed is not known: the events that were
   * lost named their own recipients and those events are gone.
   */
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
            // A connection that cannot be written to is one that is closing, and its own close
            // handler detaches it. Failing here would deny the resync to everybody after it.
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
   * Every establish after the first, which is the moment this server could have missed something.
   *
   * `onlisten` fires when the driver establishes the subscription and again on every reconnect, so
   * this is the same hook the action policy listener uses to re-read its row. What it cannot do here
   * is re-read anything: the policy is one row and this is a stream of per-member deltas Postgres
   * does not keep. So the recovery is handed to the browsers, which already know how to do it — the
   * resync tells them to refetch the roster, exactly as their own `onopen` does.
   *
   * THE FIRST ESTABLISH IS SKIPPED, and the flag is what keeps the message meaning one thing. A
   * resync says "there was a gap, and something announced in it may have been yours". The first
   * establish has no gap behind it: there is no earlier subscription for anything to have been
   * missed between. Sending one anyway would ask every connection to refetch on a boot where nothing
   * was lost, and would make the message mean "possibly a gap", which is not a thing a client can
   * act on differently.
   *
   * The cost is one roster refetch per connected tab per reconnect. That is the same burst the
   * deployment already absorbs whenever this server restarts and every browser's own socket
   * reconnects at once, so it is a shape the roster query is already sized for, and a Postgres
   * reconnect is rarer than a deploy.
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
