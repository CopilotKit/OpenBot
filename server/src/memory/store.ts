import { createHash, randomUUID } from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "../db/client";
import { memorySources, personalMemories } from "../db/schema/memory";
import { lockDefaults, recordOptOut, sourceServerId } from "./defaults";
import type {
  IntelligenceMemory,
  IntelligenceMemoryRecord,
} from "./intelligence";
import {
  type FormedMemoryInput,
  formedMemorySchema,
  type ImportedMemory,
  MemoryNotFoundError,
  type MemoryRecord,
  MemoryRefusedError,
  MemoryUnavailableError,
  parseMemoryInput,
  parseMemoryPatch,
  parseMemorySourceInput,
} from "./types";

/**
 * The id a memory gets in OpenBot when only Intelligence holds it. Prefixed so the routes can tell
 * it from an OpenBot row id without a lookup, and so it can never collide with one.
 */
const INTELLIGENCE_ID_PREFIX = "intelligence:";
const INTELLIGENCE_PROVENANCE = "CopilotKit Intelligence";

const digestOf = (content: string) =>
  createHash("sha256").update(content).digest("hex");

/**
 * What Intelligence should hold: a live, switched-on memory the person has accepted.
 *
 * A Bot-formed or imported memory waits for the person's review before it leaves OpenBot, and a
 * paused or forgotten one is retired from Intelligence, because Intelligence has no field for
 * "paused" and anything else reading the person's Intelligence memory would otherwise see it.
 */
// Parenthesised: drizzle's `not()` does not wrap a raw fragment, so without them `not(mirrorEligible)`
// negated only its first clause.
const mirrorEligible = sql`(${personalMemories.deletedAt} IS NULL AND ${personalMemories.enabled} AND ${personalMemories.reviewState} IN ('confirmed', 'edited') AND ${personalMemories.content} <> '')`;
const contentDigest = sql`encode(sha256(convert_to(${personalMemories.content}, 'UTF8')), 'hex')`;

type MemoryRow = typeof personalMemories.$inferSelect;
const isMirrorEligible = (row: MemoryRow) =>
  row.deletedAt === null &&
  row.enabled &&
  (row.reviewState === "confirmed" || row.reviewState === "edited") &&
  row.content !== "";

function fromIntelligence(
  ownerUserId: string,
  memory: IntelligenceMemoryRecord,
): MemoryRecord {
  const now = new Date();
  return {
    id: `${INTELLIGENCE_ID_PREFIX}${memory.id}`,
    ownerUserId,
    content: memory.content,
    provenance: INTELLIGENCE_PROVENANCE,
    enabled: true,
    reviewState: "confirmed",
    formedBy: "intelligence",
    formedByAgentId: null,
    sourceId: null,
    externalId: null,
    importDigest: null,
    sourceApp: INTELLIGENCE_PROVENANCE,
    sourceRef: null,
    sourceLink: null,
    observedAt: null,
    deletedAt: null,
    intelligenceMemoryId: memory.id,
    intelligenceDigest: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A person's memory: CopilotKit Intelligence when this deployment is entitled to it, OpenBot's own
 * tables when it is not.
 *
 * When Intelligence memory is available, it holds the content and does the recall, and every memory
 * the person has accepted is mirrored there. The OpenBot row stays as the record of what Intelligence
 * has no field for: where a memory came from, whether it is reviewed or paused, which Bot formed it
 * and which source it was imported from. Those decide which Bot may see a memory, so every rule a
 * Bot's recall obeys is still applied here, over the rows, before anything Intelligence returns
 * reaches a Bot. Memories Intelligence holds for the person that no row describes (formed by another
 * app on the project, or by Intelligence) are read back as the person's own, the way a memory the
 * person wrote is.
 *
 * Without Intelligence memory, nothing here calls the platform, and the store behaves exactly as it
 * did before: the tables are the whole store. Losing Intelligence mid-flight (a lapsed licence, an
 * outage) falls back to the tables rather than failing; a memory that lives only in Intelligence is
 * the one thing the tables cannot stand in for, and editing or forgetting one then answers 503.
 */
export function createMemoryStore(
  database: Database,
  options: { intelligence?: IntelligenceMemory } = {},
) {
  const { intelligence } = options;
  /** One mirror pass per person at a time in this process, so two writes cannot both create. */
  const mirroring = new Map<string, Promise<unknown>>();

  const getSource = async (ownerUserId: string, id: string) => {
    const [row] = await database
      .select()
      .from(memorySources)
      .where(
        and(
          eq(memorySources.id, id),
          eq(memorySources.ownerUserId, ownerUserId),
        ),
      );
    if (!row) throw new MemoryNotFoundError();
    return row;
  };

  /** Whether another live row of this person's points at the same Intelligence memory. */
  async function linkIsShared(row: MemoryRow): Promise<boolean> {
    if (!row.intelligenceMemoryId) return false;
    const [other] = await database
      .select({ id: personalMemories.id })
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, row.ownerUserId),
          eq(personalMemories.intelligenceMemoryId, row.intelligenceMemoryId),
          ne(personalMemories.id, row.id),
          isNull(personalMemories.deletedAt),
        ),
      )
      .limit(1);
    return other !== undefined;
  }

  /** Bring one row's Intelligence copy in line with it. Leaves the row as it was on any failure. */
  async function mirrorRow(memory: IntelligenceMemory, row: MemoryRow) {
    const owner = row.ownerUserId;
    if (isMirrorEligible(row)) {
      const digest = digestOf(row.content);
      let id: string | undefined;
      if (!row.intelligenceMemoryId) {
        id = await memory.create(owner, row.content);
      } else if (await linkIsShared(row)) {
        // Intelligence merged two of this person's memories into one. Superseding it would retire
        // the other row's copy too, so this row gets a memory of its own instead.
        id = await memory.create(owner, row.content);
      } else {
        const result = await memory.supersede(
          owner,
          row.intelligenceMemoryId,
          row.content,
        );
        id =
          result === "gone" ? await memory.create(owner, row.content) : result;
      }
      if (!id) return;
      await database
        .update(personalMemories)
        .set({ intelligenceMemoryId: id, intelligenceDigest: digest })
        .where(eq(personalMemories.id, row.id));
      return;
    }
    if (!row.intelligenceMemoryId) return;
    const retired =
      (await linkIsShared(row)) ||
      (await memory.remove(owner, row.intelligenceMemoryId));
    if (!retired) return;
    await database
      .update(personalMemories)
      .set({ intelligenceMemoryId: null, intelligenceDigest: null })
      .where(eq(personalMemories.id, row.id));
  }

  /** Rows whose Intelligence copy is missing, stale, or should no longer exist. */
  const outOfStep = or(
    and(
      mirrorEligible,
      or(
        isNull(personalMemories.intelligenceMemoryId),
        sql`${personalMemories.intelligenceDigest} IS DISTINCT FROM ${contentDigest}`,
      ),
    ),
    and(not(mirrorEligible), isNotNull(personalMemories.intelligenceMemoryId)),
  ) as SQL;

  /**
   * Mirror this person's out-of-step rows (or only `rowId`). Serialised per person in this process;
   * across replicas, a race creates at most a near-duplicate, which Intelligence absorbs into the
   * existing memory and answers with its id. Never throws: a failure leaves the row out of step, and
   * the next pass picks it up.
   */
  async function mirror(ownerUserId: string, rowId?: string, limit = 50) {
    if (!intelligence) return 0;
    const memory = intelligence;
    const previous = mirroring.get(ownerUserId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        if (!(await memory.available())) return 0;
        const rows = await database
          .select()
          .from(personalMemories)
          .where(
            and(
              eq(personalMemories.ownerUserId, ownerUserId),
              rowId ? eq(personalMemories.id, rowId) : undefined,
              outOfStep,
            ),
          )
          .limit(limit);
        for (const row of rows) {
          try {
            await mirrorRow(memory, row);
          } catch (error) {
            console.error(
              JSON.stringify({
                type: "memory-mirror-error",
                error: error instanceof Error ? error.name : "UnknownError",
                context: { memoryId: row.id },
                timestamp: new Date().toISOString(),
              }),
            );
          }
        }
        return rows.length;
      });
    mirroring.set(ownerUserId, run);
    try {
      return await run;
    } finally {
      if (mirroring.get(ownerUserId) === run) mirroring.delete(ownerUserId);
    }
  }

  /** Every Intelligence id this person's rows point at, forgotten rows included. */
  async function linkedIds(ownerUserId: string) {
    const rows = await database
      .select({
        id: personalMemories.id,
        intelligenceMemoryId: personalMemories.intelligenceMemoryId,
      })
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, ownerUserId),
          isNotNull(personalMemories.intelligenceMemoryId),
        ),
      );
    return new Set(rows.map((row) => row.intelligenceMemoryId as string));
  }

  /** The person's Intelligence memories that no OpenBot row describes. */
  async function intelligenceOnly(
    ownerUserId: string,
    memories: IntelligenceMemoryRecord[],
  ): Promise<MemoryRecord[]> {
    if (!memories.length) return [];
    const linked = await linkedIds(ownerUserId);
    return memories
      .filter((memory) => !linked.has(memory.id))
      .map((memory) => fromIntelligence(ownerUserId, memory));
  }

  /**
   * The rows a Bot may recall, every filter in the query. Bot-formed memories go only to the Bot that
   * formed them, and only while it still holds their source app; imported ones only through a source
   * this Bot may use; the person's own to every Bot of theirs.
   */
  function eligibleRows(
    ownerUserId: string,
    eligibleSourceIds: string[],
    formed: { botId: string; heldServerIds: ReadonlySet<string> } | undefined,
    narrow: { term?: string; intelligenceIds?: string[] },
  ) {
    const held = [...(formed?.heldServerIds ?? [])];
    const formedByThisBot = formed
      ? and(
          eq(personalMemories.formedBy, "bot"),
          eq(personalMemories.formedByAgentId, formed.botId),
          or(
            isNull(personalMemories.sourceRef),
            held.length > 0
              ? inArray(
                  sql<string>`split_part(${personalMemories.sourceRef}, '/', 1)`,
                  held,
                )
              : sql`false`,
          ),
        )
      : undefined;
    const personOrSource = and(
      sql`${personalMemories.formedBy} <> 'bot'`,
      or(
        isNull(personalMemories.sourceId),
        eligibleSourceIds.length > 0
          ? inArray(personalMemories.sourceId, eligibleSourceIds)
          : sql`false`,
      ),
    );
    return database
      .select()
      .from(personalMemories)
      .where(
        and(
          eq(personalMemories.ownerUserId, ownerUserId),
          eq(personalMemories.enabled, true),
          isNull(personalMemories.deletedAt),
          formedByThisBot
            ? or(formedByThisBot, personOrSource)
            : personOrSource,
          narrow.term
            ? sql`strpos(lower(${personalMemories.content}), lower(${narrow.term})) > 0`
            : undefined,
          narrow.intelligenceIds
            ? narrow.intelligenceIds.length > 0
              ? inArray(
                  personalMemories.intelligenceMemoryId,
                  narrow.intelligenceIds,
                )
              : sql`false`
            : undefined,
        ),
      )
      .orderBy(desc(personalMemories.updatedAt))
      .limit(40);
  }

  return {
    async list(ownerUserId: string): Promise<MemoryRecord[]> {
      const rows = await database
        .select()
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .orderBy(desc(personalMemories.updatedAt))
        .limit(500);
      if (!intelligence) return rows;
      const remote = await intelligence.list(ownerUserId);
      if (!remote) return rows;
      return [...rows, ...(await intelligenceOnly(ownerUserId, remote))];
    },
    async create(ownerUserId: string, input: unknown) {
      const [row] = await database
        .insert(personalMemories)
        .values({
          id: randomUUID(),
          ownerUserId,
          ...parseMemoryInput(input),
          reviewState: "confirmed",
        })
        .returning();
      if (!row) throw new Error("Memory insert returned no row.");
      await mirror(ownerUserId, row.id);
      return row;
    },
    /**
     * A memory a Bot formed from something it observed, awaiting the person's review.
     *
     * Deduplicated on content, deleted rows included: a memory the person forgot stays forgotten
     * even when the Bot reads the same record again tomorrow. It reaches Intelligence only once the
     * person accepts it.
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
      const [existing] = await database
        .select({
          id: personalMemories.id,
          deletedAt: personalMemories.deletedAt,
        })
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            eq(personalMemories.formedBy, "bot"),
            eq(personalMemories.importDigest, digest),
          ),
        )
        .limit(1);
      if (existing)
        return {
          id: existing.id,
          duplicate: true,
          forgotten: !!existing.deletedAt,
        };
      const observedAt = parsed.data.observedAt ?? new Date();
      const [row] = await database
        .insert(personalMemories)
        .values({
          id: randomUUID(),
          ownerUserId,
          content: parsed.data.content,
          provenance:
            `${parsed.data.sourceApp}${parsed.data.sourceLink ? ` (${parsed.data.sourceLink})` : ""}, observed ${observedAt.toISOString()}`.slice(
              0,
              500,
            ),
          reviewState: "unreviewed",
          formedBy: "bot",
          formedByAgentId: input.agentId,
          sourceApp: parsed.data.sourceApp,
          sourceRef: input.sourceRef ?? null,
          sourceLink: parsed.data.sourceLink ?? null,
          observedAt,
          importDigest: digest,
        })
        .onConflictDoNothing({
          target: [personalMemories.ownerUserId, personalMemories.importDigest],
          where: sql`${personalMemories.formedBy} = 'bot'`,
        })
        .returning({ id: personalMemories.id });
      if (row) return { id: row.id, duplicate: false, forgotten: false };
      // Formed by a concurrent run between the check above and this insert.
      const [raced] = await database
        .select({
          id: personalMemories.id,
          deletedAt: personalMemories.deletedAt,
        })
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            eq(personalMemories.formedBy, "bot"),
            eq(personalMemories.importDigest, digest),
          ),
        )
        .limit(1);
      if (!raced) throw new Error("Memory insert returned no row.");
      return { id: raced.id, duplicate: true, forgotten: !!raced.deletedAt };
    },
    async update(
      ownerUserId: string,
      id: string,
      input: unknown,
    ): Promise<MemoryRecord> {
      const patch = parseMemoryPatch(input);
      if (id.startsWith(INTELLIGENCE_ID_PREFIX)) {
        // Intelligence keeps the content and nothing else, so there is nothing to pause or review.
        if (patch.enabled !== undefined)
          throw new MemoryRefusedError(
            "A memory kept in CopilotKit Intelligence can be edited or forgotten, not paused.",
          );
        const remoteId = id.slice(INTELLIGENCE_ID_PREFIX.length);
        if (!patch.content) {
          const current = (await intelligence?.list(ownerUserId))?.find(
            (memory) => memory.id === remoteId,
          );
          if (!current) throw new MemoryNotFoundError();
          return fromIntelligence(ownerUserId, current);
        }
        if (!intelligence || !(await intelligence.available()))
          throw new MemoryUnavailableError();
        const result = await intelligence.supersede(
          ownerUserId,
          remoteId,
          patch.content,
        );
        if (result === "gone") throw new MemoryNotFoundError();
        if (!result) throw new MemoryUnavailableError();
        return fromIntelligence(ownerUserId, {
          id: result,
          content: patch.content,
        });
      }
      const [row] = await database
        .update(personalMemories)
        .set({
          ...patch,
          ...(patch.content ? { reviewState: "edited" as const } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personalMemories.id, id),
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .returning();
      if (!row) throw new MemoryNotFoundError();
      await mirror(ownerUserId, row.id);
      return row;
    },
    async remove(ownerUserId: string, id: string) {
      if (id.startsWith(INTELLIGENCE_ID_PREFIX)) {
        if (!intelligence || !(await intelligence.available()))
          throw new MemoryUnavailableError();
        const remoteId = id.slice(INTELLIGENCE_ID_PREFIX.length);
        // Only a memory of this person's that no row describes is forgotten by this id. A linked one
        // is forgotten through its row, so its provenance and tombstone go with it.
        if ((await linkedIds(ownerUserId)).has(remoteId))
          throw new MemoryNotFoundError();
        if (!(await intelligence.remove(ownerUserId, remoteId)))
          throw new MemoryUnavailableError();
        return;
      }
      // Imported tombstones prevent the next sync from resurrecting a fact the person deleted.
      const [row] = await database
        .update(personalMemories)
        .set({
          deletedAt: new Date(),
          enabled: false,
          content: "",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(personalMemories.id, id),
            eq(personalMemories.ownerUserId, ownerUserId),
            isNull(personalMemories.deletedAt),
          ),
        )
        .returning({ id: personalMemories.id });
      if (!row) throw new MemoryNotFoundError();
      await mirror(ownerUserId, row.id);
    },
    /**
     * Mirror out-of-step memories to Intelligence, oldest owners first: the backfill on the first
     * pass after a deployment becomes entitled, and afterwards anything a failure left behind.
     * Idempotent: a row is out of step until its Intelligence id and digest match its content.
     */
    async mirrorPending(limitPeople = 20) {
      if (!intelligence || !(await intelligence.available())) return 0;
      const owners = await database
        .selectDistinct({ ownerUserId: personalMemories.ownerUserId })
        .from(personalMemories)
        .where(outOfStep)
        .limit(limitPeople);
      let mirrored = 0;
      for (const { ownerUserId } of owners)
        mirrored += await mirror(ownerUserId);
      return mirrored;
    },
    async sources(ownerUserId: string) {
      return database
        .select()
        .from(memorySources)
        .where(eq(memorySources.ownerUserId, ownerUserId))
        .orderBy(desc(memorySources.createdAt));
    },
    getSource,
    async createSource(ownerUserId: string, input: unknown) {
      const [row] = await database
        .insert(memorySources)
        .values({
          id: randomUUID(),
          ownerUserId,
          ...parseMemorySourceInput(input),
        })
        .returning();
      if (!row) throw new Error("Memory source insert returned no row.");
      return row;
    },
    async setSourceEnabled(ownerUserId: string, id: string, enabled: boolean) {
      const [row] = await database
        .update(memorySources)
        .set({ enabled, nextSyncAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        )
        .returning();
      if (!row) throw new MemoryNotFoundError();
      return row;
    },
    async removeSource(ownerUserId: string, id: string) {
      // The source's memories cascade with it; retire their Intelligence copies first.
      if (intelligence && (await intelligence.available())) {
        const linked = await database
          .select()
          .from(personalMemories)
          .where(
            and(
              eq(personalMemories.ownerUserId, ownerUserId),
              eq(personalMemories.sourceId, id),
              isNotNull(personalMemories.intelligenceMemoryId),
            ),
          );
        for (const row of linked)
          await mirrorRow(intelligence, {
            ...row,
            deletedAt: new Date(),
            enabled: false,
          }).catch(() => {});
      }
      const [source] = await database
        .select({ agentId: memorySources.agentId })
        .from(memorySources)
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        )
        .limit(1);
      if (!source) throw new MemoryNotFoundError();
      // Removing a source is turning that app down for this Bot: OpenBot never adds it back.
      await database.transaction(async (transaction) => {
        await lockDefaults(transaction, ownerUserId, source.agentId);
        const [row] = await transaction
          .delete(memorySources)
          .where(
            and(
              eq(memorySources.id, id),
              eq(memorySources.ownerUserId, ownerUserId),
            ),
          )
          .returning({ toolRef: memorySources.toolRef });
        if (!row) throw new MemoryNotFoundError();
        await recordOptOut(transaction, {
          ownerUserId,
          agentId: source.agentId,
          feature: "memory_source",
          scope: sourceServerId(row.toolRef),
        });
      });
    },
    async dueSources(limit = 5) {
      return database
        .select()
        .from(memorySources)
        .where(
          and(
            eq(memorySources.enabled, true),
            lte(memorySources.nextSyncAt, new Date()),
          ),
        )
        .limit(Math.min(limit, 10));
    },
    async claimSync(ownerUserId: string, id: string) {
      const now = new Date();
      const [row] = await database
        .update(memorySources)
        .set({
          syncStatus: "running",
          nextSyncAt: new Date(now.getTime() + 120_000),
          updatedAt: now,
        })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
            eq(memorySources.enabled, true),
            or(
              sql`${memorySources.syncStatus} <> 'running'`,
              lte(memorySources.nextSyncAt, now),
            ),
          ),
        )
        .returning();
      return row ?? null;
    },
    async failSync(ownerUserId: string, id: string, error: string) {
      await database
        .update(memorySources)
        .set({
          syncStatus: "error",
          syncError: error.slice(0, 500),
          nextSyncAt: new Date(Date.now() + 900_000),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        );
    },
    async completeSync(
      ownerUserId: string,
      sourceId: string,
      records: ImportedMemory[],
    ) {
      await database.transaction(async (transaction) => {
        const [source] = await transaction
          .select()
          .from(memorySources)
          .where(
            and(
              eq(memorySources.id, sourceId),
              eq(memorySources.ownerUserId, ownerUserId),
              eq(memorySources.enabled, true),
            ),
          )
          .for("update");
        if (!source) throw new MemoryNotFoundError();
        for (const record of records) {
          await transaction
            .insert(personalMemories)
            .values({
              id: randomUUID(),
              ownerUserId,
              sourceId,
              externalId: record.externalId,
              importDigest: record.digest,
              content: record.content,
              provenance: `${source.title}: ${record.provenance}`,
              formedBy: "import",
              sourceApp: source.title,
              sourceRef: source.toolRef,
              observedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [personalMemories.sourceId, personalMemories.externalId],
              set: {
                content: sql`CASE WHEN ${personalMemories.reviewState} = 'edited' OR ${personalMemories.deletedAt} IS NOT NULL THEN ${personalMemories.content} ELSE ${record.content} END`,
                provenance: `${source.title}: ${record.provenance}`,
                importDigest: record.digest,
                updatedAt: new Date(),
              },
              setWhere: sql`${personalMemories.importDigest} IS DISTINCT FROM ${record.digest}`,
            });
        }
        await transaction
          .update(memorySources)
          .set({
            syncStatus: "succeeded",
            syncError: null,
            lastSyncAt: new Date(),
            nextSyncAt: new Date(Date.now() + 900_000),
            updatedAt: new Date(),
          })
          .where(eq(memorySources.id, sourceId));
      });
      // A confirmed import whose content changed upstream is out of step now; mirror it.
      await mirror(ownerUserId);
    },
    async retrieve(
      ownerUserId: string,
      eligibleSourceIds: string[],
      search = "",
      /**
       * The Bot asking and the app servers it currently holds. Bot-formed memories are returned
       * only to the Bot that formed them, and only while it still holds their source app; without
       * this argument none are returned.
       */
      formed?: { botId: string; heldServerIds: ReadonlySet<string> },
    ): Promise<MemoryRecord[]> {
      const term = search.trim();
      const local = await eligibleRows(ownerUserId, eligibleSourceIds, formed, {
        term,
      });
      if (!intelligence) return local;
      if (term) {
        /*
         * Ranked by Intelligence, filtered by the rows. A recalled memory a row describes reaches
         * this Bot only if that row is one this Bot may recall; one no row describes is the
         * person's own. The substring matches from the rows follow, for anything recall missed.
         */
        const recalled = await intelligence.recall(ownerUserId, term, 20);
        if (!recalled) return local;
        const allowed = await eligibleRows(
          ownerUserId,
          eligibleSourceIds,
          formed,
          { intelligenceIds: recalled.map((memory) => memory.id) },
        );
        const byRemote = new Map(
          allowed.map((row) => [row.intelligenceMemoryId, row]),
        );
        const unlinked = new Set(
          (await intelligenceOnly(ownerUserId, recalled)).map(
            (memory) => memory.intelligenceMemoryId,
          ),
        );
        const ranked: MemoryRecord[] = recalled.flatMap((memory) => {
          const row = byRemote.get(memory.id);
          if (row) return [row];
          return unlinked.has(memory.id)
            ? [fromIntelligence(ownerUserId, memory)]
            : [];
        });
        const seen = new Set(ranked.map((memory) => memory.id));
        return [
          ...ranked,
          ...local.filter((memory) => !seen.has(memory.id)),
        ].slice(0, 40);
      }
      const remote = await intelligence.list(ownerUserId);
      if (!remote) return local;
      return [
        ...local,
        ...(await intelligenceOnly(ownerUserId, remote)).slice(0, 20),
      ].slice(0, 40);
    },
  };
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;
