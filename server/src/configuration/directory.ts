/**
 * Everything Intelligence holds beside this deployment's Bots, in memory on this instance: each Bot's
 * access, each person's preferences, the component catalogue and the skills (see `types.ts`).
 *
 * Four record caches (`cache.ts`) behind one subscription to Intelligence's `configuration_changed`
 * announcements, on the same project topic the Bot directory hears `agent_changed` on. Every (re)join
 * reads all four sets again, and so does a timer; a write made here is applied from Intelligence's
 * answer at once. Nothing on a turn's path reaches Intelligence: reads come from memory.
 *
 * A BOT PURGED FOR GOOD. Intelligence removes its access record and every preference and withholding
 * that named it, and announces each. This instance also reads those records again the moment the Bot
 * directory hears of the purge, rather than waiting on the announcements, and reads rather than
 * forgets: a purge heard late may follow the same id being made again, and given things.
 */
import type { AgentRegistryClient } from "../agents/bot-registry/client";
import { subscribeToProjectEvents } from "../agents/bot-registry/events";
import { type RecordCache, createRecordCache } from "./cache";
import {
  type ConfigurationClient,
  ConfigurationMissingError,
  configurationKey,
} from "./client";
import type {
  BotAccess,
  BotAccessChange,
  BotAccessChangeResult,
  ComponentEntry,
  PersonPreferences,
  PersonPreferencesChange,
  PersonPreferencesChangeResult,
  SkillEntry,
} from "./types";

/** Well inside the hour the gateway keeps a join code alive for. */
const RESYNC_INTERVAL_MS = 15 * 60 * 1_000;

export type BotConfiguration = {
  client: ConfigurationClient;
  access: RecordCache<BotAccess>;
  preferences: RecordCache<PersonPreferences>;
  components: RecordCache<ComponentEntry>;
  skills: RecordCache<SkillEntry>;
  /** Read every set and subscribe. Resolves once the first reads are complete. */
  start(): Promise<void>;
  stop(): void;
  /** Read every set again. */
  resync(): Promise<void>;
  /** Whether every set has been read at least once. */
  loaded(): boolean;
  /** This Bot's access, from memory. A Bot with none holds nothing and is published to nobody. */
  accessOf(botId: string): BotAccess;
  /** This person's preferences, from memory. A person who set nothing has every default. */
  preferencesOf(userId: string): PersonPreferences;
  /** Apply changes to Bots' access in one Intelligence call, and hold what it answered. */
  changeAccess(
    changes: BotAccessChange[],
    options?: { key?: string; expectedRevisions?: Record<string, number> },
  ): Promise<BotAccessChangeResult[]>;
  /** Apply changes to one person's preferences in one Intelligence call, and hold what it answered. */
  changePreferences(
    userId: string,
    changes: PersonPreferencesChange[],
    options?: { key?: string; expectedRevision?: number },
  ): Promise<{
    results: PersonPreferencesChangeResult[];
    preferences: PersonPreferences;
  }>;
  /** Spend a one-time consent: true for exactly one call, on any replica. */
  consumeConsent(
    userId: string,
    botId: string,
    serverId: string,
  ): Promise<boolean>;
  /** A Bot was purged: read again everything held here that named it. */
  botPurged(botId: string): Promise<void>;
};

export const emptyAccess = (botId: string): BotAccess => ({
  botId,
  revision: 0,
  grants: [],
  publication: null,
  assignments: [],
});

export const emptyPreferences = (userId: string): PersonPreferences => ({
  userId,
  revision: 0,
  instructions: null,
  instructionsUpdatedAt: null,
  bots: [],
  routes: [],
  optOuts: [],
  consents: [],
  consentDefaults: [],
});

export function createBotConfiguration(options: {
  client: ConfigurationClient;
  /** Mints the realtime credentials; the agent registry's subscribe serves every announcement. */
  registry: Pick<AgentRegistryClient, "subscribe">;
  /** The gateway address the runtime is configured with. Absent: no announcements, timer only. */
  gatewayWsUrl?: string;
  resyncIntervalMs?: number;
}): BotConfiguration {
  const { client } = options;

  const access = createRecordCache<BotAccess>({
    name: "bot-access",
    listAll: () => client.access.all(),
    read: async (botId) => {
      const record = await client.access.get(botId);
      return record && record.revision > 0 ? record : null;
    },
    keyOf: (record) => record.botId,
    revisionOf: (record) => record.revision,
  });
  const preferences = createRecordCache<PersonPreferences>({
    name: "person-preferences",
    listAll: () => client.preferences.all(),
    read: async (userId) => {
      const record = await client.preferences.get(userId);
      return record.revision > 0 ? record : null;
    },
    keyOf: (record) => record.userId,
    revisionOf: (record) => record.revision,
  });
  const components = createRecordCache<ComponentEntry>({
    name: "components",
    listAll: () => client.components.all(),
    read: (name) => client.components.get(name),
    keyOf: (record) => record.name,
    revisionOf: (record) => record.version,
  });
  const skills = createRecordCache<SkillEntry>({
    name: "skills",
    listAll: () => client.skills.all(),
    read: (slug) => client.skills.get(slug),
    keyOf: (record) => record.slug,
    revisionOf: (record) => record.version,
  });
  const caches: Record<string, RecordCache<unknown>> = {
    agent_access: access as RecordCache<unknown>,
    end_user_preferences: preferences as RecordCache<unknown>,
    ui_component: components as RecordCache<unknown>,
    skill: skills as RecordCache<unknown>,
  };

  let subscription: ReturnType<typeof subscribeToProjectEvents> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const resyncAll = async () => {
    await Promise.all(Object.values(caches).map((cache) => cache.resync()));
  };

  const failed = (note: string) => (error: unknown) =>
    console.warn(
      JSON.stringify({
        type: "bot-configuration-resync-failed",
        note,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  const configuration: BotConfiguration = {
    client,
    access,
    preferences,
    components,
    skills,

    async start() {
      if (options.gatewayWsUrl) {
        subscription = subscribeToProjectEvents({
          client: options.registry,
          gatewayWsUrl: options.gatewayWsUrl,
          logType: "bot-configuration-subscription-retry",
          events: {
            configuration_changed: (payload) => {
              const change = parseChange(payload);
              if (!change) return;
              const cache = caches[change.resource];
              if (cache)
                void cache.heard(change.key, change.revision, change.change);
            },
          },
          onJoined: () => {
            resyncAll().catch(failed("Still serving what was last read."));
          },
        });
      }
      await resyncAll();
      timer = setInterval(() => {
        resyncAll().catch(failed("Still serving what was last read."));
      }, options.resyncIntervalMs ?? RESYNC_INTERVAL_MS);
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
      subscription?.stop();
    },

    resync: resyncAll,

    loaded: () =>
      access.loaded() &&
      preferences.loaded() &&
      components.loaded() &&
      skills.loaded(),

    accessOf: (botId) => access.get(botId) ?? emptyAccess(botId),
    preferencesOf: (userId) =>
      preferences.get(userId) ?? emptyPreferences(userId),

    async changeAccess(changes, writeOptions = {}) {
      const { results, records } = await client.access.change(
        changes,
        writeOptions.key ?? configurationKey("access"),
        writeOptions.expectedRevisions,
      );
      for (const record of records) {
        if (record.revision > 0) access.apply(record);
      }
      return results;
    },

    async changePreferences(userId, changes, writeOptions = {}) {
      const answer = await client.preferences.change(
        userId,
        changes,
        writeOptions.key ?? configurationKey("preferences"),
        writeOptions.expectedRevision,
      );
      if (answer.preferences.revision > 0)
        preferences.apply(answer.preferences);
      return answer;
    },

    async consumeConsent(userId, botId, serverId) {
      let consumed: boolean;
      try {
        ({ consumed } = await client.preferences.consumeConsent(
          userId,
          botId,
          serverId,
          configurationKey("consume-consent"),
        ));
      } catch (error) {
        // A Bot Intelligence no longer has holds no consent to spend.
        if (error instanceof ConfigurationMissingError) return false;
        throw error;
      }
      // What is held here still lists the spent consent: read the record again.
      await preferences.refresh(userId);
      return consumed;
    },

    async botPurged(botId) {
      /*
       * Read again rather than forgotten. Intelligence removed the Bot's access and everything that
       * named it when it purged the Bot, so what it holds now is the truth, and it is also the truth
       * when this announcement is late: the id may have been made again since, and given things,
       * and forgetting here would drop those until the next full read.
       */
      const named = (entries: { botId: string }[]) =>
        entries.some((entry) => entry.botId === botId);
      const reads: Promise<unknown>[] = [access.refresh(botId)];
      for (const record of preferences.all())
        if (
          named(record.bots) ||
          named(record.optOuts) ||
          named(record.consents)
        )
          reads.push(preferences.refresh(record.userId));
      for (const record of components.all())
        if (named(record.withheldFrom))
          reads.push(components.refresh(record.name));
      const settled = await Promise.allSettled(reads);
      const failed = settled.filter((result) => result.status === "rejected");
      if (failed.length > 0)
        console.warn(
          JSON.stringify({
            type: "bot-configuration-purge-read-failed",
            botId,
            note: "The next full read picks the change up.",
            failed: failed.length,
          }),
        );
    },
  };
  return configuration;
}

function parseChange(payload: unknown): {
  resource: string;
  key: string;
  revision: number;
  change: string;
} | null {
  if (!payload || typeof payload !== "object") return null;
  const { resource, key, revision, change } = payload as Record<
    string,
    unknown
  >;
  if (
    typeof resource !== "string" ||
    typeof key !== "string" ||
    typeof revision !== "number"
  )
    return null;
  return {
    resource,
    key,
    revision,
    change: typeof change === "string" ? change : "updated",
  };
}

let installed: BotConfiguration | undefined;

/** Make this the configuration every read and write in this process goes through. */
export function installBotConfiguration(
  configuration: BotConfiguration,
): BotConfiguration {
  installed = configuration;
  return configuration;
}

/** Whether a configuration is installed: false in a unit test of some other module. */
export function botConfigurationInstalled(): boolean {
  return installed !== undefined;
}

/**
 * What Intelligence holds beside the Bots, as this process holds it.
 *
 * Throws when nothing installed one, rather than answering with empty sets: no grants looks like a
 * deployment where nobody was ever given anything, and nothing about it would say why.
 */
export function botConfiguration(): BotConfiguration {
  if (!installed) {
    throw new Error(
      "No Bot configuration is installed. The server installs one at boot (configuration/directory.ts); a test installs the one in tests/support/bots.ts.",
    );
  }
  return installed;
}
