import { createHash, randomUUID } from "node:crypto";
import type { Database } from "../db/client";
import type { MemoryCache } from "./cache";
import { lockDefaults, recordOptOut, sourceServerId } from "./defaults";
import {
  type IntelligenceMemory,
  MemoryIntelligenceError,
  memoryIdempotencyKey,
  type WireMemory,
  type WireMemorySource,
} from "./intelligence";
import {
  type FormedMemoryInput,
  formedMemorySchema,
  type ImportedMemory,
  MemoryNotFoundError,
  type MemoryRecord,
  MemoryRefusedError,
  type MemorySource,
  MemoryUnavailableError,
  parseMemoryInput,
  parseMemoryPatch,
  parseMemorySourceInput,
} from "./types";

/**
 * Ids this OpenBot once gave a memory only Intelligence held. Every memory now has its Intelligence id,
 * so the prefix is dropped wherever an old transcript or tab still sends it.
 */
const INTELLIGENCE_ID_PREFIX = "intelligence:";
const INTELLIGENCE_PROVENANCE = "CopilotKit Intelligence";
/** Where a person's own memory came from, when they wrote it. */
const PERSON_PROVENANCE = "You";
/** How long a claimed sync holds its source before another claimant may take it. */
const SYNC_LEASE_MS = 120_000;
/** When a source syncs again after a sync, successful or not. */
const SYNC_INTERVAL_MS = 900_000;
/** How long a known answer about whether semantic recall is on is reused. */
const MODE_TTL_MS = 10 * 60_000;

const bareId = (id: string) =>
  id.startsWith(INTELLIGENCE_ID_PREFIX)
    ? id.slice(INTELLIGENCE_ID_PREFIX.length)
    : id;

const date = (value: string | null | undefined) =>
  value ? new Date(value) : null;

/**
 * A memory OpenBot formed carries who formed it; one with no `formedBy` was written for the person by
 * another app on the same Intelligence project (or by Intelligence itself).
 */
const isOtherApps = (memory: WireMemory) => memory.formedBy === null;

/**
 * Whether a memory another app wrote is one this person sees: what a default Intelligence reader sees,
 * confirmed, switched on, for every agent. OpenBot's own memories are all shown, in every state.
 */
const shown = (memory: WireMemory) =>
  !memory.invalidatedAt &&
  memory.scope === "user" &&
  (!isOtherApps(memory) ||
    (memory.agentId === null &&
      memory.enabled &&
      memory.reviewState !== "unreviewed"));

/** A memory as OpenBot's screens, tools and rules read it. */
export function toMemoryRecord(
  ownerUserId: string,
  memory: WireMemory,
): MemoryRecord {
  const otherApps = isOtherApps(memory);
  const formedBy: MemoryRecord["formedBy"] = otherApps
    ? "intelligence"
    : memory.formedBy === "agent"
      ? "bot"
      : (memory.formedBy as "person" | "import");
  return {
    id: memory.id,
    ownerUserId,
    content: memory.content,
    provenance:
      memory.provenance ??
      (otherApps ? INTELLIGENCE_PROVENANCE : PERSON_PROVENANCE),
    enabled: otherApps ? true : memory.enabled,
    reviewState: otherApps ? "confirmed" : memory.reviewState,
    formedBy,
    formedByAgentId: formedBy === "bot" ? memory.agentId : null,
    sourceId: memory.sourceId,
    externalId: memory.externalId,
    importDigest: memory.contentDigest,
    sourceApp: otherApps ? INTELLIGENCE_PROVENANCE : memory.sourceApp,
    sourceRef: memory.sourceRef,
    sourceLink: memory.sourceLink,
    observedAt: date(memory.observedAt),
    deletedAt: date(memory.invalidatedAt),
    intelligenceMemoryId: memory.id,
    intelligenceDigest: null,
    createdAt: new Date(memory.createdAt),
    updatedAt: new Date(memory.updatedAt),
  };
}

/** A memory source as OpenBot reads it. */
export function toMemorySource(source: WireMemorySource): MemorySource {
  return {
    id: source.id,
    ownerUserId: source.userId,
    agentId: source.agentId ?? "",
    toolRef: source.connectorRef,
    title: source.title,
    args: source.settings,
    enabled: source.enabled,
    syncStatus: source.syncStatus,
    syncError: source.syncError,
    lastSyncAt: date(source.lastSyncAt),
    nextSyncAt: new Date(source.nextSyncAt),
    createdAt: new Date(source.createdAt),
    updatedAt: new Date(source.updatedAt),
  };
}

const newestFirst = (a: { updatedAt: Date }, b: { updatedAt: Date }) =>
  b.updatedAt.getTime() - a.updatedAt.getTime();

/**
 * Whether Intelligence could not be reached or failed, as opposed to refusing: the person is told to
 * try again (503) rather than that the request was wrong.
 */
function unavailable(error: unknown): boolean {
  return (
    error instanceof MemoryIntelligenceError &&
    (error.status === null || error.status >= 500)
  );
}

/**
 * A person's memory, kept in CopilotKit Intelligence: the memories they wrote, imported from an app, or a
 * Bot observed, and the apps they are imported from. Intelligence holds all of it (the words, who formed
 * each, whether it is reviewed or paused, which Bot may see it, the source and record it came from, and
 * forgotten ones as tombstones); OpenBot keeps none of it.
 *
 * Storage is on every Intelligence plan. Semantic recall is Intelligence's paid feature: when it answers in
 * hybrid mode, a search is ranked by it; otherwise a search is OpenBot's own match over the person's words,
 * as it always was without it.
 *
 * Every rule a Bot's recall obeys is applied here, over the person's memories as this instance holds them
 * (`cache.ts`), before anything reaches a Bot: Bot-formed memories only to the Bot that formed them, and
 * only while it still holds the app they were read from; imported ones only through a source this Bot may
 * use; paused ones to no Bot; the person's own, and those another app wrote for them, to every Bot of
 * theirs. Memories another app wrote for the person show here and can be edited or forgotten here.
 */
export function createMemoryStore(
  database: Database,
  options: {
    intelligence: IntelligenceMemory;
    cache: MemoryCache;
    now?: () => number;
  },
) {
  const { intelligence, cache } = options;
  const now = options.now ?? Date.now;
  let semantic: { hybrid: boolean; until: number } | undefined;

  async function person(ownerUserId: string) {
    try {
      return await cache.get(ownerUserId);
    } catch (error) {
      if (unavailable(error)) throw new MemoryUnavailableError();
      throw error;
    }
  }

  /**
   * One live memory of this person's, or not found. An id a content edit has since replaced (a Bot that
   * recalled it before the person edited it, a tab not yet refreshed) still finds the memory it became.
   */
  async function memoryOf(ownerUserId: string, id: string) {
    const memories = (await person(ownerUserId)).memories;
    const held = memories.find((entry) => entry.id === bareId(id));
    if (held && shown(held)) return held;
    let next: string | null | undefined = bareId(id);
    for (let hop = 0; next && hop < 20; hop++) {
      const memory = await write(() =>
        intelligence.getMemory(ownerUserId, next as string),
      );
      if (!memory) break;
      if (!memory.invalidatedAt) {
        if (!shown(memory)) break;
        cache.invalidate(ownerUserId);
        return memory;
      }
      next = memory.supersededBy;
    }
    throw new MemoryNotFoundError();
  }

  /** A source read fresh from Intelligence, when it is this person's. */
  async function freshSource(ownerUserId: string, id: string) {
    const source = await intelligence.getSource(id);
    if (!source || source.userId !== ownerUserId)
      throw new MemoryNotFoundError();
    return source;
  }

  /**
   * A change to a source at the version just read, read again and redone when somebody else changed it
   * first. `decide` sees the current source and returns the change, or null to make none.
   */
  async function changeSource(
    ownerUserId: string,
    id: string,
    decide: (
      source: WireMemorySource,
    ) => Parameters<IntelligenceMemory["updateSource"]>[1] | null,
    attempts = 3,
  ): Promise<WireMemorySource | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const source = await freshSource(ownerUserId, id);
      const patch = decide(source);
      if (!patch) return null;
      const result = await intelligence.updateSource(id, patch, source.version);
      if (result === null) throw new MemoryNotFoundError();
      if (result === "stale") continue;
      cache.putSource(result);
      return result;
    }
    return null;
  }

  async function write<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (unavailable(error)) throw new MemoryUnavailableError();
      throw error;
    }
  }

  /**
   * The memories a Bot may recall, best first. Bot-formed memories go only to the Bot that formed them,
   * and only while it still holds their source app; imported ones only through a source this Bot may use;
   * the person's own, and those another app wrote for them, to every Bot of theirs. Paused ones to none.
   */
  function eligible(
    memories: WireMemory[],
    ownerUserId: string,
    eligibleSourceIds: string[],
    formed: { botId: string; heldServerIds: ReadonlySet<string> } | undefined,
  ): MemoryRecord[] {
    const sources = new Set(eligibleSourceIds);
    return memories
      .filter(shown)
      .map((memory) => toMemoryRecord(ownerUserId, memory))
      .filter((memory) => {
        if (!memory.enabled) return false;
        if (memory.formedBy === "bot")
          return (
            !!formed &&
            memory.formedByAgentId === formed.botId &&
            (memory.sourceRef === null ||
              formed.heldServerIds.has(memory.sourceRef.split("/")[0] ?? ""))
          );
        return memory.sourceId === null || sources.has(memory.sourceId);
      });
  }

  return {
    async list(ownerUserId: string): Promise<MemoryRecord[]> {
      return (await person(ownerUserId)).memories
        .filter(shown)
        .map((memory) => toMemoryRecord(ownerUserId, memory))
        .sort(newestFirst)
        .slice(0, 500);
    },
    async create(ownerUserId: string, input: unknown): Promise<MemoryRecord> {
      const parsed = parseMemoryInput(input);
      // Named here, so a retry after a lost answer is the same memory, never a second.
      const id = randomUUID();
      const memory = await write(() =>
        intelligence.createMemory(
          ownerUserId,
          {
            id,
            content: parsed.content,
            provenance: parsed.provenance,
            enabled: parsed.enabled,
            reviewState: "confirmed",
            formedBy: "person",
          },
          memoryIdempotencyKey(`create:${id}`),
        ),
      );
      cache.putMemory(ownerUserId, memory);
      return toMemoryRecord(ownerUserId, memory);
    },
    /**
     * A memory a Bot formed from something it observed, awaiting the person's review.
     *
     * Deduplicated on content per Bot, since each Bot is given only the memories it formed itself: a
     * second Bot forming the same fact keeps its own. Forgetting is the person's, so a fact they forgot
     * from any Bot stays forgotten, even when a Bot reads the same record again tomorrow. Intelligence
     * decides both, race-safe: a forgotten fact from any Bot first, then this Bot's own.
     */
    async formMemory(ownerUserId: string, input: FormedMemoryInput) {
      const parsed = formedMemorySchema.safeParse({
        content: input.content,
        sourceApp: input.sourceApp,
        ...(input.sourceLink ? { sourceLink: input.sourceLink } : {}),
        ...(input.observedAt ? { observedAt: input.observedAt } : {}),
      });
      if (!parsed.success)
        throw new MemoryRefusedError(
          parsed.error.issues[0]?.message ?? "Invalid memory.",
        );
      const digest = createHash("sha256")
        .update(parsed.data.content.toLocaleLowerCase())
        .digest("hex");
      const observedAt = parsed.data.observedAt ?? new Date(now());
      const memory = await write(() =>
        intelligence.createMemory(ownerUserId, {
          content: parsed.data.content,
          provenance:
            `${parsed.data.sourceApp}${parsed.data.sourceLink ? ` (${parsed.data.sourceLink})` : ""}, observed ${observedAt.toISOString()}`.slice(
              0,
              500,
            ),
          reviewState: "unreviewed",
          formedBy: "agent",
          agentId: input.agentId,
          contentDigest: digest,
          sourceApp: parsed.data.sourceApp,
          sourceRef: input.sourceRef ?? null,
          sourceLink: parsed.data.sourceLink ?? null,
          observedAt: observedAt.toISOString(),
        }),
      );
      cache.putMemory(ownerUserId, memory);
      return {
        id: memory.id,
        duplicate: memory.duplicate === true,
        forgotten: !!memory.invalidatedAt,
      };
    },
    async update(
      ownerUserId: string,
      id: string,
      input: unknown,
    ): Promise<MemoryRecord> {
      const patch = parseMemoryPatch(input);
      const current = await memoryOf(ownerUserId, id);
      if (isOtherApps(current)) {
        // Another app's memory: its words can change here, but OpenBot does not pause or review it.
        if (patch.enabled !== undefined)
          throw new MemoryRefusedError(
            "A memory kept in CopilotKit Intelligence can be edited or forgotten, not paused.",
          );
        if (!patch.content) return toMemoryRecord(ownerUserId, current);
      }
      const changed = await write(() =>
        intelligence.updateMemory(
          ownerUserId,
          current.id,
          isOtherApps(current)
            ? { content: patch.content }
            : {
                ...(patch.content ? { content: patch.content } : {}),
                ...(patch.enabled === undefined
                  ? {}
                  : { enabled: patch.enabled }),
                // A person's words over an imported or observed fact are theirs: an edit marks it so,
                // and the next import leaves them.
                ...(patch.content
                  ? { reviewState: "edited" as const }
                  : patch.reviewState
                    ? { reviewState: patch.reviewState }
                    : {}),
              },
        ),
      );
      if (!changed) {
        cache.invalidate(ownerUserId);
        throw new MemoryNotFoundError();
      }
      cache.putMemory(ownerUserId, changed, changed.retiredId);
      return toMemoryRecord(ownerUserId, changed);
    },
    async remove(ownerUserId: string, id: string) {
      const current = await memoryOf(ownerUserId, id);
      // A forgotten memory OpenBot formed stays as a blank tombstone, so the next sync cannot resurrect
      // an imported fact the person deleted and no Bot forms it again. Another app's is retired as that
      // app would.
      const done = await write(() =>
        intelligence.forgetMemory(ownerUserId, current.id, {
          erase: !isOtherApps(current),
        }),
      );
      cache.dropMemory(ownerUserId, current.id);
      if (!done) throw new MemoryNotFoundError();
    },
    async sources(ownerUserId: string): Promise<MemorySource[]> {
      return (await person(ownerUserId)).sources
        .map(toMemorySource)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },
    async getSource(ownerUserId: string, id: string): Promise<MemorySource> {
      return toMemorySource(await write(() => freshSource(ownerUserId, id)));
    },
    async createSource(
      ownerUserId: string,
      input: unknown,
    ): Promise<MemorySource> {
      const parsed = parseMemorySourceInput(input);
      const id = randomUUID();
      const source = await write(() =>
        intelligence.createSource(
          {
            id,
            userId: ownerUserId,
            agentId: parsed.agentId,
            connectorRef: parsed.toolRef,
            title: parsed.title,
            settings: parsed.args,
          },
          memoryIdempotencyKey(`create-source:${id}`),
        ),
      );
      cache.putSource(source);
      return toMemorySource(source);
    },
    async setSourceEnabled(ownerUserId: string, id: string, enabled: boolean) {
      const source = await write(() =>
        changeSource(ownerUserId, id, () => ({
          enabled,
          nextSyncAt: new Date(now()).toISOString(),
        })),
      );
      if (!source) throw new MemoryUnavailableError();
      return toMemorySource(source);
    },
    /**
     * Remove a source, and with it every memory imported from it. Removing a source is turning that app
     * down for this Bot: OpenBot never adds it back. The turn-down is recorded FIRST, under the lock
     * adoption takes, and committed; only then is the source deleted in Intelligence. Adoption reads the
     * sources before the turn-downs, so whichever it sees, it does not add the app back (defaults.ts).
     */
    async removeSource(ownerUserId: string, id: string) {
      const source = await write(() => freshSource(ownerUserId, id));
      await database.transaction(async (transaction) => {
        await lockDefaults(transaction, ownerUserId, source.agentId ?? "");
        await recordOptOut(transaction, {
          ownerUserId,
          agentId: source.agentId ?? "",
          feature: "memory_source",
          scope: sourceServerId(source.connectorRef),
        });
      });
      const deleted = await write(() => intelligence.deleteSource(id));
      cache.dropSource(ownerUserId, id);
      if (!deleted) throw new MemoryNotFoundError();
    },
    /** This person's sources for one Bot, read fresh from Intelligence (not this instance's copy). */
    async sourcesFor(
      ownerUserId: string,
      agentId: string,
    ): Promise<MemorySource[]> {
      return (await intelligence.sources({ userId: ownerUserId, agentId })).map(
        toMemorySource,
      );
    },
    /**
     * Switch on the source OpenBot picked for one app by default. Its id is made from the person, the Bot
     * and the app, so two instances adopting the same default at once make one source, not two. Null when
     * that id already names a different source (the person's own, made since).
     */
    async adoptSource(
      ownerUserId: string,
      agentId: string,
      candidate: { serverId: string; toolRef: string; title: string },
    ): Promise<MemorySource | null> {
      const id = `default-${createHash("sha256")
        .update(`${ownerUserId}\n${agentId}\n${candidate.serverId}`)
        .digest("hex")
        .slice(0, 40)}`;
      try {
        const source = await intelligence.createSource(
          {
            id,
            userId: ownerUserId,
            agentId,
            connectorRef: candidate.toolRef,
            title: candidate.title,
            settings: {},
          },
          // A fresh key: the same default made again after a reset is a new source, not a replay. Two
          // instances adopting it at once meet on the id instead.
          memoryIdempotencyKey("adopt-source"),
        );
        cache.putSource(source);
        return toMemorySource(source);
      } catch (error) {
        if (
          error instanceof MemoryIntelligenceError &&
          error.code === "MEMORY_SOURCE_ALREADY_EXISTS"
        )
          return null;
        throw error;
      }
    },
    /** Sources due to sync, across everyone. Background work: read from Intelligence. */
    async dueSources(limit = 5): Promise<MemorySource[]> {
      const due = await intelligence.sources({
        enabled: true,
        dueBefore: new Date(now()),
        limit: Math.min(limit, 10),
      });
      return due.map(toMemorySource);
    },
    /**
     * Claim a source's sync: switched on, and not already running unless its lease ran out. Of two
     * claimants only one succeeds (Intelligence refuses the other's stale version).
     */
    async claimSync(
      ownerUserId: string,
      id: string,
    ): Promise<MemorySource | null> {
      const at = now();
      const source = await freshSource(ownerUserId, id).catch((error) => {
        if (error instanceof MemoryNotFoundError) return null;
        throw error;
      });
      if (
        !source?.enabled ||
        (source.syncStatus === "running" &&
          new Date(source.nextSyncAt).getTime() > at)
      )
        return null;
      const claimed = await intelligence.updateSource(
        id,
        {
          syncStatus: "running",
          nextSyncAt: new Date(at + SYNC_LEASE_MS).toISOString(),
        },
        source.version,
      );
      if (!claimed || claimed === "stale") return null;
      cache.putSource(claimed);
      return toMemorySource(claimed);
    },
    async failSync(ownerUserId: string, id: string, error: string) {
      await changeSource(ownerUserId, id, () => ({
        syncStatus: "error",
        syncError: error.slice(0, 500),
        nextSyncAt: new Date(now() + SYNC_INTERVAL_MS).toISOString(),
      })).catch((failure) => {
        if (failure instanceof MemoryNotFoundError) return null;
        throw failure;
      });
    },
    /**
     * Bring in what a sync read. Intelligence upserts each record by its id in the source: a new one is
     * imported unreviewed, an unchanged one is left, and a changed one is refreshed unless the person
     * edited or forgot it (whose words stay; its provenance is refreshed).
     */
    async completeSync(
      ownerUserId: string,
      sourceId: string,
      records: ImportedMemory[],
    ) {
      const source = await freshSource(ownerUserId, sourceId);
      if (!source.enabled) throw new MemoryNotFoundError();
      const observedAt = new Date(now()).toISOString();
      const results = await intelligence.importRecords(
        ownerUserId,
        sourceId,
        records.map((record) => ({
          externalId: record.externalId,
          content: record.content,
          contentDigest: record.digest,
          provenance: `${source.title}: ${record.provenance}`.slice(0, 1000),
          sourceApp: source.title,
          sourceRef: source.connectorRef,
          observedAt,
        })),
        { reviewState: "unreviewed" },
      );
      if (!results) throw new MemoryNotFoundError();
      await changeSource(ownerUserId, sourceId, () => ({
        syncStatus: "succeeded",
        syncError: null,
        lastSyncAt: new Date(now()).toISOString(),
        nextSyncAt: new Date(now() + SYNC_INTERVAL_MS).toISOString(),
      }));
      // What was imported reaches this instance's copy on the person's next turn.
      cache.invalidate(ownerUserId);
    },
    async retrieve(
      ownerUserId: string,
      eligibleSourceIds: string[],
      search = "",
      /**
       * The Bot asking and the app servers it currently holds. Bot-formed memories are returned only to
       * the Bot that formed them, and only while it still holds their source app; without this argument
       * none are returned.
       */
      formed?: { botId: string; heldServerIds: ReadonlySet<string> },
    ): Promise<MemoryRecord[]> {
      const term = search.trim().toLocaleLowerCase();
      const allowed = eligible(
        (await person(ownerUserId)).memories,
        ownerUserId,
        eligibleSourceIds,
        formed,
      );
      // OpenBot's own first, newest first, then up to 20 another app wrote for the person.
      const own = allowed
        .filter((memory) => memory.formedBy !== "intelligence")
        .sort(newestFirst);
      const others = allowed
        .filter((memory) => memory.formedBy === "intelligence")
        .sort(newestFirst);
      if (!term)
        return [...own.slice(0, 40), ...others.slice(0, 20)].slice(0, 40);
      const matching = [...own, ...others].filter((memory) =>
        memory.content.toLocaleLowerCase().includes(term),
      );
      /*
       * Ranked by Intelligence when it recalls semantically, filtered by these rules: a recalled memory
       * reaches this Bot only if this Bot may recall it. The word matches follow, for anything recall
       * missed. Without semantic recall, the word matches alone, as before.
       */
      const ranked: MemoryRecord[] = [];
      if (!semantic || semantic.until <= now() || semantic.hybrid) {
        try {
          const recalled = await intelligence.recall(ownerUserId, term, {
            limit: 20,
            ...(formed ? { agentId: formed.botId } : {}),
          });
          semantic = {
            hybrid: recalled.mode === "hybrid",
            until: now() + MODE_TTL_MS,
          };
          if (recalled.mode === "hybrid") {
            const byId = new Map(allowed.map((memory) => [memory.id, memory]));
            for (const memory of recalled.memories) {
              const record = byId.get(memory.id);
              if (record) ranked.push(record);
            }
          }
        } catch (error) {
          // Recall ranks; the word matches still answer without it.
          semantic = { hybrid: false, until: now() + 60_000 };
          console.warn(
            JSON.stringify({
              type: "memory-recall-error",
              error: error instanceof Error ? error.message : String(error),
              timestamp: new Date(now()).toISOString(),
            }),
          );
        }
      }
      const seen = new Set(ranked.map((memory) => memory.id));
      return [
        ...ranked,
        ...matching.filter((memory) => !seen.has(memory.id)),
      ].slice(0, 40);
    },
    /**
     * Remove a person's memory for good, when OpenBot removes the person: their sources (and what they
     * imported) and every memory of theirs. The old tables' foreign keys took these with the person.
     */
    async forgetPerson(ownerUserId: string) {
      await intelligence.purgeSources({ userId: ownerUserId });
      await intelligence.purgePerson(ownerUserId);
      cache.forget(ownerUserId);
    },
    /**
     * Remove a Bot's memory for good, when the Bot is purged: the sources bound to it (and what they
     * imported) and every memory it formed, for everyone.
     */
    async forgetBot(botId: string) {
      await intelligence.purgeSources({ agentId: botId });
      await intelligence.purgeAgent(botId);
      cache.forget();
    },
    /**
     * What resetting one Bot for one person removes of their memory: its sources (with the memories they
     * imported) and the memories it formed itself. Read from Intelligence, not this instance's copy.
     */
    async botResetPlan(ownerUserId: string, agentId: string) {
      const [sources, memories] = await Promise.all([
        intelligence.sources({ userId: ownerUserId, agentId }),
        intelligence.allMemories(ownerUserId),
      ]);
      const sourceIds = new Set(sources.map((source) => source.id));
      return {
        sources: sources.map(toMemorySource),
        importedMemories: memories.filter(
          (memory) =>
            memory.sourceId !== null &&
            sourceIds.has(memory.sourceId) &&
            !memory.invalidatedAt,
        ).length,
        formedMemoryIds: memories
          .filter(
            (memory) =>
              memory.formedBy === "agent" &&
              memory.agentId === agentId &&
              memory.sourceId === null &&
              !memory.invalidatedAt,
          )
          .map((memory) => memory.id),
      };
    },
    /** Carry out {@link botResetPlan}'s removals in Intelligence. */
    async resetBot(
      ownerUserId: string,
      plan: { sources: MemorySource[]; formedMemoryIds: string[] },
    ) {
      for (const source of plan.sources)
        await intelligence.deleteSource(source.id);
      let formed = 0;
      for (const id of plan.formedMemoryIds)
        if (await intelligence.forgetMemory(ownerUserId, id, { purge: true }))
          formed += 1;
      cache.forget(ownerUserId);
      return formed;
    },
  };
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;
