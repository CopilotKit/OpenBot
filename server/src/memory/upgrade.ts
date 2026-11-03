/**
 * Moving an existing deployment's memory into Intelligence, once, at boot.
 *
 * A deployment that ran before this release holds each person's memory sources in `memory_sources` and
 * their memories in `personal_memories`, and, when it was entitled to Intelligence memory, a copy of each
 * accepted memory's words in Intelligence (`intelligence_memory_id`). This copies everything into
 * Intelligence's memories and memory sources:
 *
 *  - sources first, with their ids (memories name them), owner, Bot, connector action, title, settings,
 *    switch, sync state and times;
 *  - then memories with their ids, words, provenance, review state, switch, who formed them and which Bot,
 *    their source and record id, digest, source app, ref and link, when observed, and their times. A
 *    forgotten one is copied as the tombstone it is (blank, retired, its record id and digest kept), so a
 *    re-import or a Bot does not bring it back.
 *  - A memory already mirrored to Intelligence is ADOPTED rather than copied a second time: that
 *    Intelligence memory is given the row's metadata, and keeps its own id. When its words differ from
 *    the row's (an edit the mirror had not carried yet), or two rows shared one mirrored memory, or the
 *    mirrored memory is gone, the row is copied under its own id instead (and an out-of-date mirror is
 *    retired), so nothing is ever in Intelligence twice.
 *
 * Then it checks that Intelligence holds every source and memory it was to copy, and only then records the
 * copy as done, so it never runs again: a memory later forgotten or purged in Intelligence must not come
 * back from the local row this release keeps.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. Every source and memory is created
 * under its own id from the local row alone, so two replicas copying the same one meet on the id and
 * Intelligence answers the second with the first. Adopting sets the same metadata however often it runs.
 *
 * LOUD ON A MISMATCH. One Intelligence refuses, or one missing after the copy, stops the boot with the ids
 * named: running on with some of a person's memory moved and some not would show them a partial memory and
 * let a Bot form again what they had forgotten.
 */
import { asc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  intelligenceCopies,
  memorySources,
  personalMemories,
} from "../db/schema";
import {
  type IntelligenceMemory,
  MemoryIntelligenceError,
  type MemoryWriteFields,
  memoryIdempotencyKey,
} from "./intelligence";

export const MEMORY_COPY_NAME = "memory";

export class MemoryCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryCopyMismatchError";
  }
}

export type MemoryCopyOutcome =
  | { kind: "done-before" }
  | {
      kind: "copied";
      sources: number;
      memories: number;
      adopted: number;
    };

type MemoryRow = typeof personalMemories.$inferSelect;

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** The metadata Intelligence keeps for a local row. */
function metadataOf(row: MemoryRow): MemoryWriteFields {
  const formedBy =
    row.formedBy === "bot"
      ? "agent"
      : row.formedBy === "import"
        ? "import"
        : "person";
  return {
    agentId: row.formedBy === "bot" ? row.formedByAgentId : null,
    reviewState: row.reviewState,
    enabled: row.deletedAt ? false : row.enabled,
    provenance: row.provenance.slice(0, 1000),
    formedBy,
    sourceId: row.sourceId,
    externalId: row.externalId,
    contentDigest: row.importDigest,
    sourceApp: row.sourceApp?.slice(0, 160) ?? null,
    sourceRef: row.sourceRef?.slice(0, 256) ?? null,
    sourceLink: row.sourceLink?.slice(0, 1000) ?? null,
    observedAt: iso(row.observedAt),
  };
}

function refused(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function copyLocalMemoryToIntelligence(
  database: Database,
  intelligence: IntelligenceMemory,
): Promise<MemoryCopyOutcome> {
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, MEMORY_COPY_NAME))
    .limit(1);
  if (done) return { kind: "done-before" };

  const problems: string[] = [];

  // Sources first: memories name them.
  const sources = await database
    .select()
    .from(memorySources)
    .orderBy(asc(memorySources.createdAt));
  for (const source of sources) {
    try {
      await intelligence.createSource(
        {
          id: source.id,
          userId: source.ownerUserId,
          agentId: source.agentId,
          connectorRef: source.toolRef,
          title: source.title,
          settings: source.args,
          enabled: source.enabled,
          // A sync running when the deployment stopped never finished; the next sweep runs it again.
          syncStatus:
            source.syncStatus === "running" ? "idle" : source.syncStatus,
          syncError: source.syncError,
          lastSyncAt: iso(source.lastSyncAt),
          nextSyncAt: iso(source.nextSyncAt),
          createdAt: source.createdAt.toISOString(),
          updatedAt: source.updatedAt.toISOString(),
        },
        memoryIdempotencyKey("upgrade-source"),
      );
    } catch (error) {
      problems.push(`source ${source.id}: ${refused(error)}`);
    }
  }
  if (problems.length > 0)
    throw new MemoryCopyMismatchError(
      `Intelligence refused ${problems.length} of this deployment's ${sources.length} memory sources, so they were not moved and this server will not start without them:\n${problems.join("\n")}`,
    );

  const rows = await database
    .select()
    .from(personalMemories)
    .orderBy(asc(personalMemories.createdAt), asc(personalMemories.id));
  /** The Intelligence id each row ends up under: its own, or the mirrored memory it adopted. */
  const expected = new Map<string, { userId: string; id: string }>();
  const adoptedIds = new Set<string>();
  let adopted = 0;

  for (const row of rows) {
    const metadata = metadataOf(row);
    const mirrored = row.intelligenceMemoryId;
    try {
      if (mirrored && !row.deletedAt && !adoptedIds.has(mirrored)) {
        const current = await intelligence.getMemory(row.ownerUserId, mirrored);
        if (
          current &&
          !current.invalidatedAt &&
          current.scope === "user" &&
          current.content === row.content
        ) {
          // The words are already there: give them the row's metadata and keep Intelligence's id.
          const changed = await intelligence.updateMemory(
            row.ownerUserId,
            mirrored,
            metadata,
            memoryIdempotencyKey("upgrade-adopt"),
          );
          if (changed) {
            adoptedIds.add(mirrored);
            expected.set(row.id, { userId: row.ownerUserId, id: mirrored });
            adopted += 1;
            continue;
          }
        } else if (current && !current.invalidatedAt) {
          // Out of date: the row's words win, under the row's own id, and the old mirror is retired.
          await intelligence.forgetMemory(row.ownerUserId, mirrored);
        }
      } else if (mirrored && row.deletedAt && !adoptedIds.has(mirrored)) {
        // Forgotten here after it was mirrored, and the mirror never retired: retire it now.
        await intelligence.forgetMemory(row.ownerUserId, mirrored);
      }
      await intelligence.createMemory(
        row.ownerUserId,
        {
          id: row.id,
          content: row.deletedAt ? "" : row.content,
          ...metadata,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          ...(row.deletedAt
            ? { invalidatedAt: row.deletedAt.toISOString() }
            : {}),
        },
        memoryIdempotencyKey("upgrade-memory"),
      );
      expected.set(row.id, { userId: row.ownerUserId, id: row.id });
    } catch (error) {
      // A second replica adopted this row's mirror first and retired it with a supersede: the row is
      // then copied under its own id by the replica that finds the mirror gone. Report anything else.
      if (
        error instanceof MemoryIntelligenceError &&
        error.code === "MEMORY_ALREADY_EXISTS"
      ) {
        expected.set(row.id, { userId: row.ownerUserId, id: row.id });
        continue;
      }
      problems.push(`memory ${row.id}: ${refused(error)}`);
    }
  }
  if (problems.length > 0)
    throw new MemoryCopyMismatchError(
      `Intelligence refused ${problems.length} of this deployment's ${rows.length} memories, so they were not moved and this server will not start without them:\n${problems.join("\n")}`,
    );

  // Verify: every source, and every memory under the id it was to have.
  const sourcesThere = new Set(
    (await intelligence.sources({})).map((source) => source.id),
  );
  const missingSources = sources.filter(
    (source) => !sourcesThere.has(source.id),
  );
  const people = new Set(rows.map((row) => row.ownerUserId));
  const memoriesThere = new Set<string>();
  for (const userId of people)
    for (const memory of await intelligence.allMemories(userId, {
      includeInvalidated: true,
    }))
      memoriesThere.add(`${userId}\n${memory.id}`);
  const missingMemories = [...expected.entries()].filter(
    ([, target]) => !memoriesThere.has(`${target.userId}\n${target.id}`),
  );
  if (missingSources.length > 0 || missingMemories.length > 0)
    throw new MemoryCopyMismatchError(
      `${sources.length} memory sources and ${rows.length} memories were to be copied into Intelligence; ${sources.length - missingSources.length} and ${rows.length - missingMemories.length} are there. Missing sources: ${missingSources.map((source) => source.id).join(", ") || "none"}. Missing memories: ${missingMemories.map(([id]) => id).join(", ") || "none"}`,
    );

  await database
    .insert(intelligenceCopies)
    .values({ name: MEMORY_COPY_NAME, copied: sources.length + rows.length })
    .onConflictDoNothing();
  console.info(
    JSON.stringify({
      type: "memory-copied-to-intelligence",
      sources: sources.length,
      memories: rows.length,
      adopted,
    }),
  );
  return {
    kind: "copied",
    sources: sources.length,
    memories: rows.length,
    adopted,
  };
}
