import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createAttachmentRoutes } from "../src/channels/attachments";
import { createPageFrameStore } from "../src/computer/page-frames";
import { createDatabase } from "../src/db/client";
import {
  attachments,
  channelMemberships,
  channels,
  computerPageFrame,
  intelligenceCopies,
  users,
} from "../src/db/schema";
import { filesClient, installFilesClient } from "../src/files/client";
import {
  ATTACHMENT_COPY_NAME,
  copyLocalAttachmentsToIntelligence,
  copyLocalPageFramesToIntelligence,
  FileCopyMismatchError,
  PAGE_FRAME_COPY_NAME,
} from "../src/files/upgrade";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { restoreTestFiles, useTestFiles } from "./support/files";

/**
 * An existing deployment's attachments and page frames, moved into Intelligence at boot.
 *
 * The rows are written the way the previous release wrote them — straight into `attachments` and
 * `computer_page_frame`, bytes and base64 in the columns — and read back the way this release reads
 * them: through Intelligence's file store, and through the attachment route a browser fetches with.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
useTestFiles();

const prefix = `files-upgrade-${randomUUID().slice(0, 8)}`;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Seeded = {
  memberId: string;
  channelId: string;
  sent: string;
  staged: string;
  stale: string;
  computerId: string;
};

async function forgetCopies(): Promise<void> {
  await database
    .delete(intelligenceCopies)
    .where(
      inArray(intelligenceCopies.name, [
        ATTACHMENT_COPY_NAME,
        PAGE_FRAME_COPY_NAME,
      ]),
    );
}

/** What the previous release left behind: a channel with three attachments, and two frames. */
async function seedPreviousRelease(): Promise<Seeded> {
  const memberId = `${prefix}-member-${randomUUID()}`;
  await database
    .insert(users)
    .values({ id: memberId, email: `${memberId}@example.test` });
  const channelId = `${prefix}-channel-${randomUUID()}`;
  await database.insert(channels).values({
    id: channelId,
    name: "Upgraded channel",
    description: "Files from before the upgrade.",
  });
  await database
    .insert(channelMemberships)
    .values({ channelId, userId: memberId });

  const now = Date.now();
  const [sent] = await database
    .insert(attachments)
    .values({
      channelId,
      uploadedBy: memberId,
      uploadGroup: "a-composer",
      name: "report.png",
      mimeType: "image/png",
      sizeBytes: 9,
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      createdAt: new Date(now - 10 * DAY),
      attachedAt: new Date(now - 10 * DAY + 60_000),
    })
    .returning({ id: attachments.id });
  const [staged] = await database
    .insert(attachments)
    .values({
      channelId,
      uploadedBy: memberId,
      uploadGroup: "another-composer",
      name: "draft.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      bytes: Buffer.from("draft"),
      createdAt: new Date(now - 2 * HOUR),
    })
    .returning({ id: attachments.id });
  // Staged two days ago: past the 24-hour window, so the sweep would have taken it.
  const [stale] = await database
    .insert(attachments)
    .values({
      channelId,
      uploadedBy: memberId,
      name: "forgotten.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      bytes: Buffer.from("old"),
      createdAt: new Date(now - 2 * DAY),
    })
    .returning({ id: attachments.id });

  const computerId = `person:${memberId}/${prefix}-bot`;
  await database.insert(computerPageFrame).values([
    {
      computerId,
      toolCallId: "turn-recent",
      url: "https://example.com/recent",
      title: "Recent page",
      frame: Buffer.from("recent-png").toString("base64"),
      capturedAt: new Date(now - 3 * DAY),
    },
    {
      // Past the 30-day retention: the retention sweep would have taken it.
      computerId,
      toolCallId: "turn-old",
      url: "https://example.com/old",
      title: "Old page",
      frame: Buffer.from("old-png").toString("base64"),
      capturedAt: new Date(now - 31 * DAY),
    },
  ]);

  return {
    memberId,
    channelId,
    sent: sent.id,
    staged: staged.id,
    stale: stale.id,
    computerId,
  };
}

const seededChannels: string[] = [];
const seededUsers: string[] = [];
const seededComputers: string[] = [];

async function seed(): Promise<Seeded> {
  const seeded = await seedPreviousRelease();
  seededChannels.push(seeded.channelId);
  seededUsers.push(seeded.memberId);
  seededComputers.push(seeded.computerId);
  return seeded;
}

afterEach(async () => {
  restoreTestFiles();
  await forgetCopies();
  for (const channelId of seededChannels.splice(0)) {
    await filesClient().purge({
      purpose: "chat_attachment",
      collection: channelId,
    });
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const userId of seededUsers.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
  for (const computerId of seededComputers.splice(0)) {
    await filesClient().purge({
      purpose: "page_frame",
      collection: computerId,
    });
    await database
      .delete(computerPageFrame)
      .where(eq(computerPageFrame.computerId, computerId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function quietly<T>(work: () => Promise<T>): Promise<T> {
  const info = spyOn(console, "info").mockImplementation(() => {});
  return work().finally(() => info.mockRestore());
}

describe("the boot-time copy of attachments", () => {
  test("keeps each attachment's id, uploader, channel, name, type, size, group and times", async () => {
    await forgetCopies();
    const seeded = await seed();

    const outcome = await quietly(() =>
      copyLocalAttachmentsToIntelligence(database, { stagedTtlHours: 24 }),
    );
    expect(outcome.kind).toBe("copied");

    const sent = await filesClient().get(seeded.sent);
    expect(sent).toMatchObject({
      id: seeded.sent,
      purpose: "chat_attachment",
      ownerUserId: seeded.memberId,
      collection: seeded.channelId,
      batch: "a-composer",
      name: "report.png",
      contentType: "image/png",
      sizeBytes: 9,
      expiresAt: null,
    });
    const [local] = await database
      .select({
        createdAt: attachments.createdAt,
        attachedAt: attachments.attachedAt,
      })
      .from(attachments)
      .where(eq(attachments.id, seeded.sent));
    expect(sent?.createdAt.getTime()).toBe(local.createdAt.getTime());
    // When it was sent is when it was committed.
    expect(sent?.committedAt?.getTime()).toBe(local.attachedAt?.getTime());
    expect(
      Buffer.compare(
        (await filesClient().content(seeded.sent)) ?? Buffer.alloc(0),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ),
    ).toBe(0);

    // Staged stays staged, with the window it had left from when it was uploaded.
    const staged = await filesClient().get(seeded.staged);
    expect(staged?.committedAt).toBeNull();
    expect(staged?.expiresAt?.getTime()).toBe(
      (staged?.createdAt.getTime() ?? 0) + 24 * HOUR,
    );

    // The one the sweep would have deleted is not brought back.
    expect(await filesClient().get(seeded.stale)).toBeNull();
    if (outcome.kind === "copied") expect(outcome.skipped).toBeGreaterThan(0);

    // And recorded, so it never runs again.
    expect(
      await quietly(() =>
        copyLocalAttachmentsToIntelligence(database, { stagedTtlHours: 24 }),
      ),
    ).toEqual({ kind: "done-before" });
  });

  test("a message from before the upgrade still shows its file to a member", async () => {
    await forgetCopies();
    const seeded = await seed();
    await quietly(() =>
      copyLocalAttachmentsToIntelligence(database, { stagedTtlHours: 24 }),
    );

    const member: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", {
        id: seeded.memberId,
        email: `${seeded.memberId}@example.test`,
        role: "user",
      });
      await next();
    };
    const app = new Hono<{ Variables: AppVariables }>();
    app.route("/", createAttachmentRoutes(database, member));
    // The URL every stored message carries names the id it had before the upgrade.
    const served = await app.request(`http://test/${seeded.sent}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).byteLength).toBe(9);
  });

  test("with the sweep switched off, every staged attachment is copied and none expires", async () => {
    await forgetCopies();
    const seeded = await seed();
    await quietly(() =>
      copyLocalAttachmentsToIntelligence(database, { stagedTtlHours: null }),
    );
    expect((await filesClient().get(seeded.stale))?.expiresAt).toBeNull();
    expect((await filesClient().get(seeded.staged))?.expiresAt).toBeNull();
  });

  test("two replicas copying at once copy each attachment once, and both finish", async () => {
    await forgetCopies();
    const seeded = await seed();

    const outcomes = await quietly(() =>
      Promise.all([
        copyLocalAttachmentsToIntelligence(database, { stagedTtlHours: 24 }),
        copyLocalAttachmentsToIntelligence(database, { stagedTtlHours: 24 }),
      ]),
    );

    expect(outcomes.every((outcome) => outcome.kind === "copied")).toBe(true);
    const inChannel = await filesClient().list({
      purpose: "chat_attachment",
      collection: seeded.channelId,
    });
    expect(inChannel.map((file) => file.id).sort()).toEqual(
      [seeded.sent, seeded.staged].sort(),
    );
  });

  test("an attachment Intelligence refuses stops the boot, naming it, and records nothing", async () => {
    await forgetCopies();
    const seeded = await seed();
    const real = useTestFiles();
    installFilesClient({
      ...real,
      create: async (file, content, key) => {
        if (file.id === seeded.staged) {
          throw new Error("Intelligence refused this one.");
        }
        return real.create(file, content, key);
      },
    });

    const copying = quietly(() =>
      copyLocalAttachmentsToIntelligence(database, { stagedTtlHours: 24 }),
    );
    await expect(copying).rejects.toBeInstanceOf(FileCopyMismatchError);
    await expect(copying).rejects.toThrow(seeded.staged);

    const [recorded] = await database
      .select({ name: intelligenceCopies.name })
      .from(intelligenceCopies)
      .where(eq(intelligenceCopies.name, ATTACHMENT_COPY_NAME));
    expect(recorded).toBeUndefined();

    // The next boot, with Intelligence answering, finishes the job.
    restoreTestFiles();
    const retried = await quietly(() =>
      copyLocalAttachmentsToIntelligence(database, { stagedTtlHours: 24 }),
    );
    expect(retried.kind).toBe("copied");
    expect(await filesClient().get(seeded.staged)).not.toBeNull();
  });
});

describe("the boot-time copy of page frames", () => {
  test("keeps each frame's computer, turn, page, title and capture time, and the retention it has left", async () => {
    await forgetCopies();
    const seeded = await seed();

    const outcome = await quietly(() =>
      copyLocalPageFramesToIntelligence(database),
    );
    expect(outcome.kind).toBe("copied");

    const frames = createPageFrameStore();
    expect(await frames.load(seeded.computerId, "turn-recent")).toEqual({
      url: "https://example.com/recent",
      title: "Recent page",
      frame: Buffer.from("recent-png").toString("base64"),
    });
    const [kept] = await filesClient().list({
      purpose: "page_frame",
      collection: seeded.computerId,
      key: "turn-recent",
    });
    const [local] = await database
      .select({ capturedAt: computerPageFrame.capturedAt })
      .from(computerPageFrame)
      .where(eq(computerPageFrame.toolCallId, "turn-recent"));
    expect(kept.createdAt.getTime()).toBe(local.capturedAt.getTime());
    expect(kept.expiresAt?.getTime()).toBe(
      local.capturedAt.getTime() + 30 * DAY,
    );

    // Past retention: not brought back.
    expect(await frames.load(seeded.computerId, "turn-old")).toBeNull();

    expect(
      await quietly(() => copyLocalPageFramesToIntelligence(database)),
    ).toEqual({ kind: "done-before" });
  });

  test("two replicas copying frames at once both finish with each frame kept once", async () => {
    await forgetCopies();
    const seeded = await seed();
    const outcomes = await quietly(() =>
      Promise.all([
        copyLocalPageFramesToIntelligence(database),
        copyLocalPageFramesToIntelligence(database),
      ]),
    );
    expect(outcomes.every((outcome) => outcome.kind === "copied")).toBe(true);
    const kept = await filesClient().list({
      purpose: "page_frame",
      collection: seeded.computerId,
    });
    expect(kept.map((file) => file.key)).toEqual(["turn-recent"]);
  });
});
