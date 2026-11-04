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
 * Routines and responsibilities are deleted, and their runs with them through the foreign keys that
 * already cascade. Memory sources are deleted in Intelligence, which takes their imported memories with
 * them, after the local transaction commits: no OpenBot transaction is held across a call to it.
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
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { conversations as conversationDirectory } from "../conversations/directory";
import type { Database } from "../db/client";
import {
  proactiveSettings,
  proactiveSuggestions,
  responsibilities,
  routines,
  workItems,
} from "../db/schema";
import {
  lockDefaults,
  recordOptOuts,
  sourceServerId,
} from "../memory/defaults";
import type { MemoryStore } from "../memory/store";
import { policy } from "../policy/cache";
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

  const research = (ownerUserId: string, agentId: string) =>
    and(
      eq(proactiveSettings.ownerUserId, ownerUserId),
      eq(proactiveSettings.agentId, agentId),
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
      formedMemories: remembered.formedMemoryIds.length,
      backgroundResearch: await count(
        database
          .select({ total })
          .from(proactiveSettings)
          .where(research(ownerUserId, agentId)),
      ),
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
       * What this person had switched off, turned down for good, said in Intelligence BEFORE the
       * deletes below (the sources' in Intelligence after the transaction): no adoption on any replica
       * can then bring one back once it is gone (memory/defaults.ts), and no transaction here waits on
       * Intelligence.
       */
      const optOutsOf = (
        sources: { toolRef: string; enabled: boolean }[],
        settings: { enabled: boolean }[],
      ) => [
        ...sources
          .filter((source) => !source.enabled)
          .map((source) => ({
            agentId,
            feature: "memory_source" as const,
            scope: sourceServerId(source.toolRef),
          })),
        ...(settings.some((setting) => !setting.enabled)
          ? [{ agentId, feature: "proactive_research" as const }]
          : []),
      ];
      const sayKey = (optOut: { feature: string; scope?: string }) =>
        `${optOut.feature}\u001f${optOut.scope ?? ""}`;
      const before = optOutsOf(
        sources,
        await database
          .select({ enabled: proactiveSettings.enabled })
          .from(proactiveSettings)
          .where(research(ownerUserId, agentId)),
      );
      await recordOptOuts(ownerUserId, before);
      const said = new Set(before.map(sayKey));
      let late: ReturnType<typeof optOutsOf> = [];

      const result = await database.transaction(async (transaction) => {
        // The lock defaults adoption takes, so no research default is adopted between these reads and the deletes.
        await lockDefaults(transaction, ownerUserId, agentId);
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
        const settings = await transaction
          .select({
            id: proactiveSettings.id,
            enabled: proactiveSettings.enabled,
          })
          .from(proactiveSettings)
          .where(research(ownerUserId, agentId));
        // Switched off between the read above and this one: said once the transaction is done.
        late = optOutsOf(sources, settings).filter(
          (optOut) => !said.has(sayKey(optOut)),
        );
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
        return {
          conversations: found.mine.length,
          sharedConversationsKept: found.kept,
          memorySources: sources.length,
          memories: remembered.importedMemories,
          routines: deletedRoutines.length,
          responsibilities: deletedGoals.length,
          followUps: followUps.length,
          formedMemories: 0,
          backgroundResearch: settings.length,
        };
      });
      await recordOptOuts(ownerUserId, late);
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
