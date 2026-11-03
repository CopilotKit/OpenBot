/**
 * The policy records that belong to a Bot, and removing them when the Bot is gone for good.
 *
 * A Shared app approval names one Bot. It used to go with the Bot by `ON DELETE CASCADE` through the
 * local tables (`agents/bot-registry/local-rows.ts`); in Intelligence it is removed here instead:
 * when Intelligence says a Bot was purged, and at boot for any Bot purged while no instance was running
 * to hear it. A soft delete removes nothing, as before: a deleted Bot's approvals stay with it, and come
 * back into force if it is restored.
 *
 * Approval rules name Bots too, but as an action class a person or an administrator wrote, often a
 * glob, and they never went with a Bot; they still do not.
 */
import type { PolicyCache } from "./cache";
import { PolicyVersionConflictError } from "./client";

/**
 * Remove every Shared app approval these Bots hold. Read from Intelligence, not memory: none may be
 * missed.
 *
 * A BOT MADE AGAIN UNDER THE SAME ID KEEPS WHAT IT IS GIVEN. A purge is announced to every server,
 * and an announcement can arrive after the id was made again and given a new approval. So each
 * approval is removed only while `stillGone` says Intelligence has no such Bot, and only at the
 * version read: one stored over it in the meantime is the new Bot's, and stays.
 */
export async function removeBotPolicy(
  cache: PolicyCache,
  botIds: readonly string[],
  stillGone: (botId: string) => Promise<boolean> = async () => true,
): Promise<number> {
  let removed = 0;
  for (const agentId of botIds) {
    const { items } = await cache.client.connectionApprovals({ agentId });
    for (const approval of items) {
      if (!(await stillGone(agentId))) return removed;
      try {
        if (
          await cache.deleteConnectionApproval(
            { agentId, connectionId: approval.connectionId },
            { ifMatch: approval.version },
          )
        )
          removed += 1;
      } catch (error) {
        if (!(error instanceof PolicyVersionConflictError)) throw error;
      }
    }
  }
  return removed;
}

/**
 * Remove the approvals of every Bot Intelligence no longer has at all. `listAll` must return every Bot,
 * deleted ones included. The approvals are read first, so an approval for a Bot made after this read
 * began is never mistaken for an orphan.
 */
export async function sweepPurgedBotPolicy(
  cache: PolicyCache,
  listAll: () => Promise<Iterable<{ id: string }>>,
  stillGone?: (botId: string) => Promise<boolean>,
): Promise<string[]> {
  const { items } = await cache.client.connectionApprovals();
  const named = new Set(items.map((approval) => approval.agentId));
  if (named.size === 0) return [];
  const known = new Set<string>();
  for (const bot of await listAll()) known.add(bot.id);
  const gone = [...named].filter((id) => !known.has(id));
  if (gone.length > 0) {
    await removeBotPolicy(cache, gone, stillGone);
    console.warn(
      JSON.stringify({
        type: "bot-policy-swept",
        note: "Shared app approvals named Bots that Intelligence no longer has; they were removed as the old cascade would have.",
        bots: gone,
      }),
    );
  }
  return gone;
}
