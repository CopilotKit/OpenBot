/**
 * The schedule definitions this deployment has, held in memory per server instance and kept fresh
 * from Intelligence: routines, check-in settings and people, responsibilities, their triggers and
 * source bindings. Modelled on the Bot directory (`agents/bot-registry/directory.ts`); read that
 * file's header for the reasoning, which holds here unchanged.
 *
 * WHY A CACHE. The sweeps that fire schedules run on every replica every minute, a turn checks
 * whether its person has check-ins with the Bot, and an inbound webhook finds its trigger. Reading
 * Intelligence for each would put a network round trip under all of them, so each instance holds the
 * whole set of definitions (a deployment's routines, check-ins and responsibilities number in the
 * thousands, not the millions) and reads it from memory. Run history is never held here: it is read
 * from Intelligence when a page asks for it.
 *
 * HOW IT STAYS FRESH, ACROSS REPLICAS. A write made here updates the cache from Intelligence's answer
 * at once, so this instance reads its own writes. Every other instance hears of it from Intelligence's
 * realtime gateway, which announces each change by collection, id and version; the announcement is
 * followed by a read of that one record. Announcements can be lost, so every collection is read again
 * whenever the subscription joins, which includes every reconnect, and on a timer. A miss reads
 * through. Versions order what arrives: an older copy never replaces a newer one.
 *
 * DELETED FOR GOOD. A soft-deleted record stays here with `deletedAt` set. A purged record leaves.
 */
import {
  type ScheduleClient,
  ScheduleNotFoundError,
  scheduleIdempotencyKey,
} from "./client";
import {
  type ScheduleChangeSubscription,
  subscribeToScheduleChanges,
} from "./events";
import {
  ANNOUNCED_COLLECTIONS,
  type AnnouncedCollection,
  type ScheduleChange,
  type ScheduleChanges,
  type ScheduleCollections,
  type ScheduleDraft,
} from "./types";

type Held<C extends AnnouncedCollection> = ScheduleCollections[C];

export type ScheduleDirectory = {
  /** Read every collection and subscribe to changes. Resolves once the first read is complete. */
  start(): Promise<void>;
  stop(): void;
  /** Whether announcements are arriving: the realtime subscription is joined. */
  subscribed(): boolean;
  /** Every record of the collection this instance holds, deleted ones included. Never reaches Intelligence. */
  cached<C extends AnnouncedCollection>(collection: C): Held<C>[];
  /** Every live record of the collection. Never reaches Intelligence. */
  live<C extends AnnouncedCollection>(collection: C): Held<C>[];
  /** From memory only, deleted ones included. For code that must not wait on Intelligence. */
  peek<C extends AnnouncedCollection>(
    collection: C,
    id: string,
  ): Held<C> | undefined;
  /** From memory, reading through to Intelligence on a miss. Deleted records included. */
  find<C extends AnnouncedCollection>(
    collection: C,
    id: string,
  ): Promise<Held<C> | null>;
  /** Read this record from Intelligence now, whatever this instance holds. Null when it is purged. */
  refresh<C extends AnnouncedCollection>(
    collection: C,
    id: string,
  ): Promise<Held<C> | null>;
  /** Take a record Intelligence just answered with (a write's result) into the cache. */
  remember<C extends AnnouncedCollection>(
    collection: C,
    record: Held<C>,
  ): Held<C>;
  create<C extends AnnouncedCollection>(
    collection: C,
    draft: ScheduleDraft<C>,
    key?: string,
  ): Promise<Held<C>>;
  update<C extends AnnouncedCollection>(
    collection: C,
    id: string,
    version: number,
    changes: ScheduleChanges<C>,
    key?: string,
  ): Promise<Held<C>>;
  /** Soft delete. With `version`, refused when the record changed since that version. */
  remove<C extends AnnouncedCollection>(
    collection: C,
    id: string,
    key?: string,
    version?: number,
  ): Promise<Held<C>>;
  /** Delete for good. */
  purge(
    collection: AnnouncedCollection,
    id: string,
    key?: string,
  ): Promise<void>;
  /** The sweep's compare-and-set on a clock; null when another replica moved it first. */
  advance<C extends "routines" | "check-in-settings">(
    collection: C,
    id: string,
    from: Date,
    to: Date,
  ): Promise<Held<C> | null>;
  /** Read every collection again. */
  resync(): Promise<void>;
  /** Hear every change this instance learns of, from its own writes or from another's. */
  onChange(
    listener: (collection: AnnouncedCollection, id: string) => void,
  ): () => void;
  /** Intelligence itself, for the history and for filters the cache does not answer. */
  client: ScheduleClient;
};

/** Well inside the hour the gateway keeps a join code alive for; every full read renews it. */
const RESYNC_INTERVAL_MS = 15 * 60 * 1_000;
/** How long a miss is remembered, so a lookup of an id that does not exist does not hit Intelligence every time. */
const MISS_TTL_MS = 2_000;

const ANNOUNCED: ReadonlySet<string> = new Set(ANNOUNCED_COLLECTIONS);

type AnyHeld = Held<AnnouncedCollection>;

export function createScheduleDirectory(options: {
  client: ScheduleClient;
  /** The gateway address the runtime is configured with. Absent: no announcements, timer only. */
  gatewayWsUrl?: string;
  resyncIntervalMs?: number;
  subscribe?: typeof subscribeToScheduleChanges;
}): ScheduleDirectory {
  const { client } = options;
  const held = new Map<AnnouncedCollection, Map<string, AnyHeld>>(
    ANNOUNCED_COLLECTIONS.map((collection) => [collection, new Map()]),
  );
  /** When each record was last confirmed by Intelligence, so a full read can tell a purge from a newcomer. */
  const seenAt = new Map<string, number>();
  /** Records purged, and when, so a full read that started before the purge does not bring one back. */
  const purgedAt = new Map<string, number>();
  const misses = new Map<string, number>();
  const inFlight = new Map<string, Promise<AnyHeld | null>>();
  const listeners = new Set<
    (collection: AnnouncedCollection, id: string) => void
  >();
  let subscription: ScheduleChangeSubscription | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let resyncing: Promise<void> | undefined;
  let resyncAgain = false;

  const keyOf = (collection: string, id: string) => `${collection}\u001f${id}`;
  const table = <C extends AnnouncedCollection>(collection: C) =>
    held.get(collection) as Map<string, Held<C>>;

  const announce = (collection: AnnouncedCollection, id: string) => {
    for (const listener of listeners) {
      try {
        listener(collection, id);
      } catch (error) {
        console.warn(
          JSON.stringify({
            type: "schedule-change-listener-failed",
            collection,
            id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
  };

  const apply = <C extends AnnouncedCollection>(
    collection: C,
    record: Held<C>,
    confirmedAt = Date.now(),
  ): Held<C> => {
    const key = keyOf(collection, record.id);
    const purged = purgedAt.get(key);
    if (purged !== undefined && purged > confirmedAt) return record;
    purgedAt.delete(key);
    misses.delete(key);
    seenAt.set(key, Math.max(seenAt.get(key) ?? 0, confirmedAt));
    const current = table(collection).get(record.id);
    if (current && current.version > record.version) return current;
    table(collection).set(record.id, record);
    if (!current || current.version !== record.version)
      announce(collection, record.id);
    return record;
  };

  const forget = (collection: AnnouncedCollection, id: string) => {
    const key = keyOf(collection, id);
    const had = table(collection).delete(id);
    seenAt.delete(key);
    purgedAt.set(key, Date.now());
    if (had) announce(collection, id);
  };

  const rememberMiss = (key: string) => {
    const now = Date.now();
    if (misses.size > 5_000)
      for (const [name, until] of misses) if (until <= now) misses.delete(name);
    misses.set(key, now + MISS_TTL_MS);
  };

  const readThrough = <C extends AnnouncedCollection>(
    collection: C,
    id: string,
  ): Promise<Held<C> | null> => {
    const key = keyOf(collection, id);
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<Held<C> | null>;
    const startedAt = Date.now();
    const read = client
      .get(collection, id)
      .then((record) => {
        if (record) return apply(collection, record as Held<C>, startedAt);
        rememberMiss(key);
        return null;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, read as Promise<AnyHeld | null>);
    return read;
  };

  const heard = async (change: ScheduleChange) => {
    if (!ANNOUNCED.has(change.collection)) return;
    const collection = change.collection as AnnouncedCollection;
    try {
      if (change.change === "purged") {
        // Asked again first: an announcement can arrive after the id was made again.
        const current = await client.get(collection, change.id);
        if (current) apply(collection, current as AnyHeld);
        else forget(collection, change.id);
        return;
      }
      const current = table(collection).get(change.id);
      if (current && current.version >= change.version) return;
      const record = await readThrough(collection, change.id);
      if (!record && table(collection).has(change.id))
        forget(collection, change.id);
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "schedule-change-read-failed",
          collection,
          id: change.id,
          note: "The next full read picks the change up.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  const readAll = async () => {
    // Every announced listing names the project's one schedules join code. Null from any of them
    // means Intelligence could not say (its Redis did not answer): treated as a changed code.
    let joinCode: string | null = null;
    let unknown = false;
    for (const collection of ANNOUNCED_COLLECTIONS) {
      const startedAt = Date.now();
      const listing = await client.all(collection, { includeDeleted: true });
      if (listing.joinCode === null) unknown = true;
      else joinCode = listing.joinCode;
      const listed = new Set<string>();
      for (const record of listing.items) {
        listed.add(record.id);
        apply(collection, record as AnyHeld, startedAt);
      }
      // Held, absent from a complete read, and not confirmed since that read began: purged.
      for (const id of [...table(collection).keys()]) {
        if (listed.has(id)) continue;
        if ((seenAt.get(keyOf(collection, id)) ?? 0) >= startedAt) continue;
        forget(collection, id);
      }
    }
    const subscribed = subscription?.joinCode();
    if (subscribed && (unknown || subscribed !== joinCode))
      subscription?.renew();
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

  const resyncLoudly = (note: string) =>
    resync().catch((error: unknown) =>
      console.warn(
        JSON.stringify({
          type: "schedule-directory-resync-failed",
          note,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );

  const directory: ScheduleDirectory = {
    client,

    async start() {
      if (options.gatewayWsUrl) {
        subscription = (options.subscribe ?? subscribeToScheduleChanges)({
          client,
          gatewayWsUrl: options.gatewayWsUrl,
          onChange: (change) => {
            void heard(change);
          },
          onJoined: () => {
            void resyncLoudly("Rejoined; the timer will read again.");
          },
        });
      }
      await resync();
      timer = setInterval(() => {
        void resyncLoudly(
          "Still serving the schedules this instance last read.",
        );
      }, options.resyncIntervalMs ?? RESYNC_INTERVAL_MS);
      timer.unref?.();
    },

    stop() {
      clearInterval(timer);
      subscription?.stop();
    },

    subscribed: () => subscription?.joinCode() != null,

    cached: (collection) => [...table(collection).values()],
    live: (collection) =>
      [...table(collection).values()].filter(
        (record) =>
          !("deletedAt" in record) ||
          (record as { deletedAt: Date | null }).deletedAt === null,
      ),
    peek: (collection, id) => table(collection).get(id),

    async find(collection, id) {
      const current = table(collection).get(id);
      if (current) return current;
      const missedUntil = misses.get(keyOf(collection, id));
      if (missedUntil !== undefined && missedUntil > Date.now()) return null;
      return readThrough(collection, id);
    },

    async refresh(collection, id) {
      const record = await readThrough(collection, id);
      if (!record && table(collection).has(id)) forget(collection, id);
      return record;
    },

    remember: (collection, record) => apply(collection, record),

    async create(
      collection,
      draft,
      key = scheduleIdempotencyKey(`create:${collection}`),
    ) {
      return apply(collection, await client.create(collection, draft, key));
    },

    async update(
      collection,
      id,
      version,
      changes,
      key = scheduleIdempotencyKey(`update:${collection}`),
    ) {
      return apply(
        collection,
        await client.update(collection, id, version, changes, key),
      );
    },

    async remove(
      collection,
      id,
      key = scheduleIdempotencyKey(`delete:${collection}`),
      version,
    ) {
      return apply(
        collection,
        await client.remove(collection, id, key, version),
      );
    },

    async purge(
      collection,
      id,
      key = scheduleIdempotencyKey(`purge:${collection}`),
    ) {
      await client.purge(collection, id, key);
      forget(collection, id);
    },

    async advance(collection, id, from, to) {
      const moved = await client.advance(collection, id, from, to);
      if (moved) return apply(collection, moved);
      // Somebody else moved it, or it is gone: learn which, so the next sweep reads the truth.
      await readThrough(collection, id).catch(() => null);
      return null;
    },

    resync,

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return directory;
}

let installed: ScheduleDirectory | undefined;

/** Make this the directory every schedule read and write in this process goes through. */
export function installScheduleDirectory(
  directory: ScheduleDirectory,
): ScheduleDirectory {
  installed = directory;
  return directory;
}

/**
 * The schedule definitions, as this process holds them.
 *
 * Throws when nothing installed a directory, rather than answering with none: an empty set looks like
 * a deployment whose routines were all deleted, and nothing about it would say why.
 */
export function schedules(): ScheduleDirectory {
  if (!installed) {
    throw new Error(
      "No schedule directory is installed. The server installs one at boot (schedules/directory.ts); a test installs the one in tests/support/schedules.ts.",
    );
  }
  return installed;
}

export { ScheduleNotFoundError };
