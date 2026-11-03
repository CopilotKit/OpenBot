import { eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema/coworker";
import { mcpTools } from "../db/schema/plugins";
import { currentEdition } from "../edition";
import { catalogueEntry, classifyTool } from "./catalogue";

type ListedTool = { ref: string; read: boolean };

type Store = {
  refreshTools(serverId: string, actorId?: string): Promise<{ tools: number }>;
  grant(
    kind: "mcp",
    ref: string,
    agentId: string,
    by: string,
    as?: "admin" | "owner",
  ): Promise<void>;
};

export type PersonalDefaultsDeps = {
  /** What this deployment has recorded for an app, each tool classified read or write. */
  tools(serverId: string): Promise<ListedTool[]>;
  /** Every Bot there is. */
  bots(): Promise<string[]>;
};

/** Who the trail names for a grant nobody pressed a button for. */
const GRANTED_BY = "openbot:personal-defaults";

/**
 * In the personal edition, connecting an app is enough for it to be useful: every tool it newly
 * lists that only reads is given to every Bot, as an admin grant on the trail. Tools that change
 * things are left off, so a Bot asks before it gets one, and an approval still stands in front of
 * every write a Bot is given later.
 *
 * ONLY NEW TOOLS. What the app already listed before this refresh is left alone, so a tool the
 * person took away from a Bot is not given back the next time the app is refreshed.
 *
 * Installed as a wrapper on `refreshTools` because every way an app's tools are learned goes
 * through it: adding the app, connecting an account, and pressing Refresh. The store's methods call
 * each other through `this`, so replacing the property is what makes the internal calls go through
 * here too.
 */
export function withPersonalDefaults<S extends Store>(
  store: S,
  deps: PersonalDefaultsDeps,
): S {
  const refresh = store.refreshTools;
  store.refreshTools = async function (
    this: S,
    serverId: string,
    actorId?: string,
  ) {
    if (currentEdition() !== "personal")
      return refresh.call(this, serverId, actorId);
    const before = new Set(
      (await deps.tools(serverId)).map((tool) => tool.ref),
    );
    const result = await refresh.call(this, serverId, actorId);
    const added = (await deps.tools(serverId)).filter(
      (tool) => tool.read && !before.has(tool.ref),
    );
    if (added.length > 0) {
      const bots = await deps.bots();
      for (const tool of added)
        for (const bot of bots)
          await this.grant("mcp", tool.ref, bot, actorId || GRANTED_BY);
    }
    return result;
  } as S["refreshTools"];
  return store;
}

/** The two reads above, from the database. */
export function personalDefaultsDeps(database: Database): PersonalDefaultsDeps {
  return {
    async tools(serverId) {
      const entry = catalogueEntry(serverId);
      const rows = await database
        .select({ name: mcpTools.name, effect: mcpTools.effect })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, serverId));
      return rows.map((row) => ({
        ref: `${serverId}/${row.name}`,
        read: classifyTool(entry, row.name, true, row.effect) === "read",
      }));
    },
    async bots() {
      const rows = await database
        .select({ id: agentProfiles.agentId })
        .from(agentProfiles)
        .where(isNull(agentProfiles.deletedAt));
      return rows.map((row) => row.id);
    },
  };
}
