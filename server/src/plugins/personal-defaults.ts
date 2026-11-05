import { and, eq, isNull, like } from "drizzle-orm";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import { enterpriseSettings } from "../db/schema/admin";
import { agentProfiles } from "../db/schema/coworker";
import { mcpServers, mcpTools, pluginGrants } from "../db/schema/plugins";
import { currentEdition } from "../edition";

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
 * The apps the personal edition turns on by itself, once, the first time it starts: Parallel's
 * keyless web search, so a Bot can look something up with nothing set up. Unlike Routines, the
 * person can turn one off, and it stays off.
 */
export const PERSONAL_DEFAULT_APPS: readonly string[] = Object.freeze([
  "parallel",
]);

/** What the deployment remembers about its default apps. */
export type DefaultAppsMemory = {
  /** The default apps this deployment has already turned on once. */
  added(): Promise<Set<string>>;
  /** Writes down that it has, so turning one off is final. */
  remember(app: string): Promise<void>;
};

type DefaultAppsStore = Pick<Store, "refreshTools"> & {
  serverAddress(serverId: string): Promise<unknown>;
  addServer(input: { key: string; by: string }): Promise<unknown>;
};

/**
 * At startup, in the personal edition: turn each default app on the first time, and fetch the
 * tools of one that is on but has none, which is what an offline first start leaves. The
 * `refreshTools` wrapper above then gives every Bot all of them. Answers the apps still waiting
 * for their tools.
 *
 * Remembered only once the app's row is there, so a start that failed before writing it tries
 * again next time, and one that failed after it does not add the app a second time. An app that is
 * not there and is remembered was turned off by the person, and is left alone.
 */
export async function ensurePersonalDefaultApps(
  store: DefaultAppsStore,
  deps: PersonalDefaultsDeps,
  memory: DefaultAppsMemory,
): Promise<string[]> {
  if (currentEdition() !== "personal") return [];
  const remembered = await memory.added();
  const waiting: string[] = [];
  for (const app of PERSONAL_DEFAULT_APPS) {
    // Adding asks the vendor for the tools already, so a fresh add is not asked a second time.
    let asked = false;
    if (!remembered.has(app)) {
      if (!(await store.serverAddress(app))) {
        asked = true;
        try {
          await store.addServer({ key: app, by: GRANTED_BY });
        } catch (error) {
          if (!(await store.serverAddress(app))) throw error;
        }
      }
      await memory.remember(app);
    }
    if (!(await store.serverAddress(app))) continue;
    if ((await deps.tools(app)).length > 0) continue;
    if (asked || (await store.refreshTools(app)).tools === 0) waiting.push(app);
  }
  return waiting;
}

/** How long to wait before each retry while a default app has no tools. The last one repeats. */
export const DEFAULT_APPS_RETRY_MS: readonly number[] = Object.freeze([
  30_000, 60_000, 120_000, 300_000,
]);

/**
 * Runs {@link ensurePersonalDefaultApps} without holding up startup, and runs it again on a timer
 * while an app is still waiting for its tools, so web search starts working when the network comes
 * back without anybody pressing Refresh. A failure is a warning, never a reason not to start.
 * Answers a function that stops the retries.
 */
export function startPersonalDefaultApps(
  store: DefaultAppsStore,
  deps: PersonalDefaultsDeps,
  memory: DefaultAppsMemory,
  retryMs: readonly number[] = DEFAULT_APPS_RETRY_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let warned = false;
  const warnOnce = (sentence: string) => {
    if (!warned) console.warn(sentence);
    warned = true;
  };
  const attempt = async (retry: number) => {
    try {
      const waiting = await ensurePersonalDefaultApps(store, deps, memory);
      if (waiting.length === 0) return;
      warnOnce(
        `${waiting.join(", ")} could not list its tools, so web search is not ready yet. OpenBot will keep trying.`,
      );
    } catch (error) {
      warnOnce(
        `OpenBot could not turn on its default apps (${reasonWithoutStatement(error)}). It will keep trying.`,
      );
    }
    if (stopped) return;
    const delay = retryMs[Math.min(retry, retryMs.length - 1)] ?? 300_000;
    timer = setTimeout(() => void attempt(retry + 1), delay);
    timer.unref?.();
  };
  void attempt(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
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

/** The reads above, from the database. */
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
    async servers() {
      const rows = await database
        .select({ id: mcpServers.id })
        .from(mcpServers);
      return rows.map((row) => row.id);
    },
  };
}

/**
 * Where the default apps already turned on are written down: one `enterprise_settings` row, so the
 * fact outlives the app's own row, which turning the app off deletes. The personal edition never
 * reads that table's other keys (see `PERSONAL_ENTERPRISE_SETTINGS`), and the team edition's
 * settings ignore this one.
 */
export const DEFAULT_APPS_SETTING = "personal_default_apps";

/** The memory above, from the database. */
export function personalDefaultAppsMemory(
  database: Database,
): DefaultAppsMemory {
  const added = async () => {
    const [row] = await database
      .select({ value: enterpriseSettings.value })
      .from(enterpriseSettings)
      .where(eq(enterpriseSettings.key, DEFAULT_APPS_SETTING));
    const apps = (row?.value as { value?: unknown } | undefined)?.value;
    return new Set(
      Array.isArray(apps)
        ? apps.filter((app): app is string => typeof app === "string")
        : [],
    );
  };
  return {
    added,
    async remember(app) {
      const value = { value: [...new Set([...(await added()), app])].sort() };
      await database
        .insert(enterpriseSettings)
        .values({ key: DEFAULT_APPS_SETTING, value, updatedBy: GRANTED_BY })
        .onConflictDoUpdate({
          target: enterpriseSettings.key,
          set: { value, updatedBy: GRANTED_BY, updatedAt: new Date() },
        });
    },
  };
}
