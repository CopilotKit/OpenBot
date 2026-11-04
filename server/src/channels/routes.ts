import { sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { bots } from "../agents/bot-registry/directory";
import type { Bot } from "../agents/bot-registry/types";
import {
  AgentNotFoundError,
  type AgentProfileStore,
} from "../agents/profile-store";
import type { AgentActor, AgentProfile } from "../agents/profile-types";
import { type AuditStore, recordAuditEvent } from "../audit";
import type { AppVariables } from "../auth/guards";
import {
  ConversationAgentMissingError,
  ConversationMissingError,
  ConversationVersionConflictError,
} from "../conversations/client";
import { conversations } from "../conversations/directory";
import { IntelligenceApiError, writeKey } from "../conversations/http";
import {
  type Conversation,
  type ConversationDraft,
  isMember,
  ownThread,
} from "../conversations/types";
import type { Database } from "../db/client";
import { parsePageLimit } from "../paging";
import {
  CHANNEL_ACTIVITY_TOPIC,
  type ChannelActivityEvent,
  type ChannelEventHub,
} from "./events";
import { upgradeWebSocket } from "./socket";
import { oneLine } from "./text";
import type { ThreadIdentity } from "./thread-identity";
import { type ChannelWork, channelWorkDto, workIn } from "./working";

export type AgentChannel = {
  id: string;
  name: string;
  agentIds: string[];
  threadId: string;
  active: boolean;
  /**
   * When something was last said here, or null for a conversation nobody has used.
   *
   * On the channel itself rather than only on the roster summary, because the conversation screen
   * needs it: a thread the history store does not know about is an empty NEW conversation when this
   * is null and a conversation whose history is unreachable when it is set, and those are different
   * things to put on the screen. See the note in `channel-chat.tsx`.
   */
  lastMessageAt: Date | null;
};

/** A channel plus the last thing said in it, which is what a roster renders. */
export type ChannelSummary = AgentChannel & {
  /** A few words about the conversation, or null. Readers fall back to the channel's name. */
  summary: string | null;
  lastMessage: string | null;
  lastMessageAgentId: string | null;
  createdAt: Date;
  /** Whether the caller pinned this channel. A pin is per-member, so this is the caller's, only. */
  pinned: boolean;
  /** When the caller last had this channel open, or null for never. The caller's, only. */
  lastReadAt: Date | null;
  /**
   * Whether this is a task's own conversation (tasks/*), which holds one piece of work. Choosers of
   * "a conversation with this Bot", such as where its check-ins reach the person, leave these out.
   */
  task: boolean;
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

export type ChannelStore = {
  /** A new conversation with these Bots, the caller its only member. */
  create(actor: AgentActor, agentIds: string[]): Promise<AgentChannel>;
  /**
   * What `create` would make, without making it: checked against the person's Bots and named. For a
   * record that must be made in the same write as its conversation (a task's, tasks/runner.ts), so
   * the conversation is never visible without the record that says what it is for.
   */
  draft(actor: AgentActor, agentIds: string[]): Promise<ConversationDraft>;
  /**
   * The one conversation this person has with this Bot alone, made if they have not had one yet.
   *
   * FOUND BEFORE IT IS MADE, because the callers that want it are called more than once for the
   * same pair. A hop delivered to a Bot is retried when the delivery fails, and creating here would
   * leave a fresh empty conversation behind for every attempt: the person would open the roster to
   * five Knowledge channels, four of them empty, and no way to tell which one holds the answer.
   *
   * The one it finds is the one the person already talks to that Bot in, which is also where they
   * would look for the answer. Never a task's own conversation: that one holds one piece of work,
   * and is often the newest, so ordering alone would pick it.
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
   * Hide the channel for every member. Soft: the conversation and its threads survive in
   * Intelligence, and every read filters. Throws ChannelNotFoundError for a non-member and
   * ChannelPackageOwnedError for a channel the tenant package defines, which configuration owns
   * rather than any member.
   *
   * True when this call deleted the channel; false when it was already deleted. A repeat is a
   * no-op, so it announces nothing and its route records nothing.
   */
  softDelete(actor: AgentActor, channelId: string): Promise<boolean>;
  recordActivity(
    actor: AgentActor,
    channelId: string,
    activity: ChannelActivity,
    source?: {
      id: string;
      /** Enrich this source's preview at the same timestamp only while this text still matches. */
      enrichFrom?: string;
    },
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
  /**
   * Tell a channel's members what it is waiting on now, without saying a turn started or ended.
   *
   * For the moments the queue moves and no turn does: a hop finished, released for another try, or
   * turned into a relay. Every busy signal carries the same list, so this is only for those.
   */
  signalWork(threadId: string): Promise<void>;
  /**
   * What each of these channels is waiting on, for this person: their own thread's hops and their
   * own routines. See `workIn` in working.ts.
   */
  workIn(
    actor: AgentActor,
    channels: readonly { id: string; threadId: string }[],
  ): Promise<Map<string, ChannelWork[]>>;
};

const PRIVATE_AGENT_CHANNEL_DESCRIPTION = "Private agent channel.";
const MAX_CHANNEL_NAME_CODE_POINTS = 120;
const MAX_ACTIVITY_GRAPHEMES = 200;

/** Reduce a message to the one line a roster draws. See `oneLine` for why it is shared. */
function previewOf(text: string) {
  return oneLine(text, MAX_ACTIVITY_GRAPHEMES);
}

function channelName(names: string[]) {
  const joined = names.join(", ");
  const codePoints = Array.from(joined);
  if (codePoints.length <= MAX_CHANNEL_NAME_CODE_POINTS) return joined;
  return `${codePoints.slice(0, MAX_CHANNEL_NAME_CODE_POINTS - 1).join("")}…`;
}

/**
 * The conversation as this person's channel: live, theirs, with their own thread in it, and the Bots
 * Intelligence still has, in id order. Null when any of that is missing, which is the same answer a
 * channel that does not exist gets.
 *
 * A Bot purged for good is left out, as the cascade that removed its `channel_agents` row did; a
 * channel left with no Bot at all is no channel anybody can open.
 */
export function channelOf(
  conversation: Conversation,
  actorId: string,
  known: ReadonlyMap<string, Bot>,
): AgentChannel | null {
  if (conversation.deletedAt !== null) return null;
  if (!isMember(conversation, actorId)) return null;
  const thread = ownThread(conversation, actorId);
  if (!thread) return null;
  const agentIds = conversation.agents
    .map((agent) => agent.agentId)
    .filter((agentId) => known.has(agentId))
    .sort();
  if (agentIds.length === 0) return null;
  return {
    id: conversation.id,
    name: conversation.name,
    agentIds,
    threadId: thread.threadId,
    active: agentIds.every(
      (agentId) => (known.get(agentId)?.deletedAt ?? null) === null,
    ),
    lastMessageAt: conversation.lastMessageAt,
  };
}

/** The Bots these conversations name, read from the Bot directory. */
async function botsOf(list: readonly Conversation[]) {
  return bots().findMany(
    list.flatMap((conversation) =>
      conversation.agents.map((agent) => agent.agentId),
    ),
  );
}

export function createChannelStore(
  database: Database,
  profileStore: AgentProfileStore,
  threadIdentity: ThreadIdentity,
): ChannelStore {
  /**
   * The conversation a new channel would be: checked against the person's Bots, named from them in
   * the caller's order, and given the caller's own thread.
   */
  const draftFor = async (
    actor: AgentActor,
    agentIds: string[],
  ): Promise<ConversationDraft> => {
    const profilesById = new Map<string, AgentProfile>();
    for (const agentId of [...agentIds].sort()) {
      const profile = await profileStore.get(actor, agentId);
      if (!profile) throw new AgentNotFoundError(agentId);
      profilesById.set(agentId, profile);
    }
    // Named from the caller's ordering, which is the order the channel presents its agents in.
    const name = channelName(
      agentIds.map((agentId) => {
        const profile = profilesById.get(agentId);
        if (!profile) throw new AgentNotFoundError(agentId);
        return profile.name;
      }),
    );
    return {
      id: `channel_${crypto.randomUUID()}`,
      name,
      description: PRIVATE_AGENT_CHANNEL_DESCRIPTION,
      agents: agentIds.map((agentId) => ({ agentId })),
      // Minted rather than a bare random id, so the thread says which deployment it belongs to
      // in a project that may hold more than one. See thread-identity.ts.
      members: [{ userId: actor.id, threadId: threadIdentity.mint() }],
    };
  };

  /** The channel a conversation this person may use is, or null. */
  const channelFor = async (
    conversation: Conversation | null,
    actorId: string,
  ): Promise<AgentChannel | null> =>
    conversation
      ? channelOf(conversation, actorId, await botsOf([conversation]))
      : null;

  /**
   * Tell a channel's members what it is waiting on, and whether a turn just started or ended.
   *
   * No write anywhere: busy is a moment, and the rows the work list is read from (this deployment's
   * own work queue) stay the source of truth. So this stays on this deployment's own notification
   * channel, like the queue's wake-ups, rather than going through Intelligence: there is nothing
   * stored to announce a change of. The list rides on every one of these so a client never merges
   * a delta into what it holds: the newest event is the whole answer, and the same answer a reload
   * gets.
   *
   * THE LIST GOES ONLY TO THE PERSON WHOSE THREAD IT IS. Each member has a thread of their own in
   * a channel, and what that thread waits on names the Bots its owner asked. The other members
   * hear that a turn started or ended, as they always have, and nothing about whom it asked.
   *
   * `workAt` is the database's clock just before the list was read. Two announcements for one
   * channel can be read on two replicas and delivered in either order, so the browser keeps the
   * list with the latest `workAt` rather than the one that happened to arrive last.
   */
  const announceWork = async (
    conversation: Conversation,
    thread: { threadId: string; userId: string } | null,
    busy?: boolean,
  ): Promise<void> => {
    const members = conversation.members.map((member) => member.userId);
    if (members.length === 0) return;
    const channelId = conversation.id;

    const notify = (event: ChannelActivityEvent) =>
      database.execute(
        sql`select pg_notify(${CHANNEL_ACTIVITY_TOPIC}, ${JSON.stringify(event)})`,
      );
    const base = {
      channelId,
      lastMessage: null,
      lastMessageAt: null,
      lastMessageAgentId: null,
      ...(busy === undefined ? {} : { busy }),
    };

    const owner = thread && members.includes(thread.userId) ? thread : null;
    const others = members.filter((userId) => userId !== owner?.userId);

    if (owner) {
      // Fixed-width UTC to the microsecond, so two stamps compare as strings.
      const [stamp] = await database.execute<{ at: string }>(
        sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`,
      );
      const work =
        (
          await workIn(database, [
            { id: channelId, threadId: owner.threadId, userId: owner.userId },
          ])
        ).get(channelId) ?? [];
      await notify({
        ...base,
        memberIds: [owner.userId],
        work: work.map(channelWorkDto),
        ...(stamp ? { workAt: stamp.at } : {}),
      });
    }
    // A settle with no turn moving has nothing to tell anybody but the thread's owner.
    if (busy !== undefined && others.length > 0)
      await notify({ ...base, memberIds: others });
  };

  /** A person's own thread in a live conversation: what a turn's busy signal is keyed by. */
  const ownThreadNamed = async (threadId: string) => {
    const found = await conversations().byThread(threadId);
    // A scratch thread maps to nothing, and a Bot's thread in a group is not a channel's thread, so
    // a hop running in either signals nowhere.
    if (!found || found.thread.agentId !== null) return null;
    return found;
  };

  const store: ChannelStore = {
    async create(actor, agentIds) {
      const draft = await draftFor(actor, agentIds);
      const conversation = await conversations().create(
        draft,
        writeKey("channel.create"),
      );
      const channel = await channelFor(conversation, actor.id);
      if (!channel) throw new ChannelNotFoundError(conversation.id);
      return channel;
    },

    draft: draftFor,

    async direct(actor, agentId) {
      const draft = await draftFor(actor, [agentId]);
      const threadId = draft.members?.[0]?.threadId;
      if (!threadId) throw new Error("A new channel needs its owner's thread.");
      /*
       * ONE AT A TIME PER PERSON AND BOT, across every replica: Intelligence finds and makes under a
       * lock on the pair. Looking and then making here would not be find-or-create: two hops
       * delivered at the same moment each saw nothing and each made a conversation, and that person
       * ended up with two Knowledge channels holding two threads, with the answers split between
       * them. A Bot asking for several things in one turn produces exactly that.
       */
      const { conversation } = await conversations().client.direct(
        {
          userId: actor.id,
          agentId,
          create: {
            id: draft.id,
            name: draft.name,
            description: draft.description ?? PRIVATE_AGENT_CHANNEL_DESCRIPTION,
            threadId,
          },
        },
        writeKey("channel.direct"),
      );
      const channel = await channelFor(
        conversations().apply(conversation),
        actor.id,
      );
      // Null only if it was deleted between the two steps, which is a reason to make a new one
      // rather than to fail: the caller asked for a conversation, not for that row.
      return channel ?? store.create(actor, [agentId]);
    },

    async get(actor, channelId) {
      return channelFor(await conversations().get(channelId), actor.id);
    },

    async list(actor, query = {}) {
      const limit = Math.min(
        Math.max(query.limit ?? DEFAULT_CHANNEL_PAGE, 1),
        MAX_CHANNEL_PAGE,
      );
      const filter = { memberUserId: actor.id, order: "recent" as const };
      const directory = conversations();
      let page: Awaited<ReturnType<typeof directory.client.page>>;
      try {
        page = await directory.client.page(filter, query.cursor ?? null, limit);
      } catch (error) {
        // A malformed or stale cursor reads as the first page, which is the honest answer to a
        // stale link.
        if (
          query.cursor &&
          error instanceof IntelligenceApiError &&
          error.status === 400
        )
          page = await directory.client.page(filter, null, limit);
        else throw error;
      }
      const held = page.conversations.map((conversation) =>
        directory.apply(conversation),
      );
      const known = await botsOf(held);
      const channels: ChannelSummary[] = [];
      for (const conversation of page.conversations) {
        const channel = channelOf(conversation, actor.id, known);
        if (!channel) continue;
        const member = conversation.members.find(
          (candidate) => candidate.userId === actor.id,
        );
        channels.push({
          ...channel,
          summary: conversation.summary,
          lastMessage: conversation.lastMessage,
          lastMessageAgentId: conversation.lastMessageAgentId,
          createdAt: conversation.createdAt,
          pinned: (member?.pinnedAt ?? null) !== null,
          lastReadAt: member?.lastReadAt ?? null,
          task: conversation.taskId !== null,
        });
      }
      return { channels, nextCursor: page.nextCursor };
    },

    async setPinned(actor, channelId, pinned) {
      try {
        // Announced to this member alone, by Intelligence's change event (`member`), which carries
        // the pin across this person's own tabs and replicas without putting it on anybody else's
        // roster. A deleted channel is not there to pin.
        conversations().apply(
          await conversations().client.changeMember(
            channelId,
            actor.id,
            { pinned },
            writeKey("channel.pin"),
          ),
        );
      } catch (error) {
        if (error instanceof ConversationMissingError)
          throw new ChannelNotFoundError(channelId);
        throw error;
      }
    },

    async markRead(actor, channelId) {
      try {
        // The later of now and the channel's own last-message stamp, worked out by Intelligence:
        // last_message_at is written from the reporting browser's clock and is not bounded.
        await conversations().client.changeMember(
          channelId,
          actor.id,
          { read: true },
          writeKey("channel.read"),
        );
      } catch (error) {
        // Not a member, no such channel, or a deleted one: the same answer every way.
        if (error instanceof ConversationMissingError)
          throw new ChannelNotFoundError(channelId);
        throw error;
      }
    },

    async softDelete(actor, channelId) {
      const directory = conversations();
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await directory.refresh(channelId);
        // Not a member, or no such channel: the same answer either way.
        if (!current || !isMember(current, actor.id))
          throw new ChannelNotFoundError(channelId);
        // Package channels are configuration; the sync that wrote them owns them.
        if (current.managedBy !== null)
          throw new ChannelPackageOwnedError(channelId);
        // A repeat changes nothing and announces nothing, and its route records nothing.
        if (current.deletedAt !== null) return false;
        try {
          const deleted = await directory.client.remove(
            channelId,
            writeKey("channel.delete"),
            current.version,
          );
          directory.apply(deleted);
          /*
           * Every member is told by Intelligence's change event (`deleted`), delivered to each
           * replica's open browsers, because the deletion hides the channel for all of them.
           */
          return deleted.version > current.version;
        } catch (error) {
          // Somebody else changed it between the read and the delete: read it again.
          if (error instanceof ConversationVersionConflictError) continue;
          throw error;
        }
      }
      throw new Error(
        `Channel ${channelId} kept changing while it was deleted.`,
      );
    },

    async recordActivity(actor, channelId, activity, source) {
      try {
        // A person's message and the agent's reply are reported separately, so they can arrive out
        // of order. Intelligence only moves forwards, except to enrich the same source's
        // placeholder, and compares and writes in one step, so reports from every replica agree.
        // Announced to every member by its change event (`activity`), never when nothing changed.
        const { conversation } = await conversations().client.activity(
          channelId,
          {
            userId: actor.id,
            text: previewOf(activity.text),
            at: activity.at,
            agentId: activity.agentId,
            sourceId: source?.id ?? null,
            enrichFrom:
              source?.enrichFrom !== undefined
                ? previewOf(source.enrichFrom)
                : null,
          },
          writeKey("channel.activity"),
        );
        conversations().apply(conversation);
      } catch (error) {
        // Not a member, no such channel, or a deleted one: the same answer every way, so belonging
        // to a channel is not something an outsider can probe for.
        if (error instanceof ConversationMissingError)
          throw new ChannelNotFoundError(channelId);
        if (
          error instanceof ConversationAgentMissingError &&
          activity.agentId !== null
        )
          throw new AgentNotFoundError(activity.agentId);
        throw error;
      }
    },

    async signalBusy(threadId, busy) {
      const found = await ownThreadNamed(threadId);
      if (!found) return;
      await announceWork(
        found.conversation,
        { threadId, userId: found.thread.userId },
        busy,
      );
    },

    async signalWork(threadId) {
      const found = await ownThreadNamed(threadId);
      if (!found) return;
      await announceWork(found.conversation, {
        threadId,
        userId: found.thread.userId,
      });
    },

    async signalChannelBusy(actor, channelId, busy) {
      const conversation = await conversations().get(channelId);
      // Not a member, no such channel, or a deleted one: the same refusal every way, so belonging
      // to a channel is not something an outsider can probe for.
      if (
        !conversation ||
        conversation.deletedAt !== null ||
        !isMember(conversation, actor.id)
      )
        throw new ChannelNotFoundError(channelId);
      // The caller's own thread for the channel, which is the one their hops are offered from.
      const thread = ownThread(conversation, actor.id);
      await announceWork(
        conversation,
        thread ? { threadId: thread.threadId, userId: actor.id } : null,
        busy,
      );
    },

    workIn: (actor, list) =>
      workIn(
        database,
        list.map((channel) => ({ ...channel, userId: actor.id })),
      ),
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
 * `at` comes from the client that saw the message, because only it knows when the message arrived,
 * and it may say when, but not later than now. The store compares it against what is stored and
 * only ever moves forwards, and that guard is shared with every other clock in the deployment:
 * the routine runner's, a relayed handoff answer's, every other member's browser. A browser whose
 * clock ran seven minutes ahead used to stamp the row seven minutes into the future, and it was
 * not that report that got lost — every correct one for the next seven minutes was, silently: a
 * routine's reply landed in the thread and never on the roster. Clamped rather than refused,
 * because clocks are a little ahead all the time and a report a second early is still the report.
 * A stamp in the past is kept as it is, so a person's message and the reply, reported separately
 * by the same clock, still land in the order that clock saw them.
 */
export function parseActivityInput(
  input: unknown,
  /** The server's own clock, injectable so a test can be about a specific gap. */
  now: Date = new Date(),
): ActivityInputParseResult {
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
  if (
    typeof object.agentId === "string" &&
    object.agentId.trim().length === 0
  ) {
    return { ok: false, error: "Agent ID must be a string or null." };
  }
  if (typeof object.at !== "string") {
    return { ok: false, error: "Timestamp is required." };
  }
  const reported = new Date(object.at);
  if (Number.isNaN(reported.getTime())) {
    return { ok: false, error: "Timestamp must be an ISO-8601 date." };
  }
  const at = reported.getTime() > now.getTime() ? now : reported;

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
      /*
       * Parsed strictly, not coerced: `Number.parseInt` reads `"12abc"` as 12 and `"3.9"`
       * as 3, so a typo silently returned the wrong page. A run of digits is clamped into
       * range like the store already does; anything else is a 400 naming the parameter.
       */
      const parsed = parsePageLimit(
        url.searchParams.get("limit"),
        MAX_CHANNEL_PAGE,
      );
      if (!parsed.ok) return context.json({ error: parsed.error }, 400);
      const page = await store.list(context.var.actor, {
        ...(url.searchParams.get("cursor")
          ? { cursor: url.searchParams.get("cursor") as string }
          : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      });

      /*
       * What each row is waiting on, read with the page rather than left to the socket. A busy
       * flag that only ever arrived as an event was gone on every reload, so a conversation a Bot
       * was still answering in looked finished to anybody who refreshed.
       */
      const work = await store.workIn(context.var.actor, page.channels);
      return context.json({
        channels: page.channels.map((channel) =>
          channelSummaryDto(channel, work.get(channel.id) ?? []),
        ),
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
    // A whitespace channel id would reach the store and answer 500 on some backends instead of
    // a 400 for a malformed call.
    const channelId = context.req.param("channelId");
    if (!channelId.trim()) {
      return context.json({ error: "A channel id is required." }, 400);
    }

    try {
      await store.recordActivity(context.var.actor, channelId, parsed.value);
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
    if (!context.req.param("channelId").trim()) {
      return context.json({ error: "A channel id is required." }, 400);
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
      const deleted = await store.softDelete(context.var.actor, channelId);
      // A repeat is still 204, but it deleted nothing, and the trail records acts, not attempts.
      if (deleted !== false) await recordDeleted(context, channelId);
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
        return context.json({ error: "Couldn't find that conversation." }, 404);
      }
      const work = await store.workIn(context.var.actor, [channel]);
      return context.json({
        channel: {
          ...channelDto(channel),
          work: (work.get(channel.id) ?? []).map(channelWorkDto),
        },
      });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

/** A channel as it goes over the wire: the same shape, with the date serialised. */
type ChannelWire = Omit<AgentChannel, "lastMessageAt"> & {
  lastMessageAt: string | null;
};

function channelDto(channel: AgentChannel): ChannelWire {
  return {
    id: channel.id,
    name: channel.name,
    agentIds: channel.agentIds,
    threadId: channel.threadId,
    active: channel.active,
    // ISO-8601 so the browser gets a string it can compare, like the roster's copy.
    lastMessageAt: channel.lastMessageAt?.toISOString() ?? null,
  };
}

function channelSummaryDto(
  channel: ChannelSummary,
  work: readonly ChannelWork[],
) {
  return {
    ...channelDto(channel),
    summary: channel.summary,
    lastMessage: channel.lastMessage,
    lastMessageAgentId: channel.lastMessageAgentId,
    createdAt: channel.createdAt.toISOString(),
    pinned: channel.pinned,
    // Serialised as ISO-8601 like lastMessageAt, so the browser can compare the two as strings.
    lastReadAt: channel.lastReadAt?.toISOString() ?? null,
    task: channel.task,
    work: work.map(channelWorkDto),
    /*
     * Only ever true from here. A person's own run is not on any row this can read, so a roster
     * that said false would put out the dot another tab's run had just lit.
     */
    ...(work.length > 0 ? { busy: true } : {}),
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof AgentNotFoundError) {
    return context.json({ error: "Couldn't find that Bot." }, 404);
  }
  if (error instanceof ChannelNotFoundError) {
    return context.json({ error: "Couldn't find that conversation." }, 404);
  }
  if (error instanceof ChannelPackageOwnedError) {
    return context.json(
      {
        error: "This conversation is built in and can't be deleted.",
      },
      409,
    );
  }
  throw error;
}
