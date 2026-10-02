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
 *
 * "STARTS FRESH" ALSO MEANS what the Bot learned and was allowed on its own: memories it formed for
 * this person, the background research it runs for them (its suggestions go with it, and any run
 * already queued is cancelled), and the standing permissions they gave it ("Always allow" and
 * "pre-approved" rules, which include always sharing private information). Rules that make the Bot
 * ask first or hand work back protect the person, so a reset keeps those.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  approvalRules,
  channelAgents,
  channelMemberships,
  channels,
  memorySources,
  personalMemories,
  proactiveSettings,
  proactiveSuggestions,
  responsibilities,
  routines,
  workItems,
} from "../db/schema";
import { PROACTIVE_RUN_KIND } from "../proactive/engine";
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
  /** Memories the Bot formed itself from what it read for this person. */
  formedMemories: number;
  /** This person's background research by the Bot, with its suggestions. */
  backgroundResearch: number;
  /** "Always allow" and pre-approved rules this person gave the Bot. */
  standingApprovals: number;
};

export type BotReset = ReturnType<typeof createBotReset>;

export function createBotReset(options: {
  database: Database;
  // Whether the channel was still there to delete is the store's business, not the reset's.
  softDeleteChannel: (actor: AgentActor, channelId: string) => Promise<unknown>;
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

  const formedMemories = (ownerUserId: string, agentId: string) =>
    and(
      eq(personalMemories.ownerUserId, ownerUserId),
      eq(personalMemories.formedByAgentId, agentId),
      isNull(personalMemories.sourceId),
      isNull(personalMemories.deletedAt),
    );

  const research = (ownerUserId: string, agentId: string) =>
    and(
      eq(proactiveSettings.ownerUserId, ownerUserId),
      eq(proactiveSettings.agentId, agentId),
    );

  /** Grants only: a rule that makes the Bot ask first or hand back is the person's protection. */
  const standingApprovals = (ownerUserId: string, agentId: string) =>
    and(
      eq(approvalRules.ownerUserId, ownerUserId),
      eq(approvalRules.botId, agentId),
      inArray(approvalRules.behaviour, ["allow", "pre_approved"]),
      isNull(approvalRules.revokedAt),
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
      formedMemories: await count(
        database
          .select({ total })
          .from(personalMemories)
          .where(formedMemories(ownerUserId, agentId)),
      ),
      backgroundResearch: await count(
        database
          .select({ total })
          .from(proactiveSettings)
          .where(research(ownerUserId, agentId)),
      ),
      standingApprovals: await count(
        database
          .select({ total })
          .from(approvalRules)
          .where(standingApprovals(ownerUserId, agentId)),
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
        const formed = await transaction
          .delete(personalMemories)
          .where(formedMemories(ownerUserId, agentId))
          .returning({ id: personalMemories.id });
        const settings = await transaction
          .select({ id: proactiveSettings.id })
          .from(proactiveSettings)
          .where(research(ownerUserId, agentId));
        if (settings.length > 0) {
          const ids = settings.map((setting) => setting.id);
          // A run already queued for the setting would find it gone; cancel it rather than fail it.
          await transaction
            .update(workItems)
            .set({
              finishedAt: sql`now()`,
              claimedBy: null,
              leaseUntil: null,
              lastError: "Cancelled by reset",
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(workItems.kind, PROACTIVE_RUN_KIND),
                isNull(workItems.finishedAt),
                inArray(sql<string>`${workItems.payload}->>'settingId'`, ids),
              ),
            );
          // Suggestions go with their setting through the foreign key.
          await transaction
            .delete(proactiveSuggestions)
            .where(inArray(proactiveSuggestions.settingId, ids));
          await transaction
            .delete(proactiveSettings)
            .where(inArray(proactiveSettings.id, ids));
        }
        const revoked = await transaction
          .update(approvalRules)
          .set({ revokedAt: sql`now()` })
          .where(standingApprovals(ownerUserId, agentId))
          .returning({ id: approvalRules.id });
        return {
          conversations: found.mine.length,
          sharedConversationsKept: found.kept,
          memorySources: sources.length,
          memories: memories.length,
          routines: deletedRoutines.length,
          responsibilities: deletedGoals.length,
          followUps: followUps.length,
          formedMemories: formed.length,
          backgroundResearch: settings.length,
          standingApprovals: revoked.length,
        };
      });
    },
  };
}
