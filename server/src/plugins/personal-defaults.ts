import { eq } from "drizzle-orm";
import { bots } from "../agents/bot-registry/directory";
import { botConfiguration } from "../configuration/directory";
import type { Database } from "../db/client";
import { mcpTools } from "../db/schema/plugins";
import { currentEdition } from "../edition";
import { vault } from "../vault/directory";

type ListedTool = { ref: string };

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
  /** The tools this deployment has recorded for an app. */
  tools(serverId: string): Promise<ListedTool[]>;
  /** Every Bot there is. */
  bots(): Promise<string[]>;
  /** The refs of one Bot's tool grants on one app. */
  granted(agentId: string, serverId: string): Promise<Set<string>>;
  /** Every app this deployment has added. */
  servers(): Promise<string[]>;
};

/** Who the trail names for a grant nobody pressed a button for. */
const GRANTED_BY = "openbot:personal-defaults";

/**
 * The app that is on in every edition from the start, with all its tools given to every Bot, and
 * that cannot be turned off or taken from a Bot. A Bot that cannot schedule its own reminders and
 * check-ins is missing half of what it is for.
 */
export const ALWAYS_ON_APP = "routines";

/** Who the trail names for an always-on grant. */
const ALWAYS_ON_BY = "openbot:always-on";

/** Whether an app, or one of its tools (`app/tool`), is the one that is always on. */
export function isAlwaysOn(ref: string): boolean {
  return ref === ALWAYS_ON_APP || ref.startsWith(`${ALWAYS_ON_APP}/`);
}

/** What the server answers when somebody tries to turn it off or take it from a Bot. */
export const ALWAYS_ON_REFUSAL = "Routines are always on, for every Bot.";

/** What the personal edition's server answers when somebody tries to take an app from one Bot. */
export const EVERY_BOT_REFUSAL =
  "In OpenBot Personal every Bot can use every app you connect. Turn the app off to take it from all of them.";

/**
 * Gives Bots every tool of these apps they don't hold yet. Writes nothing when they hold them all,
 * so asking on every run costs reads and no trail rows. The trail names why: Routines' grants as
 * always on, any other app's as `by`.
 */
async function grantEveryTool(
  store: Pick<Store, "grant">,
  deps: PersonalDefaultsDeps,
  apps: string[],
  bots: string[],
  by: string,
): Promise<void> {
  for (const app of apps) {
    const tools = await deps.tools(app);
    if (tools.length === 0) continue;
    const grantedBy = isAlwaysOn(app) ? ALWAYS_ON_BY : by;
    for (const bot of bots) {
      const held = await deps.granted(bot, app);
      for (const tool of tools)
        if (!held.has(tool.ref))
          await store.grant("mcp", tool.ref, bot, grantedBy);
    }
  }
}

/** The apps every Bot holds every tool of: all of them in the personal edition, else Routines. */
async function everyBotApps(deps: PersonalDefaultsDeps): Promise<string[]> {
  return currentEdition() === "personal"
    ? await deps.servers()
    : [ALWAYS_ON_APP];
}

/**
 * At startup, in every edition: add Routines if it isn't added, and give every Bot all of its tools.
 * The ones that change things too, because scheduling is the point; a Bot still asks before each one
 * runs while Ask before acting is on.
 */
export async function ensureAlwaysOnApp(
  store: Pick<Store, "grant"> & {
    serverAddress(serverId: string): Promise<unknown>;
    addServer(input: { key: string; by: string }): Promise<unknown>;
  },
  deps: PersonalDefaultsDeps,
): Promise<void> {
  if (!(await store.serverAddress(ALWAYS_ON_APP)))
    await store.addServer({ key: ALWAYS_ON_APP, by: ALWAYS_ON_BY });
  await grantEveryTool(
    store,
    deps,
    await everyBotApps(deps),
    await deps.bots(),
    GRANTED_BY,
  );
}

/**
 * In the personal edition, connecting an app is the whole decision: every Bot gets every tool it
 * lists, the ones that change things too, as an admin grant on the trail. There is one person, so
 * there is nobody to keep an app from, and what stands in front of a write is Ask before acting:
 * Allow once, Always allow here, or Deny, in the conversation. Taking an app from one Bot is
 * refused (see {@link EVERY_BOT_REFUSAL}); turning the app off takes it from all of them.
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
    const result = await refresh.call(this, serverId, actorId);
    if (currentEdition() === "personal")
      await grantEveryTool(
        this,
        deps,
        [serverId],
        await deps.bots(),
        actorId || GRANTED_BY,
      );
    return result;
  } as S["refreshTools"];

  /*
   * A Bot made after startup gets what every Bot has the first time it runs: Routines in every
   * edition, and every connected app in the personal one. What a run is offered is what this
   * answers, so it is the one moment every Bot, new or old, passes through.
   */
  const list = store.listForAgent;
  store.listForAgent = async function (this: S, agentId: string) {
    await grantEveryTool(
      this,
      deps,
      await everyBotApps(deps),
      [agentId],
      GRANTED_BY,
    );
    return list.call(this, agentId);
  } as S["listForAgent"];
  return store;
}

/**
 * The reads above. An app's tool list is this deployment's own cache (`mcp_tools`); the Bots, what
 * each holds and the apps themselves are Intelligence's, read from this instance's directories.
 */
export function personalDefaultsDeps(database: Database): PersonalDefaultsDeps {
  return {
    async tools(serverId) {
      const rows = await database
        .select({ name: mcpTools.name })
        .from(mcpTools)
        .where(eq(mcpTools.serverId, serverId));
      return rows.map((row) => ({ ref: `${serverId}/${row.name}` }));
    },
    async bots() {
      return bots()
        .live()
        .map((bot) => bot.id);
    },
    async granted(agentId, serverId) {
      return new Set(
        botConfiguration()
          .accessOf(agentId)
          .grants.filter(
            (grant) =>
              grant.kind === "mcp" && grant.ref.startsWith(`${serverId}/`),
          )
          .map((grant) => grant.ref),
      );
    },
    async servers() {
      return vault()
        .servers()
        .map((server) => server.id);
    },
  };
}
