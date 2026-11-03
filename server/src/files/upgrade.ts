/**
 * Moving an existing deployment's attachments and page frames into Intelligence, once, at boot.
 *
 * A deployment that ran before this release holds its chat attachments in `attachments` (bytes and
 * all) and each browser turn's screenshot in `computer_page_frame`. This copies them into
 * Intelligence's file store with everything a reader relies on:
 *
 *  - an attachment keeps its id (every message that carries it names `/api/attachments/<id>`), its
 *    uploader, channel, name, type, size, upload group, its creation time, and its send time as
 *    the file's commit time. A staged attachment stays staged, with the expiry the staged window
 *    gives it from when it was uploaded; one already past that window was the sweep's to delete and
 *    is not copied.
 *  - a frame keeps its computer, turn, page, title and capture time, and the retention it has left.
 *    One already past retention was the retention sweep's to delete and is not copied.
 *
 * Then it checks that Intelligence holds every one it was to copy, and only then records the copy
 * as done, so it never runs again: a file later deleted in Intelligence must not come back from the
 * local row this release keeps.
 *
 * SAFE TO RUN ANY NUMBER OF TIMES, FROM ANY NUMBER OF REPLICAS AT ONCE. An attachment is created
 * under its own id and a frame under its own computer and turn, from bodies made only from the local
 * rows, so two replicas copying the same one send the same upload and Intelligence answers the
 * second with the first. One Intelligence already has is left alone.
 *
 * LOUD ON A MISMATCH. One Intelligence refuses, or one missing after the copy, stops the boot with
 * the ids named. Running on with some copied and some not would show conversations whose files say
 * "unavailable" with nothing saying why.
 *
 * Bytes are read from the local table a few rows at a time, never all at once: the attachments
 * table is the one place this deployment kept blobs.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import { ATTACHMENT_PURPOSE } from "../channels/attachments";
import {
  createPageFrameStore,
  FRAME_RETENTION_MS,
  PAGE_FRAME_PURPOSE,
} from "../computer/page-frames";
import type { Database } from "../db/client";
import {
  attachments,
  computerPageFrame,
  intelligenceCopies,
} from "../db/schema";
import { FileExistsError, filesClient } from "./client";

export const ATTACHMENT_COPY_NAME = "attachments";
export const PAGE_FRAME_COPY_NAME = "page-frames";

/**
 * How much life a staged attachment or a frame must have left to be copied. One closer to its end
 * than this would expire between the copy and the check, and the check would report it missing.
 */
const MINIMUM_REMAINING_MS = 10 * 60 * 1000;

/** Rows whose bytes are read, and uploaded, at a time. */
const CHUNK = 8;

export class FileCopyMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileCopyMismatchError";
  }
}

export type FileCopyOutcome =
  | { kind: "done-before" }
  | {
      kind: "copied";
      local: number;
      expected: number;
      created: number;
      skipped: number;
    };

async function copyDone(database: Database, name: string): Promise<boolean> {
  const [done] = await database
    .select({ name: intelligenceCopies.name })
    .from(intelligenceCopies)
    .where(eq(intelligenceCopies.name, name))
    .limit(1);
  return Boolean(done);
}

async function recordCopy(
  database: Database,
  name: string,
  copied: number,
): Promise<void> {
  await database
    .insert(intelligenceCopies)
    .values({ name, copied })
    .onConflictDoNothing();
}

/**
 * The same key for the same upload from every replica: made from what is uploaded, so a different
 * body under the same id (a database restored over another) is told apart as a different request
 * rather than refused as a reused key.
 */
function upgradeKey(kind: string, body: unknown, bytes: Buffer): string {
  return `openbot-upgrade:${kind}:${createHash("sha256")
    .update(JSON.stringify(body))
    .update(bytes)
    .digest("hex")}`;
}

/**
 * Copies the deployment's attachments into Intelligence.
 *
 * @param options.stagedTtlHours - The staged window, or null when staged attachments never expire.
 */
export async function copyLocalAttachmentsToIntelligence(
  database: Database,
  options: { stagedTtlHours: number | null; now?: Date },
): Promise<FileCopyOutcome> {
  if (await copyDone(database, ATTACHMENT_COPY_NAME)) {
    return { kind: "done-before" };
  }
  const now = options.now ?? new Date();
  const rows = await database
    .select({
      id: attachments.id,
      channelId: attachments.channelId,
      uploadedBy: attachments.uploadedBy,
      uploadGroup: attachments.uploadGroup,
      name: attachments.name,
      mimeType: attachments.mimeType,
      createdAt: attachments.createdAt,
      attachedAt: attachments.attachedAt,
    })
    .from(attachments)
    .orderBy(attachments.id);

  const expiryOf = (row: (typeof rows)[number]): Date | null =>
    row.attachedAt !== null || options.stagedTtlHours === null
      ? null
      : new Date(
          row.createdAt.getTime() + options.stagedTtlHours * 60 * 60 * 1000,
        );
  const expected = rows.filter((row) => {
    const expiresAt = expiryOf(row);
    return (
      expiresAt === null ||
      expiresAt.getTime() - now.getTime() > MINIMUM_REMAINING_MS
    );
  });
  const skipped = rows.length - expected.length;
  if (skipped > 0) {
    console.info(
      JSON.stringify({
        type: "attachment-copy-skipped-expired",
        note: "Staged attachments past the staged window were the sweep's to delete, and are not copied.",
        count: skipped,
      }),
    );
  }

  const files = filesClient();
  const present = async () =>
    new Set(
      (await files.list({ purpose: ATTACHMENT_PURPOSE })).map(
        (file) => file.id,
      ),
    );
  const before = await present();
  const missing = expected.filter((row) => !before.has(row.id));

  let created = 0;
  const refused: string[] = [];
  for (let start = 0; start < missing.length; start += CHUNK) {
    const chunk = missing.slice(start, start + CHUNK);
    const blobs = new Map(
      (
        await database
          .select({ id: attachments.id, bytes: attachments.bytes })
          .from(attachments)
          .where(
            inArray(
              attachments.id,
              chunk.map((row) => row.id),
            ),
          )
      ).map((row) => [row.id, row.bytes]),
    );
    await Promise.all(
      chunk.map(async (row) => {
        const bytes = blobs.get(row.id);
        // Deleted locally between the listing and here: a staged file withdrawn by an older replica
        // still running. There is nothing left to copy, and the check below does not expect it.
        if (!bytes) return;
        const metadata = {
          id: row.id,
          purpose: ATTACHMENT_PURPOSE,
          ownerUserId: row.uploadedBy,
          collection: row.channelId,
          batch: row.uploadGroup,
          name: row.name,
          contentType: row.mimeType,
          committed: row.attachedAt !== null,
          ...(row.attachedAt ? { committedAt: row.attachedAt } : {}),
          createdAt: row.createdAt,
          expiresAt: expiryOf(row),
        };
        try {
          const result = await files.create(
            metadata,
            bytes,
            upgradeKey("attachments", metadata, bytes),
          );
          if (result.created) created += 1;
        } catch (error) {
          refused.push(
            `${row.id}: ${error instanceof FileExistsError ? "Intelligence holds a different file under this id" : error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }
  if (refused.length > 0) {
    throw new FileCopyMismatchError(
      `Intelligence refused ${refused.length} of this deployment's ${expected.length} attachments, so they were not moved and this server will not start without them:\n${refused.join("\n")}`,
    );
  }

  const stillLocal = new Set(
    (
      await database
        .select({ id: attachments.id })
        .from(attachments)
        .where(
          inArray(
            attachments.id,
            expected.map((row) => row.id),
          ),
        )
    ).map((row) => row.id),
  );
  const after = await present();
  const lost = expected.filter(
    (row) => stillLocal.has(row.id) && !after.has(row.id),
  );
  if (lost.length > 0) {
    throw new FileCopyMismatchError(
      `${expected.length} attachments were to be copied into Intelligence and ${expected.length - lost.length} are there. Missing: ${lost.map((row) => row.id).join(", ")}`,
    );
  }

  await recordCopy(database, ATTACHMENT_COPY_NAME, expected.length);
  console.info(
    JSON.stringify({
      type: "attachments-copied-to-intelligence",
      local: rows.length,
      expected: expected.length,
      created,
      skippedExpired: skipped,
    }),
  );
  return {
    kind: "copied",
    local: rows.length,
    expected: expected.length,
    created,
    skipped,
  };
}

/** Copies the deployment's kept page frames, with the retention each has left, into Intelligence. */
export async function copyLocalPageFramesToIntelligence(
  database: Database,
  options: { now?: Date } = {},
): Promise<FileCopyOutcome> {
  if (await copyDone(database, PAGE_FRAME_COPY_NAME)) {
    return { kind: "done-before" };
  }
  const now = options.now ?? new Date();
  const keepFrom = new Date(
    now.getTime() - FRAME_RETENTION_MS + MINIMUM_REMAINING_MS,
  );
  const total = await database.$count(computerPageFrame);
  const rows = await database
    .select({
      computerId: computerPageFrame.computerId,
      toolCallId: computerPageFrame.toolCallId,
      url: computerPageFrame.url,
      title: computerPageFrame.title,
      capturedAt: computerPageFrame.capturedAt,
    })
    .from(computerPageFrame)
    .where(gt(computerPageFrame.capturedAt, keepFrom))
    .orderBy(computerPageFrame.computerId, computerPageFrame.toolCallId);
  const skipped = total - rows.length;

  const slot = (computerId: string | null, key: string | null) =>
    `${computerId ?? ""}\u0000${key ?? ""}`;
  const files = filesClient();
  const present = async () =>
    new Set(
      (await files.list({ purpose: PAGE_FRAME_PURPOSE })).map((file) =>
        slot(file.collection, file.key),
      ),
    );
  const before = await present();
  const missing = rows.filter(
    (row) => !before.has(slot(row.computerId, row.toolCallId)),
  );

  const store = createPageFrameStore();
  const refused: string[] = [];
  let created = 0;
  for (let start = 0; start < missing.length; start += CHUNK) {
    const chunk = missing.slice(start, start + CHUNK);
    await Promise.all(
      chunk.map(async (row) => {
        const [stored] = await database
          .select({ frame: computerPageFrame.frame })
          .from(computerPageFrame)
          .where(
            and(
              eq(computerPageFrame.computerId, row.computerId),
              eq(computerPageFrame.toolCallId, row.toolCallId),
            ),
          );
        if (!stored) return;
        try {
          await store.save({
            computerId: row.computerId,
            toolCallId: row.toolCallId,
            url: row.url,
            ...(row.title ? { title: row.title } : {}),
            frame: stored.frame,
            capturedAt: row.capturedAt,
          });
          created += 1;
        } catch (error) {
          refused.push(
            `${row.computerId} ${row.toolCallId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }
  if (refused.length > 0) {
    throw new FileCopyMismatchError(
      `Intelligence refused ${refused.length} of this deployment's ${rows.length} page frames, so they were not moved and this server will not start without them:\n${refused.join("\n")}`,
    );
  }

  const after = await present();
  const lost = rows.filter(
    (row) => !after.has(slot(row.computerId, row.toolCallId)),
  );
  if (lost.length > 0) {
    throw new FileCopyMismatchError(
      `${rows.length} page frames were to be copied into Intelligence and ${rows.length - lost.length} are there. Missing: ${lost.map((row) => `${row.computerId} ${row.toolCallId}`).join(", ")}`,
    );
  }

  await recordCopy(database, PAGE_FRAME_COPY_NAME, rows.length);
  console.info(
    JSON.stringify({
      type: "page-frames-copied-to-intelligence",
      local: total,
      expected: rows.length,
      created,
      skippedExpired: skipped,
    }),
  );
  return {
    kind: "copied",
    local: total,
    expected: rows.length,
    created,
    skipped,
  };
}
