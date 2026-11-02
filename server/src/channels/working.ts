/**
 * What is working on a conversation right now, when nobody's browser is running it.
 *
 * A conversation can be waiting on work its person cannot see: a Bot it asked, answering in a
 * scratch thread nobody is shown, or a routine firing into it. The busy signal used to say only
 * "something is running", on the socket and nowhere else, so an open conversation looked idle and a
 * reload forgot even that much.
 *
 * READ FROM THE ROWS THAT ALREADY SAY SO, never written here. A hop is a `work_items` row until it
 * is finished and a routine firing is a `routine_runs` row until it has a status, so the queue and
 * the run history are the record. A second table of "busy reasons" would be a copy of them that a
 * crashed pod leaves behind: the hop would be retried and finished, and the copy would still say the
 * conversation was waiting. Derived, the answer a reload gets and the answer a socket event carries
 * are the same query.
 *
 * ONE ENTRY PER PIECE OF WORK, keyed by the work. A hop retried five times is one row on the queue
 * and one entry here. A hop whose answer is on its way back is the same entry too: the relay is
 * keyed `relay:<hop key>`, so it is folded into the hop it carries the answer for, and the timer a
 * person is watching does not restart when the answer turns around.
 */
import { TURN_LIMITS } from "@openbot/toolkit/limits";
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  lte,
  notLike,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { HANDOFF_KIND } from "../agents/handoff";
import type { Database } from "../db/client";
import { agents, routineRuns, routines, workItems } from "../db/schema";
import { DEFAULT_MAX_ATTEMPTS } from "../work/queue";

/** Something a conversation is waiting on. */
export type ChannelWork =
  | {
      /** A Bot this conversation's Bot asked, which has not answered here yet. */
      kind: "handoff";
      /** The hop's own key, so two asks of the same Bot are two entries. */
      key: string;
      /** The Bot that was asked. */
      botId: string;
      /** Its name when the hop was offered. Null on a hop written before names were carried. */
      botName: string | null;
      /** When it was asked. */
      since: Date;
    }
  | {
      /** A routine firing into this conversation. */
      kind: "routine";
      /** The run's id. */
      key: string;
      routineId: string;
      /** The Bot the routine runs as. */
      botId: string;
      botName: string | null;
      since: Date;
    };

/** The same, on the wire. */
export type ChannelWorkWire = Omit<ChannelWork, "since"> & { since: string };

export function channelWorkDto(work: ChannelWork): ChannelWorkWire {
  return { ...work, since: work.since.toISOString() };
}

/**
 * How long a routine run with no outcome still counts as running.
 *
 * The routine sweep's own cutoff for an abandoned run, so this never says a routine is running for
 * longer than the sweep would leave its row open. See `ABANDONED_RUN_MS` in routines/sweep.ts.
 */
const ROUTINE_IN_FLIGHT_MS = 2 * TURN_LIMITS.turnTimeoutMs;

const RELAY_PREFIX = "relay:";

type HandoffPayload = {
  threadId?: unknown;
  toBotId?: unknown;
  toName?: unknown;
  fromBotId?: unknown;
  answerIn?: unknown;
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** A conversation as one person holds it: the channel, and that person's own thread in it. */
export type ChannelThread = {
  id: string;
  /** The thread this person's Bot runs in. Hops are offered from it, so it scopes theirs. */
  threadId: string;
  /** The person. Their routines fire into this thread; another member's do not. */
  userId: string;
};

/**
 * What each of these conversations is waiting on, oldest first. A conversation waiting on nothing
 * is absent from the map.
 *
 * SCOPED TO THE PERSON, never to the channel. Every member of a channel has a thread of their own
 * in it, and the hops and routines in that thread are theirs: another member reading the same
 * channel must not learn which Bot somebody else asked, or which Bot their routine runs as.
 */
export async function workIn(
  database: Database,
  channels: readonly ChannelThread[],
): Promise<Map<string, ChannelWork[]>> {
  const found = new Map<string, ChannelWork[]>();
  if (channels.length === 0) return found;
  const channelByThread = new Map(
    channels.map((channel) => [channel.threadId, channel.id]),
  );
  const ownerByChannel = new Map(
    channels.map((channel) => [channel.id, channel.userId]),
  );
  const add = (channelId: string, work: ChannelWork) => {
    const list = found.get(channelId) ?? [];
    list.push(work);
    found.set(channelId, list);
  };

  /*
   * The hop that asked, joined to a relay so the relay can be read as the hop it answers: who was
   * asked and when. The relay's own payload names the Bot that answered as its sender and nothing
   * of when the question was put.
   */
  const asked = alias(workItems, "asked");
  // The same expression as `work_items_open_thread_idx`, so the read uses it. See work.ts.
  const threadOf = sql<string>`(${workItems.payload}->>'threadId')`;
  const hops = await database
    .select({
      key: workItems.key,
      payload: workItems.payload,
      createdAt: workItems.createdAt,
      askedPayload: asked.payload,
      askedAt: asked.createdAt,
    })
    .from(workItems)
    .leftJoin(
      asked,
      and(
        eq(asked.kind, workItems.kind),
        like(workItems.key, `${RELAY_PREFIX}%`),
        /*
         * The asked key cut out of the relay's, rather than the relay's built from every asked
         * key: this way round it is a primary-key lookup per relay, and the other way round is a
         * scan of every hop the table holds.
         */
        eq(
          asked.key,
          sql`substr(${workItems.key}, ${RELAY_PREFIX.length + 1})`,
        ),
      ),
    )
    .where(
      and(
        eq(workItems.kind, HANDOFF_KIND),
        isNull(workItems.finishedAt),
        inArray(threadOf, [...channelByThread.keys()]),
        // A notice says a hop failed for good. Nothing is coming, so nothing is waited on.
        notLike(workItems.key, "notice:%"),
        // Given up on: still a row, never claimed again. Unless its last attempt is still running.
        or(
          lt(workItems.attempts, DEFAULT_MAX_ATTEMPTS),
          gt(workItems.leaseUntil, sql`now()`),
        ),
        /*
         * A relay that is running is the asking Bot speaking in this conversation, which is the
         * answer arriving rather than a wait for it. Only a relay still queued is a wait.
         */
        or(
          sql`${workItems.payload}->>'answerIn' is null`,
          isNull(workItems.claimedBy),
          isNull(workItems.leaseUntil),
          lte(workItems.leaseUntil, sql`now()`),
        ),
      ),
    );

  const seen = new Set<string>();
  for (const hop of hops.sort(
    (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
  )) {
    const payload = hop.payload as HandoffPayload;
    const channelId = channelByThread.get(String(payload.threadId));
    if (!channelId) continue;
    const isRelay = text(payload.answerIn) !== null;
    const original = (hop.askedPayload ?? null) as HandoffPayload | null;
    const key = isRelay ? hop.key.slice(RELAY_PREFIX.length) : hop.key;
    if (seen.has(key)) continue;
    seen.add(key);
    // A relay is sent BY the Bot that was asked, so its sender is the one being waited on.
    const botId = isRelay
      ? (text(original?.toBotId) ?? text(payload.fromBotId))
      : text(payload.toBotId);
    if (!botId) continue;
    add(channelId, {
      kind: "handoff",
      key,
      botId,
      botName: text(isRelay ? original?.toName : payload.toName),
      since: (isRelay ? hop.askedAt : null) ?? hop.createdAt,
    });
  }

  const runs = await database
    .select({
      runId: routineRuns.id,
      routineId: routines.id,
      channelId: routines.channelId,
      ownerUserId: routines.ownerUserId,
      botId: routines.agentId,
      botName: agents.name,
      startedAt: routineRuns.startedAt,
    })
    .from(routineRuns)
    .innerJoin(routines, eq(routines.id, routineRuns.routineId))
    .leftJoin(agents, eq(agents.id, routines.agentId))
    .where(
      and(
        isNull(routineRuns.status),
        inArray(
          routines.channelId,
          channels.map((channel) => channel.id),
        ),
        gt(
          routineRuns.startedAt,
          sql`now() - make_interval(secs => ${ROUTINE_IN_FLIGHT_MS / 1000})`,
        ),
      ),
    );
  for (const run of runs) {
    // Somebody else's routine, firing into their own thread in a channel this person shares.
    if (ownerByChannel.get(run.channelId) !== run.ownerUserId) continue;
    add(run.channelId, {
      kind: "routine",
      key: run.runId,
      routineId: run.routineId,
      botId: run.botId,
      botName: run.botName ?? null,
      since: run.startedAt,
    });
  }

  for (const list of found.values())
    list.sort((left, right) => left.since.getTime() - right.since.getTime());
  return found;
}
