/**
 * A person's memories and memory sources, held in memory on this instance.
 *
 * `contextFor` and `retrieve` run on every turn, so they read from here, never from Intelligence. An entry is
 * a person's live memories (every review state, switched on or off, for every Bot) and their sources, read
 * from Intelligence when first asked for and kept until:
 *
 * - Intelligence announces a change to that person's memory or sources (`memory_changes`), which this
 *   instance did not make itself: the next read waits for a fresh copy. An announcement for a version this
 *   instance already holds is its own write coming back, and changes nothing.
 * - The subscription joins again after a drop: announcements made meanwhile were missed, so every entry is
 *   read again on its next use.
 * - The entry is older than the refresh interval: a timer of its own, as delivery is at most once.
 *
 * A write this instance makes is applied to the entry as Intelligence answers it, so the person's next turn
 * here sees it at once.
 */
import {
  type ProjectChange,
  type ProjectChangeSubscription,
  type ProjectChangesClient,
  subscribeToProjectChanges,
} from "../intelligence/project-changes";
import type {
  IntelligenceMemory,
  WireMemory,
  WireMemorySource,
} from "./intelligence";

/** How long an entry is served before it is read again regardless of announcements. */
const REFRESH_MS = 5 * 60_000;
/** How many people's entries one instance keeps. The least recently read go first. */
const MAX_PEOPLE = 2_000;

export type PersonMemory = {
  memories: WireMemory[];
  sources: WireMemorySource[];
};

type Entry = {
  memories: Map<string, WireMemory>;
  sources: Map<string, WireMemorySource>;
  loadedAt: number;
  stale: boolean;
};

/** One `memory_changes` announcement, as the contract states it. */
export type MemoryChange = {
  entity: "memory" | "source";
  userId: string | null;
  id: string;
  version: number;
  change: string;
};

/** The family's fields, or null for anything this OpenBot does not know. */
export function parseMemoryChange(
  change: Record<string, unknown>,
): MemoryChange | null {
  const { entity, userId, id, version } = change;
  if (entity !== "memory" && entity !== "source") return null;
  if (typeof id !== "string" || typeof version !== "number") return null;
  return {
    entity,
    userId: typeof userId === "string" ? userId : null,
    id,
    version,
    change: typeof change.change === "string" ? change.change : "updated",
  };
}

export type MemoryCache = ReturnType<typeof createMemoryCache>;

export function createMemoryCache(options: {
  intelligence: Pick<IntelligenceMemory, "allMemories" | "sources">;
  /** Intelligence's change feed. Without it, entries refresh on the timer and after local writes only. */
  changes?: {
    client: Pick<ProjectChangesClient, "subscribe" | "joinCode">;
    gatewayWsUrl: string;
    subscribe?: typeof subscribeToProjectChanges;
  };
  refreshMs?: number;
  maxPeople?: number;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  const maxPeople = options.maxPeople ?? MAX_PEOPLE;
  const entries = new Map<string, Entry>();
  const loading = new Map<string, Promise<Entry>>();
  /** Bumped by every announcement for a person, so a read that raced one is known to be stale. */
  const generations = new Map<string, number>();
  const generation = (userId: string) => generations.get(userId) ?? 0;
  let subscription: ProjectChangeSubscription | undefined;
  let joined = false;

  async function load(userId: string): Promise<Entry> {
    const pending = loading.get(userId);
    if (pending) return pending;
    const run = (async () => {
      const startedAt = generation(userId);
      const [memories, sources] = await Promise.all([
        options.intelligence.allMemories(userId),
        options.intelligence.sources({ userId }),
      ]);
      const entry: Entry = {
        memories: new Map(memories.map((memory) => [memory.id, memory])),
        sources: new Map(sources.map((source) => [source.id, source])),
        loadedAt: now(),
        // An announcement arrived while this was read: what was read may predate it.
        stale: generation(userId) !== startedAt,
      };
      // Most recently read last, so the oldest are first to go.
      entries.delete(userId);
      entries.set(userId, entry);
      while (entries.size > maxPeople) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return entry;
    })();
    loading.set(userId, run);
    try {
      return await run;
    } finally {
      if (loading.get(userId) === run) loading.delete(userId);
    }
  }

  async function entryFor(userId: string): Promise<Entry> {
    const entry = entries.get(userId);
    if (entry && !entry.stale && now() - entry.loadedAt < refreshMs) {
      entries.delete(userId);
      entries.set(userId, entry);
      return entry;
    }
    return load(userId);
  }

  function onChange(change: MemoryChange) {
    if (!change.userId) return;
    const entry = entries.get(change.userId);
    if (!entry) {
      if (loading.has(change.userId))
        generations.set(change.userId, generation(change.userId) + 1);
      return;
    }
    const held =
      change.entity === "memory"
        ? entry.memories.get(change.id)
        : entry.sources.get(change.id);
    const gone =
      change.change === "purged" ||
      change.change === "forgotten" ||
      change.change === "superseded";
    // This instance's own write coming back, or a change to something it no longer holds.
    if (gone ? !held : held && held.version >= change.version) return;
    generations.set(change.userId, generation(change.userId) + 1);
    entry.stale = true;
  }

  return {
    /** The person's live memories and sources. Reads Intelligence only on a miss. */
    async get(userId: string): Promise<PersonMemory> {
      const entry = await entryFor(userId);
      return {
        memories: [...entry.memories.values()],
        sources: [...entry.sources.values()],
      };
    },
    /** A memory this instance wrote, as Intelligence answered it. `retiredId` leaves with it. */
    putMemory(userId: string, memory: WireMemory, retiredId?: string | null) {
      const entry = entries.get(userId);
      if (!entry) return;
      if (retiredId) entry.memories.delete(retiredId);
      if (memory.invalidatedAt) entry.memories.delete(memory.id);
      else entry.memories.set(memory.id, memory);
    },
    dropMemory(userId: string, id: string) {
      entries.get(userId)?.memories.delete(id);
    },
    putSource(source: WireMemorySource) {
      entries.get(source.userId)?.sources.set(source.id, source);
    },
    /** A source this instance deleted; its imported memories went with it. */
    dropSource(userId: string, id: string) {
      const entry = entries.get(userId);
      if (!entry) return;
      entry.sources.delete(id);
      for (const [memoryId, memory] of entry.memories)
        if (memory.sourceId === id) entry.memories.delete(memoryId);
    },
    /** Read this person again on their next use. */
    invalidate(userId: string) {
      const entry = entries.get(userId);
      if (entry) entry.stale = true;
    },
    /** Drop every person: their memory was removed, or everything must be read again. */
    forget(userId?: string) {
      if (userId) {
        entries.delete(userId);
        generations.delete(userId);
      } else {
        entries.clear();
        generations.clear();
      }
    },
    onChange,
    /** Subscribe to `memory_changes`. Every join marks every entry for a fresh read. */
    start() {
      if (subscription || !options.changes) return;
      subscription = (options.changes.subscribe ?? subscribeToProjectChanges)({
        resource: "memory_changes",
        client: options.changes.client,
        gatewayWsUrl: options.changes.gatewayWsUrl,
        onChange: (change: ProjectChange) => {
          const parsed = parseMemoryChange(change);
          if (parsed) onChange(parsed);
        },
        onJoined: () => {
          joined = true;
          for (const entry of entries.values()) entry.stale = true;
          for (const userId of loading.keys())
            generations.set(userId, generation(userId) + 1);
        },
      });
    },
    stop() {
      subscription?.stop();
      subscription = undefined;
      joined = false;
    },
    /** Whether announcements are arriving. */
    subscribed() {
      return joined && subscription?.joinCode() != null;
    },
  };
}
