/**
 * Resetting a Bot for one person: their conversations with it, what it remembers for them, and the
 * work it has scheduled for them, gone; the Bot itself, and everybody else's use of it, untouched.
 *
 * PLANNED, THEN DONE. `plan` counts what would go, per kind, and a person is shown that notice before
 * anything is deleted; `execute` refuses unless the caller confirms, and deletes only what `plan`
 * would have counted at that moment.
 *
 * A CONVERSATION IS THE PERSON'S ONLY WHEN IT IS THEIRS ALONE: this Bot the only Bot in it and this
 * person the only member. A group conversation, or one somebody else is in, is someone else's too,
 * so it is kept and counted as kept, and the notice says so.
 *
 * Conversations go the way every other deletion of them does, soft, through the channel store, so
 * every open tab is told and the thread survives on the platform as it would for a manual delete.
 * Routines, responsibilities and memory sources are deleted, and their runs and imported memories
 * with them through the foreign keys that already cascade.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  channelAgents,
  channelMemberships,
  channels,
  memorySources,
  personalMemories,
  responsibilities,
  routines,
  workItems,
} from "../db/schema";
import type { AgentActor } from "./profile-types";
import { WAKE_UP_KIND } from "./wake-up";

export type ResetPlan = {
  conversations: number;
  /** Conversations with this Bot that are shared with others, and so are kept. */
  sharedConversationsKept: number;
  memorySources: number;
  memories: number;
  routines: number;
  responsibilities: number;
  followUps: number;
};

export type BotReset = ReturnType<typeof createBotReset>;

export function createBotReset(options: {
  database: Database;
  softDeleteChannel: (actor: AgentActor, channelId: string) => Promise<void>;
}) {
  const { database, softDeleteChannel } = options;

  /** Every live conversation this person is in that has this Bot in it, split by whether it is theirs alone. */
  async function conversations(ownerUserId: string, agentId: string) {
    const rows = await database
      .select({
        id: channels.id,
        packageId: channels.packageId,
        otherBots: sql<number>`(select count(*) from ${channelAgents} other_bots where other_bots.channel_id = ${channels.id} and other_bots.agent_id <> ${agentId})::int`,
        otherMembers: sql<number>`(select count(*) from ${channelMemberships} other_members where other_members.channel_id = ${channels.id} and other_members.user_id <> ${ownerUserId})::int`,
      })
      .from(channels)
      .innerJoin(
        channelMemberships,
        and(
          eq(channelMemberships.channelId, channels.id),
          eq(channelMemberships.userId, ownerUserId),
        ),
      )
      .innerJoin(
        channelAgents,
        and(
          eq(channelAgents.channelId, channels.id),
          eq(channelAgents.agentId, agentId),
        ),
      )
      .where(isNull(channels.deletedAt));
    const alone = rows.filter(
      (row) =>
        row.packageId === null && row.otherBots === 0 && row.otherMembers === 0,
    );
    return {
      mine: alone.map((row) => row.id),
      kept: rows.length - alone.length,
    };
  }

  const pendingFollowUps = (ownerUserId: string, agentId: string) =>
    and(
      eq(workItems.kind, WAKE_UP_KIND),
      isNull(workItems.finishedAt),
      sql`${workItems.payload}->>'ownerUserId' = ${ownerUserId}`,
      sql`${workItems.payload}->>'agentId' = ${agentId}`,
    );

  async function count(query: Promise<{ total: number }[]>): Promise<number> {
    const [row] = await query;
    return row?.total ?? 0;
  }

  async function plan(
    ownerUserId: string,
    agentId: string,
  ): Promise<ResetPlan> {
    const conversationsFound = await conversations(ownerUserId, agentId);
    const sources = await database
      .select({ id: memorySources.id })
      .from(memorySources)
      .where(
        and(
          eq(memorySources.ownerUserId, ownerUserId),
          eq(memorySources.agentId, agentId),
        ),
      );
    const total = sql<number>`count(*)::int`;
    return {
      conversations: conversationsFound.mine.length,
      sharedConversationsKept: conversationsFound.kept,
      memorySources: sources.length,
      memories:
        sources.length === 0
          ? 0
          : await count(
              database
                .select({ total })
                .from(personalMemories)
                .where(
                  and(
                    eq(personalMemories.ownerUserId, ownerUserId),
                    inArray(
                      personalMemories.sourceId,
                      sources.map((source) => source.id),
                    ),
                    isNull(personalMemories.deletedAt),
                  ),
                ),
            ),
      routines: await count(
        database
          .select({ total })
          .from(routines)
          .where(
            and(
              eq(routines.ownerUserId, ownerUserId),
              eq(routines.agentId, agentId),
            ),
          ),
      ),
      responsibilities: await count(
        database
          .select({ total })
          .from(responsibilities)
          .where(
            and(
              eq(responsibilities.ownerUserId, ownerUserId),
              eq(responsibilities.agentId, agentId),
            ),
          ),
      ),
      followUps: await count(
        database
          .select({ total })
          .from(workItems)
          .where(pendingFollowUps(ownerUserId, agentId)),
      ),
    };
  }

  return {
    plan,

    /** Delete what `plan` counts, for this person only. Returns what was actually deleted. */
    async execute(actor: AgentActor, agentId: string): Promise<ResetPlan> {
      const ownerUserId = actor.id;
      const found = await conversations(ownerUserId, agentId);
      for (const channelId of found.mine)
        await softDeleteChannel(actor, channelId);

      return database.transaction(async (transaction) => {
        const sources = await transaction
          .select({ id: memorySources.id })
          .from(memorySources)
          .where(
            and(
              eq(memorySources.ownerUserId, ownerUserId),
              eq(memorySources.agentId, agentId),
            ),
          );
        const memories =
          sources.length === 0
            ? []
            : await transaction
                .select({ id: personalMemories.id })
                .from(personalMemories)
                .where(
                  and(
                    eq(personalMemories.ownerUserId, ownerUserId),
                    inArray(
                      personalMemories.sourceId,
                      sources.map((source) => source.id),
                    ),
                    isNull(personalMemories.deletedAt),
                  ),
                );
        // Memories go with their source through the foreign key.
        await transaction
          .delete(memorySources)
          .where(
            and(
              eq(memorySources.ownerUserId, ownerUserId),
              eq(memorySources.agentId, agentId),
            ),
          );
        const deletedRoutines = await transaction
          .delete(routines)
          .where(
            and(
              eq(routines.ownerUserId, ownerUserId),
              eq(routines.agentId, agentId),
            ),
          )
          .returning({ id: routines.id });
        const deletedGoals = await transaction
          .delete(responsibilities)
          .where(
            and(
              eq(responsibilities.ownerUserId, ownerUserId),
              eq(responsibilities.agentId, agentId),
            ),
          )
          .returning({ id: responsibilities.id });
        const followUps = await transaction
          .update(workItems)
          .set({
            finishedAt: sql`now()`,
            claimedBy: null,
            leaseUntil: null,
            lastError: "Cancelled by reset",
            updatedAt: sql`now()`,
          })
          .where(pendingFollowUps(ownerUserId, agentId))
          .returning({ key: workItems.key });
        return {
          conversations: found.mine.length,
          sharedConversationsKept: found.kept,
          memorySources: sources.length,
          memories: memories.length,
          routines: deletedRoutines.length,
          responsibilities: deletedGoals.length,
          followUps: followUps.length,
        };
      });
    },
  };
}
