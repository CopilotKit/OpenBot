/**
 * This deployment's own rows that name an app (tool server), and removing them when the app goes.
 *
 * Apps live in Intelligence, so the tables here name one by id with no foreign key, and nothing in
 * PostgreSQL removes these rows when an app is removed. They used to go by `ON DELETE CASCADE` from
 * `mcp_servers`, and a Bot's grants on the app were deleted beside the server row. This file is that
 * cascade, run by hand: when an app is removed here, when Intelligence says one was removed elsewhere,
 * and at boot for any app removed while no instance was running to hear it.
 *
 * A NEW TABLE THAT NAMES AN APP BELONGS HERE.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  mcpToolLists,
  mcpTools,
  pendingAuthorizations,
  pluginGrants,
  sharedUseApprovals,
  sharedUseRequests,
} from "../db/schema";

/** Removes every row here that names one of these apps. */
export async function removeServerLocalRows(
  database: Database,
  serverIds: string[],
): Promise<void> {
  if (serverIds.length === 0) return;
  await database.transaction(async (transaction) => {
    await transaction
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.kind, "mcp"),
          inArray(sql`split_part(${pluginGrants.ref}, '/', 1)`, serverIds),
        ),
      );
    await transaction
      .delete(mcpTools)
      .where(inArray(mcpTools.serverId, serverIds));
    await transaction
      .delete(mcpToolLists)
      .where(inArray(mcpToolLists.serverId, serverIds));
    await transaction
      .delete(pendingAuthorizations)
      .where(inArray(pendingAuthorizations.serverId, serverIds));
    await transaction
      .delete(sharedUseApprovals)
      .where(inArray(sharedUseApprovals.serverId, serverIds));
    await transaction
      .delete(sharedUseRequests)
      .where(inArray(sharedUseRequests.serverId, serverIds));
  });
}

/** The app ids this deployment's rows name. */
async function serverIdsNamedLocally(database: Database): Promise<Set<string>> {
  const named = new Set<string>();
  const rows = await database.execute<{ id: string }>(sql`
    SELECT server_id AS id FROM mcp_tools
    UNION SELECT server_id FROM mcp_tool_lists
    UNION SELECT server_id FROM pending_authorizations
    UNION SELECT server_id FROM shared_use_approvals
    UNION SELECT server_id FROM shared_use_requests
    UNION SELECT split_part(ref, '/', 1) FROM plugin_grants WHERE kind = 'mcp'
  `);
  for (const row of [...rows]) named.add(row.id);
  return named;
}

/**
 * At boot: removes rows naming apps Intelligence no longer has, removed while no instance was running
 * to hear it. Run after the upgrade copy, since before it an upgrading deployment's own apps are not
 * in Intelligence yet.
 */
export async function sweepRemovedServerRows(
  database: Database,
  liveServerIds: Iterable<string>,
): Promise<string[]> {
  const named = await serverIdsNamedLocally(database);
  if (named.size === 0) return [];
  const known = new Set(liveServerIds);
  const gone = [...named].filter((id) => !known.has(id));
  if (gone.length > 0) {
    await removeServerLocalRows(database, gone);
    console.warn(
      JSON.stringify({
        type: "app-rows-swept",
        note: "Rows named apps that Intelligence no longer has; they were removed as the old cascade would have.",
        servers: gone,
      }),
    );
  }
  return gone;
}
