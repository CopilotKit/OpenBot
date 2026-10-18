import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import { agents, users } from "../src/db/schema/core";
import {
  demonstrationMediaChunks,
  demonstrations,
} from "../src/db/schema/demonstrations";
import { createDemonstrationMediaStore } from "../src/demonstrations/media-store";
import { createDemonstrationRecorder } from "../src/demonstrations/recording";
import { createDemonstrationStore } from "../src/demonstrations/store";
import { DemonstrationNotFoundError } from "../src/demonstrations/types";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const prefix = `demonstration-media-${randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const bot = `${prefix}-bot`;
const cloudBot = `${prefix}-cloud`;
const store = createDemonstrationStore(database);
const recorder = createDemonstrationRecorder({
  store,
  ownsBot: async () => true,
  ownsSkill: async () => true,
});
const media = createDemonstrationMediaStore(database);
const bytes = (...values: number[]) => new Uint8Array(values);
const storedChunks = async (mediaId: string) =>
  (
    await database
      .select()
      .from(demonstrationMediaChunks)
      .where(eq(demonstrationMediaChunks.mediaId, mediaId))
      .orderBy(asc(demonstrationMediaChunks.index))
  ).map((row) => Array.from(row.bytes));
const screen = {
  kind: "screen",
  mimeType: "video/webm;codecs=vp9,opus",
} as const;
const ndjson = { kind: "network", mimeType: "application/x-ndjson" } as const;
const text = (value: string) => new TextEncoder().encode(value);
const read = async (iterable: AsyncIterable<Uint8Array>) => {
  const out: number[] = [];
  for await (const chunk of iterable) out.push(...chunk);
  return out;
};

beforeAll(async () => {
  await database.insert(users).values([
    { id: owner, email: `${owner}@example.test` },
    { id: other, email: `${other}@example.test` },
  ]);
  await database.insert(agents).values(
    [bot, cloudBot].map((id) => ({
      id,
      name: id,
      type: "built_in" as const,
      configuration: {},
    })),
  );
});
afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner, other]));
  await database.delete(agents).where(inArray(agents.id, [bot, cloudBot]));
  await database.$client.close();
});

/** A demonstration row of its own per test: one person holds one open extension recording per Bot. */
const started = async (
  title: string,
  status: "recording" | "stopped" = "stopped",
) => {
  const id = `${prefix}-${randomUUID()}`;
  await database.insert(demonstrations).values({
    id,
    ownerUserId: owner,
    botId: bot,
    title,
    status,
    source: "extension",
  });
  return { id };
};

test("three chunks upload, complete, and read back in index order", async () => {
  const demo = await started("Media order");
  const created = await media.create(owner, demo.id, screen);
  expect(created).toMatchObject({
    kind: "screen",
    mimeType: "video/webm;codecs=vp9,opus",
    chunks: [],
    byteSize: 0,
    completedAt: null,
  });
  await media.putChunk(owner, demo.id, created.id, 2, bytes(7, 8, 9));
  await media.putChunk(owner, demo.id, created.id, 0, bytes(1, 2));
  const partial = await media.putChunk(owner, demo.id, created.id, 1, bytes(3));
  expect(partial.chunks).toEqual([0, 1, 2]);
  expect(partial.byteSize).toBe(6);
  const done = await media.complete(owner, demo.id, created.id, 3);
  expect(done.completedAt).not.toBeNull();
  expect(await storedChunks(created.id)).toEqual([[1, 2], [3], [7, 8, 9]]);
  const content = await media.content(demo.id, created.id);
  expect(content?.mimeType).toBe("video/webm;codecs=vp9,opus");
  expect(await read(content?.chunks ?? (async function* () {})())).toEqual([
    1, 2, 3, 7, 8, 9,
  ]);
  expect(await media.get(owner, demo.id, created.id)).toEqual(done);
  expect(await media.list(demo.id)).toEqual([done]);
});
test("resending a stored chunk with the same length changes nothing", async () => {
  const demo = await started("Resend");
  const { id } = await media.create(owner, demo.id, screen);
  await media.putChunk(owner, demo.id, id, 0, bytes(1, 2, 3));
  const again = await media.putChunk(owner, demo.id, id, 0, bytes(1, 2, 3));
  expect(again.byteSize).toBe(3);
  expect(again.chunks).toEqual([0]);
  expect(await storedChunks(id)).toEqual([[1, 2, 3]]);
});
test("a different length at a stored index is a conflict", async () => {
  const demo = await started("Different length");
  const { id } = await media.create(owner, demo.id, screen);
  await media.putChunk(owner, demo.id, id, 0, bytes(1, 2, 3));
  await expect(
    media.putChunk(owner, demo.id, id, 0, bytes(1, 2)),
  ).rejects.toMatchObject({ name: "DemonstrationMediaConflictError" });
  expect(await storedChunks(id)).toEqual([[1, 2, 3]]);
});
test("another person is told the recording does not exist", async () => {
  const demo = await started("Not yours");
  const { id } = await media.create(owner, demo.id, screen);
  await expect(media.create(other, demo.id, screen)).rejects.toThrow(
    DemonstrationNotFoundError,
  );
  await expect(media.putChunk(other, demo.id, id, 0, bytes(1))).rejects.toThrow(
    DemonstrationNotFoundError,
  );
  await expect(media.get(other, demo.id, id)).rejects.toThrow(
    DemonstrationNotFoundError,
  );
  await expect(media.complete(other, demo.id, id, 0)).rejects.toThrow(
    DemonstrationNotFoundError,
  );
  await expect(media.get(owner, demo.id, randomUUID())).rejects.toThrow(
    DemonstrationNotFoundError,
  );
  await expect(media.get(owner, `${prefix}-missing`, id)).rejects.toThrow(
    DemonstrationNotFoundError,
  );
});
test("complete with a gap is a conflict and the media stays open", async () => {
  const demo = await started("Gap");
  const { id } = await media.create(owner, demo.id, screen);
  await media.putChunk(owner, demo.id, id, 0, bytes(1));
  await media.putChunk(owner, demo.id, id, 2, bytes(3));
  await expect(media.complete(owner, demo.id, id, 3)).rejects.toMatchObject({
    name: "DemonstrationMediaConflictError",
    message: "Some of the recording is still uploading.",
  });
  expect((await media.get(owner, demo.id, id)).completedAt).toBeNull();
  await media.putChunk(owner, demo.id, id, 1, bytes(2));
  expect(
    (await media.complete(owner, demo.id, id, 3)).completedAt,
  ).not.toBeNull();
});
test("a chunk after complete is a conflict", async () => {
  const demo = await started("After complete");
  const { id } = await media.create(owner, demo.id, screen);
  await media.putChunk(owner, demo.id, id, 0, bytes(1));
  await media.complete(owner, demo.id, id, 1);
  await expect(
    media.putChunk(owner, demo.id, id, 1, bytes(2)),
  ).rejects.toMatchObject({ name: "DemonstrationMediaConflictError" });
  await expect(
    media.putChunk(owner, demo.id, id, 0, bytes(1)),
  ).rejects.toMatchObject({ name: "DemonstrationMediaConflictError" });
});
test("a chunk uploaded after Stop is accepted", async () => {
  const demo = await recorder.start(owner, bot, "After stop", "extension");
  const { id } = await media.create(owner, demo.id, screen);
  await recorder.stop(owner, demo.id);
  const record = await media.putChunk(owner, demo.id, id, 0, bytes(5, 6));
  expect(record.chunks).toEqual([0]);
  expect(
    (await media.complete(owner, demo.id, id, 1)).completedAt,
  ).not.toBeNull();
});
test("deleting the demonstration removes its media and chunks", async () => {
  const demo = await started("Cascade");
  const { id } = await media.create(owner, demo.id, screen);
  await media.putChunk(owner, demo.id, id, 0, bytes(1));
  await database.delete(demonstrations).where(eq(demonstrations.id, demo.id));
  expect(await media.list(demo.id)).toEqual([]);
  expect(await storedChunks(id)).toEqual([]);
});
test("a cloud-browser demonstration refuses media", async () => {
  const demo = await recorder.start(owner, cloudBot, "Cloud", "computer");
  await expect(media.create(owner, demo.id, screen)).rejects.toMatchObject({
    name: "DemonstrationMediaRefusedError",
    message: "Only recordings made in the browser extension keep media.",
  });
  await recorder.stop(owner, demo.id);
});
test("a media takes more than the chunk size in total", async () => {
  const demo = await started("No cap");
  const { id } = await media.create(owner, demo.id, screen);
  const big = new Uint8Array(512 * 1024).fill(9);
  for (let index = 0; index < 4; index++)
    await media.putChunk(owner, demo.id, id, index, big);
  const record = await media.complete(owner, demo.id, id, 4);
  expect(record.byteSize).toBe(4 * 512 * 1024);
});
test("line counts NDJSON lines across chunk boundaries", async () => {
  const demo = await started("Lines");
  const { id } = await media.create(owner, demo.id, ndjson);
  await media.putChunk(owner, demo.id, id, 0, text('{"a":1}\n{"b"'));
  await media.putChunk(owner, demo.id, id, 1, text(':2}\n{"c":3}\n'));
  await media.complete(owner, demo.id, id, 2);
  expect(await media.line(demo.id, id, 0)).toBe('{"a":1}');
  expect(await media.line(demo.id, id, 1)).toBe('{"b":2}');
  expect(await media.line(demo.id, id, 2)).toBe('{"c":3}');
  expect(await media.line(demo.id, id, 3)).toBeNull();
  expect(await media.line(demo.id, randomUUID(), 0)).toBeNull();
});
test("a multi-byte character split across chunks stays whole in a line", async () => {
  const demo = await started("Split character");
  const { id } = await media.create(owner, demo.id, ndjson);
  const whole = text('{"w":"€"}\n');
  await media.putChunk(owner, demo.id, id, 0, whole.slice(0, 7));
  await media.putChunk(owner, demo.id, id, 1, whole.slice(7));
  await media.complete(owner, demo.id, id, 2);
  expect(await media.line(demo.id, id, 0)).toBe('{"w":"€"}');
});
test("content of another demonstration's media id is null", async () => {
  const demo = await started("Wrong demonstration");
  const second = await started("Second");
  const { id } = await media.create(owner, demo.id, screen);
  expect(await media.content(second.id, id)).toBeNull();
  expect(await media.content(demo.id, id)).not.toBeNull();
});
