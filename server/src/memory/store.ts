import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { memorySources, personalMemories } from "../db/schema/memory";
import {
  type FormedMemoryInput,
  formedMemorySchema,
  type ImportedMemory,
  MemoryNotFoundError,
  MemoryRefusedError,
  parseMemoryInput,
  parseMemoryPatch,
  parseMemorySourceInput,
} from "./types";

export function createMemoryStore(database: Database) {
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
  return {
    async list(ownerUserId: string) {
      return database
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
      return row;
    },
    /**
     * A memory a Bot formed from something it observed, awaiting the person's review.
     *
     * Deduplicated on content, deleted rows included: a memory the person forgot stays forgotten
     * even when the Bot reads the same record again tomorrow.
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
        .returning({ id: personalMemories.id });
      if (!row) throw new Error("Memory insert returned no row.");
      return { id: row.id, duplicate: false, forgotten: false };
    },
    async update(ownerUserId: string, id: string, input: unknown) {
      const patch = parseMemoryPatch(input);
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
      return row;
    },
    async remove(ownerUserId: string, id: string) {
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
      const [row] = await database
        .delete(memorySources)
        .where(
          and(
            eq(memorySources.id, id),
            eq(memorySources.ownerUserId, ownerUserId),
          ),
        )
        .returning({ id: memorySources.id });
      if (!row) throw new MemoryNotFoundError();
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
    ) {
      const rows = await database
        .select()
        .from(personalMemories)
        .where(
          and(
            eq(personalMemories.ownerUserId, ownerUserId),
            eq(personalMemories.enabled, true),
            isNull(personalMemories.deletedAt),
          ),
        )
        .orderBy(desc(personalMemories.updatedAt))
        .limit(500);
      const allowed = new Set(eligibleSourceIds);
      return rows
        .filter(
          (row) =>
            (row.formedBy === "bot"
              ? !!formed &&
                row.formedByAgentId === formed.botId &&
                (!row.sourceRef ||
                  formed.heldServerIds.has(row.sourceRef.split("/")[0] ?? ""))
              : !row.sourceId || allowed.has(row.sourceId)) &&
            (!search ||
              row.content
                .toLocaleLowerCase()
                .includes(search.toLocaleLowerCase())),
        )
        .slice(0, 40);
    },
  };
}
export type MemoryStore = ReturnType<typeof createMemoryStore>;
