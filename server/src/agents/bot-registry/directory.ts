/**
 * Every Bot this deployment has, held in memory per server instance and kept fresh from Intelligence.
 *
 * WHY A CACHE. Bots are read on every turn, every page load and every tool call, and they live in
 * Intelligence's agent registry now rather than in this deployment's database. Reading the registry
 * on each of those would put a network round trip under everything a person does. So each instance
 * holds the whole set (a project's Bots number in the hundreds, not the millions) and reads it from
 * memory.
 *
 * HOW IT STAYS FRESH, ACROSS REPLICAS. A write made here updates the cache from the registry's answer
 * at once, so this instance reads its own writes. Every other instance hears of it from Intelligence's
 * realtime gateway, which announces each change by id and version; the announcement is followed by a
 * read of that one Bot. Announcements can be lost (a socket drops, a replica restarts), so the whole set
 * is read again whenever the subscription joins, which includes every reconnect, and on a timer. A miss
 * reads through to the registry, so a Bot made on another replica a moment ago is found even before its
 * announcement arrives. Versions order what arrives: an older copy never replaces a newer one.
 *
 * DELETED FOR GOOD. A soft-deleted Bot stays in the cache with `deletedAt` set, because its
 * conversations stay readable. A purged Bot leaves, and the purge listeners run, which is how this
 * deployment's own rows that named it go too (see `local-rows.ts`).
 */
import {
  type AgentRegistryClient,
  BotMissingError,
  idempotencyKey,
} from "./client";
import {
  type BotChange,
  type BotChangeSubscription,
  subscribeToBotChanges,
} from "./events";
import type { Bot, BotChanges, BotDraft } from "./types";

export type BotDirectory = {
  /** Read the whole set and subscribe to changes. Resolves once the first read is complete. */
  start(): Promise<void>;
  stop(): void;
  /** Whether announcements are arriving: the realtime subscription is joined. */
  subscribed(): boolean;
  /** Every Bot this instance holds, deleted ones included. Never reaches Intelligence. */
  cached(): Bot[];
  /** Every live Bot this instance holds. Never reaches Intelligence. */
  live(): Bot[];
  /**
   * From memory only. For code inside an OpenBot transaction, which must not wait on Intelligence
   * while it holds a connection.
   */
  peek(id: string): Bot | undefined;
  /** From memory, reading through to Intelligence on a miss. Deleted Bots included. */
  find(id: string): Promise<Bot | null>;
  findMany(ids: Iterable<string>): Promise<Map<string, Bot>>;
  /** Read this Bot from Intelligence now, whatever this instance holds. Null when it is purged. */
  refresh(id: string): Promise<Bot | null>;
  /** The live Bot holding this callback-token hash, reading through on a miss. */
  byCallbackTokenHash(hash: string): Promise<Bot | null>;
  create(draft: BotDraft, key?: string): Promise<Bot>;
  update(
    id: string,
    version: number,
    changes: BotChanges,
    key?: string,
  ): Promise<Bot>;
  /**
   * Soft delete: the Bot stops running and leaves every roster; its history stays readable. With
   * `version`, refused (BotVersionConflictError) when the Bot changed since that version.
   */
  remove(id: string, key?: string, version?: number): Promise<Bot>;
  restore(id: string, key?: string): Promise<Bot>;
  /** Delete for good. The purge listeners run here and on every other instance. */
  purge(id: string, key?: string): Promise<void>;
  /** Read the whole set again. */
  resync(): Promise<void>;
  onPurged(listener: (id: string) => Promise<void> | void): () => void;
  /** The registry itself, for the few callers that need a filter the cache does not answer. */
  registry: AgentRegistryClient;
};

/** Well inside the hour the gateway keeps a join code alive for; every full read renews it. */
const RESYNC_INTERVAL_MS = 15 * 60 * 1_000;
/** How long a miss is remembered, so a lookup of an id that does not exist does not hit Intelligence every time. */
const MISS_TTL_MS = 2_000;

export function createBotDirectory(options: {
  registry: AgentRegistryClient;
  /** The gateway address the runtime is configured with. Absent: no announcements, timer only. */
  gatewayWsUrl?: string;
  resyncIntervalMs?: number;
  /** How announcements are subscribed to. The gateway's, unless a test drives them itself. */
  subscribe?: typeof subscribeToBotChanges;
}): BotDirectory {
  const { registry } = options;
  const bots = new Map<string, Bot>();
  /** When each Bot was last confirmed by Intelligence, so a full read can tell a purge from a newcomer. */
  const seenAt = new Map<string, number>();
  /** Ids purged, and when, so a full read that started before the purge does not bring one back. */
  const purgedAt = new Map<string, number>();
  const misses = new Map<string, number>();
  const inFlight = new Map<string, Promise<Bot | null>>();
  const purgeListeners = new Set<(id: string) => Promise<void> | void>();
  let subscription: BotChangeSubscription | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resyncing: Promise<void> | undefined;
  let resyncAgain = false;

  const apply = (bot: Bot, confirmedAt = Date.now()): Bot => {
    const purged = purgedAt.get(bot.id);
    if (purged !== undefined && purged > confirmedAt) {
      return bot;
    }
    purgedAt.delete(bot.id);
    misses.delete(bot.id);
    const held = bots.get(bot.id);
    seenAt.set(bot.id, Math.max(seenAt.get(bot.id) ?? 0, confirmedAt));
    if (held && held.version > bot.version) return held;
    bots.set(bot.id, bot);
    return bot;
  };

  const forget = async (id: string, always = false) => {
    const had = always || bots.has(id);
    bots.delete(id);
    seenAt.delete(id);
    purgedAt.set(id, Date.now());
    if (!had) return;
    for (const listener of purgeListeners) {
      try {
        await listener(id);
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "bot-purge-cleanup-failed",
            botId: id,
            note: "The Bot is gone from Intelligence; rows here that named it were not all removed. The next boot's sweep retries.",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };

  const rememberMiss = (key: string) => {
    const now = Date.now();
    // Kept small: an entry only matters for a couple of seconds.
    if (misses.size > 5_000)
      for (const [held, until] of misses) if (until <= now) misses.delete(held);
    misses.set(key, now + MISS_TTL_MS);
  };

  const readThrough = (id: string): Promise<Bot | null> => {
    const pending = inFlight.get(id);
    if (pending) return pending;
    const startedAt = Date.now();
    const read = registry
      .get(id)
      .then((bot) => {
        if (bot) return apply(bot, startedAt);
        rememberMiss(id);
        return null;
      })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, read);
    return read;
  };

  const heard = async (change: BotChange) => {
    try {
      if (change.change === "purged") {
        // Asked again first: an announcement can arrive after the id was made again, and the rows
        // here would then belong to the new Bot. Only an id Intelligence no longer has is cleaned up,
        // and then even when this instance never held it, since the rows are in the shared database.
        const current = await registry.get(change.agentId);
        if (current) {
          apply(current);
          return;
        }
        await forget(change.agentId, true);
        return;
      }
      const held = bots.get(change.agentId);
      if (held && held.version >= change.version) return;
      const bot = await readThrough(change.agentId);
      // Announced and already gone: purged in between, and the purge's own announcement may be lost.
      if (!bot && bots.has(change.agentId)) await forget(change.agentId);
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "bot-change-read-failed",
          botId: change.agentId,
          note: "The next full read picks the change up.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const readAll = async () => {
    const startedAt = Date.now();
    const { bots: everything, joinCode } = await registry.all({
      includeDeleted: true,
    });
    const listed = new Set<string>();
    for (const bot of everything) {
      listed.add(bot.id);
      apply(bot, startedAt);
    }
    // Held, absent from a complete read, and not confirmed since that read began: purged.
    for (const id of [...bots.keys()]) {
      if (listed.has(id)) continue;
      if ((seenAt.get(id) ?? 0) >= startedAt) continue;
      await forget(id);
    }
    const subscribed = subscription?.joinCode();
    if (subscribed && subscribed !== joinCode) {
      // Intelligence rotated the code, or could not say what it is (null: its Redis did not answer).
      // Announcements for a new code never reach the old topic, so subscribe again; a subscription
      // Intelligence cannot mint is retried with backoff.
      subscription?.renew();
    }
  };

  const resync = (): Promise<void> => {
    if (resyncing) {
      resyncAgain = true;
      return resyncing;
    }
    resyncing = (async () => {
      try {
        do {
          resyncAgain = false;
          await readAll();
        } while (resyncAgain);
      } finally {
        resyncing = undefined;
      }
    })();
    return resyncing;
  };

  const directory: BotDirectory = {
    registry,

    async start() {
      if (options.gatewayWsUrl) {
        subscription = (options.subscribe ?? subscribeToBotChanges)({
          client: registry,
          gatewayWsUrl: options.gatewayWsUrl,
          onChange: (change) => {
            void heard(change);
          },
          onJoined: () => {
            resync().catch((error: unknown) =>
              console.warn(
                JSON.stringify({
                  type: "bot-registry-resync-failed",
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            );
          },
        });
      }
      await resync();
      timer = setInterval(() => {
        resync().catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              type: "bot-registry-resync-failed",
              note: "Still serving the Bots this instance last read.",
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }, options.resyncIntervalMs ?? RESYNC_INTERVAL_MS);
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
      subscription?.stop();
    },

    subscribed: () => subscription?.joinCode() != null,

    cached: () => [...bots.values()],
    live: () => [...bots.values()].filter((bot) => bot.deletedAt === null),
    peek: (id) => bots.get(id),

    async find(id) {
      const held = bots.get(id);
      if (held) return held;
      const missedUntil = misses.get(id);
      if (missedUntil !== undefined && missedUntil > Date.now()) return null;
      return readThrough(id);
    },

    async findMany(ids) {
      const found = new Map<string, Bot>();
      await Promise.all(
        [...new Set(ids)].map(async (id) => {
          const bot = await directory.find(id);
          if (bot) found.set(id, bot);
        }),
      );
      return found;
    },

    async refresh(id) {
      const bot = await readThrough(id);
      if (!bot && bots.has(id)) await forget(id);
      return bot;
    },

    async byCallbackTokenHash(hash) {
      for (const bot of bots.values()) {
        if (bot.callbackTokenHash === hash && bot.deletedAt === null)
          return bot;
      }
      // Issued on another instance a moment ago, before its announcement arrived here. A hash that
      // matched nothing is remembered briefly, so a caller presenting a bad token again and again
      // does not turn each attempt into a request to Intelligence.
      const missKey = `token:${hash}`;
      const missedUntil = misses.get(missKey);
      if (missedUntil !== undefined && missedUntil > Date.now()) return null;
      const page = await registry.page({ callbackTokenHash: hash }, null, 1);
      const bot = page.bots[0];
      if (!bot) {
        rememberMiss(missKey);
        return null;
      }
      return apply(bot);
    },

    async create(draft, key = idempotencyKey("create")) {
      return apply(await registry.create(draft, key));
    },

    async update(id, version, changes, key = idempotencyKey("update")) {
      return apply(await registry.update(id, version, changes, key));
    },

    async remove(id, key = idempotencyKey("delete"), version) {
      return apply(await registry.remove(id, key, version));
    },

    async restore(id, key = idempotencyKey("restore")) {
      return apply(await registry.restore(id, key));
    },

    async purge(id, key = idempotencyKey("purge")) {
      await registry.purge(id, key);
      // Cleaned up whether or not this call was the one that removed it: either way it is gone.
      await forget(id, true);
    },

    resync,

    onPurged(listener) {
      purgeListeners.add(listener);
      return () => purgeListeners.delete(listener);
    },
  };
  return directory;
}

let installed: BotDirectory | undefined;

/** Make this the directory every Bot read and write in this process goes through. */
export function installBotDirectory(directory: BotDirectory): BotDirectory {
  installed = directory;
  return directory;
}

/**
 * The Bots, as this process holds them.
 *
 * Throws when nothing installed a directory, rather than answering with no Bots: an empty roster
 * looks like a deployment whose Bots were all deleted, and nothing about it would say why.
 */
export function bots(): BotDirectory {
  if (!installed) {
    throw new Error(
      "No Bot directory is installed. The server installs one at boot (agents/bot-registry); a test installs the one in tests/support/bots.ts.",
    );
  }
  return installed;
}

/** For callers that read a Bot and need to say which one was missing. */
export { BotMissingError };
