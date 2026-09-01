import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import type { Database } from "../db/client";
import {
  agentProfiles,
  channelAgents,
  channelMemberships,
  channels,
  intelligenceChannelMappings,
} from "../db/schema";
import {
  CHANNEL_ACTIVITY_TOPIC,
  type ChannelActivityEvent,
  type ChannelEventHub,
} from "./events";
import { upgradeWebSocket } from "./socket";
import type { ThreadIdentity } from "./thread-identity";

export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
};

/** A channel plus the last thing said in it, which is what a roster renders. */
export type ChannelSummary = AgentChannel & {
  /** Parallel to agentIds, without copying image payloads into every roster row. */
  hasCustomAvatars: boolean[];
  /** Content version source for immutable avatar URLs, parallel to agentIds. */
  avatarUpdatedAts: Date[];
  lastMessage: string | null;
  lastMessageAt: Date | null;
  lastMessageAgentId: string | null;
  createdAt: Date;
  /** Whether the caller pinned this channel. A pin is per-member, so this is the caller's, only. */
  pinned: boolean;
  /** When the caller last had this channel open, or null for never. The caller's, only. */
  lastReadAt: Date | null;
};

/** What a client that ran an agent reports back about the message it just saw. */
export type ChannelActivity = {
  text: string;
  /** The agent that said it, or null when a person did. */
  agentId: string | null;
  at: Date;
};

/** One page of somebody's channels, newest activity first. */
export type ChannelPage = {
  channels: ChannelSummary[];
  /** Where the next page starts, or null at the end. */
  nextCursor: string | null;
};

export type ChannelQuery = { cursor?: string; limit?: number };

/**
 * How many channels one page holds.
 *
 * The sidebar asked for all of them on every render, one row per channel-agent pair, and nothing
 * removes a channel: somebody who talks to their Bot daily accumulates thousands, so a query that is
 * instant in a demo returns thousands of rows on every page load for every employee, and grows
 * monotonically. A page is what a sidebar can show anyway.
 */
const DEFAULT_CHANNEL_PAGE = 50;

/** The most a caller may ask for, so the endpoint cannot be talked back into reading everything. */
const MAX_CHANNEL_PAGE = 200;

/**
 * Where a page stopped: every part of the sort, in sort order.
 *
 * `pinned` leads, because the ordering does: a keyset cursor has to name the whole sort key or the
 * next page is selected by a different rule than the page it follows, which serves some channels
 * twice and others never. `recency` and `id` are both here for the same reason — two channels can
 * share a timestamp.
 */
type ChannelCursor = { pinned: boolean; recency: string; id: string };

function encodeChannelCursor(cursor: ChannelCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * A malformed cursor reads as the first page, which is the honest answer to a stale link.
 *
 * A cursor minted before `pinned` existed is malformed by this definition, and deliberately: it
 * describes a position in an ordering this query no longer has.
 */
function decodeChannelCursor(
  value: string | undefined,
): ChannelCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as ChannelCursor;
    return typeof parsed?.id === "string" &&
      typeof parsed?.recency === "string" &&
      typeof parsed?.pinned === "boolean"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The roster's sort key, as SQL, in the order it sorts.
 *
 * Every part descends, which is what lets the cursor be one row comparison rather than a nest of
 * ORs: a pin is 1 and no pin is 0, so `desc` puts pinned channels first, and both remaining parts
 * already wanted `desc`. Starting a conversation counts as activity — a channel somebody just made
 * has nothing said in it yet and is the one they are about to type in, so ordering on the message
 * alone would bury it under every channel that has one.
 *
 * The browser repeats the recency half when the socket patches a row, and lifts pinned rows at
 * render; both must agree with this, or the list reorders itself on the next event. See `byRecency`
 * in use-channel-events.ts and `pinnedFirst` in app-sidebar.tsx.
 */
const PINNED_RANK = sql`case when ${channelMemberships.pinnedAt} is not null then 1 else 0 end`;
const RECENCY = sql`coalesce(${channels.lastMessageAt}, ${channels.createdAt})`;
const ROSTER_ORDER = [
  sql`${PINNED_RANK} desc`,
  sql`${RECENCY} desc`,
  desc(channels.id),
];

/** The transaction `create` and `direct` share, as the driver hands it to a callback. */
type ChannelTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type ChannelStore = {
  create(actor: AgentActor, agentIds: string[]): Promise<AgentChannel>;
  /**
   * The one conversation this person has with this Bot alone, made if they have not had one yet.
   *
   * FOUND BEFORE IT IS MADE, because the callers that want it are called more than once for the
   * same pair. A hop delivered to a Bot is retried when the delivery fails, and creating here would
   * leave a fresh empty conversation behind for every attempt: the person would open the roster to
   * five Knowledge channels, four of them empty, and no way to tell which one holds the answer.
   *
   * The one it finds is the one the person already talks to that Bot in, which is also where they
   * would look for the answer.
   */
  direct(actor: AgentActor, agentId: string): Promise<AgentChannel>;
  get(actor: AgentActor, channelId: string): Promise<AgentChannel | null>;
  list(actor: AgentActor, query?: ChannelQuery): Promise<ChannelPage>;
  /** Pin or unpin the caller's own membership. Throws ChannelNotFoundError for a non-member. */
  setPinned(
    actor: AgentActor,
    channelId: string,
    pinned: boolean,
  ): Promise<void>;
  /** Stamp the caller's own membership as read now. Throws ChannelNotFoundError for a non-member. */
  markRead(actor: AgentActor, channelId: string): Promise<void>;
  /**
   * Hide the channel for every member. Soft: the row and the thread survive, every read filters.
   * Throws ChannelNotFoundError for a non-member and ChannelPackageOwnedError for a channel the
   * tenant package defines, which configuration owns rather than any member.
   */
  softDelete(actor: AgentActor, channelId: string): Promise<void>;
  recordActivity(
    actor: AgentActor,
    channelId: string,
    activity: ChannelActivity,
  ): Promise<void>;
  /**
   * Tell a channel's members that a turn started or ended in it, by the thread it runs in.
   *
   * Keyed by thread because that is all a headless turn knows. A thread that maps to no channel —
   * the scratch thread a handoff answers in — resolves to nothing and signals nowhere, which is
   * the point of a scratch thread. Announced, never written: `busy` is a moment, not a fact about
   * the channel, and a missed one costs a dot until the next real event rather than any data.
   */
  signalBusy(threadId: string, busy: boolean): Promise<void>;
  /**
   * The same signal, from a person's own run, by the channel they are in.
   *
   * A browser knows exactly when its run starts and stops and which channel it is in, which the
   * server cannot see: the runtime does not tell this deployment when a person's turn begins. So
   * the browser reports it, and this checks the caller belongs to the channel before announcing —
   * the membership check `signalBusy` does not need, because that one is only ever called by the
   * server about work it started itself.
   */
  signalChannelBusy(
    actor: AgentActor,
    channelId: string,
    busy: boolean,
  ): Promise<void>;
};

const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";
const MAX_CHANNEL_NAME_CODE_POINTS = 120;
const MAX_ACTIVITY_CODE_POINTS = 200;

/**
 * Reduce a message to one line of plain text.
 *
 * A preview is rendered as text wherever a roster appears, so control characters have nothing to do
 * there: at best they are invisible, at worst a terminal escape somebody put in a message follows it
 * into a log. Newlines collapse to spaces because a preview is one line by definition.
 */
function previewOf(text: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  const flattened = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  const collapsed = flattened.replace(/\s+/g, " ");
  const codePoints = Array.from(collapsed);
  if (codePoints.length <= MAX_ACTIVITY_CODE_POINTS) return collapsed;
  return `${codePoints.slice(0, MAX_ACTIVITY_CODE_POINTS - 1).join("")}…`;
}

function channelName(names: string[]) {
  const joined = names.join(", ");
  const codePoints = Array.from(joined);
  if (codePoints.length <= MAX_CHANNEL_NAME_CODE_POINTS) return joined;
  return `${codePoints.slice(0, MAX_CHANNEL_NAME_CODE_POINTS - 1).join("")}…`;
}

export function createChannelStore(
  database: Database,
  profileStore: AgentProfileStore,
  threadIdentity: ThreadIdentity,
): ChannelStore {
  /**
   * Making a channel, on a transaction the caller already holds.
   *
   * Extracted so `direct` can find-or-create inside ONE transaction. Two of those arriving together
   * for the same person and Bot each found nothing and each made a conversation, so that person had
   * two Knowledge channels holding two threads, with their answers split between them. Reproduced
   * against a real PostgreSQL: it needs no cluster, only two hops delivered at once, which is what a
   * Bot asking for several things in one turn produces.
   */
  const makeChannel = async (
    transaction: ChannelTransaction,
    actor: AgentActor,
    agentIds: string[],
  ): Promise<AgentChannel> => {
    // Validated on this transaction, not through `profileStore.get`: the read has to share
    // the connection this transaction already holds, and has to hold the profile so an agent
    // cannot be deleted between passing the check and being linked to the new channel.
    //
    // Locks are taken in agent-ID order. Two channels selecting the same pair of agents in
    // opposite orders would otherwise be able to deadlock against each other.
    const profilesById = new Map<string, AgentProfile>();
    for (const agentId of [...agentIds].sort()) {
      const profile = await profileStore.getWithin(transaction, actor, agentId);
      if (!profile) throw new AgentNotFoundError(agentId);
      profilesById.set(agentId, profile);
    }

    const id = `channel_${crypto.randomUUID()}`;
    // Minted rather than a bare random id, so the thread says which deployment it belongs to
    // in a project that may hold more than one. See thread-identity.ts.
    const threadId = threadIdentity.mint();
    // Named from the caller's ordering, which is the order the channel presents its agents in.
    const name = channelName(
      agentIds.map((agentId) => {
        const profile = profilesById.get(agentId);
        if (!profile) throw new AgentNotFoundError(agentId);
        return profile.name;
      }),
    );

    await transaction.insert(channels).values({
      id,
      name,
      description: PRIVATE_AGENT_CHANNEL_DESCRIPTION,
    });
    await transaction.insert(channelMemberships).values({
      channelId: id,
      userId: actor.id,
    });
    await transaction
      .insert(channelAgents)
      .values(agentIds.map((agentId) => ({ channelId: id, agentId })));
    await transaction.insert(intelligenceChannelMappings).values({
      userId: actor.id,
      channelId: id,
      threadId,
    });

    return { id, name, agentIds, threadId, active: true };
  };

  const store: ChannelStore = {
    create(actor, agentIds) {
      return database.transaction(
        async (transaction) => makeChannel(transaction, actor, agentIds),
        { isolationLevel: "read committed" },
      );
    },

    async direct(actor, agentId) {
      const found = await database.transaction(
        async (transaction) => {
          /*
           * ONE AT A TIME PER PERSON AND BOT, across every replica.
           *
           * Looking and then making is not find-or-create: two hops delivered at the same moment
           * each saw nothing and each made a conversation, and that person ended up with two
           * Knowledge channels holding two threads, with the answers split between them. A Bot
           * asking for several things in one turn produces exactly that, so it needs no cluster and
           * no unusual timing.
           *
           * An advisory lock rather than a unique constraint, because what has to be unique is not a
           * column: it is "this person's channel whose whole roster is this one Bot", which is a
           * count over another table. The lock is held for the transaction and taken on the pair, so
           * nothing else on the channel table waits behind it.
           */
          await transaction.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`channel:direct:${actor.id}:${agentId}`}))`,
          );
          const [existing] = await transaction
            .select({ id: channels.id })
            .from(channels)
            .innerJoin(
              channelMemberships,
              and(
                eq(channelMemberships.channelId, channels.id),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            .innerJoin(
              channelAgents,
              and(
                eq(channelAgents.channelId, channels.id),
                eq(channelAgents.agentId, agentId),
              ),
            )
            /*
             * A channel of this person's whose whole roster is this one Bot. The count is what makes
             * it "alone": a channel holding this Bot and another one would match an agent test on
             * its own, and delivering into it would put the answer in front of a Bot nobody asked.
             */
            .where(
              and(
                isNull(channels.deletedAt),
                sql`(select count(*) from ${channelAgents} where ${channelAgents.channelId} = ${channels.id}) = 1`,
              ),
            )
            .orderBy(...ROSTER_ORDER)
            .limit(1);

          return existing
            ? existing.id
            : await makeChannel(transaction, actor, [agentId]);
        },
        { isolationLevel: "read committed" },
      );

      if (typeof found !== "string") return found;
      const channel = await store.get(actor, found);
      // Null only if it was deleted between the two reads, which is a reason to make a new one
      // rather than to fail: the caller asked for a conversation, not for that row.
      return channel ?? store.create(actor, [agentId]);
    },

    async get(actor, channelId) {
      const rows = await database
        .select({
          id: channels.id,
          name: channels.name,
          agentId: channelAgents.agentId,
          threadId: intelligenceChannelMappings.threadId,
          deletedAt: agentProfiles.deletedAt,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .innerJoin(
          intelligenceChannelMappings,
          and(
            eq(intelligenceChannelMappings.channelId, channels.id),
            eq(intelligenceChannelMappings.userId, actor.id),
          ),
        )
        .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.agentId, channelAgents.agentId),
        )
        .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)))
        .orderBy(asc(channelAgents.agentId));

      const first = rows[0];
      if (!first) return null;

      return {
        id: first.id,
        name: first.name,
        agentIds: rows.map((row) => row.agentId),
        threadId: first.threadId,
        active: rows.every((row) => row.deletedAt === null),
      };
    },

    async list(actor, query = {}) {
      const limit = Math.min(
        Math.max(query.limit ?? DEFAULT_CHANNEL_PAGE, 1),
        MAX_CHANNEL_PAGE,
      );
      const cursor = decodeChannelCursor(query.cursor);

      /*
       * The page of channels is chosen first, and the agents are joined to that page.
       *
       * The row set below is one row per channel-agent pair, so a limit on rows would cut a channel
       * in half: its second Bot would arrive on the next page as a separate entry with the same id.
       * Limiting the channels and then joining keeps a channel whole whatever it holds.
       */
      const page = await database
        .select({
          id: channels.id,
          recency: sql<Date>`${RECENCY}`,
          pinned: sql<boolean>`${channelMemberships.pinnedAt} is not null`,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .where(
          and(
            isNull(channels.deletedAt),
            // One row comparison over the whole sort key, which only reads as "everything after the
            // cursor" because every part of that key descends. See ROSTER_ORDER.
            cursor
              ? sql`(${PINNED_RANK}, ${RECENCY}, ${channels.id}) < (${cursor.pinned ? 1 : 0}::int, ${cursor.recency}::timestamptz, ${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(...ROSTER_ORDER)
        // One more than asked for, so "is there another page" needs no second count query.
        .limit(limit + 1);

      const wanted = page.slice(0, limit);
      const last = wanted.at(-1);
      const nextCursor =
        page.length > limit && last
          ? encodeChannelCursor({
              pinned: last.pinned,
              recency: new Date(last.recency).toISOString(),
              id: last.id,
            })
          : null;

      if (wanted.length === 0) return { channels: [], nextCursor: null };

      const rows = await database
        .select({
          id: channels.id,
          name: channels.name,
          agentId: channelAgents.agentId,
          hasAvatarImage: sql<boolean>`${agentProfiles.avatarImage} is not null`,
          avatarUpdatedAt: agentProfiles.updatedAt,
          threadId: intelligenceChannelMappings.threadId,
          deletedAt: agentProfiles.deletedAt,
          lastMessage: channels.lastMessage,
          lastMessageAt: channels.lastMessageAt,
          lastMessageAgentId: channels.lastMessageAgentId,
          createdAt: channels.createdAt,
          pinnedAt: channelMemberships.pinnedAt,
          lastReadAt: channelMemberships.lastReadAt,
        })
        .from(channels)
        .innerJoin(
          channelMemberships,
          and(
            eq(channelMemberships.channelId, channels.id),
            eq(channelMemberships.userId, actor.id),
          ),
        )
        .innerJoin(
          intelligenceChannelMappings,
          and(
            eq(intelligenceChannelMappings.channelId, channels.id),
            eq(intelligenceChannelMappings.userId, actor.id),
          ),
        )
        .innerJoin(channelAgents, eq(channelAgents.channelId, channels.id))
        .innerJoin(
          agentProfiles,
          eq(agentProfiles.agentId, channelAgents.agentId),
        )
        .where(
          and(
            inArray(
              channels.id,
              wanted.map((row) => row.id),
            ),
            // Repeated, not inherited from the query that chose the page: these are two statements
            // on two snapshots, so a delete that commits between them would otherwise hand back a
            // channel this person can no longer see.
            isNull(channels.deletedAt),
          ),
        )
        // The same order the page was chosen in, since the rows below are read in order.
        .orderBy(...ROSTER_ORDER, asc(channelAgents.agentId));

      // One row per channel-agent pair; the ordering above keeps each channel's rows together and
      // its agents in the same lexicographic order `get` returns.
      const summaries = new Map<string, ChannelSummary>();
      for (const row of rows) {
        const summary = summaries.get(row.id);
        if (summary) {
          summary.agentIds.push(row.agentId);
          summary.hasCustomAvatars.push(row.hasAvatarImage);
          summary.avatarUpdatedAts.push(row.avatarUpdatedAt);
          summary.active &&= row.deletedAt === null;
          continue;
        }
        summaries.set(row.id, {
          id: row.id,
          name: row.name,
          agentIds: [row.agentId],
          hasCustomAvatars: [row.hasAvatarImage],
          avatarUpdatedAts: [row.avatarUpdatedAt],
          threadId: row.threadId,
          active: row.deletedAt === null,
          lastMessage: row.lastMessage,
          lastMessageAt: row.lastMessageAt,
          lastMessageAgentId: row.lastMessageAgentId,
          createdAt: row.createdAt,
          pinned: row.pinnedAt !== null,
          lastReadAt: row.lastReadAt,
        });
      }
      return { channels: [...summaries.values()], nextCursor };
    },

    async setPinned(actor, channelId, pinned) {
      await database.transaction(
        async (transaction) => {
          const updated = await transaction
            .update(channelMemberships)
            .set({ pinnedAt: pinned ? new Date() : null })
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                eq(channelMemberships.userId, actor.id),
                // A deleted channel is not there to pin. Without this, pinning one succeeds and
                // announces, and the announcement sends this person's tabs to refetch a roster that
                // cannot show the row. `get` and `list` filter the same way.
                exists(
                  transaction
                    .select({ one: sql`1` })
                    .from(channels)
                    .where(
                      and(
                        eq(channels.id, channelId),
                        isNull(channels.deletedAt),
                      ),
                    ),
                ),
              ),
            )
            .returning({ channelId: channelMemberships.channelId });
          // Not a member, no such channel, or a deleted one: the same answer every way, matching
          // recordActivity and `get`.
          if (updated.length === 0) throw new ChannelNotFoundError(channelId);

          /*
           * Announced to this member alone.
           *
           * A pin is a fact about one membership row, so `memberIds` holds the person who made it
           * and nobody else. The hub delivers by that list, which is what carries the pin across
           * this person's own tabs and replicas without putting it on anybody else's roster.
           */
          const event: ChannelActivityEvent = {
            channelId,
            memberIds: [actor.id],
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            pinned,
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
        },
        { isolationLevel: "read committed" },
      );
    },

    async markRead(actor, channelId) {
      const updated = await database
        .update(channelMemberships)
        .set({
          /*
           * The later of this clock and the channel's own last-message stamp. last_message_at is
           * written from the reporting browser's clock and is not bounded; a marker stamped
           * plainly "now" by a server running behind it would leave the row reading as unseen for
           * every member, re-lighting the dot on each refetch until wall clock catches up.
           */
          lastReadAt: sql`greatest(now(), coalesce((select ${channels.lastMessageAt} from ${channels} where ${channels.id} = ${channelMemberships.channelId}), now()))`,
        })
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, actor.id),
            // A deleted channel is not there to read. The same guard `setPinned` carries, for the
            // same reason: the row is gone from every roster, so nothing about it is markable.
            exists(
              database
                .select({ one: sql`1` })
                .from(channels)
                .where(
                  and(eq(channels.id, channelId), isNull(channels.deletedAt)),
                ),
            ),
          ),
        )
        .returning({ channelId: channelMemberships.channelId });
      // Not a member, or no such channel: the same answer either way, matching setPinned.
      if (updated.length === 0) throw new ChannelNotFoundError(channelId);
    },

    async softDelete(actor, channelId) {
      await database.transaction(
        async (transaction) => {
          const [row] = await transaction
            .select({ packageId: channels.packageId })
            .from(channels)
            .innerJoin(
              channelMemberships,
              and(
                eq(channelMemberships.channelId, channels.id),
                eq(channelMemberships.userId, actor.id),
              ),
            )
            .where(eq(channels.id, channelId));
          // Not a member, or no such channel: the same answer either way.
          if (!row) throw new ChannelNotFoundError(channelId);
          // Package channels are configuration; the sync that wrote them owns them.
          if (row.packageId !== null) {
            throw new ChannelPackageOwnedError(channelId);
          }
          // The guard on deletedAt is what makes a repeat call a no-op rather than a new stamp.
          await transaction
            .update(channels)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(channels.id, channelId), isNull(channels.deletedAt)));

          // Read on this transaction, so the members told are the ones the channel had when it was
          // hidden. Soft leaves the membership rows in place, so this reads the same list a repeat
          // call would.
          const members = await transaction
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId));

          /*
           * Announced inside the transaction, so it is delivered on commit and a refused delete —
           * a channel the package owns, or one the caller is not in — announces nothing at all.
           *
           * Every member is told, because the deletion hides the channel for all of them: without
           * this, a second tab and a second replica keep rendering a row whose channel no longer
           * resolves until something else makes them refetch.
           */
          const event: ChannelActivityEvent = {
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage: null,
            lastMessageAt: null,
            lastMessageAgentId: null,
            deleted: true,
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
        },
        { isolationLevel: "read committed" },
      );
    },

    recordActivity(actor, channelId, activity) {
      return database.transaction(
        async (transaction) => {
          const [membership] = await transaction
            .select({ channelId: channelMemberships.channelId })
            .from(channelMemberships)
            // Joined rather than checked on the membership alone, so a deleted channel is refused
            // too. `get` and `list` filter on `deleted_at`, so without this a client holding a stale
            // roster row can bump `last_message` on a channel nobody can see and announce it to
            // every member, each of whom refetches their roster for an invisible row.
            .innerJoin(
              channels,
              and(
                eq(channels.id, channelMemberships.channelId),
                isNull(channels.deletedAt),
              ),
            )
            .where(
              and(
                eq(channelMemberships.channelId, channelId),
                eq(channelMemberships.userId, actor.id),
              ),
            );
          // Not a member, no such channel, or a deleted one: the same answer every way, so belonging
          // to a channel is not something an outsider can probe for.
          if (!membership) throw new ChannelNotFoundError(channelId);

          if (activity.agentId !== null) {
            const [linked] = await transaction
              .select({ agentId: channelAgents.agentId })
              .from(channelAgents)
              .where(
                and(
                  eq(channelAgents.channelId, channelId),
                  eq(channelAgents.agentId, activity.agentId),
                ),
              );
            if (!linked) throw new AgentNotFoundError(activity.agentId);
          }

          // A person's message and the agent's reply are reported separately, so they can arrive out
          // of order. Only ever move forwards.
          const lastMessage = previewOf(activity.text);
          const applied = await transaction
            .update(channels)
            .set({
              lastMessage,
              lastMessageAt: activity.at,
              lastMessageAgentId: activity.agentId,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(channels.id, channelId),
                or(
                  isNull(channels.lastMessageAt),
                  lt(channels.lastMessageAt, activity.at),
                ),
              ),
            )
            .returning({ id: channels.id });
          // Nothing changed, so there is nothing to announce: a stale report is not news.
          if (applied.length === 0) return;

          const members = await transaction
            .select({ userId: channelMemberships.userId })
            .from(channelMemberships)
            .where(eq(channelMemberships.channelId, channelId));

          // Announced inside the transaction, so it is delivered on commit and a write that rolls
          // back is never announced. The payload carries the members because the writer has already
          // resolved them; NOTIFY caps at 8000 bytes, which a 200-character preview leaves room in.
          const event: ChannelActivityEvent = {
            channelId,
            memberIds: members.map((member) => member.userId),
            lastMessage,
            lastMessageAt: activity.at.toISOString(),
            lastMessageAgentId: activity.agentId,
          };
          await transaction.execute(
            sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
          );
        },
        { isolationLevel: "read committed" },
      );
    },

    async signalBusy(threadId, busy) {
      // The channel this thread is shown in, if any. A scratch thread maps to nothing, so a hop
      // running there signals nowhere and the branch below returns without announcing.
      const [mapped] = await database
        .select({ channelId: intelligenceChannelMappings.channelId })
        .from(intelligenceChannelMappings)
        .where(eq(intelligenceChannelMappings.threadId, threadId))
        .limit(1);
      if (!mapped) return;

      const members = await database
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(eq(channelMemberships.channelId, mapped.channelId));
      if (members.length === 0) return;

      // No table write: busy is a moment, and the roster query stays the source of truth. Just the
      // announcement, carrying the members the same way recordActivity does.
      const event: ChannelActivityEvent = {
        channelId: mapped.channelId,
        memberIds: members.map((member) => member.userId),
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
        busy,
      };
      await database.execute(
        sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
      );
    },

    async signalChannelBusy(actor, channelId, busy) {
      const [membership] = await database
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .innerJoin(
          channels,
          and(
            eq(channels.id, channelMemberships.channelId),
            isNull(channels.deletedAt),
          ),
        )
        .where(
          and(
            eq(channelMemberships.channelId, channelId),
            eq(channelMemberships.userId, actor.id),
          ),
        );
      // Not a member, no such channel, or a deleted one: the same refusal every way, so belonging
      // to a channel is not something an outsider can probe for.
      if (!membership) throw new ChannelNotFoundError(channelId);

      const members = await database
        .select({ userId: channelMemberships.userId })
        .from(channelMemberships)
        .where(eq(channelMemberships.channelId, channelId));

      const event: ChannelActivityEvent = {
        channelId,
        memberIds: members.map((member) => member.userId),
        lastMessage: null,
        lastMessageAt: null,
        lastMessageAgentId: null,
        busy,
      };
      await database.execute(
        sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
      );
    },
  };
  return store;
}

export class ChannelNotFoundError extends Error {
  constructor(id: string) {
    super(`Channel ${id} was not found.`);
    this.name = "ChannelNotFoundError";
  }
}

export class ChannelPackageOwnedError extends Error {
  constructor(id: string) {
    super(`Channel ${id} is defined by the deployment package.`);
    this.name = "ChannelPackageOwnedError";
  }
}

type ChannelInputParseResult =
  | { ok: true; value: { agentIds: string[] } }
  | { ok: false; error: string };

type ChannelInputObject = { agentIds?: unknown };

export function parseChannelInput(input: unknown): ChannelInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, error: "Channel input must be a JSON object." };
  }

  if (!Array.isArray(input.agentIds) || input.agentIds.length === 0) {
    return { ok: false, error: "Agent IDs must be a non-empty array." };
  }

  const agentIds: string[] = [];
  for (const agentId of input.agentIds) {
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      return { ok: false, error: "Agent IDs must be non-empty strings." };
    }
    agentIds.push(agentId.trim());
  }

  if (new Set(agentIds).size !== agentIds.length) {
    return { ok: false, error: "Agent IDs must be unique." };
  }

  return { ok: true, value: { agentIds: agentIds.sort() } };
}

function isChannelInputObject(input: unknown): input is ChannelInputObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

type ActivityInputParseResult =
  | { ok: true; value: ChannelActivity }
  | { ok: false; error: string };

/**
 * Parse a reported message.
 *
 * `at` comes from the client that saw the message, because only it knows when the message arrived, * but it is never trusted as a clock: the store compares it against what is stored and only ever
 * moves forwards, so a wrong one can lose a report, not corrupt the row.
 */
export function parseActivityInput(input: unknown): ActivityInputParseResult {
  if (!isChannelInputObject(input)) {
    return { ok: false, error: "Activity must be a JSON object." };
  }
  const object = input as { text?: unknown; agentId?: unknown; at?: unknown };

  if (typeof object.text !== "string" || object.text.trim().length === 0) {
    return { ok: false, error: "Text is required." };
  }
  if (object.agentId !== null && typeof object.agentId !== "string") {
    return { ok: false, error: "Agent ID must be a string or null." };
  }
  if (typeof object.at !== "string") {
    return { ok: false, error: "Timestamp is required." };
  }
  const at = new Date(object.at);
  if (Number.isNaN(at.getTime())) {
    return { ok: false, error: "Timestamp must be an ISO-8601 date." };
  }

  return {
    ok: true,
    value: {
      agentId:
        typeof object.agentId === "string" ? object.agentId.trim() : null,
      at,
      text: object.text,
    },
  };
}

export function createChannelRoutes(
  store: ChannelStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  /** Absent in tests and wherever live updates are not wanted; the routes still work without it. */
  events?: ChannelEventHub,
  /** Where a channel's removal is written. Absent in tests that do not care about the trail. */
  auditStore?: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Write the one audit row this file ever writes, tolerantly.
   *
   * Mirrors `record` in agents/routes.ts: never fatal, because the channel is already hidden and the
   * caller has already been told so by the time this runs. A trail that is briefly unavailable is
   * not a reason to report a failure that did not happen.
   *
   * Reached only after `softDelete` resolves, so a refused delete — a channel the package owns, or
   * one the caller is not in — writes nothing. The trail records acts, not attempts.
   */
  const recordDeleted = async (
    context: Context<{ Variables: AppVariables }>,
    channelId: string,
  ): Promise<void> => {
    if (!auditStore) return;
    const actor = context.var.actor;
    try {
      await recordAuditEvent(auditStore, {
        eventType: "channel.deleted",
        targetType: "channel",
        targetId: channelId,
        /*
         * Attributed, including in single-user mode.
         *
         * The other audited surfaces drop this id when the actor is the local development one, on
         * the grounds that `audit_events.actor_user_id` has a foreign key into `users` that it would
         * violate. It has no foreign key, and `initializeDevActorUser` writes that row at start-up
         * anyway, so neither half of the reason holds. It matters here more than most: single-user
         * is the mode `.env.example` ships switched on, so an unattributed row is what a fork sees
         * by default, and "somebody deleted this conversation" is the whole point of the row.
         */
        actorUserId: actor.id,
        // Named rather than implied: the channel row and its thread are still there, and a later
        // hard delete would be a different fact about the same channel.
        payload: { mechanism: "soft" },
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "channel-audit-write-failed",
          eventType: "channel.deleted",
          channelId,
          error: String(error),
        }),
      );
    }
  };

  // Before `/:channelId`, or "events" is read as a channel id.
  if (events) {
    routes.get(
      "/events",
      requireUser,
      upgradeWebSocket((context) => {
        // Resolved at upgrade, not per message: the connection belongs to whoever authenticated it,
        // and nothing it later sends can change that.
        const { id: userId } = context.var.actor;
        let detach = () => {};
        return {
          onOpen: (_event, ws) => {
            detach = events.register(userId, (payload) => ws.send(payload));
          },
          onClose: () => detach(),
          onError: () => detach(),
        };
      }),
    );
  }

  routes.post("/", requireUser, async (context) => {
    const parsed = parseChannelInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      const channel = await store.create(
        context.var.actor,
        parsed.value.agentIds,
      );
      return context.json({ channel: channelDto(channel) }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/", requireUser, async (context) => {
    try {
      const url = new URL(context.req.url);
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const page = await store.list(context.var.actor, {
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      });

      return context.json({
        channels: page.channels.map(channelSummaryDto),
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:channelId/activity", requireUser, async (context) => {
    const parsed = parseActivityInput(
      await context.req.json().catch(() => null),
    );
    if (!parsed.ok) return context.json({ error: parsed.error }, 400);

    try {
      await store.recordActivity(
        context.var.actor,
        context.req.param("channelId"),
        parsed.value,
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:channelId/busy", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      busy?: unknown;
    } | null;
    if (typeof body?.busy !== "boolean") {
      return context.json({ error: "busy must be true or false" }, 400);
    }

    try {
      await store.signalChannelBusy(
        context.var.actor,
        context.req.param("channelId"),
        body.busy,
      );
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/:channelId/pin", requireUser, async (context) => {
    const body = await context.req.json().catch(() => null);
    if (!isChannelInputObject(body)) {
      return context.json({ error: "Pin input must be a JSON object." }, 400);
    }
    const { pinned } = body as { pinned?: unknown };
    if (typeof pinned !== "boolean") {
      return context.json({ error: "Pinned must be true or false." }, 400);
    }

    try {
      await store.setPinned(
        context.var.actor,
        context.req.param("channelId"),
        pinned,
      );
      return context.json({ pinned });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.put("/:channelId/read", requireUser, async (context) => {
    try {
      await store.markRead(context.var.actor, context.req.param("channelId"));
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:channelId", requireUser, async (context) => {
    const channelId = context.req.param("channelId");
    try {
      await store.softDelete(context.var.actor, channelId);
      await recordDeleted(context, channelId);
      return context.body(null, 204);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:channelId", requireUser, async (context) => {
    try {
      const channel = await store.get(
        context.var.actor,
        context.req.param("channelId"),
      );
      if (!channel) {
        return context.json({ error: "Channel not found." }, 404);
      }
      return context.json({ channel: channelDto(channel) });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function channelDto(channel: AgentChannel): AgentChannel {
  return {
    id: channel.id,
    name: channel.name,
    agentIds: channel.agentIds,
    threadId: channel.threadId,
    active: channel.active,
  };
}

function channelSummaryDto(channel: ChannelSummary) {
  return {
    ...channelDto(channel),
    avatarUrls: channel.agentIds.map((agentId, index) =>
      channel.hasCustomAvatars[index]
        ? `/api/agents/${encodeURIComponent(agentId)}/avatar/image?v=${channel.avatarUpdatedAts[index]?.getTime().toString(36)}`
        : null,
    ),
    lastMessage: channel.lastMessage,
    // Serialised as ISO-8601 so the browser gets a string it can sort and format.
    lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
    lastMessageAgentId: channel.lastMessageAgentId,
    createdAt: channel.createdAt.toISOString(),
    pinned: channel.pinned,
    // Serialised as ISO-8601 like lastMessageAt, so the browser can compare the two as strings.
    lastReadAt: channel.lastReadAt?.toISOString() ?? null,
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Agent not found." }, 404);
  }
  if (error instanceof ChannelNotFoundError) {
    return context.json({ error: "Channel not found." }, 404);
  }
  if (error instanceof ChannelPackageOwnedError) {
    return context.json(
      {
        error:
          "This channel is defined by the deployment package, so it cannot be deleted here.",
      },
      409,
    );
  }
  throw error;
}
