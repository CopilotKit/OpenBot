import type { MediaRecord } from "@openbot/shared/recorder-api";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  demonstrationMedia,
  demonstrationMediaChunks,
  demonstrations,
} from "../db/schema/demonstrations";
import { DemonstrationNotFoundError } from "./types";

/** The upload no longer fits the media as stored (a completed media, a chunk resent with other bytes, a gap). Answered as 409. */
export class DemonstrationMediaConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemonstrationMediaConflictError";
  }
}
/** The demonstration cannot hold media at all (a cloud-browser recording). Answered as 400. */
export class DemonstrationMediaRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemonstrationMediaRefusedError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEWLINE = 0x0a;

export type DemonstrationMediaStore = {
  create(
    ownerUserId: string,
    demonstrationId: string,
    input: { kind: "screen" | "audio" | "network"; mimeType: string },
  ): Promise<MediaRecord>;
  putChunk(
    ownerUserId: string,
    demonstrationId: string,
    mediaId: string,
    index: number,
    bytes: Uint8Array,
  ): Promise<MediaRecord>;
  get(
    ownerUserId: string,
    demonstrationId: string,
    mediaId: string,
  ): Promise<MediaRecord>;
  complete(
    ownerUserId: string,
    demonstrationId: string,
    mediaId: string,
    chunkCount: number,
  ): Promise<MediaRecord>;
  /** Read side for the cookie routes (no owner check here; the routes check owner-or-administrator first). */
  list(demonstrationId: string): Promise<MediaRecord[]>;
  content(
    demonstrationId: string,
    mediaId: string,
  ): Promise<{ mimeType: string; chunks: AsyncIterable<Uint8Array> } | null>;
  line(
    demonstrationId: string,
    mediaId: string,
    line: number,
  ): Promise<string | null>;
};

export function createDemonstrationMediaStore(
  database: Database,
): DemonstrationMediaStore {
  type Executor = Pick<Database, "select" | "update" | "insert">;
  type MediaRow = typeof demonstrationMedia.$inferSelect;

  const present = (row: MediaRow, chunks: number[]): MediaRecord => ({
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    chunks,
    byteSize: row.byteSize,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  });
  async function indexes(executor: Executor, mediaId: string) {
    const rows = await executor
      .select({ index: demonstrationMediaChunks.index })
      .from(demonstrationMediaChunks)
      .where(eq(demonstrationMediaChunks.mediaId, mediaId))
      .orderBy(asc(demonstrationMediaChunks.index));
    return rows.map((row) => row.index);
  }
  /** The media row, locked, when it belongs to this person's demonstration; not found otherwise. */
  async function owned(
    transaction: Executor,
    ownerUserId: string,
    demonstrationId: string,
    mediaId: string,
  ) {
    if (!UUID.test(mediaId)) throw new DemonstrationNotFoundError();
    const [row] = await transaction
      .select({ media: demonstrationMedia })
      .from(demonstrationMedia)
      .innerJoin(
        demonstrations,
        eq(demonstrations.id, demonstrationMedia.demonstrationId),
      )
      .where(
        and(
          eq(demonstrationMedia.id, mediaId),
          eq(demonstrationMedia.demonstrationId, demonstrationId),
          eq(demonstrations.ownerUserId, ownerUserId),
        ),
      )
      .for("update", { of: demonstrationMedia });
    if (!row) throw new DemonstrationNotFoundError();
    return row.media;
  }

  return {
    async create(ownerUserId, demonstrationId, input) {
      const [demonstration] = await database
        .select({ source: demonstrations.source })
        .from(demonstrations)
        .where(
          and(
            eq(demonstrations.id, demonstrationId),
            eq(demonstrations.ownerUserId, ownerUserId),
          ),
        );
      if (!demonstration) throw new DemonstrationNotFoundError();
      if (demonstration.source !== "extension")
        throw new DemonstrationMediaRefusedError(
          "Only recordings made in the browser extension keep media.",
        );
      const [row] = await database
        .insert(demonstrationMedia)
        .values({
          demonstrationId,
          ownerUserId,
          kind: input.kind,
          mimeType: input.mimeType,
        })
        .returning();
      if (!row) throw new Error("The media row was not created.");
      return present(row, []);
    },
    async putChunk(ownerUserId, demonstrationId, mediaId, index, bytes) {
      if (!Number.isInteger(index) || index < 0)
        throw new DemonstrationMediaRefusedError(
          "A part of the recording needs a whole number position from zero.",
        );
      return database.transaction(async (transaction) => {
        const row = await owned(
          transaction,
          ownerUserId,
          demonstrationId,
          mediaId,
        );
        if (row.completedAt)
          throw new DemonstrationMediaConflictError(
            "This recording is already complete.",
          );
        const [stored] = await transaction
          .select({
            length: sql<number>`octet_length(${demonstrationMediaChunks.bytes})`,
          })
          .from(demonstrationMediaChunks)
          .where(
            and(
              eq(demonstrationMediaChunks.mediaId, mediaId),
              eq(demonstrationMediaChunks.index, index),
            ),
          );
        if (stored) {
          if (Number(stored.length) !== bytes.byteLength)
            throw new DemonstrationMediaConflictError(
              "This chunk was already uploaded with different contents.",
            );
          return present(row, await indexes(transaction, mediaId));
        }
        await transaction
          .insert(demonstrationMediaChunks)
          .values({ mediaId, index, bytes: Buffer.from(bytes) });
        const [updated] = await transaction
          .update(demonstrationMedia)
          .set({
            byteSize: sql`${demonstrationMedia.byteSize} + ${bytes.byteLength}`,
          })
          .where(eq(demonstrationMedia.id, mediaId))
          .returning();
        if (!updated) throw new DemonstrationNotFoundError();
        return present(updated, await indexes(transaction, mediaId));
      });
    },
    async get(ownerUserId, demonstrationId, mediaId) {
      return database.transaction(async (transaction) => {
        const row = await owned(
          transaction,
          ownerUserId,
          demonstrationId,
          mediaId,
        );
        return present(row, await indexes(transaction, mediaId));
      });
    },
    async complete(ownerUserId, demonstrationId, mediaId, chunkCount) {
      return database.transaction(async (transaction) => {
        const row = await owned(
          transaction,
          ownerUserId,
          demonstrationId,
          mediaId,
        );
        const stored = await indexes(transaction, mediaId);
        if (row.completedAt) {
          if (row.chunkCount !== chunkCount)
            throw new DemonstrationMediaConflictError(
              "This recording was completed with a different number of chunks.",
            );
          return present(row, stored);
        }
        if (stored.some((index) => index >= chunkCount))
          throw new DemonstrationMediaConflictError(
            "The recording has more parts than it says.",
          );
        const held = new Set(stored);
        for (let index = 0; index < chunkCount; index++)
          if (!held.has(index))
            throw new DemonstrationMediaConflictError(
              "Some of the recording is still uploading.",
            );
        const [updated] = await transaction
          .update(demonstrationMedia)
          .set({ chunkCount, completedAt: sql`now()` })
          .where(eq(demonstrationMedia.id, mediaId))
          .returning();
        if (!updated) throw new DemonstrationNotFoundError();
        return present(updated, stored);
      });
    },
    async list(demonstrationId) {
      const rows = await database
        .select()
        .from(demonstrationMedia)
        .where(eq(demonstrationMedia.demonstrationId, demonstrationId))
        .orderBy(asc(demonstrationMedia.createdAt), asc(demonstrationMedia.id));
      return Promise.all(
        rows.map(async (row) => present(row, await indexes(database, row.id))),
      );
    },
    async content(demonstrationId, mediaId) {
      const row = await findMedia(demonstrationId, mediaId);
      if (!row) return null;
      return { mimeType: row.mimeType, chunks: chunksOf(row.id) };
    },
    async line(demonstrationId, mediaId, line) {
      const row = await findMedia(demonstrationId, mediaId);
      if (!row) return null;
      let current = 0;
      let pieces: Buffer[] = [];
      for await (const chunk of chunksOf(row.id)) {
        let start = 0;
        for (
          let at = chunk.indexOf(NEWLINE);
          at !== -1;
          at = chunk.indexOf(NEWLINE, start)
        ) {
          if (current === line)
            return Buffer.concat([
              ...pieces,
              chunk.subarray(start, at),
            ]).toString("utf8");
          current += 1;
          pieces = [];
          start = at + 1;
        }
        if (current === line && start < chunk.length)
          pieces.push(Buffer.from(chunk.subarray(start)));
      }
      // The last line may end without a newline.
      return current === line && pieces.length > 0
        ? Buffer.concat(pieces).toString("utf8")
        : null;
    },
  };

  async function findMedia(demonstrationId: string, mediaId: string) {
    if (!UUID.test(mediaId)) return null;
    const [row] = await database
      .select()
      .from(demonstrationMedia)
      .where(
        and(
          eq(demonstrationMedia.id, mediaId),
          eq(demonstrationMedia.demonstrationId, demonstrationId),
        ),
      );
    return row ?? null;
  }
  /** One chunk in memory at a time, in index order. */
  async function* chunksOf(mediaId: string) {
    for (const index of await indexes(database, mediaId)) {
      const [chunk] = await database
        .select({ bytes: demonstrationMediaChunks.bytes })
        .from(demonstrationMediaChunks)
        .where(
          and(
            eq(demonstrationMediaChunks.mediaId, mediaId),
            eq(demonstrationMediaChunks.index, index),
          ),
        );
      if (chunk) yield new Uint8Array(chunk.bytes);
    }
  }
}
