/**
 * This deployment's own rows that name a Bot, and removing them when the Bot is gone for good.
 *
 * Bots live in Intelligence, so the tables here name one by id with no foreign key, and nothing in
 * PostgreSQL removes these rows when a Bot goes. They used to go by `ON DELETE CASCADE` (and one,
 * a channel's last speaker, by `SET NULL`) when an `agents` row was deleted. This file is that cascade,
 * run by hand: when Intelligence says a Bot was purged, and at boot for any Bot purged while no
 * instance was running to hear it.
 *
 * A soft delete removes nothing here, exactly as before: the `agents` row stayed and so did these,
 * which is what keeps a deleted Bot's conversations readable.
 *
 * A NEW TABLE THAT NAMES A BOT BELONGS IN {@link BOT_CHILD_TABLES}. `bot-registry-local-rows` in the
 * tests reads the schema for every `agent_id`-shaped column and fails when one is missing here.
 *
 * Not here: what moved into Intelligence beside the Bot (its grants, publication, audience and
 * assignments; people's preferences about it; components withheld from it). Intelligence removes
 * those with the Bot, and their old tables here are written by nothing (see
 * `configuration/frozen-tables.ts`).
 */
import { inArray, isNotNull, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database } from "../../db/client";
import {
  appAccessRequests,
  botTasks,
  channelAgents,
  channels,
  deliveryBindings,
  deliveryChallenges,
  deliveryInbox,
  deliveryOutbox,
  demonstrations,
  memorySources,
  personalMemories,
  sharedUseApprovals,
  sharedUseRequests,
} from "../../db/schema";

type ChildTable = { table: PgTable; column: AnyPgColumn };

/** Every table whose rows belong to a Bot and go with it. */
export const BOT_CHILD_TABLES: readonly ChildTable[] = [
  { table: appAccessRequests, column: appAccessRequests.agentId },
  { table: botTasks, column: botTasks.agentId },
  { table: channelAgents, column: channelAgents.agentId },
  { table: deliveryBindings, column: deliveryBindings.agentId },
  { table: deliveryChallenges, column: deliveryChallenges.agentId },
  { table: deliveryInbox, column: deliveryInbox.agentId },
  { table: deliveryOutbox, column: deliveryOutbox.agentId },
  { table: demonstrations, column: demonstrations.botId },
  { table: memorySources, column: memorySources.agentId },
  { table: personalMemories, column: personalMemories.formedByAgentId },
  { table: sharedUseApprovals, column: sharedUseApprovals.agentId },
  { table: sharedUseRequests, column: sharedUseRequests.agentId },
];

/** Columns that name a Bot and are cleared, not deleted with it: the row is about something else. */
export const BOT_REFERENCE_COLUMNS: readonly ChildTable[] = [
  { table: channels, column: channels.lastMessageAgentId },
];

/** Remove every row here that belongs to these Bots, in one transaction. */
export async function removeBotLocalRows(
  database: Database,
  botIds: readonly string[],
): Promise<void> {
  if (botIds.length === 0) return;
  await database.transaction(async (transaction) => {
    for (const { table, column } of BOT_CHILD_TABLES) {
      await transaction.delete(table).where(inArray(column, [...botIds]));
    }
    // The one column in BOT_REFERENCE_COLUMNS: a channel outlives the Bot that spoke last in it.
    await transaction
      .update(channels)
      .set({ lastMessageAgentId: null })
      .where(inArray(channels.lastMessageAgentId, [...botIds]));
  });
}

/** Every Bot id any of those tables names. */
export async function botIdsNamedLocally(
  database: Database,
): Promise<Set<string>> {
  const named = new Set<string>();
  for (const { table, column } of [
    ...BOT_CHILD_TABLES,
    ...BOT_REFERENCE_COLUMNS,
  ]) {
    const rows = await database
      .selectDistinct({ id: sql<string>`${column}` })
      .from(table)
      .where(isNotNull(column));
    for (const row of rows) named.add(row.id);
  }
  return named;
}

/**
 * Remove the rows of every Bot Intelligence no longer has at all.
 *
 * The ids are read here BEFORE Intelligence is asked, and that order is the safety: a Bot is created
 * in Intelligence before any row here names it, so an id this read found was already in Intelligence
 * when it was read, and absent from the complete listing that follows means it was purged since. Asked
 * the other way round, a Bot made between the two reads would have its first rows removed.
 *
 * `listAll` must return every Bot, deleted ones included: a soft-deleted Bot keeps its rows.
 */
export async function sweepPurgedBotRows(
  database: Database,
  listAll: () => Promise<Iterable<{ id: string }>>,
): Promise<string[]> {
  const named = await botIdsNamedLocally(database);
  if (named.size === 0) return [];
  const known = new Set<string>();
  for (const bot of await listAll()) known.add(bot.id);
  const gone = [...named].filter((id) => !known.has(id));
  if (gone.length > 0) {
    await removeBotLocalRows(database, gone);
    console.warn(
      JSON.stringify({
        type: "bot-rows-swept",
        note: "Rows named Bots that Intelligence no longer has; they were removed as the old cascade would have.",
        bots: gone,
      }),
    );
  }
  return gone;
}
