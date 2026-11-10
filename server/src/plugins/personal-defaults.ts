import { and, eq, isNull, like, sql } from "drizzle-orm";
import {
  type AuditStore,
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
} from "../audit";
import type { Database } from "../db/client";
import { reasonWithoutStatement } from "../db/query-failure";
import { enterpriseSettings } from "../db/schema/admin";
import { agentProfiles } from "../db/schema/coworker";
import { learningSettings } from "../db/schema/learning";
import {
  mcpServers,
  mcpTools,
  pluginGrants,
  skills,
} from "../db/schema/plugins";
import { currentEdition } from "../edition";

type ListedTool = { ref: string };

type Store = {
  refreshTools(serverId: string, actorId?: string): Promise<{ tools: number }>;
  grant(
    kind: "mcp" | "skill",
    ref: string,
    agentId: string,
    by: string,
    as?: "admin" | "owner",
  ): Promise<void>;
  grantTools(
    app: string,
    refs: string[],
    agentId: string,
    by: string,
  ): Promise<void>;
  listForAgent(agentId: string): Promise<unknown>;
  installSkill(input: { slug: string; by: string }): Promise<void>;
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
  /** Whether a skill with this slug has been written already. */
  skillExists(slug: string): Promise<boolean>;
  /** Every skill there is, by slug. */
  skills(): Promise<string[]>;
  /** The skills one Bot offers, by slug. */
  heldSkills(agentId: string): Promise<Set<string>>;
  /** Whether this Bot has been given every skill once already. */
  skillsGiven(agentId: string): Promise<boolean>;
  /** Writes down that it has, so a skill switched off for it stays off. */
  rememberSkillsGiven(agentId: string): Promise<void>;
  /**
   * Takes every Bot left out of Automatic Learning (a per-Bot mapping of null) back in, so it
   * follows the default container like every other Bot. Answers the Bots it took back in.
   */
  includeEveryBotInLearning(): Promise<string[]>;
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
 * What the personal edition's server answers when somebody tries to stop one Bot asking another.
 * Every Bot there is the one person's, so each can ask the others (see `botsReachableFrom`).
 */
export const EVERY_BOT_ASKS_REFUSAL =
  "In OpenBot Personal every Bot can ask your other Bots for help.";

/**
 * Gives Bots every tool of these apps they don't hold yet. Writes nothing when they hold them all,
 * so asking on every run costs reads and no trail rows. The trail names why: Routines' grants as
 * always on, any other app's as `by`.
 *
 * One trail row per Bot and app, naming every tool it was given, and started by OpenBot when `by`
 * is OpenBot's own (see `initiatedBy`). An upgrade that added seven goal tools to Routines wrote one
 * row per tool for every Bot, each saying a person had changed a setting.
 */
async function grantEveryTool(
  store: Pick<Store, "grantTools">,
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
      const missing = tools
        .map((tool) => tool.ref)
        .filter((ref) => !held.has(ref))
        .sort();
      if (missing.length > 0)
        await store.grantTools(app, missing, bot, grantedBy);
    }
  }
}

/**
 * In the personal edition, gives each of these Bots every skill it doesn't offer yet, ONCE per Bot.
 *
 * Unlike an app's tools, which every Bot always holds, a skill can be switched off for one Bot on
 * the skill's page, and that has to stick. So a Bot is given the skills there are the first time it
 * passes through here (at startup for the Bots that exist, at its first listing or run for one made
 * later), that is written down, and it is never given them again. A skill written afterwards reaches
 * it through the `installSkill` wrapper below, which gives each new skill to every Bot.
 */
async function giveEverySkillOnce(
  store: Pick<Store, "grant">,
  deps: PersonalDefaultsDeps,
  bots: string[],
): Promise<void> {
  if (currentEdition() !== "personal") return;
  for (const bot of bots) {
    if (await deps.skillsGiven(bot)) continue;
    const held = await deps.heldSkills(bot);
    for (const slug of await deps.skills())
      if (!held.has(slug)) await store.grant("skill", slug, bot, GRANTED_BY);
    await deps.rememberSkillsGiven(bot);
  }
}

/**
 * At startup, in the personal edition: give each Bot that exists every skill, once. See
 * {@link giveEverySkillOnce}.
 */
export async function ensurePersonalSkills(
  store: Pick<Store, "grant">,
  deps: PersonalDefaultsDeps,
): Promise<void> {
  await giveEverySkillOnce(store, deps, await deps.bots());
}

/**
 * At startup, in the personal edition: the skills the person wrote become theirs, if a build before
 * this stored them as nobody's.
 *
 * Settings > Skills saves with `global`, as Admin > Skills does, and the route stored every such
 * skill as the deployment's, so a Bot's "Your skills" read "No skills yet" beside a Bot that held
 * one. The route now gives it to the person (`route-groups/skills.ts`); this gives them the ones
 * written before that.
 *
 * Only skills the person installed: `installed_by` is their email, which is what the route records.
 * A skill OpenBot ships has none, and one the person edited keeps it, so both stay OpenBot's, as an
 * edit keeps the owner a skill already had. Writes nothing once there are none left, and then an
 * audit row naming them, started by OpenBot.
 *
 * @returns the slugs it gave to the person
 */
export async function ensurePersonalSkillsOwned(
  database: Pick<Database, "update">,
  person: { id: string; email: string },
  audit?: AuditStore,
): Promise<string[]> {
  if (currentEdition() !== "personal") return [];
  const owned = await database
    .update(skills)
    .set({ ownerUserId: person.id })
    .where(
      and(
        isNull(skills.ownerUserId),
        eq(skills.origin, "yours"),
        eq(skills.installedBy, person.email),
      ),
    )
    .returning({ slug: skills.slug });
  const slugs = owned.map((row) => row.slug).sort();
  if (slugs.length > 0 && audit)
    await recordAuditEvent(audit, {
      eventType: "configuration.changed",
      targetType: "skill",
      initiator: DEPLOYMENT_INITIATOR,
      payload: { change: "skills_owned_personal", skills: slugs },
    });
  return slugs;
}

/**
 * In the personal edition every Bot takes part in Automatic Learning: its conversations go to the
 * Learning container and it uses every Skill learned there and in the person's own space. There is
 * no switch for one Bot there (the Admin screen that has one is the team edition's), so a Bot left
 * out, which only a team edition's settings in the same database can do, is taken back in. At
 * startup for the Bots that exist; every Bot's first listing or run checks again (see
 * `withPersonalDefaults`). A Bot made later has no mapping and follows the default already.
 *
 * Writes only when a Bot was left out, and then an audit row naming the Bots, started by OpenBot.
 */
export async function ensurePersonalLearning(
  deps: Pick<PersonalDefaultsDeps, "includeEveryBotInLearning">,
  audit?: AuditStore,
): Promise<string[]> {
  if (currentEdition() !== "personal") return [];
  const included = await deps.includeEveryBotInLearning();
  if (included.length > 0 && audit)
    await recordAuditEvent(audit, {
      eventType: "configuration.changed",
      targetType: "learning",
      initiator: DEPLOYMENT_INITIATOR,
      payload: { change: "every_bot_included_personal", bots: included },
    });
  return included;
}

/** The apps every Bot holds every tool of: all of them in the personal edition, else Routines. */
async function everyBotApps(deps: PersonalDefaultsDeps): Promise<string[]> {
  return currentEdition() === "personal"
    ? await deps.servers()
    : [ALWAYS_ON_APP];
}

/**
 * At startup, in every edition: add Routines if it isn't added, bring the saved tools of every app
 * whose tools are OpenBot's own code up to date with this build (see `refreshOwnListings`), and give
 * every Bot all of Routines' tools. The ones that change things too, because scheduling is the point;
 * a Bot still asks before each one runs while Extra vigilant is on.
 *
 * Brought up to date before the grants, so a tool this build adds to Routines is given to every Bot
 * at the same start rather than the one after.
 */
export async function ensureAlwaysOnApp(
  store: Pick<Store, "grantTools"> & {
    serverAddress(serverId: string): Promise<unknown>;
    addServer(input: { key: string; by: string }): Promise<unknown>;
    refreshOwnListings(): Promise<string[]>;
  },
  deps: PersonalDefaultsDeps,
): Promise<void> {
  if (!(await store.serverAddress(ALWAYS_ON_APP)))
    await store.addServer({ key: ALWAYS_ON_APP, by: ALWAYS_ON_BY });
  await store.refreshOwnListings();
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
 * there is nobody to keep an app from, and what stands in front of a write is Extra vigilant:
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
   * edition, and every connected app, every skill and Automatic Learning in the personal one. What a
   * run is offered is what this answers, so it is the one moment every Bot, new or old, passes
   * through.
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
    await giveEverySkillOnce(this, deps, [agentId]);
    if (currentEdition() === "personal") await deps.includeEveryBotInLearning();
    return list.call(this, agentId);
  } as S["listForAgent"];

  /*
   * In the personal edition a new skill goes to every Bot, as a new app does: the person writing it
   * is the only person there, and a skill no Bot offers does nothing until they find the switch.
   * Only when it is new. Saving it again is an edit, and must not turn back on a Bot they switched
   * off on the skill's page.
   */
  const install = store.installSkill;
  store.installSkill = async function (
    this: S,
    input: Parameters<S["installSkill"]>[0],
  ) {
    const fresh =
      currentEdition() === "personal" && !(await deps.skillExists(input.slug));
    await install.call(this, input);
    if (fresh)
      for (const bot of await deps.bots())
        await this.grant("skill", input.slug, bot, input.by || GRANTED_BY);
  } as S["installSkill"];
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
    async skills() {
      const rows = await database.select({ slug: skills.slug }).from(skills);
      return rows.map((row) => row.slug);
    },
    async heldSkills(agentId) {
      const rows = await database
        .select({ ref: pluginGrants.ref })
        .from(pluginGrants)
        .where(
          and(
            eq(pluginGrants.kind, "skill"),
            eq(pluginGrants.agentId, agentId),
          ),
        );
      return new Set(rows.map((row) => row.ref));
    },
    /*
     * One settings row per Bot rather than one list of them: two Bots listed at once would each read
     * the list, add themselves and write it back, and one of them would be lost and given every skill
     * again, switched-off ones included.
     */
    async skillsGiven(agentId) {
      const [row] = await database
        .select({ key: enterpriseSettings.key })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, skillsGivenSetting(agentId)))
        .limit(1);
      return row !== undefined;
    },
    async rememberSkillsGiven(agentId) {
      await database
        .insert(enterpriseSettings)
        .values({
          key: skillsGivenSetting(agentId),
          value: { value: true },
          updatedBy: GRANTED_BY,
        })
        .onConflictDoNothing();
    },
    /*
     * One statement on the one settings row, so it cannot lose a change saved at the same moment and
     * keeps every other key as it is. Matches no row, and writes nothing, while no Bot is left out.
     */
    async includeEveryBotInLearning() {
      const rows = await database.execute<{ bots: string[] }>(sql`
        WITH old AS (
          SELECT ${learningSettings.settings} AS settings
          FROM ${learningSettings}
          WHERE ${learningSettings.id} = 'current'
          FOR UPDATE
        )
        UPDATE ${learningSettings}
        SET settings = jsonb_set(
              ${learningSettings.settings},
              '{agents}',
              COALESCE(
                (SELECT jsonb_object_agg(bot, target)
                 FROM jsonb_each(${learningSettings.settings}->'agents') AS mapping(bot, target)
                 WHERE target <> 'null'::jsonb),
                '{}'::jsonb
              )
            ),
            updated_at = now()
        FROM old
        WHERE ${learningSettings.id} = 'current'
          AND jsonb_typeof(old.settings->'agents') = 'object'
          AND EXISTS (
            SELECT 1 FROM jsonb_each(old.settings->'agents') AS mapping(bot, target)
            WHERE target = 'null'::jsonb
          )
        RETURNING (
          SELECT COALESCE(array_agg(bot ORDER BY bot), '{}')
          FROM jsonb_each(old.settings->'agents') AS mapping(bot, target)
          WHERE target = 'null'::jsonb
        ) AS bots
      `);
      return [...rows].flatMap((row) => row.bots);
    },
    async skillExists(slug) {
      const [row] = await database
        .select({ slug: skills.slug })
        .from(skills)
        .where(eq(skills.slug, slug))
        .limit(1);
      return row !== undefined;
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

/** The settings row that says a Bot has been given every skill once. */
export function skillsGivenSetting(agentId: string): string {
  return `personal_skills_given:${agentId}`;
}

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
