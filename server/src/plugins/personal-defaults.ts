import { and, eq, isNull, like } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema/coworker";
import { mcpTools, pluginGrants } from "../db/schema/plugins";
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
  listForAgent(agentId: string): Promise<unknown>;
};

export type PersonalDefaultsDeps = {
  /** What this deployment has recorded for an app, each tool classified read or write. */
  tools(serverId: string): Promise<ListedTool[]>;
  /** Every Bot there is. */
  bots(): Promise<string[]>;
  /** The refs of one Bot's tool grants on one app. */
  granted(agentId: string, serverId: string): Promise<Set<string>>;
};

/** Who the trail names for a grant nobody pressed a button for. */
const GRANTED_BY = "openbot:personal-defaults";

/**
 * The app that is on in the personal edition from the start, with all its tools given to every Bot,
 * and that cannot be turned off or taken from a Bot. A personal assistant that cannot schedule its
 * own reminders and check-ins is missing half of what it is for.
 */
export const ALWAYS_ON_APP = "routines";

/** Whether an app, or one of its tools (`app/tool`), is the one that is always on here. */
export function isAlwaysOn(ref: string): boolean {
  return (
    currentEdition() === "personal" &&
    (ref === ALWAYS_ON_APP || ref.startsWith(`${ALWAYS_ON_APP}/`))
  );
}

/** What the server answers when somebody tries to turn it off or take it from a Bot. */
export const ALWAYS_ON_REFUSAL =
  "Routines are always on in OpenBot Personal, for every Bot.";

/** Gives Bots every always-on tool they don't hold yet. Writes nothing when they hold them all. */
async function grantAlwaysOn(
  store: Pick<Store, "grant">,
  deps: PersonalDefaultsDeps,
  bots: string[],
): Promise<void> {
  const tools = await deps.tools(ALWAYS_ON_APP);
  for (const bot of bots) {
    const held = await deps.granted(bot, ALWAYS_ON_APP);
    for (const tool of tools)
      if (!held.has(tool.ref))
        await store.grant("mcp", tool.ref, bot, GRANTED_BY);
  }
}

/**
 * At startup in the personal edition: add Routines if it isn't added, and give every Bot all of its
 * tools. The ones that change things too, because scheduling is the point; a Bot still asks before
 * each one runs while Ask before acting is on.
 */
export async function ensureAlwaysOnApp(
  store: Pick<Store, "grant"> & {
    serverAddress(serverId: string): Promise<unknown>;
    addServer(input: { key: string; by: string }): Promise<unknown>;
  },
  deps: PersonalDefaultsDeps,
): Promise<void> {
  if (currentEdition() !== "personal") return;
  if (!(await store.serverAddress(ALWAYS_ON_APP)))
    await store.addServer({ key: ALWAYS_ON_APP, by: GRANTED_BY });
  await grantAlwaysOn(store, deps, await deps.bots());
}

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

  /*
   * A Bot made after startup gets Routines the first time it runs: what a run is offered is what
   * this answers, so it is the one moment every Bot, new or old, passes through.
   */
  const list = store.listForAgent;
  store.listForAgent = async function (this: S, agentId: string) {
    if (currentEdition() === "personal")
      await grantAlwaysOn(this, deps, [agentId]);
    return list.call(this, agentId);
  } as S["listForAgent"];
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
    async granted(agentId, serverId) {
      const rows = await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "mcp"),
            eq(pluginGrants.agentId, agentId),
            like(pluginGrants.ref, `${serverId}/%`),
          ),
        );
      return new Set(rows.map((row) => row.ref));
    },
  };
}
