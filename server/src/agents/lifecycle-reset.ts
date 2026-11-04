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
 * Routines and responsibilities are deleted for good in Intelligence, which removes their runs (and a
 * responsibility's triggers) with them, before the local transaction. Memory sources are deleted in
 * Intelligence, which takes their imported memories with them, after it commits: no OpenBot
 * transaction is held across a call to Intelligence.
 *
 * "STARTS FRESH" ALSO MEANS what the Bot learned and was allowed on its own: memories it formed for
 * this person, the background research it runs for them (its suggestions go with it, and any run
 * already queued is cancelled), and the standing permissions they gave it ("Always allow" and
 * "pre-approved" rules, which include always sharing private information). Rules that make the Bot
 * ask first or hand work back protect the person, so a reset keeps those.
 *
 * For the same reason a reset keeps the person's "no" to a default: a memory source or background
 * research they had turned off is recorded as turned down (`memory/defaults.ts`), so starting fresh
 * never switches back on what they switched off. What they left on comes back on by default.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { conversations as conversationDirectory } from "../conversations/directory";
import type { Database } from "../db/client";
import { workItems } from "../db/schema";
import {
  lockDefaults,
  recordOptOuts,
  sourceServerId,
} from "../memory/defaults";
import type { MemoryStore } from "../memory/store";
import { policy } from "../policy/cache";
import { checkInsOf, resetCheckInsOf } from "../proactive/store";
import {
  purgeResponsibilitiesOf,
  responsibilitiesOf,
} from "../responsibilities/store";
import { purgeRoutinesOf, routinesOf } from "../routines/store";
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
  /** The person's memory, in Intelligence. */
  memory: Pick<MemoryStore, "botResetPlan" | "resetBot">;
}) {
  const { database, softDeleteChannel, memory } = options;

  /** Every live conversation this person is in that has this Bot in it, split by whether it is theirs alone. */
  async function conversations(ownerUserId: string, agentId: string) {
    const found = await conversationDirectory().client.all({
      memberUserId: ownerUserId,
      agentId,
    });
    const alone = found.filter(
      (conversation) =>
        conversation.managedBy === null &&
        conversation.agents.every((agent) => agent.agentId === agentId) &&
        conversation.members.every((member) => member.userId === ownerUserId),
    );
    return {
      mine: alone.map((conversation) => conversation.id),
      kept: found.length - alone.length,
    };
  }

  const pendingFollowUps = (ownerUserId: string, agentId: string) =>
    and(
      eq(workItems.kind, WAKE_UP_KIND),
      isNull(workItems.finishedAt),
      sql`${workItems.payload}->>'ownerUserId' = ${ownerUserId}`,
      sql`${workItems.payload}->>'agentId' = ${agentId}`,
    );

  /**
   * Grants only: a rule that makes the Bot ask first or hand back is the person's protection. The rules
   * are Intelligence's (organization policy), held in memory on every server.
   */
  const standingApprovals = (ownerUserId: string, agentId: string) =>
    policy()
      .approvalRules({ ownerUserId })
      .filter(
        (rule) =>
          rule.agentId === agentId &&
          (rule.behaviour === "allow" || rule.behaviour === "pre_approved"),
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
    const remembered = await memory.botResetPlan(ownerUserId, agentId);
    const total = sql<number>`count(*)::int`;
    return {
      conversations: conversationsFound.mine.length,
      sharedConversationsKept: conversationsFound.kept,
      memorySources: remembered.sources.length,
      memories: remembered.importedMemories,
      routines: (await routinesOf(ownerUserId, agentId)).length,
      responsibilities: (await responsibilitiesOf(ownerUserId, agentId)).length,
      followUps: await count(
        database
          .select({ total })
          .from(workItems)
          .where(pendingFollowUps(ownerUserId, agentId)),
      ),
      formedMemories: remembered.formedMemoryIds.length,
      backgroundResearch: checkInsOf(ownerUserId, agentId),
      standingApprovals: standingApprovals(ownerUserId, agentId).length,
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
      // Read from Intelligence before the transaction: none is held across a call to it.
      const remembered = await memory.botResetPlan(ownerUserId, agentId);
      const { sources } = remembered;

      /*
       * The memory sources this person had switched off, turned down for good, said in Intelligence
       * BEFORE the sources go (in Intelligence, after the transaction): no adoption on any replica can
       * then bring one back once it is gone (memory/defaults.ts). Check-ins say theirs themselves.
       */
      await recordOptOuts(
        ownerUserId,
        sources
          .filter((source) => !source.enabled)
          .map((source) => ({
            agentId,
            feature: "memory_source" as const,
            scope: sourceServerId(source.toolRef),
          })),
      );
      // Routines and check-ins live in Intelligence, so they go before the transaction rather than
      // inside it: no OpenBot transaction waits on Intelligence. Removed for good, their runs (and a
      // check-in's items) with them, as the reset always removed them. A check-in the person had
      // switched off is recorded as turned down first, under the lease adoption takes.
      const deletedRoutines = await purgeRoutinesOf(ownerUserId, agentId);
      const research = await resetCheckInsOf(database, ownerUserId, agentId);
      // Responsibilities likewise, their runs and triggers with them.
      const deletedGoals = await purgeResponsibilitiesOf(ownerUserId, agentId);

      const result = await database.transaction(async (transaction) => {
        // The lock defaults adoption takes, so no memory source is adopted while the follow-ups go.
        await lockDefaults(transaction, ownerUserId, agentId);
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
          memories: remembered.importedMemories,
          routines: deletedRoutines,
          responsibilities: deletedGoals,
          followUps: followUps.length,
          formedMemories: 0,
          backgroundResearch: research,
        };
      });
      // The sources (with what they imported) and what the Bot formed itself, in Intelligence.
      result.formedMemories = await memory.resetBot(ownerUserId, remembered);
      /*
       * The standing grants are revoked in Intelligence once the deletes here have committed: no
       * transaction here waits on Intelligence. Each revoke stands alone, so one that fails leaves the
       * others revoked and the reset reports what it did.
       */
      let standingRevoked = 0;
      for (const rule of standingApprovals(ownerUserId, agentId)) {
        await policy().revokeApprovalRule(rule.id);
        standingRevoked += 1;
      }
      return { ...result, standingApprovals: standingRevoked };
    },
  };
}
